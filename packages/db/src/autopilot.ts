import { and, count, eq, inArray, sql } from 'drizzle-orm';
import {
  AutopilotSettingsPatchSchema,
  AutopilotStateSchema,
  EventSettingsSchema,
  autopilotSettings,
  resolveAutopilotTimings,
  type AutopilotResponse,
  type AutopilotSettingsPatch,
  type AutopilotState,
} from '@santa/contracts';
import {
  AUTOPILOT_POLL_SECONDS,
  MIN_VOTERS_FLOOR,
  applyTick,
  autoAdvanceSeconds,
  commitAction,
  gamesInShow,
  holdState,
  idleAutopilotState,
  nextAction,
  planTimeline,
  resumeState,
  skipStepState,
  startState,
  stepForPhase,
  stopState,
  type AutopilotAction,
  type AutopilotCounts,
  type AutopilotEffect,
  type AutopilotSnapshot,
  type CeremonyStep,
} from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { EventError } from './events.js';
import { cancelJobs, enqueueJob } from './jobs.js';
import { showChoiceHoldUntil } from './showChoiceGuard.js';
import { ceremonyBlockers, pendingDecisions } from './ceremony.js';
import { ACTIVE_GAME_STATUSES } from './games.js';
import { auctionEnabled } from './auction.js';
import { miniGamesEnabled } from './phase2.js';

/**
 * Show autopilot persistence + tick core (ADR-0009). The pure engine lives in `@santa/domain` (`autopilot.ts`).
 * - State: one `autopilot_state` row per event (validated `AutopilotState` JSON), organizer-only.
 * - Ticks: durable `autopilot.tick` jobs carrying `{ seq }`. Every state change bumps `seq`, so queued ticks of an
 *   older state are no-ops; a tick additionally CLAIMS its seq (single atomic UPDATE) so a duplicate/concurrent
 *   delivery can never run the side effect twice. A claim older than `CLAIM_TTL_MS` is considered crashed.
 * - Effects run OUTSIDE any transaction (the services open their own), with actor `system`.
 * Errors: autopilot_active | autopilot_not_running | autopilot_not_held | autopilot_not_active |
 *   autopilot_phase_not_allowed | stale_seq | paused | invalid_settings | features_locked | not_found.
 */
export const AUTOPILOT_TICK_JOB = 'autopilot.tick';
export const AUTOPILOT_CLAIM_TTL_MS = 60_000;

type Event = typeof s.events.$inferSelect;

export type AutopilotCommandName = 'start' | 'hold' | 'resume' | 'stop' | 'skip';

/** Effects the server has to execute (wait / resync / complete need no service call beyond bookkeeping). */
export type AutopilotRunnableAction = Extract<
  AutopilotAction,
  { type: Exclude<AutopilotEffect['type'], 'wait' | 'resync'> }
>;

export type AutopilotExecutor = (
  action: AutopilotRunnableAction,
  ctx: { eventId: string; now: Date },
) => Promise<void>;

/* ---------- storage ---------- */

async function loadEvent(db: Db, eventId: string, lock = false): Promise<Event> {
  const q = db.select().from(s.events).where(eq(s.events.id, eventId));
  const [e] = await (lock ? q.for('update') : q);
  if (!e) throw new EventError('not_found');
  return e;
}

/** Row exists for every event once touched; `lock` takes a row lock (the row is created first if missing). */
async function loadStateRow(db: Db, eventId: string, lock = false): Promise<AutopilotState> {
  await db
    .insert(s.autopilotState)
    .values({ eventId, state: idleAutopilotState() })
    .onConflictDoNothing();
  const q = db.select().from(s.autopilotState).where(eq(s.autopilotState.eventId, eventId));
  const [row] = await (lock ? q.for('update') : q);
  return AutopilotStateSchema.parse(row!.state);
}

/** Current state (idle default when never started). Read-only: does not create the row. */
export async function loadAutopilotState(db: Db, eventId: string): Promise<AutopilotState> {
  const [row] = await db
    .select({ state: s.autopilotState.state })
    .from(s.autopilotState)
    .where(eq(s.autopilotState.eventId, eventId));
  return row ? AutopilotStateSchema.parse(row.state) : idleAutopilotState();
}

