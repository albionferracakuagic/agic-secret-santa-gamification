import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  GameConfigSchema,
  GameViewSchema,
  phase2Settings,
  type GameConfig,
  type GameKind,
  type GameViewOutput,
  type MyGameResponse,
} from '@santa/contracts';
import {
  BINGO_FREE_CELL,
  BINGO_SIZE,
  DEFAULT_ROUNDS,
  GAMES_PHASE,
  GAME_RULES,
  GAME_TITLES,
  BINGO_BANK,
  TRIVIA_BANK,
  bingoLines,
  bingoScore,
  bingoSquare,
  buildGiftRounds,
  buildMysteryRounds,
  buildSpeedRounds,
  buildTriviaRounds,
  choicePoints,
  generateBingoCard,
  planPhase2Award,
  publishPeopleBoard,
  speedPoints,
  suspectsFor,
  type PublishResult,
  type RoundSpec,
} from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { EventError } from './events.js';
import { writeAudit } from './audit.js';
import { cancelJobs, enqueueJob } from './jobs.js';
import { awardXp } from './xp.js';
import { unlockAchievement } from './achievements.js';
import { setGuess } from './guess.js';
import { loadActiveParticipant, loadEventRow, publishedPeople, type EventRow } from './phase2.js';
import type { CeremonyAnnouncement } from './ceremony.js';

/** Auto-advance of the current step (intro end, round end, reveal end). Idempotent via `stepVersion`. */
export const GAME_STEP_JOB = 'game.step';
/** Speed rounds: broadcast at the random GO moment so clients learn it only when it happens. */
export const GAME_GO_JOB = 'game.go';

export const ACTIVE_GAME_STATUSES = ['intro', 'round_open', 'round_closed', 'results'] as const;

type Game = typeof s.miniGames.$inferSelect;
type Round = typeof s.gameRounds.$inferSelect;
type Rng = () => number;
type MyGameMe = NonNullable<MyGameResponse['me']>;

const kindOf = (g: Game) => g.kind as GameKind;
const cfgOf = (g: Game): GameConfig => GameConfigSchema.parse(g.config);
const specOf = (r: Round) => r.spec as unknown as RoundSpec;
const isChoice = (k: GameKind) => k === 'trivia' || k === 'guess_the_gift';

/* ---------- creation ---------- */

export async function createGame(
  db: Db,
  p: {
    eventId: string;
    actor: string;
    kind: GameKind;
    title?: Record<string, string> | undefined;
    config?: unknown;
    now: Date;
    rng?: Rng;
  },
) {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId, true);
    if (e.phase !== GAMES_PHASE) throw new EventError('not_in_games_phase');
    const cfg = GameConfigSchema.parse(p.config ?? {});
    const rng = p.rng ?? Math.random;
    const count = cfg.rounds ?? DEFAULT_ROUNDS[p.kind];
    const gifts = await tx
      .select()
      .from(s.gifts)
      .where(
        and(eq(s.gifts.eventId, e.id), eq(s.gifts.hidden, false), ne(s.gifts.status, 'registered')),
      );
    const pick = (open: boolean) =>
      gifts
        .filter((g) => (open ? g.status === 'opened' : true))
        .filter((g) => !cfg.giftIds || cfg.giftIds.includes(g.id))
        .map((g) => ({ id: g.id, aliasNo: g.aliasNo, name: g.name }));
    let specs: RoundSpec[];
    switch (p.kind) {
      case 'trivia':
        specs = buildTriviaRounds(count, cfg.customQuestions ?? [], rng);
        break;
      case 'guess_the_gift':
        specs = buildGiftRounds(pick(false), count, rng);
        break;
      case 'mystery_santa': {
        const people = await tx
          .select({
            id: s.participants.id,
            displayName: s.participants.displayName,
            status: s.participants.status,
          })
          .from(s.participants)
          .where(eq(s.participants.eventId, e.id));
        specs = buildMysteryRounds(pick(true), suspectsFor(people, ''), count, rng);
        break;
      }
      case 'speed':
        specs = buildSpeedRounds(count, cfg.roundSeconds, rng);
        break;
      case 'bingo':
        specs = [
          {
            prompt: {
              en: 'Mark the squares as you see them happen',
              it: 'Segna le caselle man mano che le vedi accadere',
            },
            options: [],
            correctIds: [],
          },
        ];
        break;
    }
    if (specs.length === 0) throw new EventError('not_enough_gifts');
    const title = p.title && Object.keys(p.title).length ? p.title : { ...GAME_TITLES[p.kind]! };
    const [game] = await tx
      .insert(s.miniGames)
      .values({
        eventId: e.id,
        kind: p.kind,
        title,
        config: cfg as unknown as Record<string, unknown>,
        createdBy: p.actor,
        createdAt: p.now,
      })
      .returning();
    await tx.insert(s.gameRounds).values(
      specs.map((spec, idx) => ({
        gameId: game!.id,
        idx,
        spec: spec as unknown as Record<string, unknown>,
      })),
    );
    await writeAudit(tx, {
      eventId: e.id,
      actor: p.actor,
      action: 'game.create',
      target: game!.id,
      data: { kind: p.kind },
      at: p.now,
    });
    return { gameId: game!.id, rounds: specs.length };
  });
}

