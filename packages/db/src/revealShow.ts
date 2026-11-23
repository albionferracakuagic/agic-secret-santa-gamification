import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  MyRevealShowResponse,
  RevealShowStateOutput,
  ShowChoiceOption,
  ShowChoiceViewOutput,
} from '@santa/contracts';
import { SHOW_CHOICE_SECONDS } from '@santa/contracts';
import { decideShowChoice } from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { EventError } from './events.js';
import { enqueueJob } from './jobs.js';
import { revealStage } from './reveal.js';
import { gameView } from './games.js';
import { spotlightView } from './spotlight.js';
import { auctionView } from './auction.js';

/**
 * Reveal-show extras, all durable (nothing in memory):
 * - Light the Tree: `show_tree_lights` (one row per participant per revealed gift); only COUNT(*) is projected.
 * - Snowstorm vs Sleigh Bells: `show_choice_rounds` + `show_choice_ballots`; the durable `reveal.choice.close` job
 *   closes a round at its deadline, stores ONLY the outcome and deletes the ballots.
 */
export const REVEAL_CHOICE_CLOSE_JOB = 'reveal.choice.close';

/* ---------------- read models (public-safe) ---------------- */

export async function treeLights(db: Db, eventId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.showTreeLights)
    .where(eq(s.showTreeLights.eventId, eventId));
  return Number(r?.n ?? 0);
}

type RoundRow = typeof s.showChoiceRounds.$inferSelect;

const choiceView = (r: RoundRow): ShowChoiceViewOutput =>
  r.status === 'open'
    ? { status: 'open', round: r.roundNo, endsAt: r.endsAt.toISOString(), result: null }
    : {
        status: 'closed',
        round: r.roundNo,
        endsAt: r.endsAt.toISOString(),
        result: r.result ?? 'none',
      };

/** Public reveal-show state: total lights, latest round (outcome only), durable effect. No tallies, no people. */
export async function revealShowState(db: Db, eventId: string): Promise<RevealShowStateOutput> {
  const [lights, [latest], [lastClosed]] = await Promise.all([
    treeLights(db, eventId),
    db
      .select()
      .from(s.showChoiceRounds)
      .where(eq(s.showChoiceRounds.eventId, eventId))
      .orderBy(desc(s.showChoiceRounds.roundNo))
      .limit(1),
    db
      .select({ result: s.showChoiceRounds.result })
      .from(s.showChoiceRounds)
      .where(and(eq(s.showChoiceRounds.eventId, eventId), eq(s.showChoiceRounds.status, 'closed')))
      .orderBy(desc(s.showChoiceRounds.roundNo))
      .limit(1),
  ]);
  const r = lastClosed?.result;
  return {
    lights,
    choice: latest ? choiceView(latest) : null,
    effect: r === 'snowstorm' || r === 'sleigh_bells' ? r : null,
  };
}

/** The caller's OWN selections only (lit gifts; own vote in the open round). */
export async function myRevealShow(
  db: Db,
  eventId: string,
  participantId: string,
): Promise<MyRevealShowResponse> {
  const lit = await db
    .select({ giftId: s.showTreeLights.giftId })
    .from(s.showTreeLights)
    .where(
      and(eq(s.showTreeLights.eventId, eventId), eq(s.showTreeLights.participantId, participantId)),
    );
  const [open] = await db
    .select({ id: s.showChoiceRounds.id, roundNo: s.showChoiceRounds.roundNo })
    .from(s.showChoiceRounds)
    .where(and(eq(s.showChoiceRounds.eventId, eventId), eq(s.showChoiceRounds.status, 'open')));
  let choice: MyRevealShowResponse['choice'] = null;
  if (open) {
    const [b] = await db
      .select({ choice: s.showChoiceBallots.choice })
      .from(s.showChoiceBallots)
      .where(
        and(
          eq(s.showChoiceBallots.roundId, open.id),
          eq(s.showChoiceBallots.participantId, participantId),
        ),
      );
    choice = { round: open.roundNo, myChoice: b?.choice ?? null };
  }
  return { litGiftIds: lit.map((l) => l.giftId), choice };
}

/* ---------------- Light the Tree ---------------- */

