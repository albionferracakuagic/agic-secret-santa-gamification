import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { enqueueJob, scheduledJobs } from '@santa/db';
import { createTestDb, type TestDb } from '@santa/db/testing';
import { JobRunner } from './runner.js';

let db: TestDb;
const T0 = new Date('2026-12-24T20:00:00Z');
const row = async (id: string) =>
  (await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)))[0]!;

beforeEach(async () => {
  db = await createTestDb();
});

describe('JobRunner', () => {
  it('runs due jobs via the handler registry, not before runAt', async () => {
    const seen: unknown[] = [];
    const runner = new JobRunner(db, { clock: () => T0 }).register('ping', async (j) => {
      seen.push(j.payload);
    });
    const due = await enqueueJob(db, {
      kind: 'ping',
      runAt: new Date(T0.getTime() - 1),
      payload: { n: 1 },
    });
    const later = await enqueueJob(db, { kind: 'ping', runAt: new Date(T0.getTime() + 5000) });
    expect(await runner.tick()).toBe(1);
    expect(seen).toEqual([{ n: 1 }]);
    expect((await row(due)).status).toBe('done');
    expect((await row(later)).status).toBe('pending');
  });

  it('retries with backoff; unknown kind dead-letters after maxAttempts', async () => {
    let now = T0;
    const errors: string[] = [];
    const runner = new JobRunner(db, {
      clock: () => now,
      maxAttempts: 2,
      backoffMs: 1000,
      onError: (_j, e) => errors.push((e as Error).message),
    });
    const id = await enqueueJob(db, { kind: 'nope', runAt: T0 });
    await runner.tick();
    expect((await row(id)).status).toBe('pending');
    now = new Date(T0.getTime() + 5000);
    await runner.tick();
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 2 });
    expect(errors).toHaveLength(2);
  });

  it('crash mid-job: restarted process recovers and re-runs it (at-least-once, idempotent effect)', async () => {
    const id = await enqueueJob(db, { kind: 'close-voting', runAt: T0 });
    const effects = new Set<string>();
    const handler = async () => {
      effects.add('voting-closed');
    };
    // process A applied the effect, then the process died before the ack: row stays 'running'
    await handler();
    await db
      .update(scheduledJobs)
      .set({ status: 'running', lockedBy: 'A', lockedAt: T0 })
      .where(eq(scheduledJobs.id, id));
    // process B starts (single replica): startup recovery requeues and runs it
    const b = new JobRunner(db, {
      workerId: 'B',
      clock: () => new Date(T0.getTime() + 1),
    }).register('close-voting', handler);
    await b.start({ intervalMs: 3_600_000 });
    await b.stop();
    expect((await row(id)).status).toBe('done');
    expect(effects.size).toBe(1);
  });

  it('multi-replica recovery waits for lease expiry instead of stealing live jobs', async () => {
    const id = await enqueueJob(db, { kind: 'x', runAt: T0 });
    await db
      .update(scheduledJobs)
      .set({ status: 'running', lockedBy: 'live', lockedAt: T0 })
      .where(eq(scheduledJobs.id, id));
    let now = new Date(T0.getTime() + 10_000);
    let ran = 0;
    const r = new JobRunner(db, { leaseMs: 60_000, clock: () => now }).register('x', async () => {
      ran++;
    });
    await r.start({ requeueAll: false, intervalMs: 3_600_000 });
    expect(ran).toBe(0);
    now = new Date(T0.getTime() + 61_000);
    await r.tick();
    await r.stop();
    expect(ran).toBe(1);
  });
});
