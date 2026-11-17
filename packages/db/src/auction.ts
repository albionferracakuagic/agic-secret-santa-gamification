import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { phase3Settings, type AuctionViewOutput } from '@santa/contracts';
import { antiSnipe, bidHoldKey, bidReleaseKey, minNextBid } from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { EventError } from './events.js';
import { writeAudit } from './audit.js';
import { cancelJobs, enqueueJob } from './jobs.js';
import { coinBalance, coinsEnabled, creditCoins } from './coins.js';
import { loadActiveParticipant, loadEventRow, personMap, type EventRow } from './phase2.js';

/** Closes the prize at its (possibly extended) deadline; guarded by `closeVersion`. */
export const AUCTION_CLOSE_JOB = 'auction.close';

export const auctionEnabled = (e: EventRow) =>
  coinsEnabled(e) && (e.settings.features as { auction?: boolean }).auction === true;

type Prize = typeof s.auctionPrizes.$inferSelect;

function assertEnabled(e: EventRow) {
  if (!coinsEnabled(e)) throw new EventError('coins_disabled');
  if (!auctionEnabled(e)) throw new EventError('auction_disabled');
}

const currentBid = async (db: Db, prizeId: string) => {
  const [b] = await db
    .select()
    .from(s.auctionBids)
    .where(and(eq(s.auctionBids.prizeId, prizeId), eq(s.auctionBids.status, 'leading')));
  return b;
};

/* ---------- organizer: prize CRUD ---------- */

export async function createPrize(
  db: Db,
  p: {
    eventId: string;
    actor: string;
    title: Record<string, string>;
    reveal: Record<string, string>;
    minBid: number;
    now: Date;
  },
) {
  const e = await loadEventRow(db, p.eventId);
  assertEnabled(e);
  const existing = await db.select({ id: s.auctionPrizes.id }).from(s.auctionPrizes).where(eq(s.auctionPrizes.eventId, p.eventId));
  const [row] = await db
    .insert(s.auctionPrizes)
    .values({ eventId: p.eventId, title: p.title, reveal: p.reveal, minBid: p.minBid, sort: existing.length, createdAt: p.now })
    .returning();
  await writeAudit(db, { eventId: p.eventId, actor: p.actor, action: 'prize.create', target: row!.id, at: p.now });
  return row!;
}

export async function updatePrize(
  db: Db,
  p: {
    eventId: string;
    prizeId: string;
    actor: string;
    patch: { title?: Record<string, string> | undefined; reveal?: Record<string, string> | undefined; minBid?: number | undefined };
    now: Date;
  },
) {
  const [row] = await db
    .update(s.auctionPrizes)
    .set({
      ...(p.patch.title ? { title: p.patch.title } : {}),
      ...(p.patch.reveal ? { reveal: p.patch.reveal } : {}),
      ...(p.patch.minBid ? { minBid: p.patch.minBid } : {}),
    })
    .where(and(eq(s.auctionPrizes.id, p.prizeId), eq(s.auctionPrizes.eventId, p.eventId), eq(s.auctionPrizes.status, 'draft')))
    .returning();
  if (!row) {
    const [any] = await db.select({ id: s.auctionPrizes.id }).from(s.auctionPrizes).where(and(eq(s.auctionPrizes.id, p.prizeId), eq(s.auctionPrizes.eventId, p.eventId)));
    throw new EventError(any ? 'invalid_prize_state' : 'not_found');
  }
  await writeAudit(db, { eventId: p.eventId, actor: p.actor, action: 'prize.update', target: p.prizeId, at: p.now });
  return row;
}

