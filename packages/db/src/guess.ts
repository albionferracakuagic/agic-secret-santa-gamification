import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { CLUES_PER_GIFT, phase2Settings } from '@santa/contracts';
import {
  GUESS_PHASES,
  detectiveScores,
  giftLabel,
  invisibleSantaScores,
  planPhase2Award,
  publishPeopleBoard,
  screenClue,
  suspectsFor,
  type PublishResult,
  type SettledGuess,
} from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { EventError } from './events.js';
import { writeAudit } from './audit.js';
import { awardXp } from './xp.js';
import { guessEnabled, loadActiveParticipant, loadEventRow, type EventRow } from './phase2.js';

const alias = (g: { aliasNo: number }) => giftLabel(g);

function assertGuessWindow(e: EventRow) {
  if (!guessEnabled(e)) throw new EventError('feature_disabled');
  if (e.paused) throw new EventError('paused');
  if (!GUESS_PHASES.includes(e.phase)) throw new EventError('guess_closed');
}

/* ---------- guesses ---------- */

export interface GuessSettlement {
  guesserId: string;
  giftId: string;
  alias: string;
  correct: boolean;
  /** XP newly awarded by this settlement (0 when incorrect or already awarded). */
  xp: number;
}

/**
 * Idempotent: marks every unsettled guess whose gift giver is now revealed as correct/incorrect and grants the
 * (non-qualifying) XP for correct ones. Safe to call from any path (reveal route, ceremony, reads, jobs).
 */
export async function settleGuesses(
  db: Db,
  eventId: string,
  now: Date,
): Promise<GuessSettlement[]> {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, eventId);
    const xp = phase2Settings(e.settings).guessCorrectXp;
    const rows = await tx
      .select({ guess: s.santaGuesses, giverId: s.gifts.giverId, aliasNo: s.gifts.aliasNo })
      .from(s.santaGuesses)
      .innerJoin(s.gifts, eq(s.gifts.id, s.santaGuesses.giftId))
      .where(
        and(
          eq(s.santaGuesses.eventId, eventId),
          isNull(s.santaGuesses.settledAt),
          isNotNull(s.gifts.giverRevealedAt),
        ),
      )
      .for('update', { of: s.santaGuesses });
    const out: GuessSettlement[] = [];
    for (const r of rows) {
      const correct = r.guess.suspectId === r.giverId;
      await tx
        .update(s.santaGuesses)
        .set({ correct, settledAt: now })
        .where(eq(s.santaGuesses.id, r.guess.id));
      const awarded =
        correct &&
        xp > 0 &&
        (await awardXp(tx, {
          eventId,
          participantId: r.guess.guesserId,
          award: planPhase2Award('guess_correct', xp, `guess:${r.guess.giftId}`),
        }));
      out.push({
        guesserId: r.guess.guesserId,
        giftId: r.guess.giftId,
        alias: alias(r),
        correct,
        xp: awarded ? xp : 0,
      });
    }
    return out;
  });
}

/** One editable guess per gift until that gift's giver is revealed (FR-025). `source` marks prediction rounds. */
export async function setGuess(
  db: Db,
  p: {
    participantId: string;
    giftId: string;
    suspectId: string;
    now: Date;
    source?: 'guess' | 'prediction';
  },
): Promise<{ giftId: string; suspectId: string }> {
  return db.transaction(async (tx) => {
    const me = await loadActiveParticipant(tx, p.participantId);
    const e = await loadEventRow(tx, me.eventId);
    assertGuessWindow(e);
    const [g] = await tx
      .select()
      .from(s.gifts)
      .where(and(eq(s.gifts.id, p.giftId), eq(s.gifts.eventId, e.id), eq(s.gifts.hidden, false)))
      .for('update');
    if (!g) throw new EventError('not_found');
    if (g.giverId === me.id) throw new EventError('own_gift');
    if (g.status === 'registered') throw new EventError('gift_not_opened');
    if (g.giverRevealedAt) throw new EventError('guess_closed');
    const people = await tx
      .select({
        id: s.participants.id,
        displayName: s.participants.displayName,
        status: s.participants.status,
      })
      .from(s.participants)
      .where(eq(s.participants.eventId, e.id));
    if (!suspectsFor(people, me.id).some((x) => x.id === p.suspectId))
      throw new EventError('invalid_suspect');
    await tx
      .insert(s.santaGuesses)
      .values({
        eventId: e.id,
        giftId: g.id,
        guesserId: me.id,
        suspectId: p.suspectId,
        source: p.source ?? 'guess',
        createdAt: p.now,
        updatedAt: p.now,
      })
      .onConflictDoUpdate({
        target: [s.santaGuesses.giftId, s.santaGuesses.guesserId],
        set: { suspectId: p.suspectId, source: p.source ?? 'guess', updatedAt: p.now },
      });
    return { giftId: g.id, suspectId: p.suspectId };
  });
}

