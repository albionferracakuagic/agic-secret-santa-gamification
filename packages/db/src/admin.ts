import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { EventError } from './events.js';
import { purgePhase2Personal } from './phase2.js';
import { loadPublishedVotedCount, votingIsClosed } from './voting.js';

/**
 * Removes a participant: session dropped, gift hidden (so it leaves boards and voting), claim credentials gone.
 * While voting is still open their votes are deleted; after close the locked awards are not rewritten
 * (they stay and are flagged by the integrity review).
 */
export async function removeParticipant(
  db: Db,
  p: {
    eventId: string;
    actor: string;
    participantId: string;
    reason?: string | undefined;
    now: Date;
  },
): Promise<{ participantId: string; votesRemoved: number }> {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    const [me] = await tx
      .select()
      .from(s.participants)
      .where(and(eq(s.participants.id, p.participantId), eq(s.participants.eventId, p.eventId)));
    if (!me) throw new EventError('not_found');
    await tx
      .update(s.participants)
      .set({ status: 'removed', sessionTokenHash: null, claimCodeHash: null })
      .where(eq(s.participants.id, me.id));
    await tx.delete(s.claimTokens).where(eq(s.claimTokens.participantId, me.id));
    await tx.update(s.gifts).set({ hidden: true }).where(eq(s.gifts.giverId, me.id));
    await purgePhase2Personal(tx, me.id);
    let votesRemoved = 0;
    if (e.phase === 'voting' && !votingIsClosed(e, p.now)) {
      const gone = await tx
        .delete(s.votes)
        .where(and(eq(s.votes.eventId, p.eventId), eq(s.votes.voterId, me.id)))
        .returning({ id: s.votes.voterId });
      votesRemoved = gone.length;
    }
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'participant.remove',
      target: me.id,
      reason: p.reason ?? null,
      data: { votesRemoved },
      at: p.now,
    });
    return { participantId: me.id, votesRemoved };
  });
}

const count = (n: unknown) => Number(n ?? 0);

/** Masked event statistics: counts only. `votedCount` is the PUBLISHED counter, never the live one. */
export async function eventStats(db: Db, eventId: string, now: Date) {
  const [e] = await db.select().from(s.events).where(eq(s.events.id, eventId));
  if (!e) throw new EventError('not_found');
  const byStatus = await db
    .select({ status: s.participants.status, n: sql<number>`count(*)::int` })
    .from(s.participants)
    .where(eq(s.participants.eventId, eventId))
    .groupBy(s.participants.status);
  const participants = { unclaimed: 0, pending: 0, active: 0, removed: 0 } as Record<
    string,
    number
  >;
  for (const r of byStatus) participants[r.status] = count(r.n);
  const [g] = await db
    .select({
      registered: sql<number>`count(*)::int`,
      opened: sql<number>`count(*) filter (where ${s.gifts.status} <> 'registered')::int`,
      revealed: sql<number>`count(*) filter (where ${s.gifts.giverRevealedAt} is not null)::int`,
      hidden: sql<number>`count(*) filter (where ${s.gifts.hidden})::int`,
    })
    .from(s.gifts)
    .where(eq(s.gifts.eventId, eventId));
  const [cer] = await db
    .select({ status: s.ceremonyState.status })
    .from(s.ceremonyState)
    .where(eq(s.ceremonyState.eventId, eventId));
  const closed = votingIsClosed(e, now);
  const votingStatus =
    e.phase === 'voting' && !closed
      ? 'open'
      : ['voting', 'games', 'reveal', 'awards', 'completed'].includes(e.phase)
        ? 'closed'
        : 'not_open';
  return {
    phase: e.phase,
    paused: e.paused,
    participants,
    gifts: {
      registered: count(g?.registered),
      opened: count(g?.opened),
      revealed: count(g?.revealed),
      hidden: count(g?.hidden),
    },
    voting: {
      status: votingStatus as 'open' | 'closed' | 'not_open',
      votedCount: await loadPublishedVotedCount(db, eventId),
      round: e.votingRound,
    },
    ceremony: cer?.status ?? ('idle' as const),
    reactionsEnabled: e.settings.features.reactionsEnabled,
  };
}

