import {
  AUTOPILOT_STEPS,
  resolveAutopilotTimings,
  type AutopilotSettings,
  type AutopilotState,
  type AutopilotStep,
  type AutopilotTimings,
  type Phase,
} from '@santa/contracts';

/**
 * Show autopilot engine (ADR-0009, plan A). PURE: no IO, no clock, no randomness.
 *
 * Server loop per durable `autopilot.tick` job carrying `seq`:
 *   lock state row -> applyTick(state, job.seq) (reject stale/duplicate) -> nextAction(state, snapshot, now)
 *   -> execute the side effect (services, actor `system`) -> commitAction(state, action, now)
 *   -> persist + enqueue the next tick at `newState.stepEndsAt` with `newState.seq`.
 * Every state change bumps `seq`, so queued ticks of an older state become no-ops.
 * The actual event phase always wins: if the organizer moves the phase manually, nextAction emits `resync`.
 */

export type AutopilotTimelineItem = AutopilotState['timeline'][number];
export type AutopilotLogEntry = AutopilotState['log'][number];
export type AutopilotLogCode = AutopilotLogEntry['code'];
export type AutopilotTieBreak = 'shared' | 'secondary' | 'organizer';
export type CeremonyRunStatus = 'idle' | 'running' | 'paused' | 'done' | 'cancelled';

/** Polling interval while waiting on something outside the autopilot (ceremony job, organizer, phase). */
export const AUTOPILOT_POLL_SECONDS = 5;
/** Dwell per organizer-driven ceremony step (intro, category, winner, ...) = max(this, interludeSeconds). */
export const AUTOPILOT_CEREMONY_STEP_MIN_SECONDS = 8;
/** Ceremony length estimate when the script is not built yet. */
export const AUTOPILOT_DEFAULT_CEREMONY_STEPS = 10;
/** Keeps the stored log within the contract cap (oldest entries dropped). */
export const AUTOPILOT_LOG_CAP = 200;

export interface AutopilotCounts {
  /** Visible (non-hidden) gifts. */
  gifts: number;
  /** Visible gifts still `registered` (not opened). */
  unopenedGifts: number;
  /** Opened gifts whose giver is not revealed yet. */
  revealableGifts: number;
  /** Ceremony script length when known (0 = nothing to show -> awards skipped); default estimate otherwise. */
  ceremonySteps?: number;
  /** `settings.openingCountdownSeconds` (pre-reveal countdown per gift); default 0. */
  openingCountdownSeconds?: number;
}

export interface AutopilotFeatures {
  miniGames: boolean;
  auction: boolean;
}

/** Live event facts the engine decides on. Server builds it inside the tick transaction. */
export interface AutopilotSnapshot {
  phase: Phase;
  /** Event freeze. */
  paused: boolean;
  /** resolveAutopilotTimings(autopilotSettings(event.settings)). */
  timings: AutopilotTimings;
  tieBreak: AutopilotTieBreak;
  opening: {
    /** Visible gifts. */
    total: number;
    /** Visible gifts with status != registered. */
    opened: number;
    countdownSeconds: number;
  };
  voting: {
    /** Winners locked (events.votingClosedAt set by closeVoting). */
    closed: boolean;
    closedAt: string | null;
    /** Distinct voters below MIN_VOTERS_FLOOR: still closed, only logged (privacy gate hides boards). */
    belowFloor: boolean;
  };
  games: {
    /** gamesInShow(settings, features). */
    inShow: boolean;
    /** Mini-games feature on (autopilot starts one game); otherwise the step is a pure time box. */
    miniGames: boolean;
    /** A mini-game is on screen (intro/round_open/round_closed/results). */
    active: boolean;
    /** Mini-games already finished in this event. */
    played: number;
  };
  reveal: {
    /** Opened, giver not revealed. */
    revealable: number;
    revealed: number;
  };
  ceremony: {
    status: CeremonyRunStatus;
    index: number;
    /** Ceremony's own auto-advance deadline (countdown step), handled by the ceremony job. */
    stepEndsAt: string | null;
    /** autoAdvanceSeconds() of the step the next start/advance enters (script[0] when idle, script[index+1] when running). */
    upcomingAutoSeconds: number | null;
    /** ceremonyBlockers() contains nothing_to_show. */
    nothingToShow: boolean;
    /** Publishable tied awards without an organizer decision (tieBreak organizer). */
    pendingDecisions: number;
  };
}