/** Everything the guess screen needs. Own guesses only; results only for gifts whose giver is revealed. */
export async function guessState(db: Db, participantId: string, now: Date) {
  const me = await loadActiveParticipant(db, participantId);
  const e = await loadEventRow(db, me.eventId);
  if (!guessEnabled(e)) return { enabled: false, suspects: [], gifts: [] };
  await settleGuesses(db, e.id, now);
  const xp = phase2Settings(e.settings).guessCorrectXp;
  const people = await db
    .select({
      id: s.participants.id,
      displayName: s.participants.displayName,
      avatar: s.participants.avatar,
      status: s.participants.status,
    })
    .from(s.participants)
    .where(eq(s.participants.eventId, e.id));
  const gifts = await db
    .select()
    .from(s.gifts)
    .where(
      and(eq(s.gifts.eventId, e.id), eq(s.gifts.hidden, false), ne(s.gifts.status, 'registered')),
    )
    .orderBy(asc(s.gifts.aliasNo));
  const mine = await db.select().from(s.santaGuesses).where(eq(s.santaGuesses.guesserId, me.id));
  const clues = gifts.length
    ? await db
        .select({ id: s.santaClues.id, giftId: s.santaClues.giftId, text: s.santaClues.text })
        .from(s.santaClues)
        .where(
          and(
            inArray(
              s.santaClues.giftId,
              gifts.map((g) => g.id),
            ),
            eq(s.santaClues.status, 'approved'),
          ),
        )
        .orderBy(asc(s.santaClues.id))
    : [];
  return {
    enabled: true,
    suspects: suspectsFor(people, me.id).map((p) => ({
      participantId: p.id,
      displayName: p.displayName,
      avatar: p.avatar,
    })),
    gifts: gifts.map((g) => {
      const guess = mine.find((x) => x.giftId === g.id);
      const revealed = g.giverRevealedAt !== null;
      return {
        giftId: g.id,
        alias: alias(g),
        state:
          g.giverId === me.id
            ? ('own' as const)
            : revealed
              ? ('revealed' as const)
              : ('guessable' as const),
        myGuess: guess?.suspectId ?? null,
        result:
          revealed && guess?.settledAt
            ? guess.correct
              ? { outcome: 'correct' as const, cue: 'confetti' as const, xp }
              : { outcome: 'incorrect' as const, cue: 'wink' as const, xp: 0 }
            : null,
        clues: clues.filter((c) => c.giftId === g.id).map((c) => ({ clueId: c.id, text: c.text })),
      };
    }),
  };
}

/* ---------- giver clues ---------- */

export async function submitClue(db: Db, p: { participantId: string; text: string; now: Date }) {
  return db.transaction(async (tx) => {
    const me = await loadActiveParticipant(tx, p.participantId);
    const e = await loadEventRow(tx, me.eventId);
    assertGuessWindow(e);
    const [g] = await tx
      .select()
      .from(s.gifts)
      .where(and(eq(s.gifts.eventId, e.id), eq(s.gifts.giverId, me.id), eq(s.gifts.hidden, false)))
      .for('update');
    if (!g) throw new EventError('not_found');
    if (g.status === 'registered') throw new EventError('gift_not_opened');
    if (g.giverRevealedAt) throw new EventError('guess_closed');
    const screen = screenClue(p.text, { giverName: me.displayName });
    if (!screen.ok) throw new EventError('clue_not_allowed', screen.reason);
    const existing = await tx
      .select({ id: s.santaClues.id })
      .from(s.santaClues)
      .where(and(eq(s.santaClues.giftId, g.id), ne(s.santaClues.status, 'rejected')));
    if (existing.length >= CLUES_PER_GIFT) throw new EventError('clue_limit');
    const [row] = await tx
      .insert(s.santaClues)
      .values({ eventId: e.id, giftId: g.id, giverId: me.id, text: p.text, createdAt: p.now })
      .returning({ id: s.santaClues.id });
    return { clueId: row!.id, status: 'pending' as const };
  });
}