type Anomaly =
  | 'vote_from_inactive_participant'
  | 'vote_for_own_gift'
  | 'vote_for_hidden_gift'
  | 'vote_for_unopened_gift';

async function anomalyRows(db: Db, eventId: string) {
  const rows = await db
    .select({
      voterId: s.votes.voterId,
      giftId: s.votes.giftId,
      at: s.votes.updatedAt,
      boardKey: s.votingCategories.key,
      voterStatus: s.participants.status,
      giverId: s.gifts.giverId,
      hidden: s.gifts.hidden,
      giftStatus: s.gifts.status,
    })
    .from(s.votes)
    .innerJoin(s.votingCategories, eq(s.votingCategories.id, s.votes.categoryId))
    .innerJoin(s.participants, eq(s.participants.id, s.votes.voterId))
    .innerJoin(s.gifts, eq(s.gifts.id, s.votes.giftId))
    .where(eq(s.votes.eventId, eventId));
  return rows.flatMap((r) => {
    const out: Array<{ anomaly: Anomaly; r: (typeof rows)[number] }> = [];
    if (r.voterStatus !== 'active') out.push({ anomaly: 'vote_from_inactive_participant', r });
    if (r.giverId === r.voterId) out.push({ anomaly: 'vote_for_own_gift', r });
    if (r.hidden) out.push({ anomaly: 'vote_for_hidden_gift', r });
    if (r.giftStatus === 'registered') out.push({ anomaly: 'vote_for_unopened_gift', r });
    return out;
  });
}

const ANOMALIES: Anomaly[] = [
  'vote_from_inactive_participant',
  'vote_for_own_gift',
  'vote_for_hidden_gift',
  'vote_for_unopened_gift',
];

/** Masked aggregates only: counts per anomaly and per category; no voter or gift ids. */
export async function integrityReport(db: Db, eventId: string) {
  const [e] = await db.select().from(s.events).where(eq(s.events.id, eventId));
  if (!e) throw new EventError('not_found');
  const cats = await db
    .select({
      key: s.votingCategories.key,
      voters: sql<number>`count(distinct ${s.votes.voterId})::int`,
    })
    .from(s.votingCategories)
    .leftJoin(s.votes, eq(s.votes.categoryId, s.votingCategories.id))
    .where(and(eq(s.votingCategories.eventId, eventId), eq(s.votingCategories.enabled, true)))
    .groupBy(s.votingCategories.key, s.votingCategories.sort)
    .orderBy(s.votingCategories.sort);
  const found = await anomalyRows(db, eventId);
  const anomalies = Object.fromEntries(
    ANOMALIES.map((a) => [a, found.filter((f) => f.anomaly === a).length]),
  ) as Record<Anomaly, number>;
  return {
    round: e.votingRound,
    categories: cats.map((c) => ({
      boardKey: c.key,
      voters: count(c.voters),
      belowPrivacyFloor: count(c.voters) < Math.max(e.settings.minVoters, 5),
    })),
    anomalies,
    clean: found.length === 0,
  };
}

/** Per-vote details: callers must hold an active unmask grant and the read is audited. */
export async function integrityDetails(db: Db, p: { eventId: string; actor: string; now: Date }) {
  const found = await anomalyRows(db, p.eventId);
  await writeAudit(db, {
    eventId: p.eventId,
    actor: p.actor,
    action: 'integrity.details',
    data: { items: found.length },
    at: p.now,
  });
  return {
    items: found.map(({ anomaly, r }) => ({
      anomaly,
      boardKey: r.boardKey,
      voterId: r.voterId,
      giftId: r.giftId,
      at: r.at,
    })),
  };
}