interface ActionBase {
  /** state.seq the action was computed on; commitAction rejects it once the state moved on. */
  expectedSeq: number;
  /** Autopilot step after the action ran. */
  step: AutopilotStep;
  /** When to enqueue the next tick (and, except for `wait`, the new state.stepEndsAt); null only for `complete`. */
  nextTickAt: string | null;
  log: AutopilotLogEntry[];
}

export type AutopilotEffect =
  | { type: 'open_next_gift' }
  | { type: 'open_voting'; minutes: number }
  | { type: 'close_voting' }
  | { type: 'start_game' }
  | { type: 'end_game' }
  | { type: 'reveal_next_gift' }
  | { type: 'resolve_ties'; mode: 'shared' }
  | { type: 'start_ceremony' }
  | { type: 'advance_ceremony'; fromIndex: number }
  | { type: 'advance_phase'; from: Phase; to: Phase }
  | { type: 'complete' }
  /** Organizer moved the phase manually: adopt the actual phase, no side effect. */
  | { type: 'resync'; from: AutopilotStep | null }
  /** Nothing to do yet: re-tick at `untilAt` (no side effect). */
  | { type: 'wait'; untilAt: string; reason: AutopilotWaitReason };

export type AutopilotWaitReason =
  'step_timer' | 'ceremony_countdown' | 'ceremony_paused' | 'ceremony_cancelled' | 'outside_show';

export type AutopilotAction =
  | (ActionBase & AutopilotEffect)
  /** No tick should run: frozen (server holds with `frozen_held`) or autopilot not running. */
  | { type: 'noop'; reason: 'frozen' | 'not_running' };

export type AutopilotActionType = AutopilotAction['type'];

/* ---------- helpers ---------- */

const iso = (d: Date) => d.toISOString();
const plus = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);
const ms = (s: string) => new Date(s).getTime();
const stepIdx = (s: AutopilotStep) => AUTOPILOT_STEPS.indexOf(s);
const entry = (
  now: Date,
  code: AutopilotLogCode,
  params?: Record<string, number | boolean | string>,
): AutopilotLogEntry => (params ? { at: iso(now), code, params } : { at: iso(now), code });

/** Games step runs iff extras are included and at least one extra feature is on. */
export const gamesInShow = (
  settings: Pick<AutopilotSettings, 'includeExtras'>,
  f: AutopilotFeatures,
) => settings.includeExtras && (f.miniGames || f.auction);

export const ceremonyStepSeconds = (t: AutopilotTimings) =>
  Math.max(AUTOPILOT_CEREMONY_STEP_MIN_SECONDS, t.interludeSeconds);

/** Show step for an event phase; null before gift_opening (outside the show). */
export function stepForPhase(phase: Phase): AutopilotStep | null {
  switch (phase) {
    case 'gift_opening':
      return 'opening';
    case 'voting':
      return 'voting';
    case 'games':
      return 'games';
    case 'reveal':
      return 'reveal';
    case 'awards':
      return 'awards';
    case 'completed':
      return 'complete';
    default:
      return null;
  }
}

/** Seconds to wait after entering a step before its first sub-action (title card / time box). */
function entryDelaySeconds(step: AutopilotStep, snap: AutopilotSnapshot): number {
  const t = snap.timings;
  switch (step) {
    case 'voting':
      return t.votingMinutes * 60;
    case 'games':
      // pure time box when there is no mini-game to start (auction only)
      return snap.games.miniGames ? t.interludeSeconds : t.gamesMinutes * 60;
    case 'complete':
      return 0;
    default:
      return t.interludeSeconds;
  }
}

/* ---------- timeline ---------- */

export interface PlanOptions {
  /** Step the show is in (default `opening`): earlier steps are `done`, this one `active`. */
  from?: AutopilotStep;
}

/** Planned duration of each step (seconds) from timings and counts. */
export function plannedStepSeconds(
  step: AutopilotStep,
  t: AutopilotTimings,
  counts: AutopilotCounts,
  from: AutopilotStep = 'opening',
): number {
  switch (step) {
    case 'opening':
      return counts.unopenedGifts * ((counts.openingCountdownSeconds ?? 0) + t.openingGiftSeconds);
    case 'voting':
      return t.votingMinutes * 60;
    case 'games':
      return t.gamesMinutes * 60;
    case 'reveal':
      return revealCount(counts, from) * t.revealGiftSeconds;
    case 'awards':
      return (counts.ceremonySteps ?? AUTOPILOT_DEFAULT_CEREMONY_STEPS) * ceremonyStepSeconds(t);
    case 'complete':
      return 0;
  }
}

