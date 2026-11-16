import { and, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from './types.js';
import * as s from './schema.js';

/** Arbitrary constant shared by every instance: only one poller claims at a time. */
export const JOBS_ADVISORY_LOCK_KEY = 7_340_001;

export interface EnqueueJob {
  eventId?: string | null;
  kind: string;
  runAt: Date;
  payload?: unknown;
}

export interface ClaimedJob {
  id: string;
  eventId: string | null;
  kind: string;
  payload: unknown;
  attempts: number;
}

export async function enqueueJob(db: Db, job: EnqueueJob): Promise<string> {
  const [row] = await db
    .insert(s.scheduledJobs)
    .values({
      eventId: job.eventId ?? null,
      kind: job.kind,
      runAt: job.runAt,
      payload: job.payload ?? {},
    })
    .returning({ id: s.scheduledJobs.id });
  return row!.id;
}

/** Cancel pending jobs (e.g. reopening voting cancels the pending auto-close). */
export async function cancelJobs(db: Db, eventId: string, kinds?: string[]) {
  await db
    .update(s.scheduledJobs)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(s.scheduledJobs.eventId, eventId),
        eq(s.scheduledJobs.status, 'pending'),
        kinds ? inArray(s.scheduledJobs.kind, kinds) : undefined,
      ),
    );
}

/**
 * Claims due jobs (and jobs whose running lease expired = crashed worker) in one short transaction:
 * transaction-scoped advisory lock (released at commit, safe with pooled connections) + SKIP LOCKED.
 */
export async function claimDueJobs(
  db: Db,
  o: { workerId: string; now: Date; limit: number; leaseMs: number },
): Promise<ClaimedJob[]> {
  return db.transaction(async (tx) => {
    const res = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${JOBS_ADVISORY_LOCK_KEY}) as ok`,
    );
    const ok = (res as unknown as { rows: Array<{ ok: boolean }> }).rows[0]?.ok;
    if (!ok) return [];
    const leaseCutoff = new Date(o.now.getTime() - o.leaseMs);
    const due = await tx
      .select({ id: s.scheduledJobs.id })
      .from(s.scheduledJobs)
      .where(
        or(
          and(eq(s.scheduledJobs.status, 'pending'), lte(s.scheduledJobs.runAt, o.now)),
          and(eq(s.scheduledJobs.status, 'running'), lt(s.scheduledJobs.lockedAt, leaseCutoff)),
        ),
      )
      .orderBy(s.scheduledJobs.runAt)
      .limit(o.limit)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(s.scheduledJobs)
      .set({
        status: 'running',
        lockedBy: o.workerId,
        lockedAt: o.now,
        attempts: sql`${s.scheduledJobs.attempts} + 1`,
      })
      .where(
        inArray(
          s.scheduledJobs.id,
          due.map((d) => d.id),
        ),
      )
      .returning({
        id: s.scheduledJobs.id,
        eventId: s.scheduledJobs.eventId,
        kind: s.scheduledJobs.kind,
        payload: s.scheduledJobs.payload,
        attempts: s.scheduledJobs.attempts,
      });
  });
}

export async function completeJob(db: Db, id: string, workerId: string) {
  await db
    .update(s.scheduledJobs)
    .set({ status: 'done', lockedBy: null, lockedAt: null, lastError: null })
    .where(and(eq(s.scheduledJobs.id, id), eq(s.scheduledJobs.lockedBy, workerId)));
}

export async function failJob(
  db: Db,
  job: ClaimedJob,
  o: { workerId: string; now: Date; error: string; maxAttempts: number; backoffMs: number },
) {
  const dead = job.attempts >= o.maxAttempts;
  await db
    .update(s.scheduledJobs)
    .set({
      status: dead ? 'failed' : 'pending',
      runAt: dead ? undefined : new Date(o.now.getTime() + o.backoffMs * job.attempts),
      lockedBy: null,
      lockedAt: null,
      lastError: o.error.slice(0, 500),
    })
    .where(and(eq(s.scheduledJobs.id, job.id), eq(s.scheduledJobs.lockedBy, o.workerId)));
}

/** Single-replica startup recovery: anything still 'running' belonged to a dead process. */
export async function requeueRunningJobs(db: Db): Promise<number> {
  const rows = await db
    .update(s.scheduledJobs)
    .set({ status: 'pending', lockedBy: null, lockedAt: null })
    .where(eq(s.scheduledJobs.status, 'running'))
    .returning({ id: s.scheduledJobs.id });
  return rows.length;
}
