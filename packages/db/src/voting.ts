import { and, countDistinct, eq, sql } from 'drizzle-orm';
import { canPublishBallots, isActivityAllowed, planAward, type PublishConfig } from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { awardXp } from './xp.js';
import { cancelJobs, enqueueJob } from './jobs.js';
import { changePhase, EventError } from './events.js';
import { freezeBoards } from './boards.js';

export const VOTING_AUTOCLOSE_JOB = 'voting.autoclose';
export const BOARD_PUBLISH_JOB = 'board.publish';
export const VOTED_COUNTER_KEY = 'voted_counter';

type Event = typeof s.events.$inferSelect;

const stateOf = (e: Event) => ({
  phase: e.phase,
  paused: e.paused,
  milestones: {
    giftOpeningStartedAt: e.giftOpeningStartedAt,
    votingClosedAt: e.votingClosedAt,
    revealStartedAt: e.revealStartedAt,
    ceremonyStartedAt: e.ceremonyStartedAt,
  },
});

/** Server-authoritative: closed by the organizer OR by the timer deadline having passed. */
export const votingIsClosed = (e: Event, now: Date) =>
  e.votingClosedAt !== null || (e.votingEndsAt !== null && now >= e.votingEndsAt);

/* ---------- open / close ---------- */

/** gift_opening -> voting (one transaction), optional timer + cadence job for the "N voted" counter. */
export async function openVoting(
  db: Db,
  p: { eventId: string; actor: string; durationMinutes?: number | undefined; now: Date },
) {
  await db.transaction(async (tx) => {
    await changePhase(tx, { eventId: p.eventId, actor: p.actor, to: 'voting', now: p.now });
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId));
    const endsAt = p.durationMinutes
      ? new Date(p.now.getTime() + p.durationMinutes * 60_000)
      : null;
    await tx.update(s.events).set({ votingEndsAt: endsAt }).where(eq(s.events.id, p.eventId));
    if (endsAt)
      await enqueueJob(tx, { eventId: p.eventId, kind: VOTING_AUTOCLOSE_JOB, runAt: endsAt });
    await enqueueJob(tx, {
      eventId: p.eventId,
      kind: BOARD_PUBLISH_JOB,
      runAt: new Date(p.now.getTime() + e!.settings.cadenceSeconds * 1000),
    });
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'voting.open',
      data: { durationMinutes: p.durationMinutes ?? null },
      at: p.now,
    });
  });
}

/**
 * Closes voting (idempotent) and LOCKS winners per category through canPublish() (final purpose):
 * categories that fail the privacy policy get `publishable=false` and no winners (neutral fallback).
 */
export async function closeVoting(
  db: Db,
  p: { eventId: string; actor: string; now: Date },
): Promise<{
  closedAt: Date;
  categoriesLocked: number;
  categoriesPublishable: number;
  alreadyClosed: boolean;
}> {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    if (e.phase !== 'voting') throw new EventError('voting_not_open');

    const existing = await tx
      .select()
      .from(s.awards)
      .where(and(eq(s.awards.eventId, p.eventId), eq(s.awards.votingRound, e.votingRound)));
    const live = existing.filter((a) => a.invalidatedAt === null);
    if (e.votingClosedAt) {
      return {
        closedAt: e.votingClosedAt,
        categoriesLocked: live.length,
        categoriesPublishable: live.filter((a) => a.publishable).length,
        alreadyClosed: true,
      };
    }

    await tx
      .update(s.events)
      .set({ votingClosedAt: p.now, updatedAt: p.now })
      .where(eq(s.events.id, p.eventId));

    const categories = await tx
      .select()
      .from(s.votingCategories)
      .where(and(eq(s.votingCategories.eventId, p.eventId), eq(s.votingCategories.enabled, true)));
    const votes = await tx.select().from(s.votes).where(eq(s.votes.eventId, p.eventId));
    const cfg: PublishConfig = {
      topN: 1,
      hiddenMin: e.settings.hiddenMin,
      minVoters: e.settings.minVoters,
      minTotalVotes: e.settings.minTotalVotes,
      tieBreak: e.settings.tieBreak,
    };

    let publishable = 0;
    for (const c of categories) {
      const ballots = votes
        .filter((v) => v.categoryId === c.id)
        .map((v) => ({ voterId: v.voterId, entryId: v.giftId }));
      const result = canPublishBallots(ballots, cfg, { purpose: 'final' });
      let ok = result.ok;
      let winners = result.ok
        ? result.entries.filter((x) => x.rank === 1).map((x) => x.entryId)
        : [];
      let tieInfo: Record<string, unknown> = { tied: winners.length > 1 };
      if (!result.ok && result.reason === 'organizer_decision_required') {
        // Floors passed but the tie rule wants a human: candidates wait for POST .../awards/:boardKey/decide.
        const live = canPublishBallots(ballots, cfg, { purpose: 'live' });
        const candidates = live.ok
          ? live.entries.filter((x) => x.rank === 1).map((x) => x.entryId)
          : [];
        ok = candidates.length > 0;
        winners = [];
        tieInfo = { tied: true, needsDecision: true, candidates };
      }
      if (ok) publishable++;
      await tx.insert(s.awards).values({
        eventId: p.eventId,
        boardKey: c.key,
        votingRound: e.votingRound,
        winners,
        tieInfo,
        publishable: ok,
        lockedAt: p.now,
      });
    }

    await cancelJobs(tx, p.eventId, [VOTING_AUTOCLOSE_JOB]);
    await publishVotedCounter(tx, p.eventId, p.now);
    await freezeBoards(tx, p.eventId);
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'voting.close',
      data: { categories: categories.length, publishable },
      at: p.now,
    });
    return {
      closedAt: p.now,
      categoriesLocked: categories.length,
      categoriesPublishable: publishable,
      alreadyClosed: false,
    };
  });
}