/** Only drafts and cancelled prizes can be deleted (nothing was ever bid on them). */
export async function deletePrize(db: Db, p: { eventId: string; prizeId: string; actor: string; now: Date }) {
  const rows = await db
    .delete(s.auctionPrizes)
    .where(
      and(
        eq(s.auctionPrizes.id, p.prizeId),
        eq(s.auctionPrizes.eventId, p.eventId),
        inArray(s.auctionPrizes.status, ['draft', 'cancelled']),
      ),
    )
    .returning({ id: s.auctionPrizes.id });
  if (rows.length === 0) {
    const [any] = await db
      .select({ id: s.auctionPrizes.id })
      .from(s.auctionPrizes)
      .where(and(eq(s.auctionPrizes.id, p.prizeId), eq(s.auctionPrizes.eventId, p.eventId)));
    throw new EventError(any ? 'invalid_prize_state' : 'not_found');
  }
  await writeAudit(db, { eventId: p.eventId, actor: p.actor, action: 'prize.delete', target: p.prizeId, at: p.now });
}
export async function organizerPrizes(db: Db, eventId: string) {
  const e = await loadEventRow(db, eventId);
  const prizes = await db.select().from(s.auctionPrizes).where(eq(s.auctionPrizes.eventId, eventId)).orderBy(asc(s.auctionPrizes.sort), asc(s.auctionPrizes.createdAt));
  const people = await personMap(db, prizes.flatMap((p) => (p.winnerId ? [p.winnerId] : [])));
  return {
    enabled: auctionEnabled(e),
    prizes: await Promise.all(
      prizes.map(async (p) => ({
        prizeId: p.id,
        title: p.title,
        reveal: p.reveal,
        status: p.status,
        onStage: p.onStage,
        minBid: p.minBid,
        endsAt: p.endsAt?.toISOString() ?? null,
        currentBid: (await currentBid(db, p.id))?.amount ?? p.winningBid ?? null,
        winner: p.winnerId ? (people.get(p.winnerId) ?? null) : null,
      })),
    ),
  };
}

/* ---------- state machine ---------- */

async function scheduleClose(tx: Db, e: EventRow, prize: Prize, version: number, endsAt: Date) {
  await enqueueJob(tx, {
    eventId: e.id,
    kind: AUCTION_CLOSE_JOB,
    runAt: endsAt,
    payload: { prizeId: prize.id, version },
  });
}

async function closePrize(tx: Db, prize: Prize, now: Date) {
  const lead = await currentBid(tx, prize.id);
  if (lead) await tx.update(s.auctionBids).set({ status: 'won' }).where(eq(s.auctionBids.id, lead.id));
  // the winner's hold stays in the ledger: it IS the payment (never refunded, never convertible)
  const [row] = await tx
    .update(s.auctionPrizes)
    .set({
      status: 'closed',
      closedAt: now,
      closeVersion: prize.closeVersion + 1,
      winnerId: lead?.bidderId ?? null,
      winningBid: lead?.amount ?? null,
    })
    .where(eq(s.auctionPrizes.id, prize.id))
    .returning();
  return row!;
}

async function releaseLeader(tx: Db, prize: Prize, now: Date) {
  const lead = await currentBid(tx, prize.id);
  if (!lead) return;
  await tx.update(s.auctionBids).set({ status: 'outbid' }).where(eq(s.auctionBids.id, lead.id));
  await creditCoins(tx, {
    eventId: prize.eventId,
    participantId: lead.bidderId,
    reason: 'bid_release',
    amount: lead.amount,
    rewardKey: bidReleaseKey(lead.id),
    now,
  });
}

export type PrizeAction = 'open' | 'close' | 'reveal' | 'dismiss' | 'cancel';