async function saveState(db: Db, eventId: string, state: AutopilotState, now: Date) {
  await db
    .update(s.autopilotState)
    .set({ state, claimSeq: null, claimedAt: null, updatedAt: now })
    .where(eq(s.autopilotState.eventId, eventId));
}

/** Idempotent per (event, seq): at most one pending tick job per seq. */
async function enqueueTick(db: Db, eventId: string, seq: number, runAt: Date) {
  const [dup] = await db
    .select({ id: s.scheduledJobs.id })
    .from(s.scheduledJobs)
    .where(
      and(
        eq(s.scheduledJobs.eventId, eventId),
        eq(s.scheduledJobs.kind, AUTOPILOT_TICK_JOB),
        eq(s.scheduledJobs.status, 'pending'),
        sql`${s.scheduledJobs.payload}->>'seq' = ${String(seq)}`,
      ),
    );
  if (dup) return;
  await enqueueJob(db, { eventId, kind: AUTOPILOT_TICK_JOB, runAt, payload: { seq } });
}

/** Persists a new state and (re)schedules its tick: older queued ticks are cancelled (they would no-op anyway). */
async function persist(
  db: Db,
  eventId: string,
  state: AutopilotState,
  now: Date,
  tickAt: Date | null,
) {
  await saveState(db, eventId, state, now);
  await cancelJobs(db, eventId, [AUTOPILOT_TICK_JOB]);
  if (state.status === 'running' && tickAt) await enqueueTick(db, eventId, state.seq, tickAt);
}

/* ---------- snapshot ---------- */

export async function buildAutopilotCounts(db: Db, e: Event): Promise<AutopilotCounts> {
  const [g] = await db
    .select({
      gifts: count(),
      unopened: sql<number>`count(*) filter (where ${s.gifts.status} = 'registered')::int`,
      revealable: sql<number>`count(*) filter (where ${s.gifts.status} = 'opened' and ${s.gifts.giverRevealedAt} is null)::int`,
    })
    .from(s.gifts)
    .where(and(eq(s.gifts.eventId, e.id), eq(s.gifts.hidden, false)));
  return {
    gifts: Number(g?.gifts ?? 0),
    unopenedGifts: Number(g?.unopened ?? 0),
    revealableGifts: Number(g?.revealable ?? 0),
    openingCountdownSeconds: e.settings.openingCountdownSeconds,
  };
}

const autopilotFeatures = (e: Event) => ({
  miniGames: miniGamesEnabled(e),
  auction: auctionEnabled(e),
});