// Unopened gifts are only revealable if opening is still ahead.
const revealCount = (c: AutopilotCounts, from: AutopilotStep) =>
  c.revealableGifts + (from === 'opening' ? c.unopenedGifts : 0);

function plannedSkip(
  step: AutopilotStep,
  settings: AutopilotSettings,
  counts: AutopilotCounts,
  f: AutopilotFeatures,
  from: AutopilotStep,
): boolean {
  switch (step) {
    case 'opening':
      return counts.unopenedGifts === 0;
    case 'games':
      return !gamesInShow(settings, f);
    case 'reveal':
      return revealCount(counts, from) === 0;
    case 'awards':
      return counts.ceremonySteps === 0;
    default:
      return false;
  }
}

/**
 * Planned timeline. Steps before `from` are `done`; `from` is `active` (eta = estimated end) unless empty;
 * later steps are `pending` (eta = estimated start, one interlude between steps) or `skipped` (eta null).
 */
export function planTimeline(
  settings: AutopilotSettings,
  counts: AutopilotCounts,
  features: AutopilotFeatures,
  now: Date,
  opts: PlanOptions = {},
): AutopilotTimelineItem[] {
  const t = resolveAutopilotTimings(settings);
  const from = opts.from ?? 'opening';
  const fromIdx = stepIdx(from);
  let cursor = now.getTime();
  let first = true;
  return AUTOPILOT_STEPS.map((step, i): AutopilotTimelineItem => {
    const plannedSeconds = plannedStepSeconds(step, t, counts, from);
    if (i < fromIdx) return { step, plannedSeconds, eta: null, status: 'done' };
    if (plannedSkip(step, settings, counts, features, from))
      return { step, plannedSeconds, eta: null, status: 'skipped' };
    if (i === fromIdx) {
      first = false;
      cursor += plannedSeconds * 1000;
      return { step, plannedSeconds, eta: iso(new Date(cursor)), status: 'active' };
    }
    const start = cursor + (first ? 0 : t.interludeSeconds * 1000);
    first = false;
    cursor = start + plannedSeconds * 1000;
    return { step, plannedSeconds, eta: iso(new Date(start)), status: 'pending' };
  });
}

/** Moves the timeline to `to`: old active -> done, pending in between -> skipped, later active -> pending. */
function enterStep(
  timeline: AutopilotTimelineItem[],
  to: AutopilotStep,
  now: Date,
): AutopilotTimelineItem[] {
  const toIdx = stepIdx(to);
  return timeline.map((x) => {
    const i = stepIdx(x.step);
    if (i < toIdx) {
      if (x.status === 'active') return { ...x, status: 'done', eta: null };
      if (x.status === 'pending') return { ...x, status: 'skipped', eta: null };
      return x;
    }
    if (i === toIdx) return { ...x, status: 'active', eta: iso(plus(now, x.plannedSeconds)) };
    return x.status === 'active' ? { ...x, status: 'pending' } : x;
  });
}

/* ---------- state lifecycle ---------- */

export const idleAutopilotState = (): AutopilotState => ({
  status: 'idle',
  step: null,
  seq: 0,
  stepEndsAt: null,
  startedAt: null,
  heldAt: null,
  remainingMsAtHold: null,
  timeline: [],
  log: [],
});

const appendLog = (log: AutopilotLogEntry[], add: AutopilotLogEntry[]) => {
  const all = [...log, ...add];
  return all.length > AUTOPILOT_LOG_CAP ? all.slice(all.length - AUTOPILOT_LOG_CAP) : all;
};

/** "Start show" (server checks phase === gift_opening). First tick runs immediately (stepEndsAt = now). */
export function startState(p: {
  settings: AutopilotSettings;
  counts: AutopilotCounts;
  features: AutopilotFeatures;
  now: Date;
  prev?: AutopilotState;
}): AutopilotState {
  const prev = p.prev ?? idleAutopilotState();
  return {
    status: 'running',
    step: 'opening',
    seq: prev.seq + 1,
    stepEndsAt: iso(p.now),
    startedAt: iso(p.now),
    heldAt: null,
    remainingMsAtHold: null,
    timeline: planTimeline(p.settings, p.counts, p.features, p.now),
    log: appendLog(prev.log, [entry(p.now, 'started')]),
  };
}