/* ---------- casting ---------- */

export async function castVote(
  db: Db,
  p: { participantId: string; categoryId: string; giftId: string; now: Date },
): Promise<{ categoryId: string; giftId: string; xpAwarded: boolean }> {
  return db.transaction(async (tx) => {
    const [me] = await tx
      .select()
      .from(s.participants)
      .where(eq(s.participants.id, p.participantId));
    if (!me || me.status !== 'active') throw new EventError('not_found');
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, me.eventId)).for('share');
    if (!e) throw new EventError('not_found');
    if (!isActivityAllowed(stateOf(e), 'vote')) throw new EventError('voting_not_open');
    if (votingIsClosed(e, p.now)) throw new EventError('voting_closed');

    const [cat] = await tx
      .select({ id: s.votingCategories.id })
      .from(s.votingCategories)
      .where(
        and(
          eq(s.votingCategories.id, p.categoryId),
          eq(s.votingCategories.eventId, e.id),
          eq(s.votingCategories.enabled, true),
        ),
      );
    if (!cat) throw new EventError('invalid_category');

    const [gift] = await tx
      .select()
      .from(s.gifts)
      .where(and(eq(s.gifts.id, p.giftId), eq(s.gifts.eventId, e.id)));
    if (!gift || gift.hidden || gift.status === 'registered')
      throw new EventError('gift_not_votable');
    if (gift.giverId === me.id) throw new EventError('own_gift'); // never your own gift

    await tx
      .insert(s.votes)
      .values({
        categoryId: cat.id,
        voterId: me.id,
        eventId: e.id,
        giftId: gift.id,
        createdAt: p.now,
        updatedAt: p.now,
      })
      .onConflictDoUpdate({
        target: [s.votes.categoryId, s.votes.voterId],
        set: { giftId: gift.id, updatedAt: p.now },
      });
    const xpAwarded = await awardXp(tx, {
      eventId: e.id,
      participantId: me.id,
      award: planAward('voted', e.settings.xpValues),
    });
    return { categoryId: cat.id, giftId: gift.id, xpAwarded };
  });
}

export async function ownVotes(db: Db, participantId: string) {
  return db
    .select({ categoryId: s.votes.categoryId, giftId: s.votes.giftId })
    .from(s.votes)
    .where(eq(s.votes.voterId, participantId));
}

/* ---------- published "N voted" counter (cadence) ---------- */

export async function votedCount(db: Db, eventId: string): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(s.votes.voterId) })
    .from(s.votes)
    .where(eq(s.votes.eventId, eventId));
  return Number(row?.n ?? 0);
}

export async function loadPublishedVotedCount(db: Db, eventId: string): Promise<number | null> {
  const [row] = await db
    .select({ p: s.boardPublications.lastPublished })
    .from(s.boardPublications)
    .where(
      and(
        eq(s.boardPublications.eventId, eventId),
        eq(s.boardPublications.boardKey, VOTED_COUNTER_KEY),
      ),
    );
  const v = (row?.p as { count?: number } | null)?.count;
  return typeof v === 'number' ? v : null;
}

/** Publishes the counter only if it changed since the last publication. Cursor bumps per publication. */
export async function publishVotedCounter(
  db: Db,
  eventId: string,
  now: Date,
): Promise<{ changed: boolean; count: number }> {
  const count = await votedCount(db, eventId);
  const prev = await loadPublishedVotedCount(db, eventId);
  if (prev === count) return { changed: false, count };
  await db
    .insert(s.boardPublications)
    .values({
      eventId,
      boardKey: VOTED_COUNTER_KEY,
      state: 'live',
      lastPublished: { count },
      lastPublishedAt: now,
      cursor: 1,
    })
    .onConflictDoUpdate({
      target: [s.boardPublications.eventId, s.boardPublications.boardKey],
      set: {
        lastPublished: { count },
        lastPublishedAt: now,
        cursor: sqlIncrement(),
      },
    });
  return { changed: true, count };
}

const sqlIncrement = () => sql`${s.boardPublications.cursor} + 1`;

export async function listVotingCategories(db: Db, eventId: string) {
  return db
    .select({
      id: s.votingCategories.id,
      key: s.votingCategories.key,
      name: s.votingCategories.name,
      description: s.votingCategories.description,
    })
    .from(s.votingCategories)
    .where(and(eq(s.votingCategories.eventId, eventId), eq(s.votingCategories.enabled, true)))
    .orderBy(s.votingCategories.sort);
}