/* ---------- state machine ---------- */

async function lockGame(tx: Db, gameId: string, eventId?: string): Promise<Game> {
  const [g] = await tx
    .select()
    .from(s.miniGames)
    .where(and(eq(s.miniGames.id, gameId), eventId ? eq(s.miniGames.eventId, eventId) : undefined))
    .for('update');
  if (!g) throw new EventError('not_found');
  return g;
}

const roundAt = async (tx: Db, gameId: string, idx: number) => {
  const [r] = await tx
    .select()
    .from(s.gameRounds)
    .where(and(eq(s.gameRounds.gameId, gameId), eq(s.gameRounds.idx, idx)));
  return r;
};
const totalRounds = async (tx: Db, gameId: string) =>
  Number(
    (await tx.select({ n: count() }).from(s.gameRounds).where(eq(s.gameRounds.gameId, gameId)))[0]!
      .n,
  );

/** One transition = bump the version, move the deadline, replace the durable timer. */
async function setStep(
  tx: Db,
  g: Game,
  patch: Partial<typeof s.miniGames.$inferInsert>,
  endsAt: Date | null,
): Promise<Game> {
  const stepVersion = g.stepVersion + 1;
  const [next] = await tx
    .update(s.miniGames)
    .set({ ...patch, stepEndsAt: endsAt, stepVersion })
    .where(eq(s.miniGames.id, g.id))
    .returning();
  await cancelJobs(tx, g.eventId, [GAME_STEP_JOB]);
  if (endsAt)
    await enqueueJob(tx, {
      eventId: g.eventId,
      kind: GAME_STEP_JOB,
      runAt: endsAt,
      payload: { gameId: g.id, version: stepVersion },
    });
  return next!;
}

async function openRound(tx: Db, g: Game, idx: number, now: Date): Promise<Game> {
  const round = (await roundAt(tx, g.id, idx))!;
  const cfg = cfgOf(g);
  const spec = specOf(round);
  const opensAt = new Date(now.getTime() + (spec.delayMs ?? 0));
  const endsAt = new Date(opensAt.getTime() + cfg.roundSeconds * 1000);
  await tx
    .update(s.gameRounds)
    .set({ status: 'open', opensAt, endsAt })
    .where(eq(s.gameRounds.id, round.id));
  if (spec.delayMs)
    await enqueueJob(tx, {
      eventId: g.eventId,
      kind: GAME_GO_JOB,
      runAt: opensAt,
      payload: { gameId: g.id },
    });
  return setStep(tx, g, { status: 'round_open', roundIndex: idx }, endsAt);
}

