import { and, eq, sql } from 'drizzle-orm';
import { phase3Settings } from '@santa/contracts';
import {
  COIN_ACTIVITIES,
  coinRewardKey,
  coinsForActivity,
  grantRewardKey,
  type XpAward,
} from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { EventError } from './events.js';
import { writeAudit } from './audit.js';
import { loadActiveParticipant, loadEventRow } from './phase2.js';

export const coinsEnabled = (e: { settings: { features: { coins?: boolean } } }) =>
  e.settings.features.coins === true;

/** Idempotent by construction: unique(event, participant, rewardKey). True iff newly credited. */
export async function creditCoins(
  db: Db,
  p: {
    eventId: string;
    participantId: string;
    reason: string;
    amount: number;
    rewardKey: string;
    now?: Date;
  },
): Promise<boolean> {
  const rows = await db
    .insert(s.coinLedger)
    .values({
      eventId: p.eventId,
      participantId: p.participantId,
      reason: p.reason,
      amount: p.amount,
      rewardKey: p.rewardKey,
      ...(p.now ? { createdAt: p.now } : {}),
    })
    .onConflictDoNothing({
      target: [s.coinLedger.eventId, s.coinLedger.participantId, s.coinLedger.rewardKey],
    })
    .returning({ id: s.coinLedger.id });
  return rows.length > 0;
}

/**
 * Called by awardXp after a NEW XP row: converts it to coins per the event's earn rules when coins are on. The
 * key derives from the XP reward key, so replays/retries can never pay twice. Never reachable from a request.
 */
export async function earnCoinsForXp(
  db: Db,
  p: { eventId: string; participantId: string; award: XpAward },
): Promise<void> {
  if (!(COIN_ACTIVITIES as readonly string[]).includes(p.award.activity)) return;
  const e = await loadEventRow(db, p.eventId);
  if (!coinsEnabled(e)) return;
  const amount = coinsForActivity(p.award.activity, phase3Settings(e.settings).coinRules);
  if (amount > 0)
    await creditCoins(db, {
      eventId: p.eventId,
      participantId: p.participantId,
      reason: p.award.activity,
      amount,
      rewardKey: coinRewardKey(p.award.rewardKey),
    });
}

/** Spendable balance (earned - holds + releases). Callers that spend must hold the participant row lock. */
export async function coinBalance(db: Db, participantId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${s.coinLedger.amount}), 0)::int` })
    .from(s.coinLedger)
    .where(eq(s.coinLedger.participantId, participantId));
  return Number(r?.n ?? 0);
}

/** Coins locked by bids where the participant currently leads an open prize. */
export async function heldCoins(db: Db, participantId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${s.auctionBids.amount}), 0)::int` })
    .from(s.auctionBids)
    .innerJoin(s.auctionPrizes, eq(s.auctionPrizes.id, s.auctionBids.prizeId))
    .where(
      and(
        eq(s.auctionBids.bidderId, participantId),
        eq(s.auctionBids.status, 'leading'),
        eq(s.auctionPrizes.status, 'open'),
      ),
    );
  return Number(r?.n ?? 0);
}

/** The caller's own balance and ledger. Nothing here can be queried for anyone else. */
export async function myCoins(db: Db, participantId: string) {
  const me = await loadActiveParticipant(db, participantId);
  const e = await loadEventRow(db, me.eventId);
  const entries = await db
    .select({ reason: s.coinLedger.reason, amount: s.coinLedger.amount, at: s.coinLedger.createdAt })
    .from(s.coinLedger)
    .where(eq(s.coinLedger.participantId, me.id))
    .orderBy(s.coinLedger.createdAt);
  return {
    enabled: coinsEnabled(e),
    balance: await coinBalance(db, me.id),
    held: await heldCoins(db, me.id),
    entries,
  };
}

/** Organizer-defined earning: idempotent per (key, participant); defaults to every active participant. */
export async function grantCoins(
  db: Db,
  p: {
    eventId: string;
    actor: string;
    key: string;
    amount: number;
    participantIds?: string[] | undefined;
    now: Date;
  },
): Promise<{ granted: number }> {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId, true);
    if (!coinsEnabled(e)) throw new EventError('coins_disabled');
    const active = await tx
      .select({ id: s.participants.id })
      .from(s.participants)
      .where(and(eq(s.participants.eventId, e.id), eq(s.participants.status, 'active')));
    const ids = new Set(active.map((a) => a.id));
    const targets = p.participantIds ? p.participantIds.filter((id) => ids.has(id)) : [...ids];
    let granted = 0;
    for (const participantId of targets)
      if (
        await creditCoins(tx, {
          eventId: e.id,
          participantId,
          reason: 'organizer_grant',
          amount: p.amount,
          rewardKey: grantRewardKey(p.key),
          now: p.now,
        })
      )
        granted++;
    await writeAudit(tx, {
      eventId: e.id,
      actor: p.actor,
      action: 'coins.grant',
      target: p.key,
      data: { granted, amount: p.amount },
      at: p.now,
    });
    return { granted };
  });
}

/** Organizer view: rules + one aggregate (coins issued as earnings). Never a person's balance. */
export async function organizerCoins(db: Db, eventId: string) {
  const e = await loadEventRow(db, eventId);
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${s.coinLedger.amount}), 0)::int` })
    .from(s.coinLedger)
    .where(
      and(
        eq(s.coinLedger.eventId, eventId),
        sql`${s.coinLedger.reason} not in ('bid_hold','bid_release')`,
      ),
    );
  return {
    enabled: coinsEnabled(e),
    rules: phase3Settings(e.settings).coinRules,
    issued: Number(r?.n ?? 0),
  };
}