/** Real-data snapshot the pure engine decides on (counts only; no votes, pairings or names). */
export async function buildAutopilotSnapshot(db: Db, eventId: string): Promise<AutopilotSnapshot> {
  const e = await loadEvent(db, eventId);
  const settings = autopilotSettings(e.settings);
  const features = autopilotFeatures(e);
  const c = await buildAutopilotCounts(db, e);

  const [rv] = await db
    .select({
      revealed: sql<number>`count(*) filter (where ${s.gifts.giverRevealedAt} is not null)::int`,
      opened: sql<number>`count(*) filter (where ${s.gifts.status} <> 'registered')::int`,
    })
    .from(s.gifts)
    .where(and(eq(s.gifts.eventId, eventId), eq(s.gifts.hidden, false)));

  const [voters] = await db
    .select({ n: sql<number>`count(distinct ${s.votes.voterId})::int` })
    .from(s.votes)
    .where(eq(s.votes.eventId, eventId));

  const [active] = await db
    .select({ id: s.miniGames.id })
    .from(s.miniGames)
    .where(
      and(
        eq(s.miniGames.eventId, eventId),
        inArray(s.miniGames.status, [...ACTIVE_GAME_STATUSES]),
      ),
    );
  const [played] = await db
    .select({ n: count() })
    .from(s.miniGames)
    .where(and(eq(s.miniGames.eventId, eventId), eq(s.miniGames.status, 'finished')));

  const [cer] = await db
    .select()
    .from(s.ceremonyState)
    .where(eq(s.ceremonyState.eventId, eventId));
  const script = (cer?.script ?? []) as CeremonyStep[];
  const upcoming =
    cer?.status === 'running' ? script[cer.stepIndex + 1] : cer?.status === 'idle' ? script[0] : undefined;
  const blockers = e.phase === 'awards' ? await ceremonyBlockers(db, e) : [];

  return {
    phase: e.phase,
    paused: e.paused,
    timings: resolveAutopilotTimings(settings),
    tieBreak: e.settings.tieBreak,
    opening: {
      total: c.gifts,
      opened: c.gifts - c.unopenedGifts,
      countdownSeconds: e.settings.openingCountdownSeconds,
    },
    voting: {
      closed: e.votingClosedAt !== null,
      closedAt: e.votingClosedAt?.toISOString() ?? null,
      belowFloor: Number(voters?.n ?? 0) < MIN_VOTERS_FLOOR,
    },
    games: {
      inShow: gamesInShow(settings, features),
      miniGames: features.miniGames,
      active: !!active,
      played: Number(played?.n ?? 0),
    },
    reveal: {
      revealable: c.revealableGifts,
      revealed: Number(rv?.revealed ?? 0),
    },
    ceremony: {
      status: cer?.status ?? 'idle',
      index: cer?.stepIndex ?? 0,
      stepEndsAt: cer?.stepEndsAt?.toISOString() ?? null,
      upcomingAutoSeconds: upcoming ? autoAdvanceSeconds(upcoming) : null,
      nothingToShow: blockers.includes('nothing_to_show'),
      pendingDecisions:
        e.phase === 'awards' && e.settings.tieBreak === 'organizer'
          ? (await pendingDecisions(db, e)).length
          : 0,
    },
  };
}

/* ---------- organizer commands ---------- */

interface CommandInput {
  eventId: string;
  actor: string;
  now: Date;
  /** Optimistic guard: 409 `stale_seq` when the autopilot already moved on (double-click safe). */
  fromSeq?: number | undefined;
}

const guardSeq = (state: AutopilotState, fromSeq: number | undefined) => {
  if (fromSeq !== undefined && fromSeq !== state.seq) throw new EventError('stale_seq');
};

async function audit(db: Db, p: CommandInput, command: AutopilotCommandName, state: AutopilotState) {
  await writeAudit(db, {
    eventId: p.eventId,
    actor: p.actor,
    action: `autopilot.${command}`,
    data: { seq: state.seq, step: state.step },
    at: p.now,
  });
}

/** Start the show. Allowed from gift_opening up to awards (resync adopts the actual phase); earlier/completed rejected. */
export async function startAutopilot(db: Db, p: CommandInput): Promise<AutopilotState> {
  return db.transaction(async (tx) => {
    const e = await loadEvent(tx, p.eventId, true);
    const prev = await loadStateRow(tx, p.eventId, true);
    guardSeq(prev, p.fromSeq);
    if (prev.status === 'running' || prev.status === 'held') throw new EventError('autopilot_active');
    if (!stepForPhase(e.phase) || e.phase === 'completed')
      throw new EventError('autopilot_phase_not_allowed');
    if (e.paused) throw new EventError('paused');
    const counts = await buildAutopilotCounts(tx, e);
    const state = startState({
      settings: autopilotSettings(e.settings),
      counts,
      features: autopilotFeatures(e),
      now: p.now,
      prev,
    });
    await persist(tx, p.eventId, state, p.now, p.now);
    await audit(tx, p, 'start', state);
    return state;
  });
}

export async function holdAutopilot(db: Db, p: CommandInput): Promise<AutopilotState> {
  return db.transaction(async (tx) => {
    const cur = await loadStateRow(tx, p.eventId, true);
    guardSeq(cur, p.fromSeq);
    if (cur.status !== 'running') throw new EventError('autopilot_not_running');
    const state = holdState(cur, p.now);
    await persist(tx, p.eventId, state, p.now, null);
    await audit(tx, p, 'hold', state);
    return state;
  });
}