/** Hold the timeline (participants keep voting/reacting). No-op unless running. */
export function holdState(
  state: AutopilotState,
  now: Date,
  opts: { reason?: 'held' | 'frozen_held' } = {},
): AutopilotState {
  if (state.status !== 'running') return state;
  const remaining = state.stepEndsAt ? Math.max(0, ms(state.stepEndsAt) - now.getTime()) : 0;
  return {
    ...state,
    status: 'held',
    seq: state.seq + 1,
    stepEndsAt: null,
    heldAt: iso(now),
    remainingMsAtHold: remaining,
    log: appendLog(state.log, [entry(now, opts.reason ?? 'held')]),
  };
}

/** Resume: stepEndsAt = now + remainingMsAtHold; pending/active ETAs shift by the hold duration. */
export function resumeState(state: AutopilotState, now: Date): AutopilotState {
  if (state.status !== 'held') return state;
  const heldMs = state.heldAt ? Math.max(0, now.getTime() - ms(state.heldAt)) : 0;
  const remaining = state.remainingMsAtHold ?? 0;
  return {
    ...state,
    status: 'running',
    seq: state.seq + 1,
    stepEndsAt: iso(new Date(now.getTime() + remaining)),
    heldAt: null,
    remainingMsAtHold: null,
    timeline: state.timeline.map((x) =>
      x.eta && (x.status === 'active' || x.status === 'pending')
        ? { ...x, eta: iso(new Date(ms(x.eta) + heldMs)) }
        : x,
    ),
    log: appendLog(state.log, [entry(now, 'resumed')]),
  };
}

/** Stop: back to idle (show continues manually). */
export function stopState(state: AutopilotState, now: Date): AutopilotState {
  if (state.status !== 'running' && state.status !== 'held') return state;
  return {
    ...state,
    status: 'idle',
    seq: state.seq + 1,
    stepEndsAt: null,
    heldAt: null,
    remainingMsAtHold: null,
    log: appendLog(state.log, [entry(now, 'stopped')]),
  };
}

/**
 * "Skip step": ends the current wait now. Irreversibility is kept because the next action is still
 * computed by nextAction (e.g. voting is closed before leaving it). Running only.
 */
export function skipStepState(state: AutopilotState, now: Date): AutopilotState {
  if (state.status !== 'running' || !state.step) return state;
  return {
    ...state,
    seq: state.seq + 1,
    stepEndsAt: iso(now),
    log: appendLog(state.log, [entry(now, 'step_skipped', { step: state.step })]),
  };
}

export type TickCheck = { ok: true } | { ok: false; reason: 'stale' | 'ahead' | 'not_running' };

/** Tick guard: only the tick carrying the current seq of a running autopilot may act. */
export function applyTick(state: AutopilotState, seq: number): TickCheck {
  if (state.status !== 'running') return { ok: false, reason: 'not_running' };
  if (seq < state.seq) return { ok: false, reason: 'stale' };
  if (seq > state.seq) return { ok: false, reason: 'ahead' };
  return { ok: true };
}

export type CommitResult =
  { ok: true; state: AutopilotState } | { ok: false; reason: 'stale' | 'not_running' | 'noop' };

/** Applies a (successfully executed) action: seq+1, step/timeline/log, next deadline. */
export function commitAction(
  state: AutopilotState,
  action: AutopilotAction,
  now: Date,
): CommitResult {
  if (action.type === 'noop') return { ok: false, reason: 'noop' };
  if (state.status !== 'running') return { ok: false, reason: 'not_running' };
  if (action.expectedSeq !== state.seq) return { ok: false, reason: 'stale' };
  const done = action.type === 'complete';
  let timeline: AutopilotTimelineItem[];
  if (done) {
    timeline = state.timeline.map((x) =>
      x.status === 'active' || (x.status === 'pending' && x.step === 'complete')
        ? { ...x, status: 'done', eta: null }
        : x.status === 'pending'
          ? { ...x, status: 'skipped', eta: null }
          : x,
    );
  } else {
    timeline =
      action.step !== state.step ? enterStep(state.timeline, action.step, now) : state.timeline;
    if (action.nextTickAt && action.type !== 'wait') {
      // a sub-action running past the planned end pushes the active ETA
      timeline = timeline.map((x) =>
        x.status === 'active' && (!x.eta || ms(x.eta) < ms(action.nextTickAt!))
          ? { ...x, eta: action.nextTickAt }
          : x,
      );
    }
    timeline = shiftPending(state.timeline, timeline);
  }
  return {
    ok: true,
    state: {
      ...state,
      status: done ? 'done' : 'running',
      step: action.step,
      seq: state.seq + 1,
      // a wait keeps the step gate; every other action sets it to its next deadline
      stepEndsAt: done ? null : action.type === 'wait' ? state.stepEndsAt : action.nextTickAt,
      timeline,
      log: appendLog(state.log, action.log),
    },
  };
}