async function scoreRound(tx: Db, g: Game, round: Round) {
  const subs = await tx
    .select()
    .from(s.gameSubmissions)
    .where(eq(s.gameSubmissions.roundId, round.id));
  if (subs.length === 0) return;
  const spec = specOf(round);
  const kind = kindOf(g);
  const points = new Map<string, number>();
  if (isChoice(kind)) {
    for (const x of subs)
      points.set(
        x.participantId,
        choicePoints({
          correct: spec.correctIds.includes(x.answer),
          submittedAtMs: x.submittedAt.getTime(),
          startMs: round.opensAt!.getTime(),
          endMs: round.endsAt!.getTime(),
        }),
      );
  } else if (kind === 'speed') {
    const go = round.opensAt!.getTime();
    const arrivals = new Map(
      subs
        .filter((x) => x.submittedAt.getTime() >= go)
        .map((x) => [x.participantId, x.submittedAt.getTime() - go]),
    );
    for (const [id, pts] of speedPoints(arrivals)) points.set(id, pts);
  }
  for (const x of subs) {
    const pts = points.get(x.participantId) ?? 0;
    await tx.update(s.gameSubmissions).set({ points: pts }).where(eq(s.gameSubmissions.id, x.id));
    await tx
      .insert(s.gameScores)
      .values({ gameId: g.id, participantId: x.participantId, score: pts })
      .onConflictDoUpdate({
        target: [s.gameScores.gameId, s.gameScores.participantId],
        set: { score: sql`${s.gameScores.score} + ${pts}` },
      });
  }
}

async function closeRound(tx: Db, g: Game, now: Date): Promise<Game> {
  const round = (await roundAt(tx, g.id, g.roundIndex))!;
  await scoreRound(tx, g, round);
  await tx
    .update(s.gameRounds)
    .set({ status: 'closed', closedAt: now })
    .where(eq(s.gameRounds.id, round.id));
  const reveal = cfgOf(g).revealSeconds;
  return setStep(tx, g, { status: 'round_closed' }, new Date(now.getTime() + reveal * 1000));
}

async function bingoScores(tx: Db, g: Game) {
  const marks = await tx.select().from(s.gameBingoMarks).where(eq(s.gameBingoMarks.gameId, g.id));
  const per = new Map<string, Set<number>>();
  for (const m of marks) {
    const set =
      per.get(m.participantId) ?? per.set(m.participantId, new Set()).get(m.participantId)!;
    if (m.status === 'confirmed') set.add(m.cell);
  }
  for (const [participantId, cells] of per)
    await tx
      .insert(s.gameScores)
      .values({ gameId: g.id, participantId, score: bingoScore(cells.size, bingoLines(cells)) })
      .onConflictDoUpdate({
        target: [s.gameScores.gameId, s.gameScores.participantId],
        set: { score: bingoScore(cells.size, bingoLines(cells)) },
      });
}

function publishConfig(e: EventRow) {
  return {
    topN: e.settings.topN,
    hiddenMin: e.settings.hiddenMin,
    minContributors: e.settings.minVoters,
  };
}