/** Re-plans from the remaining time (`stepEndsAt = now + remainingMsAtHold`) and schedules the tick there. */
export async function resumeAutopilot(db: Db, p: CommandInput): Promise<AutopilotState> {
  return db.transaction(async (tx) => {
    const e = await loadEvent(tx, p.eventId);
    const cur = await loadStateRow(tx, p.eventId, true);
    guardSeq(cur, p.fromSeq);
    if (cur.status !== 'held') throw new EventError('autopilot_not_held');
    if (e.paused) throw new EventError('paused'); // unfreeze first, otherwise the next tick would hold again
    const state = resumeState(cur, p.now);
    await persist(tx, p.eventId, state, p.now, state.stepEndsAt ? new Date(state.stepEndsAt) : p.now);
    await audit(tx, p, 'resume', state);
    return state;
  });
}

/** Back to idle: the show continues manually. */
export async function stopAutopilot(db: Db, p: CommandInput): Promise<AutopilotState> {
  return db.transaction(async (tx) => {
    const cur = await loadStateRow(tx, p.eventId, true);
    guardSeq(cur, p.fromSeq);
    if (cur.status !== 'running' && cur.status !== 'held')
      throw new EventError('autopilot_not_active');
    const state = stopState(cur, p.now);
    await persist(tx, p.eventId, state, p.now, null);
    await audit(tx, p, 'stop', state);
    return state;
  });
}

/** Ends the current wait now; irreversibility is still enforced by the engine (e.g. voting is closed first). */
export async function skipAutopilotStep(db: Db, p: CommandInput): Promise<AutopilotState> {
  return db.transaction(async (tx) => {
    const cur = await loadStateRow(tx, p.eventId, true);
    guardSeq(cur, p.fromSeq);
    if (cur.status !== 'running') throw new EventError('autopilot_not_running');
    const state = skipStepState(cur, p.now);
    await persist(tx, p.eventId, state, p.now, p.now);
    await audit(tx, p, 'skip', state);
    return state;
  });
}

/** Settings patch (`settings.autopilot`): `null` clears an override. Allowed until the event is completed. */
export async function updateAutopilotSettings(
  db: Db,
  p: { eventId: string; actor: string; patch: AutopilotSettingsPatch; now: Date },
) {
  const patch = AutopilotSettingsPatchSchema.parse(p.patch);
  return db.transaction(async (tx) => {
    const e = await loadEvent(tx, p.eventId, true);
    if (e.phase === 'completed') throw new EventError('features_locked');
    const merged = { ...autopilotSettings(e.settings), ...patch };
    const settings = {
      preset: merged.preset,
      ...(merged.openingGiftSeconds === null || merged.openingGiftSeconds === undefined
        ? {}
        : { openingGiftSeconds: merged.openingGiftSeconds }),
      ...(merged.votingMinutes === null || merged.votingMinutes === undefined
        ? {}
        : { votingMinutes: merged.votingMinutes }),
      ...(merged.gamesMinutes === null || merged.gamesMinutes === undefined
        ? {}
        : { gamesMinutes: merged.gamesMinutes }),
      ...(merged.revealGiftSeconds === null || merged.revealGiftSeconds === undefined
        ? {}
        : { revealGiftSeconds: merged.revealGiftSeconds }),
      ...(merged.interludeSeconds === null || merged.interludeSeconds === undefined
        ? {}
        : { interludeSeconds: merged.interludeSeconds }),
      includeExtras: merged.includeExtras,
    };
    const parsed = EventSettingsSchema.safeParse({ ...e.settings, autopilot: settings });
    if (!parsed.success)
      throw new EventError(
        'invalid_settings',
        parsed.error.issues.map((i) => i.path.join('.')).join(', '),
      );
    await tx
      .update(s.events)
      .set({ settings: parsed.data, updatedAt: p.now })
      .where(eq(s.events.id, p.eventId));
    // running show: refresh the planned durations/ETAs (the tick itself always reads the live settings)
    const st = await loadStateRow(tx, p.eventId, true);
    if (st.status === 'running' && st.step && st.step !== 'complete') {
      const timeline = planTimeline(
        autopilotSettings(parsed.data),
        await buildAutopilotCounts(tx, e),
        autopilotFeatures({ ...e, settings: parsed.data }),
        p.now,
        { from: st.step },
      );
      await saveState(tx, p.eventId, { ...st, timeline }, p.now);
    }
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'autopilot.settings',
      data: { patch },
      at: p.now,
    });
    return autopilotSettings(parsed.data);
  });
}