export async function prizeAction(
  db: Db,
  p: {
    eventId: string;
    prizeId: string;
    action: PrizeAction;
    durationSeconds?: number | undefined;
    actor: string;
    now: Date;
  },
) {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId, true);
    assertEnabled(e);
    const [prize] = await tx
      .select()
      .from(s.auctionPrizes)
      .where(and(eq(s.auctionPrizes.id, p.prizeId), eq(s.auctionPrizes.eventId, p.eventId)))
      .for('update');
    if (!prize) throw new EventError('not_found');
    let next: Prize = prize;
    let winner: string | null = null;
    switch (p.action) {
      case 'open': {
        if (prize.status !== 'draft') throw new EventError('invalid_prize_state');
        if (e.paused) throw new EventError('paused');
        const [busy] = await tx
          .select({ id: s.auctionPrizes.id })
          .from(s.auctionPrizes)
          .where(and(eq(s.auctionPrizes.eventId, e.id), eq(s.auctionPrizes.onStage, true)));
        if (busy) throw new EventError('stage_busy');
        const endsAt = new Date(p.now.getTime() + (p.durationSeconds ?? 60) * 1000);
        [next] = await tx
          .update(s.auctionPrizes)
          .set({ status: 'open', onStage: true, endsAt, closeVersion: prize.closeVersion + 1 })
          .where(eq(s.auctionPrizes.id, prize.id))
          .returning() as [Prize];
        await scheduleClose(tx, e, next, next.closeVersion, endsAt);
        break;
      }
      case 'close':
        if (prize.status !== 'open') throw new EventError('invalid_prize_state');
        next = await closePrize(tx, prize, p.now);
        winner = next.winnerId;
        break;
      case 'reveal':
        if (prize.status !== 'closed') throw new EventError('invalid_prize_state');
        [next] = await tx
          .update(s.auctionPrizes)
          .set({ status: 'revealed', revealedAt: p.now })
          .where(eq(s.auctionPrizes.id, prize.id))
          .returning() as [Prize];
        break;
      case 'dismiss':
        if (prize.status !== 'closed' && prize.status !== 'revealed') throw new EventError('invalid_prize_state');
        [next] = await tx.update(s.auctionPrizes).set({ onStage: false }).where(eq(s.auctionPrizes.id, prize.id)).returning() as [Prize];
        break;
      case 'cancel':
        if (prize.status !== 'draft' && prize.status !== 'open') throw new EventError('invalid_prize_state');
        if (prize.status === 'open') await releaseLeader(tx, prize, p.now);
        [next] = await tx
          .update(s.auctionPrizes)
          .set({ status: 'cancelled', onStage: false, closeVersion: prize.closeVersion + 1 })
          .where(eq(s.auctionPrizes.id, prize.id))
          .returning() as [Prize];
        break;
    }
    await writeAudit(tx, { eventId: e.id, actor: p.actor, action: `prize.${p.action}`, target: prize.id, at: p.now });
    return { prize: next, winnerId: winner };
  });
}

/** Timer delivery (at-least-once): stale version / early / already closed = no-op. */
export async function closeDueAuction(db: Db, p: { prizeId: string; version: number; now: Date }) {
  return db.transaction(async (tx) => {
    const [pre] = await tx.select().from(s.auctionPrizes).where(eq(s.auctionPrizes.id, p.prizeId));
    if (!pre) return null;
    await loadEventRow(tx, pre.eventId, true);
    const [prize] = await tx.select().from(s.auctionPrizes).where(eq(s.auctionPrizes.id, p.prizeId)).for('update');
    if (!prize || prize.status !== 'open' || prize.closeVersion !== p.version || !prize.endsAt || p.now < prize.endsAt) return null;
    const next = await closePrize(tx, prize, p.now);
    return { prize: next, winnerId: next.winnerId };
  });
}

/** Switching the auction off cancels every open prize and gives the leader's coins back. */
export async function cancelOpenAuctions(tx: Db, eventId: string, now: Date) {
  const open = await tx.select().from(s.auctionPrizes).where(and(eq(s.auctionPrizes.eventId, eventId), eq(s.auctionPrizes.status, 'open')));
  for (const prize of open) {
    await releaseLeader(tx, prize, now);
    await tx
      .update(s.auctionPrizes)
      .set({ status: 'cancelled', onStage: false, closeVersion: prize.closeVersion + 1 })
      .where(eq(s.auctionPrizes.id, prize.id));
  }
  await cancelJobs(tx, eventId, [AUCTION_CLOSE_JOB]);
  await tx.update(s.auctionPrizes).set({ onStage: false }).where(and(eq(s.auctionPrizes.eventId, eventId), eq(s.auctionPrizes.onStage, true)));
}

/* ---------- participant ---------- */