/** Final scores -> canPublish winners (top-N, >=5 players), XP and achievements. */
async function toResults(
  tx: Db,
  e: EventRow,
  g: Game,
  now: Date,
): Promise<{ game: Game; announcements: CeremonyAnnouncement[] }> {
  const kind = kindOf(g);
  if (kind === 'bingo') await bingoScores(tx, g);
  const players = await tx
    .select({ participantId: s.gameScores.participantId, score: s.gameScores.score })
    .from(s.gameScores)
    .innerJoin(s.participants, eq(s.participants.id, s.gameScores.participantId))
    .where(and(eq(s.gameScores.gameId, g.id), eq(s.participants.status, 'active')));
  const result: PublishResult | null =
    kind === 'mystery_santa'
      ? null // scored when the givers are revealed (Santa Detective / Invisible Santa)
      : publishPeopleBoard(
          players
            .filter((x) => x.score > 0)
            .map((x) => ({ entryId: x.participantId, score: x.score })),
          players.length,
          publishConfig(e),
        );
  const next = await setStep(
    tx,
    g,
    { status: 'results', results: result as unknown as Record<string, unknown> | null },
    null,
  );

  const cfg = cfgOf(g);
  const p2 = phase2Settings(e.settings);
  const playXp = cfg.rewards?.participationXp ?? p2.gameParticipationXp;
  const winXp = cfg.rewards?.winnerXp ?? p2.gameWinnerXp;
  const winners = new Set(
    result?.ok ? result.entries.filter((x) => x.rank === 1).map((x) => x.entryId) : [],
  );
  const announcements: CeremonyAnnouncement[] = [];
  const unlock = async (participantId: string, key: string, scope: 'pub' | 'participant') => {
    if (await unlockAchievement(tx, { eventId: e.id, participantId, key, source: 'game', now }))
      announcements.push({ scope, participantId, key });
  };
  for (const { participantId } of players) {
    if (playXp > 0)
      await awardXp(tx, {
        eventId: e.id,
        participantId,
        award: planPhase2Award('game_play', playXp, `game:${g.id}:play`),
      });
    if (winners.has(participantId) && winXp > 0)
      await awardXp(tx, {
        eventId: e.id,
        participantId,
        award: planPhase2Award('game_win', winXp, `game:${g.id}:win`),
      });
    await unlock(participantId, 'game_night', 'participant');
    const [played] = await tx
      .select({ n: count() })
      .from(s.gameScores)
      .innerJoin(s.miniGames, eq(s.miniGames.id, s.gameScores.gameId))
      .where(
        and(
          eq(s.gameScores.participantId, participantId),
          inArray(s.miniGames.status, ['results', 'finished']),
        ),
      );
    if (Number(played!.n) >= 3) await unlock(participantId, 'game_marathon', 'participant');
    if (winners.has(participantId)) await unlock(participantId, 'game_champion', 'pub');
  }
  return { game: next, announcements };
}

export interface GameStepResult {
  game: Game;
  announcements: CeremonyAnnouncement[];
}

/** Moves to the next step (timer or organizer "next"). */
async function advance(tx: Db, e: EventRow, g: Game, now: Date): Promise<GameStepResult> {
  switch (g.status) {
    case 'intro':
      return { game: await openRound(tx, g, 0, now), announcements: [] };
    case 'round_open':
      return { game: await closeRound(tx, g, now), announcements: [] };
    case 'round_closed': {
      const total = await totalRounds(tx, g.id);
      if (g.roundIndex + 1 < total)
        return { game: await openRound(tx, g, g.roundIndex + 1, now), announcements: [] };
      return toResults(tx, e, g, now);
    }
    case 'results':
      return { game: await finishGame(tx, g, now), announcements: [] };
    default:
      throw new EventError('invalid_game_state');
  }
}

async function finishGame(tx: Db, g: Game, now: Date): Promise<Game> {
  await cancelJobs(tx, g.eventId, [GAME_STEP_JOB, GAME_GO_JOB]);
  const [next] = await tx
    .update(s.miniGames)
    .set({ status: 'finished', finishedAt: now, stepEndsAt: null, stepVersion: g.stepVersion + 1 })
    .where(eq(s.miniGames.id, g.id))
    .returning();
  return next!;
}

export type GameAction = 'start' | 'next' | 'show_results' | 'finish' | 'cancel';