/** GET payload: stored settings, effective timings, state (organizer-only). */
export async function autopilotView(db: Db, eventId: string): Promise<AutopilotResponse> {
  const e = await loadEvent(db, eventId);
  const settings = autopilotSettings(e.settings);
  return {
    settings,
    timings: resolveAutopilotTimings(settings),
    state: await loadAutopilotState(db, eventId),
  };
}

/* ---------- auto-resolve ---------- */

interface TieInfoShape {
  needsDecision?: boolean;
  candidates?: string[];
  [k: string]: unknown;
}

/**
 * Autopilot never waits for the organizer: publishable awards still waiting for a tie decision become SHARED
 * (all tied candidates win). Only before the ceremony starts (same rule as `decideAward`). Returns the number
 * of boards resolved. Idempotent.
 */
export async function resolveTiesShared(
  db: Db,
  p: { eventId: string; actor: string; now: Date },
): Promise<{ resolved: number }> {
  return db.transaction(async (tx) => {
    const e = await loadEvent(tx, p.eventId, true);
    const [cer] = await tx
      .select({ status: s.ceremonyState.status })
      .from(s.ceremonyState)
      .where(eq(s.ceremonyState.eventId, p.eventId));
    if (cer && (cer.status === 'running' || cer.status === 'paused' || cer.status === 'done'))
      throw new EventError('ceremony_started');
    const awards = await tx
      .select()
      .from(s.awards)
      .where(
        and(
          eq(s.awards.eventId, p.eventId),
          eq(s.awards.votingRound, e.votingRound),
          sql`${s.awards.invalidatedAt} is null`,
        ),
      );
    let resolved = 0;
    for (const a of awards) {
      const info = (a.tieInfo ?? {}) as TieInfoShape;
      const cands = info.candidates ?? [];
      if (!a.publishable || !info.needsDecision || a.winners.length > 0 || cands.length === 0)
        continue;
      await tx
        .update(s.awards)
        .set({
          winners: cands,
          tieInfo: { ...info, needsDecision: false, tied: cands.length > 1, decided: true },
        })
        .where(eq(s.awards.id, a.id));
      await writeAudit(tx, {
        eventId: p.eventId,
        actor: p.actor,
        action: 'award.decide_shared',
        target: a.boardKey,
        at: p.now,
      });
      resolved++;
    }
    return { resolved };
  });
}

/* ---------- tick core ---------- */

export type AutopilotTickOutcome =
  | {
      ran: false;
      reason: 'stale' | 'ahead' | 'not_running' | 'claimed' | 'noop' | 'frozen_held' | 'choice_hold';
    }
  | { ran: true; action: AutopilotAction['type']; state: AutopilotState; retry?: boolean };

/**
 * One `autopilot.tick` delivery (at-least-once). Steps: validate seq -> frozen? hold -> claim seq -> decide
 * (nextAction on a fresh snapshot) -> run the side effect -> commit (seq+1) + enqueue the next tick.
 * `execute` is only called for real effects (not wait / resync). If it throws an `EventError` (organizer raced us,
 * e.g. the gift was already opened manually) the claim is released and the tick is retried shortly with the same
 * seq (the engine re-reads the actual state). Any other error releases the claim and propagates (job retry/backoff).
 */
