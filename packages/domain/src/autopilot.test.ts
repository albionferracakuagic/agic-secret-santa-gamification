import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_PRESETS,
  AutopilotStateSchema,
  PHASES,
  resolveAutopilotTimings,
  type AutopilotSettings,
  type AutopilotState,
  type Phase,
} from '@santa/contracts';
import {
  applyTick,
  commitAction,
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
  type AutopilotSnapshot,
} from './autopilot.js';
import { transition, type Milestones } from './phases.js';

const T0 = new Date('2026-12-24T18:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const iso = (s: number) => at(s).toISOString();
const settings = (over: Partial<AutopilotSettings> = {}): AutopilotSettings => ({
  preset: 'standard',
  includeExtras: true,
  ...over,
});
const STD = resolveAutopilotTimings(settings());
const counts = (over: Partial<AutopilotCounts> = {}): AutopilotCounts => ({
  gifts: 3,
  unopenedGifts: 3,
  revealableGifts: 0,
  ...over,
});
const FEAT = { miniGames: true, auction: false };

type SnapOver = Partial<
  Omit<AutopilotSnapshot, 'opening' | 'voting' | 'games' | 'reveal' | 'ceremony'>
> & {
  opening?: Partial<AutopilotSnapshot['opening']>;
  voting?: Partial<AutopilotSnapshot['voting']>;
  games?: Partial<AutopilotSnapshot['games']>;
  reveal?: Partial<AutopilotSnapshot['reveal']>;
  ceremony?: Partial<AutopilotSnapshot['ceremony']>;
};
const snap = (o: SnapOver = {}): AutopilotSnapshot => ({
  phase: o.phase ?? 'gift_opening',
  paused: o.paused ?? false,
  timings: o.timings ?? STD,
  tieBreak: o.tieBreak ?? 'shared',
  opening: { total: 3, opened: 0, countdownSeconds: 0, ...o.opening },
  voting: { closed: false, closedAt: null, belowFloor: false, ...o.voting },
  games: { inShow: true, miniGames: true, active: false, played: 0, ...o.games },
  reveal: { revealable: 0, revealed: 0, ...o.reveal },
  ceremony: {
    status: 'idle',
    index: 0,
    stepEndsAt: null,
    upcomingAutoSeconds: null,
    nothingToShow: false,
    pendingDecisions: 0,
    ...o.ceremony,
  },
});
const running = (over: Partial<AutopilotState> = {}): AutopilotState => ({
  ...startState({ settings: settings(), counts: counts(), features: FEAT, now: T0 }),
  ...over,
});

describe('planTimeline', () => {
  it.each(['quick', 'standard', 'relaxed'] as const)('plans every step for preset %s', (preset) => {
    const p = AUTOPILOT_PRESETS[preset];
    const tl = planTimeline(settings({ preset }), counts({ ceremonySteps: 6 }), FEAT, T0);
    const ceremonyStep = Math.max(8, p.interludeSeconds);
    expect(tl.map((x) => [x.step, x.status, x.plannedSeconds])).toEqual([
      ['opening', 'active', 3 * p.openingGiftSeconds],
      ['voting', 'pending', p.votingMinutes * 60],
      ['games', 'pending', p.gamesMinutes * 60],
      ['reveal', 'pending', 3 * p.revealGiftSeconds],
      ['awards', 'pending', 6 * ceremonyStep],
      ['complete', 'pending', 0],
    ]);
    // active eta = end; pending eta = start, one interlude between steps
    let end = 3 * p.openingGiftSeconds;
    expect(tl[0]!.eta).toBe(iso(end));
    for (const item of tl.slice(1)) {
      const start = end + p.interludeSeconds;
      expect(item.eta).toBe(iso(start));
      end = start + item.plannedSeconds;
    }
    expect(tl.every((x) => AutopilotStateSchema.shape.timeline.element.safeParse(x).success)).toBe(
      true,
    );
  });

  it('overrides win over the preset', () => {
    const tl = planTimeline(
      settings({ votingMinutes: 7, openingGiftSeconds: 11 }),
      counts(),
      FEAT,
      T0,
    );
    expect(tl.find((x) => x.step === 'voting')!.plannedSeconds).toBe(420);
    expect(tl.find((x) => x.step === 'opening')!.plannedSeconds).toBe(33);
  });

  it('adds the opening countdown per gift', () => {
    const tl = planTimeline(settings(), counts({ openingCountdownSeconds: 5 }), FEAT, T0);
    expect(tl[0]!.plannedSeconds).toBe(3 * (5 + STD.openingGiftSeconds));
  });

  it('skips opening and reveal with 0 gifts', () => {
    const tl = planTimeline(settings(), counts({ gifts: 0, unopenedGifts: 0 }), FEAT, T0);
    expect(tl.find((x) => x.step === 'opening')).toMatchObject({ status: 'skipped', eta: null });
    expect(tl.find((x) => x.step === 'reveal')).toMatchObject({ status: 'skipped', eta: null });
    // first live step starts right away (no interlude before it)
    expect(tl.find((x) => x.step === 'voting')).toMatchObject({ status: 'pending', eta: iso(0) });
  });

  it.each([
    ['includeExtras false', settings({ includeExtras: false }), FEAT],
    ['all extras off', settings(), { miniGames: false, auction: false }],
  ])('skips games when %s', (_n, s, f) => {
    const tl = planTimeline(s, counts(), f, T0);
    expect(tl.find((x) => x.step === 'games')!.status).toBe('skipped');
  });

  it('keeps games for auction-only extras', () => {
    const tl = planTimeline(settings(), counts(), { miniGames: false, auction: true }, T0);
    expect(tl.find((x) => x.step === 'games')!.status).toBe('pending');
  });

  it('skips awards when the ceremony has nothing to show', () => {
    const tl = planTimeline(settings(), counts({ ceremonySteps: 0 }), FEAT, T0);
    expect(tl.find((x) => x.step === 'awards')!.status).toBe('skipped');
  });

  it('re-plans from a later step: earlier steps done, unopened gifts no longer count for reveal', () => {
    const tl = planTimeline(
      settings(),
      counts({ unopenedGifts: 2, revealableGifts: 1 }),
      FEAT,
      T0,
      {
        from: 'reveal',
      },
    );
    expect(tl.map((x) => x.status)).toEqual([
      'done',
      'done',
      'done',
      'active',
      'pending',
      'pending',
    ]);
    expect(tl[3]!.plannedSeconds).toBe(STD.revealGiftSeconds);
  });
});

describe('state lifecycle', () => {
  it('start: running at opening, acts now, valid contract state', () => {
    const s = startState({ settings: settings(), counts: counts(), features: FEAT, now: T0 });
    expect(s).toMatchObject({ status: 'running', step: 'opening', seq: 1, stepEndsAt: iso(0) });
    expect(s.log.map((l) => l.code)).toEqual(['started']);
    expect(AutopilotStateSchema.parse(s)).toEqual(s);
  });

  it('hold stores remaining time; resume re-plans stepEndsAt and shifts ETAs', () => {
    const s = running({ stepEndsAt: iso(100) });
    const h = holdState(s, at(30));
    expect(h).toMatchObject({
      status: 'held',
      heldAt: iso(30),
      remainingMsAtHold: 70_000,
      stepEndsAt: null,
      seq: s.seq + 1,
    });
    expect(holdState(h, at(40))).toBe(h); // idempotent
    const r = resumeState(h, at(330));
    expect(r).toMatchObject({
      status: 'running',
      stepEndsAt: iso(400),
      heldAt: null,
      remainingMsAtHold: null,
      seq: s.seq + 2,
    });
    // every active/pending eta moved by the 300 s hold
    s.timeline.forEach((x, i) => {
      const y = r.timeline[i]!;
      if (x.eta) expect(new Date(y.eta!).getTime() - new Date(x.eta).getTime()).toBe(300_000);
    });
    expect(r.log.map((l) => l.code)).toEqual(['started', 'held', 'resumed']);
    expect(resumeState(r, at(500))).toBe(r);
    expect(AutopilotStateSchema.parse(r)).toEqual(r);
  });

  it('hold past the deadline keeps 0 ms; freeze reason is logged', () => {
    const h = holdState(running({ stepEndsAt: iso(10) }), at(50), { reason: 'frozen_held' });
    expect(h.remainingMsAtHold).toBe(0);
    expect(h.log.at(-1)!.code).toBe('frozen_held');
    expect(resumeState(h, at(90)).stepEndsAt).toBe(iso(90));
  });

  it('stop -> idle; skip ends the current wait now', () => {
    const s = running({ stepEndsAt: iso(100) });
    const k = skipStepState(s, at(5));
    expect(k).toMatchObject({ stepEndsAt: iso(5), seq: s.seq + 1 });
    expect(k.log.at(-1)).toMatchObject({ code: 'step_skipped', params: { step: 'opening' } });
    expect(stopState(k, at(6))).toMatchObject({ status: 'idle', seq: s.seq + 2, stepEndsAt: null });
    expect(stopState(idleAutopilotState(), at(6))).toEqual(idleAutopilotState());
  });

  it('log is capped at 200 entries', () => {
    let s = running();
    for (let i = 0; i < 150; i++) s = resumeState(holdState(s, at(i)), at(i));
    expect(s.log).toHaveLength(200);
    expect(AutopilotStateSchema.safeParse(s).success).toBe(true);
  });
});

describe('idempotency', () => {
  it('applyTick accepts only the current seq of a running autopilot', () => {
    const s = running({ seq: 5 });
    expect(applyTick(s, 5)).toEqual({ ok: true });
    expect(applyTick(s, 4)).toEqual({ ok: false, reason: 'stale' });
    expect(applyTick(s, 6)).toEqual({ ok: false, reason: 'ahead' });
    expect(applyTick(holdState(s, T0), 6)).toEqual({ ok: false, reason: 'not_running' });
  });

  it('a duplicate delivery of the same action is rejected after the first commit', () => {
    const s = running();
    const a = nextAction(s, snap(), T0);
    expect(a.type).toBe('open_next_gift');
    const c1 = commitAction(s, a, T0);
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    expect(applyTick(c1.state, s.seq)).toEqual({ ok: false, reason: 'stale' });
    expect(commitAction(c1.state, a, T0)).toEqual({ ok: false, reason: 'stale' });
  });

  it('hold invalidates queued ticks', () => {
    const s = running();
    const a = nextAction(s, snap(), T0);
    const r = resumeState(holdState(s, T0), T0);
    expect(applyTick(r, s.seq).ok).toBe(false);
    expect(commitAction(r, a, T0)).toEqual({ ok: false, reason: 'stale' });
  });
});

describe('nextAction', () => {
  it('freeze -> noop(frozen); not running -> noop', () => {
    expect(nextAction(running(), snap({ paused: true }), T0)).toEqual({
      type: 'noop',
      reason: 'frozen',
    });
    expect(nextAction(holdState(running(), T0), snap(), T0)).toEqual({
      type: 'noop',
      reason: 'not_running',
    });
    expect(nextAction(idleAutopilotState(), snap(), T0).type).toBe('noop');
    expect(commitAction(running(), { type: 'noop', reason: 'frozen' }, T0)).toEqual({
      ok: false,
      reason: 'noop',
    });
  });

  const t = STD;
  const due = (step: AutopilotState['step'], stepEndsAt: string | null = iso(0)) =>
    running({ step, stepEndsAt });
  type Row = [string, AutopilotState, SnapOver, Partial<AutopilotAction> & { type: string }];
  const rows: Row[] = [
    // opening
    [
      'opening: opens next gift',
      due('opening'),
      {},
      { type: 'open_next_gift', step: 'opening', nextTickAt: iso(t.openingGiftSeconds) },
    ],
    [
      'opening: dwell includes countdown',
      due('opening'),
      { opening: { countdownSeconds: 5 } },
      { type: 'open_next_gift', nextTickAt: iso(5 + t.openingGiftSeconds) },
    ],
    [
      'opening: waits for the gift dwell',
      due('opening', iso(30)),
      {},
      { type: 'wait', untilAt: iso(30) },
    ],
    [
      'opening: all opened -> open voting',
      due('opening'),
      { opening: { opened: 3 } },
      {
        type: 'open_voting',
        minutes: t.votingMinutes,
        step: 'voting',
        nextTickAt: iso(t.votingMinutes * 60),
      },
    ],
    [
      'opening: 0 gifts -> voting (empty logged)',
      due('opening'),
      { opening: { total: 0, opened: 0 } },
      { type: 'open_voting' },
    ],
    // voting
    [
      'voting: waits for the timer',
      due('voting', iso(60)),
      { phase: 'voting' },
      { type: 'wait', untilAt: iso(60) },
    ],
    [
      'voting: timer over -> close',
      due('voting'),
      { phase: 'voting' },
      { type: 'close_voting', step: 'voting', nextTickAt: iso(t.interludeSeconds) },
    ],
    [
      'voting: closed -> waits one interlude',
      due('voting'),
      { phase: 'voting', voting: { closed: true, closedAt: iso(-2) } },
      { type: 'wait', untilAt: iso(t.interludeSeconds - 2) },
    ],
    [
      'voting: closed -> games',
      due('voting'),
      { phase: 'voting', voting: { closed: true, closedAt: iso(-60) } },
      { type: 'advance_phase', from: 'voting', to: 'games', step: 'games' },
    ],
    [
      'voting: closed early by organizer -> no full timer wait',
      due('voting', iso(250)),
      { phase: 'voting', voting: { closed: true, closedAt: iso(-60) } },
      { type: 'advance_phase', to: 'games' },
    ],
    [
      'voting: games off -> reveal',
      due('voting'),
      { phase: 'voting', voting: { closed: true, closedAt: iso(-60) }, games: { inShow: false } },
      { type: 'advance_phase', from: 'voting', to: 'reveal', step: 'reveal' },
    ],
    // games
    [
      'games: title card wait',
      due('games', iso(10)),
      { phase: 'games' },
      { type: 'wait', untilAt: iso(10) },
    ],
    [
      'games: starts a mini-game',
      due('games'),
      { phase: 'games' },
      { type: 'start_game', nextTickAt: iso(t.gamesMinutes * 60) },
    ],
    [
      'games: running game waits for time box',
      due('games', iso(90)),
      { phase: 'games', games: { active: true } },
      { type: 'wait', untilAt: iso(90) },
    ],
    [
      'games: time box over -> end game',
      due('games'),
      { phase: 'games', games: { active: true } },
      { type: 'end_game' },
    ],
    [
      'games: finished early -> reveal',
      due('games', iso(400)),
      { phase: 'games', games: { played: 1 } },
      { type: 'advance_phase', from: 'games', to: 'reveal' },
    ],
    [
      'games: auction-only box over -> reveal',
      due('games'),
      { phase: 'games', games: { miniGames: false } },
      { type: 'advance_phase', to: 'reveal' },
    ],
    [
      'games: not in show (manual) -> reveal',
      due('games', iso(400)),
      { phase: 'games', games: { inShow: false } },
      { type: 'advance_phase', to: 'reveal' },
    ],
    // reveal
    [
      'reveal: reveals next gift',
      due('reveal'),
      { phase: 'reveal', reveal: { revealable: 2 } },
      { type: 'reveal_next_gift', nextTickAt: iso(t.revealGiftSeconds) },
    ],
    [
      'reveal: waits between gifts',
      due('reveal', iso(12)),
      { phase: 'reveal', reveal: { revealable: 2 } },
      { type: 'wait', untilAt: iso(12) },
    ],
    [
      'reveal: all revealed -> awards',
      due('reveal'),
      { phase: 'reveal', reveal: { revealed: 3 } },
      { type: 'advance_phase', from: 'reveal', to: 'awards', step: 'awards' },
    ],
    // awards
    [
      'awards: starts ceremony',
      due('awards'),
      { phase: 'awards' },
      { type: 'start_ceremony', nextTickAt: iso(Math.max(8, t.interludeSeconds)) },
    ],
    [
      'awards: organizer tie -> shared',
      due('awards'),
      { phase: 'awards', tieBreak: 'organizer', ceremony: { pendingDecisions: 2 } },
      { type: 'resolve_ties', mode: 'shared' },
    ],
    [
      'awards: nothing to show -> completed',
      due('awards'),
      { phase: 'awards', ceremony: { nothingToShow: true } },
      { type: 'advance_phase', from: 'awards', to: 'completed', step: 'complete' },
    ],
    [
      'awards: advances a manual ceremony step',
      due('awards'),
      { phase: 'awards', ceremony: { status: 'running', index: 3, upcomingAutoSeconds: 5 } },
      {
        type: 'advance_ceremony',
        fromIndex: 3,
        nextTickAt: iso(5 + Math.max(8, t.interludeSeconds)),
      },
    ],
    [
      'awards: countdown runs on its own',
      due('awards'),
      { phase: 'awards', ceremony: { status: 'running', stepEndsAt: iso(4) } },
      { type: 'wait', untilAt: iso(4), reason: 'ceremony_countdown' },
    ],
    [
      'awards: overdue countdown polls',
      due('awards'),
      { phase: 'awards', ceremony: { status: 'running', stepEndsAt: iso(-1) } },
      { type: 'wait', untilAt: iso(5) },
    ],
    [
      'awards: organizer paused ceremony is respected',
      due('awards'),
      { phase: 'awards', ceremony: { status: 'paused' } },
      { type: 'wait', reason: 'ceremony_paused' },
    ],
    [
      'awards: ceremony done -> completed',
      due('awards'),
      { phase: 'awards', ceremony: { status: 'done' } },
      { type: 'advance_phase', to: 'completed' },
    ],
    // complete
    [
      'complete: completes',
      due('complete'),
      { phase: 'completed' },
      { type: 'complete', nextTickAt: null },
    ],
    // resync / outside
    [
      'manual override: follows actual phase',
      due('opening', iso(300)),
      { phase: 'reveal' },
      { type: 'resync', from: 'opening', step: 'reveal', nextTickAt: iso(t.interludeSeconds) },
    ],
    [
      'manual override into voting: fresh voting window',
      due('opening'),
      { phase: 'voting' },
      { type: 'resync', step: 'voting', nextTickAt: iso(t.votingMinutes * 60) },
    ],
    [
      'back before the show: polls',
      due('opening'),
      { phase: 'gift_registration' },
      { type: 'wait', reason: 'outside_show', untilAt: iso(5) },
    ],
  ];
  it.each(rows)('%s', (_name, state, over, expected) => {
    const a = nextAction(state, snap(over), T0);
    expect(a).toMatchObject(expected);
    if (a.type !== 'noop') expect(a.expectedSeq).toBe(state.seq);
  });

  it('logs auto-resolve rules with contract-valid entries', () => {
    const codes = (s: AutopilotState, o: SnapOver) => {
      const a = nextAction(s, snap(o), T0);
      return a.type === 'noop' ? [] : a.log.map((l) => [l.code, l.params]);
    };
    expect(
      codes(due('awards'), {
        phase: 'awards',
        tieBreak: 'organizer',
        ceremony: { pendingDecisions: 2 },
      }),
    ).toEqual([['tie_shared', { count: 2 }]]);
    expect(codes(due('voting'), { phase: 'voting', voting: { belowFloor: true } })).toEqual([
      ['voting_below_floor', undefined],
    ]);
    expect(codes(due('opening'), { opening: { total: 0 } })).toEqual([
      ['step_empty_skipped', { step: 'opening' }],
      ['step_started', { step: 'voting' }],
    ]);
    expect(
      codes(due('voting'), {
        phase: 'voting',
        voting: { closed: true, closedAt: iso(-60) },
        games: { inShow: false },
      }),
    ).toEqual([
      ['step_skipped', { step: 'games' }],
      ['step_started', { step: 'reveal' }],
    ]);
    expect(codes(due('reveal'), { phase: 'reveal' })[0]).toEqual([
      'step_empty_skipped',
      { step: 'reveal' },
    ]);
    expect(codes(due('awards'), { phase: 'awards', ceremony: { nothingToShow: true } })[0]).toEqual(
      ['step_empty_skipped', { step: 'awards' }],
    );
    expect(codes(due('opening'), { phase: 'reveal' })).toEqual([
      ['manual_override_resync', { from: 'opening', to: 'reveal' }],
    ]);
    // non-organizer tie break never triggers the auto-resolve
    expect(
      nextAction(due('awards'), snap({ phase: 'awards', ceremony: { pendingDecisions: 1 } }), T0)
        .type,
    ).toBe('start_ceremony');
  });

  it('commit moves the timeline and keeps the state contract-valid', () => {
    const s = running({ stepEndsAt: iso(0) });
    const a = nextAction(s, snap({ opening: { opened: 3 } }), at(200));
    const c = commitAction(s, a, at(200));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.state.step).toBe('voting');
    expect(c.state.timeline.map((x) => x.status)).toEqual([
      'done',
      'active',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    const v = c.state.timeline[1]!;
    expect(v.eta).toBe(iso(200 + STD.votingMinutes * 60));
    // pending steps keep their planned gaps behind the active step
    expect(c.state.timeline[2]!.eta).toBe(iso(200 + STD.votingMinutes * 60 + STD.interludeSeconds));
    expect(AutopilotStateSchema.parse(c.state)).toEqual(c.state);
  });

  it('a wait keeps the step gate', () => {
    const s = running({ stepEndsAt: iso(30) });
    const a = nextAction(s, snap(), T0);
    expect(a.type).toBe('wait');
    const c = commitAction(s, a, T0);
    expect(c.ok && c.state.stepEndsAt).toBe(iso(30));
  });
});

/* ---------- property: simulated show ---------- */

interface World {
  phase: Phase;
  paused: boolean;
  milestones: Milestones;
  total: number;
  opened: number;
  revealed: number;
  votingClosedAt: number | null;
  gameActive: boolean;
  gameEndsAt: number;
  gameLen: number;
  played: number;
  inShow: boolean;
  miniGames: boolean;
  tieBreak: 'shared' | 'organizer';
  pending: number;
  script: Array<number | null>;
  cer: { status: 'idle' | 'running' | 'done'; index: number; endsAt: number | null };
}

const snapOf = (w: World): AutopilotSnapshot => ({
  phase: w.phase,
  paused: w.paused,
  timings: STD,
  tieBreak: w.tieBreak,
  opening: { total: w.total, opened: w.opened, countdownSeconds: 3 },
  voting: {
    closed: w.votingClosedAt !== null,
    closedAt: w.votingClosedAt === null ? null : new Date(w.votingClosedAt).toISOString(),
    belowFloor: w.total < 5,
  },
  games: { inShow: w.inShow, miniGames: w.miniGames, active: w.gameActive, played: w.played },
  reveal: { revealable: w.opened - w.revealed, revealed: w.revealed },
  ceremony: {
    status: w.cer.status,
    index: w.cer.index,
    stepEndsAt: w.cer.endsAt === null ? null : new Date(w.cer.endsAt).toISOString(),
    upcomingAutoSeconds:
      w.cer.status === 'idle' ? (w.script[0] ?? null) : (w.script[w.cer.index + 1] ?? null),
    nothingToShow: w.script.length === 0,
    pendingDecisions: w.pending,
  },
});

function ceremonyStep(w: World, now: number) {
  w.cer.index += 1;
  if (w.cer.index >= w.script.length) {
    w.cer = { status: 'done', index: w.cer.index, endsAt: null };
    return;
  }
  const s = w.script[w.cer.index];
  w.cer.endsAt = s ? now + s * 1000 : null;
}

function movePhase(w: World, to: Phase, now: number) {
  const r = transition({ phase: w.phase, paused: w.paused, milestones: w.milestones }, to, {
    now: new Date(now),
    pairingReady: true,
  });
  expect(r, `illegal ${w.phase} -> ${to}`).toMatchObject({ ok: true, kind: 'forward' });
  if (!r.ok) return;
  if (w.phase === 'voting' && w.votingClosedAt === null) w.votingClosedAt = now;
  w.phase = r.patch.phase;
  w.milestones = { ...w.milestones, ...r.patch.milestones };
}

describe('autopilot property', () => {
  it('from gift_opening always reaches completed with legal transitions only', () => {
    fc.assert(
      fc.property(
        fc.record({
          total: fc.integer({ min: 0, max: 8 }),
          inShow: fc.boolean(),
          miniGames: fc.boolean(),
          gameLen: fc.integer({ min: 10, max: 1200 }),
          organizerTie: fc.boolean(),
          pending: fc.integer({ min: 0, max: 3 }),
          script: fc.array(fc.option(fc.integer({ min: 1, max: 10 }), { nil: null }), {
            maxLength: 12,
          }),
          // organizer manual phase moves at these tick numbers (override must win)
          manual: fc.array(fc.integer({ min: 0, max: 80 }), { maxLength: 3 }),
          holds: fc.array(fc.integer({ min: 0, max: 80 }), { maxLength: 3 }),
        }),
        (p) => {
          const w: World = {
            phase: 'gift_opening',
            paused: false,
            milestones: {
              giftOpeningStartedAt: T0,
              votingClosedAt: null,
              revealStartedAt: null,
              ceremonyStartedAt: null,
            },
            total: p.total,
            opened: 0,
            revealed: 0,
            votingClosedAt: null,
            gameActive: false,
            gameEndsAt: 0,
            gameLen: p.gameLen,
            played: 0,
            inShow: p.inShow,
            miniGames: p.inShow && p.miniGames,
            tieBreak: p.organizerTie ? 'organizer' : 'shared',
            pending: p.organizerTie ? p.pending : 0,
            script: p.script,
            cer: { status: 'idle', index: 0, endsAt: null },
          };
          let now = T0.getTime();
          let state = startState({
            settings: settings(),
            counts: counts({
              gifts: p.total,
              unopenedGifts: p.total,
              ceremonySteps: p.script.length,
            }),
            features: { miniGames: p.miniGames, auction: false },
            now: T0,
          });
          const bound = 4 * p.total + 4 * p.script.length + 80;
          let ticks = 0;
          while (state.status !== 'done') {
            ticks += 1;
            expect(ticks, 'bounded').toBeLessThanOrEqual(bound);
            // external jobs: ceremony countdowns and mini-games finish on their own
            if (w.cer.status === 'running' && w.cer.endsAt !== null && now >= w.cer.endsAt)
              ceremonyStep(w, w.cer.endsAt);
            if (w.gameActive && now >= w.gameEndsAt) {
              w.gameActive = false;
              w.played += 1;
            }
            if (p.manual.includes(ticks) && w.phase !== 'completed') {
              const nextPhase = PHASES[PHASES.indexOf(w.phase) + 1]!;
              // the organizer only advances once the current sub-work allows it in the real UI
              if (!(w.phase === 'awards' && w.cer.status === 'running'))
                movePhase(w, nextPhase, now);
            }
            if (p.holds.includes(ticks)) {
              state = resumeState(holdState(state, new Date(now)), new Date(now + 60_000));
              now += 60_000;
            }
            const check = applyTick(state, state.seq);
            expect(check.ok).toBe(true);
            const a = nextAction(state, snapOf(w), new Date(now));
            expect(a.type).not.toBe('noop');
            if (a.type === 'noop') return;
            const nowD = new Date(now);
            switch (a.type) {
              case 'open_next_gift':
                expect(w.phase).toBe('gift_opening');
                expect(w.opened).toBeLessThan(w.total);
                w.opened += 1;
                break;
              case 'open_voting':
                expect(w.phase).toBe('gift_opening');
                movePhase(w, 'voting', now);
                break;
              case 'close_voting':
                expect(w.phase).toBe('voting');
                w.votingClosedAt = now;
                break;
              case 'start_game':
                expect(w.phase).toBe('games');
                expect(w.gameActive).toBe(false);
                w.gameActive = true;
                w.gameEndsAt = now + w.gameLen * 1000;
                break;
              case 'end_game':
                expect(w.gameActive).toBe(true);
                w.gameActive = false;
                w.played += 1;
                break;
              case 'reveal_next_gift':
                expect(w.phase).toBe('reveal');
                expect(w.opened - w.revealed).toBeGreaterThan(0);
                w.revealed += 1;
                break;
              case 'resolve_ties':
                expect(w.tieBreak).toBe('organizer');
                w.pending = 0;
                break;
              case 'start_ceremony':
                expect(w.phase).toBe('awards');
                expect(w.pending === 0 || w.tieBreak !== 'organizer').toBe(true);
                w.cer = { status: 'running', index: -1, endsAt: null };
                ceremonyStep(w, now);
                break;
              case 'advance_ceremony':
                expect(w.cer.status).toBe('running');
                expect(a.fromIndex).toBe(w.cer.index);
                expect(w.cer.endsAt).toBeNull();
                ceremonyStep(w, now);
                break;
              case 'advance_phase':
                expect(a.from).toBe(w.phase);
                // irreversibility: votes are locked before leaving voting
                if (a.from === 'voting') expect(w.votingClosedAt).not.toBeNull();
                if (a.from === 'reveal') expect(w.opened - w.revealed).toBe(0);
                movePhase(w, a.to, now);
                break;
              case 'complete':
                expect(w.phase).toBe('completed');
                break;
              case 'wait':
                expect(new Date(a.untilAt).getTime()).toBeGreaterThan(now);
                break;
              case 'resync':
                expect(a.step).toBe(stepForPhase(w.phase));
                break;
            }
            const c = commitAction(state, a, nowD);
            expect(c.ok).toBe(true);
            if (!c.ok) return;
            expect(applyTick(c.state, state.seq).ok).toBe(false); // the consumed tick is now stale
            state = c.state;
            if (a.nextTickAt) now = Math.max(now, new Date(a.nextTickAt).getTime());
          }
          expect(w.phase).toBe('completed');
          expect(state.timeline.every((x) => x.status === 'done' || x.status === 'skipped')).toBe(
            true,
          );
          expect(AutopilotStateSchema.safeParse(state).success).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