export async function gameAction(
  db: Db,
  p: { eventId: string; gameId: string; action: GameAction; actor: string; now: Date; rng?: Rng },
): Promise<GameStepResult> {
  return db.transaction(async (tx) => {
    const e = await loadEventRow(tx, p.eventId, true);
    const g = await lockGame(tx, p.gameId, p.eventId);
    if (e.paused) throw new EventError('paused');
    let out: GameStepResult;
    switch (p.action) {
      case 'start': {
        if (g.status !== 'draft') throw new EventError('invalid_game_state');
        if (e.phase !== GAMES_PHASE) throw new EventError('not_in_games_phase');
        const [other] = await tx
          .select({ id: s.miniGames.id })
          .from(s.miniGames)
          .where(
            and(
              eq(s.miniGames.eventId, e.id),
              inArray(s.miniGames.status, [...ACTIVE_GAME_STATUSES]),
            ),
          );
        if (other) throw new EventError('game_active');
        if (kindOf(g) === 'bingo') {
          const active = await tx
            .select({ id: s.participants.id })
            .from(s.participants)
            .where(and(eq(s.participants.eventId, e.id), eq(s.participants.status, 'active')));
          const rng = p.rng ?? Math.random;
          if (active.length)
            await tx
              .insert(s.gameBingoCards)
              .values(
                active.map((a) => ({
                  gameId: g.id,
                  participantId: a.id,
                  cells: generateBingoCard(rng),
                })),
              );
        }
        const intro = cfgOf(g).introSeconds;
        out = {
          game: await setStep(
            tx,
            g,
            { status: 'intro', startedAt: p.now },
            new Date(p.now.getTime() + intro * 1000),
          ),
          announcements: [],
        };
        break;
      }
      case 'next':
        if (!ACTIVE_GAME_STATUSES.includes(g.status as never))
          throw new EventError('invalid_game_state');
        out = await advance(tx, e, g, p.now);
        break;
      case 'show_results': {
        if (
          g.status === 'draft' ||
          g.status === 'finished' ||
          g.status === 'cancelled' ||
          g.status === 'results'
        )
          throw new EventError('invalid_game_state');
        const cur = g.status === 'round_open' ? await closeRound(tx, g, p.now) : g;
        out = await toResults(tx, e, cur, p.now);
        break;
      }
      case 'finish':
        if (g.status !== 'results') throw new EventError('invalid_game_state');
        out = { game: await finishGame(tx, g, p.now), announcements: [] };
        break;
      case 'cancel': {
        if (g.status === 'finished' || g.status === 'cancelled')
          throw new EventError('invalid_game_state');
        await cancelJobs(tx, e.id, [GAME_STEP_JOB, GAME_GO_JOB]);
        const [next] = await tx
          .update(s.miniGames)
          .set({
            status: 'cancelled',
            stepEndsAt: null,
            stepVersion: g.stepVersion + 1,
            finishedAt: p.now,
          })
          .where(eq(s.miniGames.id, g.id))
          .returning();
        out = { game: next!, announcements: [] };
        break;
      }
    }
    await writeAudit(tx, {
      eventId: e.id,
      actor: p.actor,
      action: `game.${p.action}`,
      target: g.id,
      at: p.now,
    });
    return out;
  });
}

/** Timer delivery (at-least-once): stale versions and early deliveries are no-ops. */
export async function advanceGameAuto(
  db: Db,
  p: { gameId: string; version: number; now: Date },
): Promise<(GameStepResult & { moved: true }) | { moved: false }> {
  return db.transaction(async (tx) => {
    const [g0] = await tx.select().from(s.miniGames).where(eq(s.miniGames.id, p.gameId));
    if (!g0) return { moved: false as const };
    const e = await loadEventRow(tx, g0.eventId, true);
    const g = await lockGame(tx, p.gameId);
    if (
      !ACTIVE_GAME_STATUSES.includes(g.status as never) ||
      g.status === 'results' ||
      g.stepVersion !== p.version ||
      !g.stepEndsAt ||
      p.now < g.stepEndsAt
    )
      return { moved: false as const };
    const r = await advance(tx, e, g, p.now);
    return { ...r, moved: true as const };
  });
}

/* ---------- participant actions ---------- */

export async function activeGame(db: Db, eventId: string): Promise<Game | undefined> {
  const [g] = await db
    .select()
    .from(s.miniGames)
    .where(
      and(eq(s.miniGames.eventId, eventId), inArray(s.miniGames.status, [...ACTIVE_GAME_STATUSES])),
    );
  return g;
}