export async function runAutopilotTick(
  db: Db,
  p: { eventId: string; seq: number; now: Date; execute: AutopilotExecutor },
): Promise<AutopilotTickOutcome> {
  // 1. guard + frozen handling + claim, in one short transaction
  const pre = await db.transaction(async (tx) => {
    const st = await loadStateRow(tx, p.eventId, true);
    const chk = applyTick(st, p.seq);
    if (!chk.ok) return { stop: { ran: false, reason: chk.reason } as AutopilotTickOutcome };
    const [row] = await tx
      .select({ claimSeq: s.autopilotState.claimSeq, claimedAt: s.autopilotState.claimedAt })
      .from(s.autopilotState)
      .where(eq(s.autopilotState.eventId, p.eventId));
    const e = await loadEvent(tx, p.eventId);
    if (e.paused) {
      // event freeze: stop the timeline; the organizer resumes explicitly after unfreezing
      await persist(tx, p.eventId, holdState(st, p.now, { reason: 'frozen_held' }), p.now, null);
      return { stop: { ran: false, reason: 'frozen_held' } as AutopilotTickOutcome };
    }
    // Snowstorm vs Sleigh Bells: the open round, then its result (authoritative closedAt + window), own the
    // stage. Defer this SAME seq (no claim, no state change) so the timeline resumes unchanged afterwards; the
    // close is its own durable job, never swallowed. Services re-check under the event lock (choice_open).
    const holdUntil = await showChoiceHoldUntil(tx, p.eventId, p.now);
    if (holdUntil) {
      await cancelJobs(tx, p.eventId, [AUTOPILOT_TICK_JOB]);
      await enqueueTick(tx, p.eventId, st.seq, holdUntil);
      return { stop: { ran: false, reason: 'choice_hold' } as AutopilotTickOutcome };
    }
    const fresh =
      row?.claimSeq === st.seq &&
      row.claimedAt &&
      p.now.getTime() - row.claimedAt.getTime() < AUTOPILOT_CLAIM_TTL_MS;
    if (fresh) return { stop: { ran: false, reason: 'claimed' } as AutopilotTickOutcome };
    await tx
      .update(s.autopilotState)
      .set({ claimSeq: st.seq, claimedAt: p.now })
      .where(eq(s.autopilotState.eventId, p.eventId));
    return { state: st };
  });
  if ('stop' in pre) return pre.stop;
  const state = pre.state!;

  const release = (db2: Db) =>
    db2
      .update(s.autopilotState)
      .set({ claimSeq: null, claimedAt: null })
      .where(and(eq(s.autopilotState.eventId, p.eventId), eq(s.autopilotState.claimSeq, state.seq)));

  // 2. decide + 3. effect
  let action: AutopilotAction;
  try {
    action = nextAction(state, await buildAutopilotSnapshot(db, p.eventId), p.now);
    if (action.type === 'noop') {
      await release(db);
      return { ran: false, reason: 'noop' };
    }
    if (action.type !== 'wait' && action.type !== 'resync')
      await p.execute(action as AutopilotRunnableAction, { eventId: p.eventId, now: p.now });
  } catch (err) {
    await release(db);
    if (err instanceof EventError) {
      await enqueueTick(
        db,
        p.eventId,
        state.seq,
        new Date(p.now.getTime() + AUTOPILOT_POLL_SECONDS * 1000),
      );
      return { ran: true, action: 'wait', state, retry: true };
    }
    throw err;
  }

  // 4. commit + next tick (re-checked under lock: a hold/stop/skip meanwhile wins)
  return db.transaction(async (tx) => {
    const cur = await loadStateRow(tx, p.eventId, true);
    const c = commitAction(cur, action, p.now);
    if (!c.ok) {
      await release(tx);
      return { ran: false, reason: c.reason === 'noop' ? 'noop' : 'stale' } as AutopilotTickOutcome;
    }
    await persist(
      tx,
      p.eventId,
      c.state,
      p.now,
      c.state.status === 'running' && action.nextTickAt
        ? new Date(action.nextTickAt)
        : null,
    );
    return { ran: true, action: action.type, state: c.state };
  });
}

/** Test/ops helper: events whose autopilot is running without any pending tick (should never happen). */
export async function autopilotOrphans(db: Db): Promise<string[]> {
  const rows = await db
    .select({ eventId: s.autopilotState.eventId, state: s.autopilotState.state })
    .from(s.autopilotState);
  const out: string[] = [];
  for (const r of rows) {
    if (r.state.status !== 'running') continue;
    const [j] = await db
      .select({ id: s.scheduledJobs.id })
      .from(s.scheduledJobs)
      .where(
        and(
          eq(s.scheduledJobs.eventId, r.eventId),
          eq(s.scheduledJobs.kind, AUTOPILOT_TICK_JOB),
          eq(s.scheduledJobs.status, 'pending'),
        ),
      );
    if (!j) out.push(r.eventId);
  }
  return out;
}