export async function placeBid(db: Db, p: { participantId: string; amount: number; now: Date }) {
  return db.transaction(async (tx) => {
    const me = await loadActiveParticipant(tx, p.participantId);
    const e = await loadEventRow(tx, me.eventId);
    assertEnabled(e);
    if (e.paused) throw new EventError('paused');
    // serialise this bidder's spending: balance check + hold happen under the participant row lock
    await tx.select({ id: s.participants.id }).from(s.participants).where(eq(s.participants.id, me.id)).for('update');
    const [staged] = await tx
      .select({ id: s.auctionPrizes.id })
      .from(s.auctionPrizes)
      .where(and(eq(s.auctionPrizes.eventId, e.id), eq(s.auctionPrizes.onStage, true)));
    if (!staged) throw new EventError('no_prize_on_stage');
    const [prize] = await tx.select().from(s.auctionPrizes).where(eq(s.auctionPrizes.id, staged.id)).for('update');
    if (!prize || prize.status !== 'open' || !prize.endsAt || p.now >= prize.endsAt) throw new EventError('auction_closed');
    const rules = phase3Settings(e.settings).auction;
    const lead = await currentBid(tx, prize.id);
    if (lead?.bidderId === me.id) throw new EventError('already_leading');
    if (p.amount < minNextBid({ currentBid: lead?.amount ?? null, minBid: prize.minBid, rules })) throw new EventError('bid_too_low');
    if ((await coinBalance(tx, me.id)) < p.amount) throw new EventError('insufficient_coins');
    if (lead) await releaseLeader(tx, prize, p.now);
    const [bid] = await tx
      .insert(s.auctionBids)
      .values({ eventId: e.id, prizeId: prize.id, bidderId: me.id, amount: p.amount, createdAt: p.now })
      .returning();
    await creditCoins(tx, {
      eventId: e.id,
      participantId: me.id,
      reason: 'bid_hold',
      amount: -p.amount,
      rewardKey: bidHoldKey(bid!.id),
      now: p.now,
    });
    const snipe = antiSnipe({ now: p.now, endsAt: prize.endsAt, extensions: prize.extensions, rules });
    let endsAt = prize.endsAt;
    if (snipe.extended) {
      endsAt = snipe.endsAt;
      const version = prize.closeVersion + 1;
      await tx
        .update(s.auctionPrizes)
        .set({ endsAt, extensions: prize.extensions + 1, closeVersion: version })
        .where(eq(s.auctionPrizes.id, prize.id));
      await scheduleClose(tx, e, prize, version, endsAt);
    }
    return { prizeId: prize.id, amount: p.amount, leading: true as const, endsAt, extended: snipe.extended };
  });
}

/* ---------- views ---------- */

/** Public view of the prize on stage: price only, never bidders. */
export async function auctionView(db: Db, eventId: string): Promise<AuctionViewOutput | null> {
  const e = await loadEventRow(db, eventId);
  if (!auctionEnabled(e)) return null;
  const [prize] = await db
    .select()
    .from(s.auctionPrizes)
    .where(and(eq(s.auctionPrizes.eventId, eventId), eq(s.auctionPrizes.onStage, true)));
  if (!prize || (prize.status !== 'open' && prize.status !== 'closed' && prize.status !== 'revealed')) return null;
  const rules = phase3Settings(e.settings).auction;
  const lead = prize.status === 'open' ? await currentBid(db, prize.id) : undefined;
  const price = prize.status === 'open' ? (lead?.amount ?? null) : prize.winningBid;
  const people = await personMap(db, prize.winnerId ? [prize.winnerId] : []);
  return {
    prizeId: prize.id,
    title: prize.title,
    status: prize.status,
    endsAt: prize.endsAt?.toISOString() ?? null,
    currentBid: price,
    minNextBid: minNextBid({ currentBid: price, minBid: prize.minBid, rules }),
    winner: prize.winnerId ? (people.get(prize.winnerId) ?? null) : null,
    reveal: prize.status === 'revealed' ? prize.reveal : null,
  };
}

export async function myAuction(db: Db, participantId: string) {
  const me = await loadActiveParticipant(db, participantId);
  const e = await loadEventRow(db, me.eventId);
  const enabled = auctionEnabled(e);
  const prize = enabled ? await auctionView(db, e.id) : null;
  let you: { leading: boolean; myBid: number | null } | null = null;
  if (prize && prize.status === 'open') {
    const [mine] = await db
      .select()
      .from(s.auctionBids)
      .where(and(eq(s.auctionBids.prizeId, prize.prizeId), eq(s.auctionBids.bidderId, me.id)))
      .orderBy(desc(s.auctionBids.amount))
      .limit(1);
    you = { leading: mine?.status === 'leading', myBid: mine?.amount ?? null };
  }
  return { enabled, balance: coinsEnabled(e) ? await coinBalance(db, me.id) : 0, prize, you };
}
