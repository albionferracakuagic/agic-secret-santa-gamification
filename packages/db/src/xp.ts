import { and, eq, sql } from 'drizzle-orm';
import { planAward, type ParticipantSource, type XpActivity, type XpAward } from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { earnCoinsForXp } from './coins.js';

/** Idempotent by construction: unique(eventId, participantId, rewardKey). Returns true iff newly awarded. */
export async function awardXp(
  db: Db,
  p: { eventId: string; participantId: string; award: XpAward },
): Promise<boolean> {
  const rows = await db
    .insert(s.xpLedger)
    .values({
      eventId: p.eventId,
      participantId: p.participantId,
      activity: p.award.activity,
      amount: p.award.amount,
      rewardKey: p.award.rewardKey,
      qualifying: p.award.qualifying,
    })
    .onConflictDoNothing({
      target: [s.xpLedger.eventId, s.xpLedger.participantId, s.xpLedger.rewardKey],
    })
    .returning({ id: s.xpLedger.id });
  if (rows.length === 0) return false;
  await earnCoinsForXp(db, p); // Santa Coins per the event's earn rules (no-op unless enabled)
  return true;
}

/**
 * Runs the qualifying action and awards its XP in ONE transaction: if the action throws, no XP is written;
 * repeating the action (any idempotency key) cannot award twice. Values come from event settings.
 */
export async function withXp<T>(
  db: Db,
  p: { eventId: string; participantId: string; activity: XpActivity },
  action: (tx: Db) => Promise<T>,
): Promise<{ result: T; awarded: boolean }> {
  return db.transaction(async (tx) => {
    const [event] = await tx
      .select({ settings: s.events.settings })
      .from(s.events)
      .where(eq(s.events.id, p.eventId));
    if (!event) throw new Error('event not found');
    const result = await action(tx);
    const awarded = await awardXp(tx, {
      eventId: p.eventId,
      participantId: p.participantId,
      award: planAward(p.activity, event.settings.xpValues),
    });
    return { result, awarded };
  });
}

export async function xpTotals(
  db: Db,
  eventId: string,
): Promise<Map<string, { total: number; qualifying: number }>> {
  const rows = await db
    .select({
      participantId: s.xpLedger.participantId,
      total: sql<number>`coalesce(sum(${s.xpLedger.amount}), 0)::int`,
      qualifying: sql<number>`coalesce(sum(${s.xpLedger.amount}) filter (where ${s.xpLedger.qualifying}), 0)::int`,
    })
    .from(s.xpLedger)
    .where(eq(s.xpLedger.eventId, eventId))
    .groupBy(s.xpLedger.participantId);
  return new Map(rows.map((r) => [r.participantId, { total: r.total, qualifying: r.qualifying }]));
}

/** Roster rows shaped for the projectors; `xp` is the total (self-only in every projection). */
export async function loadParticipantSources(
  db: Db,
  eventId: string,
): Promise<ParticipantSource[]> {
  const [people, totals] = await Promise.all([
    db.select().from(s.participants).where(eq(s.participants.eventId, eventId)),
    xpTotals(db, eventId),
  ]);
  return people.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    avatar: p.avatar,
    status: p.status,
    xp: totals.get(p.id)?.total ?? 0,
  }));
}

export async function hasAward(db: Db, eventId: string, participantId: string, rewardKey: string) {
  const rows = await db
    .select({ id: s.xpLedger.id })
    .from(s.xpLedger)
    .where(
      and(
        eq(s.xpLedger.eventId, eventId),
        eq(s.xpLedger.participantId, participantId),
        eq(s.xpLedger.rewardKey, rewardKey),
      ),
    );
  return rows.length > 0;
}