export async function submitAnswer(
  db: Db,
  p: { participantId: string; answerId: string; now: Date },
): Promise<{ roundIndex: number; accepted: true }> {
  return db.transaction(async (tx) => {
    const me = await loadActiveParticipant(tx, p.participantId);
    const e = await loadEventRow(tx, me.eventId);
    if (e.paused) throw new EventError('paused');
    const g0 = await activeGame(tx, e.id);
    if (!g0) throw new EventError('game_not_active');
    const g = await lockGame(tx, g0.id);
    const kind = kindOf(g);
    if (kind === 'bingo') throw new EventError('invalid_game_state');
    if (g.status !== 'round_open') throw new EventError('round_not_open');
    const round = (await roundAt(tx, g.id, g.roundIndex))!;
    // early taps (speed) and late answers are rejected without any penalty
    if (!round.opensAt || !round.endsAt || p.now < round.opensAt || p.now > round.endsAt)
      throw new EventError('round_not_open');
    const spec = specOf(round);
    const answer = kind === 'speed' ? 'tap' : p.answerId;
    if (kind !== 'speed' && !spec.options.some((o) => o.id === answer))
      throw new EventError('invalid_answer');
    const inserted = await tx
      .insert(s.gameSubmissions)
      .values({ gameId: g.id, roundId: round.id, participantId: me.id, answer, submittedAt: p.now })
      .onConflictDoNothing()
      .returning({ id: s.gameSubmissions.id });
    if (inserted.length === 0) throw new EventError('already_submitted');
    await tx
      .insert(s.gameScores)
      .values({ gameId: g.id, participantId: me.id, score: 0 })
      .onConflictDoNothing();
    if (kind === 'mystery_santa' && spec.giftId)
      await setGuess(tx, {
        participantId: me.id,
        giftId: spec.giftId,
        suspectId: answer,
        now: p.now,
        source: 'prediction',
      });
    return { roundIndex: g.roundIndex, accepted: true as const };
  });
}

export async function markBingo(db: Db, p: { participantId: string; cell: number; now: Date }) {
  return db.transaction(async (tx) => {
    const me = await loadActiveParticipant(tx, p.participantId);
    const e = await loadEventRow(tx, me.eventId);
    if (e.paused) throw new EventError('paused');
    const g = await activeGame(tx, e.id);
    if (!g) throw new EventError('game_not_active');
    if (kindOf(g) !== 'bingo') throw new EventError('invalid_game_state');
    if (g.status !== 'round_open') throw new EventError('round_not_open');
    if (p.cell === BINGO_FREE_CELL || p.cell < 0 || p.cell >= BINGO_SIZE)
      throw new EventError('invalid_answer');
    const [card] = await tx
      .select()
      .from(s.gameBingoCards)
      .where(and(eq(s.gameBingoCards.gameId, g.id), eq(s.gameBingoCards.participantId, me.id)));
    if (!card) throw new EventError('game_not_active');
    await tx
      .insert(s.gameBingoMarks)
      .values({ gameId: g.id, participantId: me.id, cell: p.cell, createdAt: p.now })
      .onConflictDoNothing();
    const [mark] = await tx
      .select()
      .from(s.gameBingoMarks)
      .where(
        and(
          eq(s.gameBingoMarks.gameId, g.id),
          eq(s.gameBingoMarks.participantId, me.id),
          eq(s.gameBingoMarks.cell, p.cell),
        ),
      );
    // a rejected mark stays rejected: the organizer said it did not happen
    if (mark!.status === 'rejected') throw new EventError('invalid_answer');
    await tx
      .insert(s.gameScores)
      .values({ gameId: g.id, participantId: me.id, score: 0 })
      .onConflictDoNothing();
    return {
      cell: p.cell,
      mark: mark!.status === 'confirmed' ? ('confirmed' as const) : ('pending' as const),
    };
  });
}

