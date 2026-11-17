import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { phase2Settings } from '@santa/contracts';
import {
  MISSION_ASSIGN_PHASES,
  MISSION_SUBMIT_PHASES,
  missionByKey,
  pickReplacement,
  planMissionAssignments,
  planPhase2Award,
  publishPeopleBoard,
  type PublishResult,
} from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { EventError } from './events.js';
import { writeAudit } from './audit.js';
import { enqueueJob } from './jobs.js';
import { awardXp } from './xp.js';
import { loadActiveParticipant, loadEventRow, missionsEnabled, type EventRow } from './phase2.js';

/** Fires the generic "a secret mission was completed" announcement (decorrelated from the completion time). */
export const MISSION_ANNOUNCE_JOB = 'mission.announce';
/** Random delay window (ms) between a completion and its generic announcement. */
export const MISSION_ANNOUNCE_JITTER_MS: readonly [number, number] = [10_000, 40_000];

type Rng = () => number;

const rows = (db: Db, eventId: string) =>
  db.select().from(s.missionAssignments).where(eq(s.missionAssignments.eventId, eventId));

async function scheduleAnnouncement(tx: Db, eventId: string, now: Date, rng: Rng) {
  const [lo, hi] = MISSION_ANNOUNCE_JITTER_MS;
  await enqueueJob(tx, {
    eventId,
    kind: MISSION_ANNOUNCE_JOB,
    runAt: new Date(now.getTime() + lo + Math.floor(rng() * (hi - lo))),
  });
}

async function complete(
  tx: Db,
  e: EventRow,
  a: typeof s.missionAssignments.$inferSelect,
  by: string,
  now: Date,
  rng: Rng,
) {
  await tx
    .update(s.missionAssignments)
    .set({ status: 'verified', verifiedAt: now, verifiedBy: by })
    .where(eq(s.missionAssignments.id, a.id));
  const xp = phase2Settings(e.settings).missionXp;
  const awarded =
    xp > 0 &&
    (await awardXp(tx, {
      eventId: e.id,
      participantId: a.participantId,
      award: planPhase2Award('mission_completed', xp, `mission:${a.id}`),
    }));
  await scheduleAnnouncement(tx, e.id, now, rng);
  return awarded;
}

/* ---------- participant ---------- */

const view = (a: typeof s.missionAssignments.$inferSelect, swapsAllowed: number) => {
  const def = missionByKey(a.missionKey);
  return {
    assignmentId: a.id,
    title: def ? { ...def.title } : { en: a.missionKey },
    description: def ? { ...def.description } : { en: '' },
    status: a.status,
    completed: a.status === 'verified',
    swapsLeft: Math.max(0, swapsAllowed - a.swapsUsed),
  };
};

/** The caller's OWN missions (cancelled ones are hidden). Nobody else can read these rows through any API. */
export async function myMissions(db: Db, participantId: string) {
  const me = await loadActiveParticipant(db, participantId);
  const e = await loadEventRow(db, me.eventId);
  const p2 = phase2Settings(e.settings);
  const [optOut] = await db
    .select()
    .from(s.missionOptOuts)
    .where(and(eq(s.missionOptOuts.eventId, e.id), eq(s.missionOptOuts.participantId, me.id)));
  const mine = await db
    .select()
    .from(s.missionAssignments)
    .where(
      and(
        eq(s.missionAssignments.participantId, me.id),
        ne(s.missionAssignments.status, 'cancelled'),
      ),
    )
    .orderBy(asc(s.missionAssignments.createdAt));
  return {
    enabled: missionsEnabled(e),
    optedOut: !!optOut,
    verification: p2.missionVerification,
    missions: missionsEnabled(e) ? mine.map((a) => view(a, p2.missionSwaps)) : [],
  };
}

/** Opting out cancels the missions not yet submitted; opting back in waits for the next organizer top-up. */
export async function setMissionOptOut(db: Db, p: { participantId: string; optOut: boolean }) {
  return db.transaction(async (tx) => {
    const me = await loadActiveParticipant(tx, p.participantId);
    const e = await loadEventRow(tx, me.eventId);
    if (!missionsEnabled(e)) throw new EventError('feature_disabled');
    if (p.optOut) {
      await tx
        .insert(s.missionOptOuts)
        .values({ eventId: e.id, participantId: me.id })
        .onConflictDoNothing();
      await tx
        .update(s.missionAssignments)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(s.missionAssignments.participantId, me.id),
            eq(s.missionAssignments.status, 'assigned'),
          ),
        );
    } else {
      await tx
        .delete(s.missionOptOuts)
        .where(and(eq(s.missionOptOuts.eventId, e.id), eq(s.missionOptOuts.participantId, me.id)));
    }
    return { optedOut: p.optOut };
  });
}