/**
 * Keeps the planned gaps between pending steps: they move by how much the active step's end moved
 * (old end = old active eta, or old pending start + planned duration when the step was just entered).
 */
function shiftPending(
  before: AutopilotTimelineItem[],
  after: AutopilotTimelineItem[],
): AutopilotTimelineItem[] {
  const act = after.find((x) => x.status === 'active');
  if (!act?.eta) return after;
  const old = before.find((x) => x.step === act.step);
  let oldEnd: number | null = null;
  if (old?.eta && old.status === 'active') oldEnd = ms(old.eta);
  else if (old?.eta && old.status === 'pending') oldEnd = ms(old.eta) + old.plannedSeconds * 1000;
  const firstPending = after.find((x) => x.status === 'pending' && x.eta);
  if (oldEnd === null) {
    // entered a step that had no plan (e.g. manual override into a skipped step): next starts at its end
    if (!firstPending?.eta) return after;
    oldEnd = ms(firstPending.eta);
  }
  const delta = ms(act.eta) - oldEnd;
  if (delta === 0) return after;
  return after.map((x) =>
    x.status === 'pending' && x.eta ? { ...x, eta: iso(new Date(ms(x.eta) + delta)) } : x,
  );
}

/* ---------- decision ---------- */

/**
 * Next autopilot action for the actual event state. Pure; `expectedSeq` = state.seq.
 * - not running -> noop(not_running); frozen -> noop(frozen) (server holds with `frozen_held`)
 * - actual phase != state.step -> resync (organizer override wins)
 * - otherwise the step logic below, gated by state.stepEndsAt.
 */