/**
 * One optional tap per participant per revealed gift (reveal phase). Repeats are no-ops (PK).
 * Errors: invalid_step (not in the reveal phase), gift_not_revealed (unknown / other event / hidden / not revealed).
 */
export async function lightTree(
  db: Db,
  p: { eventId: string; participantId: string; giftId: string; now: Date },
): Promise<{ lights: number; added: boolean }> {
  const [e] = await db
    .select({ phase: s.events.phase })
    .from(s.events)
    .where(eq(s.events.id, p.eventId));
  if (!e) throw new EventError('not_found');
  if (e.phase !== 'reveal') throw new EventError('invalid_step');
  const [g] = await db
    .select({ id: s.gifts.id })
    .from(s.gifts)
    .where(
      and(
        eq(s.gifts.id, p.giftId),
        eq(s.gifts.eventId, p.eventId),
        eq(s.gifts.status, 'revealed'),
        eq(s.gifts.hidden, false),
      ),
    );
  if (!g) throw new EventError('gift_not_revealed');
  const added = await db
    .insert(s.showTreeLights)
    .values({
      eventId: p.eventId,
      giftId: p.giftId,
      participantId: p.participantId,
      litAt: p.now,
    })
    .onConflictDoNothing()
    .returning({ giftId: s.showTreeLights.giftId });
  return { lights: await treeLights(db, p.eventId), added: added.length > 0 };
}

/* ---------------- Snowstorm vs Sleigh Bells ---------------- */

/**
 * Organizer opens a fixed 10 s round. Reveal phase only, not paused, not during a running drumroll (natural break:
 * no gift on stage, the staged gift already unveiled, or the finale), and not while a game / auction / spotlight
 * owns the screen (it would take the screen back at close and swallow the outcome). One open round at a time.
 * Errors: reveal_not_started, invalid_step, paused, stage_busy, choice_open.
 */
export async function startShowChoice(
  db: Db,
  p: { eventId: string; actor: string; now: Date },
): Promise<{ roundId: string; roundNo: number; endsAt: Date }> {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    if (!e.revealStartedAt) throw new EventError('reveal_not_started');
    if (e.phase !== 'reveal') throw new EventError('invalid_step');
    if (e.paused) throw new EventError('paused');
    const stage = await revealStage(tx, p.eventId);
    if (stage?.giftId && stage.countdownEndsAt && stage.countdownEndsAt > p.now) {
      const [g] = await tx
        .select({ revealedAt: s.gifts.giverRevealedAt })
        .from(s.gifts)
        .where(eq(s.gifts.id, stage.giftId));
      if (g && !g.revealedAt) throw new EventError('stage_busy');
    }
    // a side presentation (game / auction / spotlight) would take the screen back at close and swallow the
    // outcome: the choice runs only on the dedicated reveal stage
    const [game, auction, spotlight] = await Promise.all([
      gameView(tx, p.eventId, p.now),
      auctionView(tx, p.eventId),
      spotlightView(tx, p.eventId),
    ]);
    if (game || auction || spotlight) throw new EventError('stage_busy');
    const [open] = await tx
      .select({ id: s.showChoiceRounds.id })
      .from(s.showChoiceRounds)
      .where(and(eq(s.showChoiceRounds.eventId, p.eventId), eq(s.showChoiceRounds.status, 'open')));
    if (open) throw new EventError('choice_open');
    const [last] = await tx
      .select({ n: sql<number>`coalesce(max(${s.showChoiceRounds.roundNo}), 0)::int` })
      .from(s.showChoiceRounds)
      .where(eq(s.showChoiceRounds.eventId, p.eventId));
    const roundNo = Number(last?.n ?? 0) + 1;
    const endsAt = new Date(p.now.getTime() + SHOW_CHOICE_SECONDS * 1000);
    const [row] = await tx
      .insert(s.showChoiceRounds)
      .values({ eventId: p.eventId, roundNo, status: 'open', openedAt: p.now, endsAt })
      .returning({ id: s.showChoiceRounds.id });
    await enqueueJob(tx, {
      eventId: p.eventId,
      kind: REVEAL_CHOICE_CLOSE_JOB,
      runAt: endsAt,
      payload: { roundId: row!.id },
    });
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'reveal.choice.start',
      target: row!.id,
      at: p.now,
    });
    return { roundId: row!.id, roundNo, endsAt };
  });
}