export async function pendingBingoMarks(db: Db, eventId: string, gameId: string) {
  const [g] = await db
    .select()
    .from(s.miniGames)
    .where(and(eq(s.miniGames.id, gameId), eq(s.miniGames.eventId, eventId)));
  if (!g) throw new EventError('not_found');
  const marks = await db
    .select({
      markId: s.gameBingoMarks.id,
      cell: s.gameBingoMarks.cell,
      displayName: s.participants.displayName,
      cells: s.gameBingoCards.cells,
    })
    .from(s.gameBingoMarks)
    .innerJoin(s.participants, eq(s.participants.id, s.gameBingoMarks.participantId))
    .innerJoin(
      s.gameBingoCards,
      and(
        eq(s.gameBingoCards.gameId, s.gameBingoMarks.gameId),
        eq(s.gameBingoCards.participantId, s.gameBingoMarks.participantId),
      ),
    )
    .where(and(eq(s.gameBingoMarks.gameId, gameId), eq(s.gameBingoMarks.status, 'pending')))
    .orderBy(asc(s.gameBingoMarks.createdAt));
  return marks.map((m) => ({
    markId: m.markId,
    displayName: m.displayName,
    cell: m.cell,
    label: { ...(bingoSquare(m.cells[m.cell] ?? -1) ?? { en: '', it: '' }) },
  }));
}

export async function decideBingoMark(
  db: Db,
  p: {
    eventId: string;
    gameId: string;
    markId: string;
    action: 'confirm' | 'reject';
    actor: string;
    now: Date;
  },
) {
  return db.transaction(async (tx) => {
    const [m] = await tx
      .select({ mark: s.gameBingoMarks })
      .from(s.gameBingoMarks)
      .innerJoin(s.miniGames, eq(s.miniGames.id, s.gameBingoMarks.gameId))
      .where(
        and(
          eq(s.gameBingoMarks.id, p.markId),
          eq(s.gameBingoMarks.gameId, p.gameId),
          eq(s.miniGames.eventId, p.eventId),
        ),
      )
      .for('update', { of: s.gameBingoMarks });
    if (!m) throw new EventError('not_found');
    if (m.mark.status !== 'pending') throw new EventError('invalid_game_state');
    const status = p.action === 'confirm' ? ('confirmed' as const) : ('rejected' as const);
    await tx
      .update(s.gameBingoMarks)
      .set({ status, decidedAt: p.now })
      .where(eq(s.gameBingoMarks.id, p.markId));
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: `bingo.${p.action}`,
      target: p.markId,
      at: p.now,
    });
    return { markId: p.markId, status };
  });
}

/* ---------- views ---------- */

export async function listGames(db: Db, eventId: string) {
  const games = await db
    .select()
    .from(s.miniGames)
    .where(eq(s.miniGames.eventId, eventId))
    .orderBy(asc(s.miniGames.createdAt));
  const totals = games.length
    ? await db
        .select({ gameId: s.gameRounds.gameId, n: count() })
        .from(s.gameRounds)
        .where(
          inArray(
            s.gameRounds.gameId,
            games.map((g) => g.id),
          ),
        )
        .groupBy(s.gameRounds.gameId)
    : [];
  return {
    games: games.map((g) => ({
      gameId: g.id,
      kind: kindOf(g),
      status: g.status as
        'draft' | 'intro' | 'round_open' | 'round_closed' | 'results' | 'finished' | 'cancelled',
      title: g.title,
      roundIndex: g.roundIndex,
      totalRounds: Number(totals.find((t) => t.gameId === g.id)?.n ?? 0),
      config: cfgOf(g),
    })),
    catalog: { triviaQuestions: TRIVIA_BANK.length, bingoSquares: BINGO_BANK.length },
  };
}