/** The author's own clues (nobody else can list them). */
export async function ownClues(db: Db, participantId: string) {
  return db
    .select({ clueId: s.santaClues.id, text: s.santaClues.text, status: s.santaClues.status })
    .from(s.santaClues)
    .where(eq(s.santaClues.giverId, participantId))
    .orderBy(asc(s.santaClues.createdAt));
}

/** Moderation queue: gift alias + text, pending first. Never the author, never timestamps. */
export async function clueQueue(db: Db, eventId: string) {
  const rows = await db
    .select({
      clueId: s.santaClues.id,
      giftId: s.santaClues.giftId,
      aliasNo: s.gifts.aliasNo,
      text: s.santaClues.text,
      status: s.santaClues.status,
    })
    .from(s.santaClues)
    .innerJoin(s.gifts, eq(s.gifts.id, s.santaClues.giftId))
    .where(eq(s.santaClues.eventId, eventId));
  const rank = { pending: 0, approved: 1, rejected: 2 } as const;
  return rows
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] || a.aliasNo - b.aliasNo || (a.clueId < b.clueId ? -1 : 1),
    )
    .map((r) => ({
      clueId: r.clueId,
      giftId: r.giftId,
      alias: alias(r),
      text: r.text,
      status: r.status,
    }));
}

export async function decideClue(
  db: Db,
  p: { eventId: string; clueId: string; action: 'approve' | 'reject'; actor: string; now: Date },
) {
  return db.transaction(async (tx) => {
    const [c] = await tx
      .select({ clue: s.santaClues, aliasNo: s.gifts.aliasNo })
      .from(s.santaClues)
      .innerJoin(s.gifts, eq(s.gifts.id, s.santaClues.giftId))
      .where(and(eq(s.santaClues.id, p.clueId), eq(s.santaClues.eventId, p.eventId)))
      .for('update', { of: s.santaClues });
    if (!c) throw new EventError('not_found');
    if (c.clue.status !== 'pending') throw new EventError('clue_not_pending');
    const status = p.action === 'approve' ? ('approved' as const) : ('rejected' as const);
    await tx
      .update(s.santaClues)
      .set({ status, decidedAt: p.now, decidedBy: p.actor })
      .where(eq(s.santaClues.id, p.clueId));
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: `clue.${p.action}`,
      target: p.clueId,
      at: p.now,
    });
    return { clueId: p.clueId, status, giftId: c.clue.giftId, alias: alias(c), text: c.clue.text };
  });
}

/* ---------- boards (always canPublish) ---------- */

async function settledGuesses(db: Db, eventId: string): Promise<SettledGuess[]> {
  const rows = await db
    .select({
      giftId: s.santaGuesses.giftId,
      giverId: s.gifts.giverId,
      guesserId: s.santaGuesses.guesserId,
      correct: s.santaGuesses.correct,
    })
    .from(s.santaGuesses)
    .innerJoin(s.gifts, eq(s.gifts.id, s.santaGuesses.giftId))
    .innerJoin(s.participants, eq(s.participants.id, s.santaGuesses.guesserId))
    .where(
      and(
        eq(s.santaGuesses.eventId, eventId),
        isNotNull(s.santaGuesses.settledAt),
        eq(s.gifts.hidden, false),
        eq(s.participants.status, 'active'),
      ),
    );
  return rows.map((r) => ({ ...r, correct: r.correct === true }));
}

export async function santaDetectiveResult(db: Db, e: EventRow, now: Date): Promise<PublishResult> {
  await settleGuesses(db, e.id, now);
  const { scores, contributors } = detectiveScores(await settledGuesses(db, e.id));
  return publishPeopleBoard(scores, contributors, boardConfig(e));
}

export async function invisibleSantaResult(db: Db, e: EventRow, now: Date): Promise<PublishResult> {
  await settleGuesses(db, e.id, now);
  const { scores, contributors } = invisibleSantaScores(await settledGuesses(db, e.id));
  return publishPeopleBoard(scores, contributors, boardConfig(e));
}

export const boardConfig = (e: EventRow) => ({
  topN: e.settings.topN,
  hiddenMin: e.settings.hiddenMin,
  minContributors: Math.max(e.settings.minVoters, phase2Settings(e.settings).detectiveMinGuessers),
});