/**
 * One vote per participant per round; final. Accepted only while the round is open AND before its deadline
 * (server clock), so a late close job never lets a late vote in.
 * Errors: invalid_step (not in reveal), round_not_open, already_submitted.
 */
export async function voteShowChoice(
  db: Db,
  p: {
    eventId: string;
    participantId: string;
    round: number;
    choice: ShowChoiceOption;
    now: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [e] = await tx
      .select({ phase: s.events.phase })
      .from(s.events)
      .where(eq(s.events.id, p.eventId));
    if (!e) throw new EventError('not_found');
    if (e.phase !== 'reveal') throw new EventError('invalid_step');
    // row lock serialises with close/cancel: a ballot is either counted or rejected, never lost
    const [r] = await tx
      .select()
      .from(s.showChoiceRounds)
      .where(and(eq(s.showChoiceRounds.eventId, p.eventId), eq(s.showChoiceRounds.status, 'open')))
      .for('update');
    if (!r || r.roundNo !== p.round || r.endsAt.getTime() <= p.now.getTime())
      throw new EventError('round_not_open');
    const ins = await tx
      .insert(s.showChoiceBallots)
      .values({
        roundId: r.id,
        participantId: p.participantId,
        choice: p.choice,
        votedAt: p.now,
      })
      .onConflictDoNothing()
      .returning({ roundId: s.showChoiceBallots.roundId });
    if (!ins.length) throw new EventError('already_submitted');
  });
}

async function finishRound(
  tx: Db,
  r: RoundRow,
  p: { result: 'snowstorm' | 'sleigh_bells' | 'none'; actor: string; action: string; now: Date },
) {
  await tx
    .update(s.showChoiceRounds)
    .set({ status: 'closed', result: p.result, closedAt: p.now })
    .where(eq(s.showChoiceRounds.id, r.id));
  // data minimisation: no voter identity or tally survives the round
  await tx.delete(s.showChoiceBallots).where(eq(s.showChoiceBallots.roundId, r.id));
  await writeAudit(tx, {
    eventId: r.eventId,
    actor: p.actor,
    action: p.action,
    target: r.id,
    at: p.now,
  });
}

/**
 * `reveal.choice.close` job body. Idempotent and never early: no-op if the round is gone/closed or its deadline
 * has not passed. Outcome via decideShowChoice() (>=5-voter floor, ties => none).
 */
export async function closeShowChoice(
  db: Db,
  p: { eventId: string; roundId: string; now: Date },
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(s.showChoiceRounds)
      .where(and(eq(s.showChoiceRounds.id, p.roundId), eq(s.showChoiceRounds.eventId, p.eventId)))
      .for('update');
    if (!r || r.status !== 'open' || r.endsAt.getTime() > p.now.getTime())
      return { changed: false };
    const [e] = await tx
      .select({ settings: s.events.settings })
      .from(s.events)
      .where(eq(s.events.id, p.eventId));
    const ballots = await tx
      .select({ voterId: s.showChoiceBallots.participantId, choice: s.showChoiceBallots.choice })
      .from(s.showChoiceBallots)
      .where(eq(s.showChoiceBallots.roundId, r.id));
    const result = decideShowChoice(ballots, e?.settings.minVoters);
    await finishRound(tx, r, {
      result,
      actor: 'system',
      action: 'reveal.choice.close',
      now: p.now,
    });
    return { changed: true };
  });
}

/** Organizer early stop: the open round closes with NO effect (`none`), ballots discarded. Error: round_not_open. */
export async function cancelShowChoice(
  db: Db,
  p: { eventId: string; actor: string; now: Date },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(s.showChoiceRounds)
      .where(and(eq(s.showChoiceRounds.eventId, p.eventId), eq(s.showChoiceRounds.status, 'open')))
      .for('update');
    if (!r) throw new EventError('round_not_open');
    await finishRound(tx, r, {
      result: 'none',
      actor: p.actor,
      action: 'reveal.choice.cancel',
      now: p.now,
    });
  });
}