/** Public view of the active game (identical for every viewer). Null when nothing is running. */
export async function gameView(db: Db, eventId: string, now: Date): Promise<GameViewOutput | null> {
  const g = await activeGame(db, eventId);
  if (!g) return null;
  const kind = kindOf(g);
  const status = g.status as 'intro' | 'round_open' | 'round_closed' | 'results';
  let round: GameViewOutput['round'] = null;
  if (status === 'round_open' || status === 'round_closed') {
    const r = (await roundAt(db, g.id, g.roundIndex))!;
    const spec = specOf(r);
    const submissions =
      kind === 'bingo'
        ? Number(
            (
              await db
                .select({ n: count() })
                .from(s.gameBingoMarks)
                .where(
                  and(eq(s.gameBingoMarks.gameId, g.id), eq(s.gameBingoMarks.status, 'confirmed')),
                )
            )[0]!.n,
          )
        : Number(
            (
              await db
                .select({ n: count() })
                .from(s.gameSubmissions)
                .where(eq(s.gameSubmissions.roundId, r.id))
            )[0]!.n,
          );
    const closed = status === 'round_closed';
    const goTime = r.opensAt && r.opensAt > now && kind === 'speed' ? null : (r.opensAt ?? null);
    round = {
      index: g.roundIndex,
      total: await totalRounds(db, g.id),
      prompt: spec.prompt,
      options: spec.options,
      opensAt: goTime?.toISOString() ?? null,
      endsAt: r.endsAt?.toISOString() ?? null,
      submissionCount: submissions,
      correctOptionIds: closed && isChoice(kind) ? spec.correctIds : null,
    };
  }
  const stored = g.results as PublishResult | null;
  return GameViewSchema.parse({
    gameId: g.id,
    kind,
    title: g.title,
    rules: { ...GAME_RULES[kind]! },
    status,
    stepEndsAt: g.stepEndsAt?.toISOString() ?? null,
    round,
    results: status === 'results' && stored ? await publishedPeople(db, stored) : null,
  });
}

/** The caller's own state in the active game: never anyone else's answers, scores or marks. */
export async function myGameState(db: Db, participantId: string, now: Date) {
  const me = await loadActiveParticipant(db, participantId);
  const game = await gameView(db, me.eventId, now);
  const g = await activeGame(db, me.eventId);
  if (!game || !g) return { game: null, me: null };
  const kind = kindOf(g);
  const [score] = await db
    .select({ score: s.gameScores.score })
    .from(s.gameScores)
    .where(and(eq(s.gameScores.gameId, g.id), eq(s.gameScores.participantId, me.id)));
  let submitted = false;
  let answerId: string | null = null;
  let lastRound: MyGameMe['lastRound'] = null;
  if (g.roundIndex >= 0 && kind !== 'bingo') {
    const r = (await roundAt(db, g.id, g.roundIndex))!;
    const [sub] = await db
      .select()
      .from(s.gameSubmissions)
      .where(and(eq(s.gameSubmissions.roundId, r.id), eq(s.gameSubmissions.participantId, me.id)));
    submitted = !!sub;
    answerId = sub?.answer ?? null;
    if (r.status === 'closed') {
      const pts = sub?.points ?? 0;
      const correct = isChoice(kind) ? !!sub && specOf(r).correctIds.includes(sub.answer) : pts > 0;
      lastRound = {
        outcome: !sub || kind === 'mystery_santa' ? 'none' : correct ? 'correct' : 'incorrect',
        cue: correct ? 'confetti' : 'wink',
        points: pts,
      };
    }
  }
  let card: MyGameMe['card'] = null;
  if (kind === 'bingo') {
    const [row] = await db
      .select()
      .from(s.gameBingoCards)
      .where(and(eq(s.gameBingoCards.gameId, g.id), eq(s.gameBingoCards.participantId, me.id)));
    if (row) {
      const marks = await db
        .select()
        .from(s.gameBingoMarks)
        .where(and(eq(s.gameBingoMarks.gameId, g.id), eq(s.gameBingoMarks.participantId, me.id)));
      const confirmed = new Set(marks.filter((m) => m.status === 'confirmed').map((m) => m.cell));
      card = {
        cells: row.cells.map((idx, cell) => ({
          cell,
          label: {
            ...(idx === null
              ? { en: 'Free', it: 'Libera' }
              : (bingoSquare(idx) ?? { en: '', it: '' })),
          },
          free: idx === null,
          mark: confirmed.has(cell)
            ? ('confirmed' as const)
            : marks.some((m) => m.cell === cell && m.status === 'pending')
              ? ('pending' as const)
              : ('none' as const),
        })),
        lines: bingoLines(confirmed),
      };
    }
  }
  return {
    game,
    me: { submitted, answerId, score: score?.score ?? 0, lastRound, card },
  };
}
