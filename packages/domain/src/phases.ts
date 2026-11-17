import { PHASES, type Phase, type SetupWarning } from '@santa/contracts';
import { MIN_VOTERS_FLOOR } from './ranking.js';

export interface Milestones {
  giftOpeningStartedAt: Date | null;
  votingClosedAt: Date | null;
  revealStartedAt: Date | null;
  ceremonyStartedAt: Date | null;
}

export interface PhaseState {
  phase: Phase;
  paused: boolean;
  milestones: Milestones;
}

export type TransitionError =
  | 'same_phase'
  | 'paused'
  | 'invalid_step'
  | 'pairing_not_ready'
  | 'backstep_after_reveal'
  | 'use_reopen_voting';

export type Transition =
  | {
      ok: true;
      kind: 'forward' | 'back';
      /** Back-steps must be written to the audit log. */
      audit: 'phase.forward' | 'phase.back';
      patch: { phase: Phase; milestones: Partial<Milestones> };
    }
  | { ok: false; error: TransitionError };

const idx = (p: Phase) => PHASES.indexOf(p);

/** Organizer-driven order; `games` is skippable (empty in MVP). Irreversibility is enforced by milestones. */
export function transition(
  state: PhaseState,
  to: Phase,
  ctx: { now: Date; pairingReady: boolean },
): Transition {
  const from = state.phase;
  if (to === from) return { ok: false, error: 'same_phase' };
  if (state.paused) return { ok: false, error: 'paused' };

  const forwardOk = idx(to) === idx(from) + 1 || (from === 'voting' && to === 'reveal');
  const backOk = idx(to) === idx(from) - 1;

  if (forwardOk) {
    if (to === 'gift_registration' && !ctx.pairingReady)
      return { ok: false, error: 'pairing_not_ready' };
    const m: Partial<Milestones> = {};
    const { milestones: cur } = state;
    if (to === 'gift_opening' && !cur.giftOpeningStartedAt) m.giftOpeningStartedAt = ctx.now;
    if (from === 'voting' && !cur.votingClosedAt) m.votingClosedAt = ctx.now;
    if (to === 'reveal' && !cur.revealStartedAt) m.revealStartedAt = ctx.now;
    if (to === 'awards' && !cur.ceremonyStartedAt) m.ceremonyStartedAt = ctx.now;
    return {
      ok: true,
      kind: 'forward',
      audit: 'phase.forward',
      patch: { phase: to, milestones: m },
    };
  }
  if (backOk || idx(to) < idx(from)) {
    if (state.milestones.revealStartedAt) return { ok: false, error: 'backstep_after_reveal' };
    if (to === 'voting') return { ok: false, error: 'use_reopen_voting' };
    if (!backOk) return { ok: false, error: 'invalid_step' };
    return { ok: true, kind: 'back', audit: 'phase.back', patch: { phase: to, milestones: {} } };
  }
  return { ok: false, error: 'invalid_step' };
}

export type Activity =
  'join' | 'gift_register' | 'gift_edit' | 'vote' | 'react' | 'pairing_import' | 'profile_edit';

const MATRIX: Record<Phase, readonly Activity[]> = {
  preparation: ['pairing_import', 'profile_edit'],
  registration: ['join', 'pairing_import', 'profile_edit'],
  gift_registration: ['join', 'gift_register', 'gift_edit', 'pairing_import', 'profile_edit'],
  gift_opening: ['react', 'profile_edit'],
  voting: ['vote', 'react', 'profile_edit'],
  games: ['react', 'profile_edit'],
  reveal: ['react'],
  awards: ['react'],
  completed: [],
};

export function isActivityAllowed(state: PhaseState, activity: Activity): boolean {
  if (state.paused) return false;
  if (activity === 'pairing_import' && state.milestones.giftOpeningStartedAt) return false;
  return MATRIX[state.phase].includes(activity);
}

export function setupWarnings(rosterSize: number): SetupWarning[] {
  return rosterSize < MIN_VOTERS_FLOOR ? ['roster_below_voter_floor'] : [];
}