export async function submitMission(
  db: Db,
  p: {
    participantId: string;
    assignmentId: string;
    note?: string | undefined;
    now: Date;
    rng?: Rng;
  },
) {
  return db.transaction(async (tx) => {
    const me = await loadActiveParticipant(tx, p.participantId);
    const e = await loadEventRow(tx, me.eventId);
    if (!missionsEnabled(e)) throw new EventError('feature_disabled');
    if (e.paused) throw new EventError('paused');
    if (!MISSION_SUBMIT_PHASES.includes(e.phase)) throw new EventError('mission_closed');
    const [a] = await tx
      .select()
      .from(s.missionAssignments)
      .where(
        and(
          eq(s.missionAssignments.id, p.assignmentId),
          eq(s.missionAssignments.participantId, me.id),
        ),
      )
      .for('update');
    if (!a) throw new EventError('not_found');
    if (a.status !== 'assigned') throw new EventError('mission_not_pending');
    if (phase2Settings(e.settings).missionVerification === 'none') {
      const xpAwarded = await complete(tx, e, a, 'honor', p.now, p.rng ?? Math.random);
      await tx
        .update(s.missionAssignments)
        .set({ note: p.note ?? null, submittedAt: p.now })
        .where(eq(s.missionAssignments.id, a.id));
      return { assignmentId: a.id, status: 'verified' as const, completed: true, xpAwarded };
    }
    await tx
      .update(s.missionAssignments)
      .set({ status: 'submitted', note: p.note ?? null, submittedAt: p.now })
      .where(eq(s.missionAssignments.id, a.id));
    return { assignmentId: a.id, status: 'submitted' as const, completed: false, xpAwarded: false };
  });
}

/** Swap an unsubmitted mission for a different one (limited by `missionSwaps`). */
export async function swapMission(
  db: Db,
  p: { participantId: string; assignmentId: string; rng?: Rng },
) {
  return db.transaction(async (tx) => {
    const me = await loadActiveParticipant(tx, p.participantId);
    const e = await loadEventRow(tx, me.eventId);
    if (!missionsEnabled(e)) throw new EventError('feature_disabled');
    const swaps = phase2Settings(e.settings).missionSwaps;
    const [a] = await tx
      .select()
      .from(s.missionAssignments)
      .where(
        and(
          eq(s.missionAssignments.id, p.assignmentId),
          eq(s.missionAssignments.participantId, me.id),
        ),
      )
      .for('update');
    if (!a) throw new EventError('not_found');
    if (a.status !== 'assigned') throw new EventError('mission_not_pending');
    if (a.swapsUsed >= swaps) throw new EventError('swap_unavailable');
    const used = new Set(
      (
        await tx
          .select({ k: s.missionAssignments.missionKey })
          .from(s.missionAssignments)
          .where(eq(s.missionAssignments.participantId, me.id))
      ).map((r) => r.k),
    );
    const key = pickReplacement(used, p.rng ?? Math.random);
    if (!key) throw new EventError('swap_unavailable');
    const [next] = await tx
      .update(s.missionAssignments)
      .set({ missionKey: key, swapsUsed: a.swapsUsed + 1 })
      .where(eq(s.missionAssignments.id, a.id))
      .returning();
    return view(next!, swaps);
  });
}

/* ---------- organizer ---------- */

/** Tops every active, not-opted-out participant up to N open missions (idempotent). */
export async function assignMissions(
  db: Db,
  p: { eventId: string; actor: string; perParticipant?: number | undefined; now: Date; rng?: Rng },
) {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId, true);
    if (!missionsEnabled(e)) throw new EventError('feature_disabled');
    if (!MISSION_ASSIGN_PHASES.includes(e.phase)) throw new EventError('mission_closed');
    const n = p.perParticipant ?? phase2Settings(e.settings).missionsPerParticipant;
    const optOuts = new Set(
      (
        await tx
          .select({ id: s.missionOptOuts.participantId })
          .from(s.missionOptOuts)
          .where(eq(s.missionOptOuts.eventId, e.id))
      ).map((r) => r.id),
    );
    const people = (
      await tx
        .select({ id: s.participants.id })
        .from(s.participants)
        .where(and(eq(s.participants.eventId, e.id), eq(s.participants.status, 'active')))
    )
      .map((r) => r.id)
      .filter((id) => !optOuts.has(id));
    const all = await rows(tx, e.id);
    const used = new Map<string, Set<string>>();
    const open = new Map<string, number>();
    for (const a of all) {
      (used.get(a.participantId) ?? used.set(a.participantId, new Set()).get(a.participantId)!).add(
        a.missionKey,
      );
      if (a.status === 'assigned' || a.status === 'submitted' || a.status === 'verified')
        open.set(a.participantId, (open.get(a.participantId) ?? 0) + 1);
    }
    const plan = planMissionAssignments(people, n, used, open, p.rng ?? Math.random);
    if (plan.length)
      await tx.insert(s.missionAssignments).values(
        plan.map((x) => ({
          eventId: e.id,
          participantId: x.participantId,
          missionKey: x.missionKey,
          createdAt: p.now,
        })),
      );
    await writeAudit(tx, {
      eventId: e.id,
      actor: p.actor,
      action: 'missions.assign',
      data: { count: plan.length },
      at: p.now,
    });
    return { assigned: plan.length, participants: new Set(plan.map((x) => x.participantId)).size };
  });
}