export function nextAction(
  state: AutopilotState,
  snap: AutopilotSnapshot,
  now: Date,
): AutopilotAction {
  if (state.status !== 'running') return { type: 'noop', reason: 'not_running' };
  if (snap.paused) return { type: 'noop', reason: 'frozen' };
  const t = snap.timings;
  const seq = state.seq;
  const cur = stepForPhase(snap.phase);
  const keep = state.step ?? 'opening';

  const wait = (untilAt: Date | string, reason: AutopilotWaitReason): AutopilotAction => ({
    type: 'wait',
    untilAt: typeof untilAt === 'string' ? untilAt : iso(untilAt),
    reason,
    expectedSeq: seq,
    step: cur ?? keep,
    nextTickAt: typeof untilAt === 'string' ? untilAt : iso(untilAt),
    log: [],
  });
  const poll = (reason: AutopilotWaitReason) => wait(plus(now, AUTOPILOT_POLL_SECONDS), reason);

  if (!cur) return poll('outside_show');

  if (cur !== state.step) {
    return {
      type: 'resync',
      from: state.step,
      expectedSeq: seq,
      step: cur,
      nextTickAt: iso(plus(now, entryDelaySeconds(cur, snap))),
      log: [
        entry(now, 'manual_override_resync', {
          ...(state.step ? { from: state.step } : {}),
          to: cur,
        }),
      ],
    };
  }

  const gate = state.stepEndsAt;
  const due = gate === null || now.getTime() >= ms(gate);
  const act = (
    effect: Exclude<AutopilotEffect, { type: 'wait' | 'resync' }>,
    step: AutopilotStep,
    afterSeconds: number,
    log: AutopilotLogEntry[] = [],
  ): AutopilotAction => ({
    ...effect,
    expectedSeq: seq,
    step,
    nextTickAt: iso(plus(now, afterSeconds)),
    log,
  });
  const advance = (to: Phase, log: AutopilotLogEntry[] = []): AutopilotAction => {
    const step = stepForPhase(to)!;
    return act(
      { type: 'advance_phase', from: snap.phase, to },
      step,
      entryDelaySeconds(step, snap),
      [...log, entry(now, 'step_started', { step })],
    );
  };

  switch (cur) {
    case 'opening': {
      if (!due) return wait(gate!, 'step_timer');
      const unopened = snap.opening.total - snap.opening.opened;
      if (unopened > 0)
        return act(
          { type: 'open_next_gift' },
          'opening',
          snap.opening.countdownSeconds + t.openingGiftSeconds,
        );
      const log: AutopilotLogEntry[] = [];
      if (snap.opening.opened === 0)
        log.push(entry(now, 'step_empty_skipped', { step: 'opening' }));
      log.push(entry(now, 'step_started', { step: 'voting' }));
      return act(
        { type: 'open_voting', minutes: t.votingMinutes },
        'voting',
        t.votingMinutes * 60,
        log,
      );
    }

    case 'voting': {
      if (!snap.voting.closed) {
        if (!due) return wait(gate!, 'step_timer');
        return act(
          { type: 'close_voting' },
          'voting',
          t.interludeSeconds,
          snap.voting.belowFloor ? [entry(now, 'voting_below_floor')] : [],
        );
      }
      // closed by us or early by the organizer: one interlude after closing, then move on
      const readyAt = snap.voting.closedAt
        ? ms(snap.voting.closedAt) + t.interludeSeconds * 1000
        : now.getTime();
      if (now.getTime() < readyAt) return wait(new Date(readyAt), 'step_timer');
      if (snap.games.inShow) return advance('games');
      return advance('reveal', [entry(now, 'step_skipped', { step: 'games' })]);
    }

    case 'games': {
      if (!snap.games.inShow) {
        if (snap.games.active) {
          if (!due) return wait(gate!, 'step_timer');
          return act({ type: 'end_game' }, 'games', t.interludeSeconds);
        }
        return advance('reveal', [entry(now, 'step_empty_skipped', { step: 'games' })]);
      }
      if (snap.games.active) {
        if (!due) return wait(gate!, 'step_timer');
        return act({ type: 'end_game' }, 'games', t.interludeSeconds);
      }
      // game finished early (or by organizer): move on without waiting for the time box
      if (snap.games.played > 0) return advance('reveal');
      if (!due) return wait(gate!, 'step_timer');
      if (snap.games.miniGames) return act({ type: 'start_game' }, 'games', t.gamesMinutes * 60);
      return advance('reveal'); // auction-only time box elapsed
    }

    case 'reveal': {
      if (!due) return wait(gate!, 'step_timer');
      if (snap.reveal.revealable > 0)
        return act({ type: 'reveal_next_gift' }, 'reveal', t.revealGiftSeconds);
      return advance(
        'awards',
        snap.reveal.revealed === 0 ? [entry(now, 'step_empty_skipped', { step: 'reveal' })] : [],
      );
    }

    case 'awards': {
      const c = snap.ceremony;
      const dwell = ceremonyStepSeconds(t);
      switch (c.status) {
        case 'done':
          if (!due) return wait(gate!, 'step_timer');
          return advance('completed');
        case 'paused':
          return poll('ceremony_paused');
        case 'cancelled':
          return poll('ceremony_cancelled');
        case 'running': {
          if (c.stepEndsAt) {
            const end = ms(c.stepEndsAt);
            return end > now.getTime()
              ? wait(c.stepEndsAt, 'ceremony_countdown')
              : poll('ceremony_countdown');
          }
          if (!due) return wait(gate!, 'step_timer');
          return act(
            { type: 'advance_ceremony', fromIndex: c.index },
            'awards',
            (c.upcomingAutoSeconds ?? 0) + dwell,
          );
        }
        case 'idle': {
          if (!due) return wait(gate!, 'step_timer');
          if (c.nothingToShow)
            return advance('completed', [entry(now, 'step_empty_skipped', { step: 'awards' })]);
          if (c.pendingDecisions > 0 && snap.tieBreak === 'organizer')
            return act({ type: 'resolve_ties', mode: 'shared' }, 'awards', 0, [
              entry(now, 'tie_shared', { count: c.pendingDecisions }),
            ]);
          return act({ type: 'start_ceremony' }, 'awards', (c.upcomingAutoSeconds ?? 0) + dwell);
        }
      }
      return poll('ceremony_paused');
    }

    case 'complete':
      return {
        type: 'complete',
        expectedSeq: seq,
        step: 'complete',
        nextTickAt: null,
        log: [entry(now, 'completed')],
      };
  }
}