/** Aggregate counts + submissions awaiting verification. Unsubmitted missions are never listed. */
export async function organizerMissions(db: Db, eventId: string) {
  const e = await loadEventRow(db, eventId);
  const all = await rows(db, eventId);
  const pending = all.filter((a) => a.status === 'submitted');
  const names = pending.length
    ? new Map(
        (
          await db
            .select({ id: s.participants.id, name: s.participants.displayName })
            .from(s.participants)
            .where(
              inArray(
                s.participants.id,
                pending.map((a) => a.participantId),
              ),
            )
        ).map((r) => [r.id, r.name]),
      )
    : new Map<string, string>();
  const count = (st: string) => all.filter((a) => a.status === st).length;
  return {
    enabled: missionsEnabled(e),
    verification: phase2Settings(e.settings).missionVerification,
    counts: {
      assigned: count('assigned'),
      submitted: count('submitted'),
      verified: count('verified'),
    },
    pending: pending.map((a) => ({
      assignmentId: a.id,
      displayName: names.get(a.participantId) ?? '',
      title: { ...(missionByKey(a.missionKey)?.title ?? { en: a.missionKey }) },
      note: a.note,
      submittedAt: a.submittedAt!,
    })),
  };
}

export async function decideMission(
  db: Db,
  p: {
    eventId: string;
    assignmentId: string;
    action: 'verify' | 'reject' | 'reassign';
    actor: string;
    now: Date;
    rng?: Rng;
  },
) {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId);
    if (!missionsEnabled(e)) throw new EventError('feature_disabled');
    const [a] = await tx
      .select()
      .from(s.missionAssignments)
      .where(
        and(
          eq(s.missionAssignments.id, p.assignmentId),
          eq(s.missionAssignments.eventId, p.eventId),
        ),
      )
      .for('update');
    if (!a) throw new EventError('not_found');
    if (a.status !== 'submitted') throw new EventError('mission_not_pending');
    const rng = p.rng ?? Math.random;
    let status: 'verified' | 'rejected' | 'cancelled' = 'rejected';
    if (p.action === 'verify') {
      await complete(tx, e, a, p.actor, p.now, rng);
      status = 'verified';
    } else if (p.action === 'reject') {
      await tx
        .update(s.missionAssignments)
        .set({ status: 'rejected', verifiedBy: p.actor })
        .where(eq(s.missionAssignments.id, a.id));
    } else {
      const used = new Set(
        (
          await tx
            .select({ k: s.missionAssignments.missionKey })
            .from(s.missionAssignments)
            .where(eq(s.missionAssignments.participantId, a.participantId))
        ).map((r) => r.k),
      );
      const key = pickReplacement(used, rng);
      await tx
        .update(s.missionAssignments)
        .set({ status: 'cancelled', verifiedBy: p.actor })
        .where(eq(s.missionAssignments.id, a.id));
      if (key)
        await tx.insert(s.missionAssignments).values({
          eventId: e.id,
          participantId: a.participantId,
          missionKey: key,
          createdAt: p.now,
        });
      status = 'cancelled';
    }
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: `mission.${p.action}`,
      target: a.id,
      at: p.now,
    });
    return { assignmentId: a.id, status };
  });
}

/**
 * Marks every completed, not-yet-announced mission as announced and returns how many generic announcements to
 * emit. Carries no person, mission or count beyond "one per completion" (FR-030).
 */
export async function claimMissionAnnouncements(
  db: Db,
  eventId: string,
  now: Date,
): Promise<number> {
  const claimed = await db
    .update(s.missionAssignments)
    .set({ announcedAt: now })
    .where(
      and(
        eq(s.missionAssignments.eventId, eventId),
        eq(s.missionAssignments.status, 'verified'),
        isNull(s.missionAssignments.announcedAt),
      ),
    )
    .returning({ id: s.missionAssignments.id });
  return claimed.length;
}

/** Mission Master: most verified completions, published only through canPublish (>=5 distinct completers). */
export async function missionMasterResult(db: Db, e: EventRow): Promise<PublishResult> {
  const per = await db
    .select({
      participantId: s.missionAssignments.participantId,
      n: sql<number>`count(*)::int`,
    })
    .from(s.missionAssignments)
    .innerJoin(s.participants, eq(s.participants.id, s.missionAssignments.participantId))
    .where(
      and(
        eq(s.missionAssignments.eventId, e.id),
        eq(s.missionAssignments.status, 'verified'),
        eq(s.participants.status, 'active'),
      ),
    )
    .groupBy(s.missionAssignments.participantId);
  return publishPeopleBoard(
    per.map((r) => ({ entryId: r.participantId, score: Number(r.n) })),
    per.length,
    {
      topN: e.settings.topN,
      hiddenMin: e.settings.hiddenMin,
      minContributors: Math.max(
        e.settings.minVoters,
        phase2Settings(e.settings).detectiveMinGuessers,
      ),
    },
  );
}
