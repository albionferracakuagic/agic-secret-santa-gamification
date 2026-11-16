import { describe, expect, it } from 'vitest';
import { isActivityAllowed, setupWarnings, transition, type PhaseState } from './phases.js';

const NOW = new Date('2026-12-24T20:00:00Z');
const state = (over: Partial<PhaseState> = {}): PhaseState => ({
  phase: 'preparation',
  paused: false,
  milestones: {
    giftOpeningStartedAt: null,
    votingClosedAt: null,
    revealStartedAt: null,
    ceremonyStartedAt: null,
  },
  ...over,
});
const go = (s: PhaseState, to: Parameters<typeof transition>[1], pairingReady = true) =>
  transition(s, to, { now: NOW, pairingReady });

describe('phase machine (FR-007)', () => {
  it('walks forward one step at a time; games is skippable', () => {
    expect(go(state(), 'registration')).toMatchObject({ ok: true, kind: 'forward' });
    expect(go(state(), 'voting')).toMatchObject({ ok: false, error: 'invalid_step' });
    const v = state({ phase: 'voting' });
    expect(go(v, 'games')).toMatchObject({ ok: true });
    expect(go(v, 'reveal')).toMatchObject({ ok: true });
  });

  it('gift_registration requires a ready pairing import', () => {
    const s = state({ phase: 'registration' });
    expect(go(s, 'gift_registration', false)).toMatchObject({
      ok: false,
      error: 'pairing_not_ready',
    });
    expect(go(s, 'gift_registration', true)).toMatchObject({ ok: true });
  });

  it('sets milestones on first entry and never clears them', () => {
    const open = go(state({ phase: 'gift_registration' }), 'gift_opening');
    expect(open.ok && open.patch.milestones.giftOpeningStartedAt).toEqual(NOW);
    const close = go(state({ phase: 'voting' }), 'reveal');
    expect(close.ok && close.patch.milestones).toMatchObject({
      votingClosedAt: NOW,
      revealStartedAt: NOW,
    });
  });

  it('back-steps are audited and allowed before reveal only', () => {
    const back = go(state({ phase: 'gift_opening' }), 'gift_registration');
    expect(back).toMatchObject({ ok: true, kind: 'back', audit: 'phase.back' });
    const revealed = state({
      phase: 'awards',
      milestones: {
        giftOpeningStartedAt: NOW,
        votingClosedAt: NOW,
        revealStartedAt: NOW,
        ceremonyStartedAt: NOW,
      },
    });
    expect(go(revealed, 'reveal')).toMatchObject({ ok: false, error: 'backstep_after_reveal' });
  });

  it('going back into voting must use reopen-voting (invalidates awards)', () => {
    expect(go(state({ phase: 'games' }), 'voting')).toMatchObject({
      ok: false,
      error: 'use_reopen_voting',
    });
  });

  it('paused events do not change phase', () => {
    expect(go(state({ paused: true }), 'registration')).toMatchObject({
      ok: false,
      error: 'paused',
    });
  });
});

describe('activity matrix', () => {
  it('allows only what the phase permits and nothing while paused', () => {
    expect(isActivityAllowed(state({ phase: 'voting' }), 'vote')).toBe(true);
    expect(isActivityAllowed(state({ phase: 'voting', paused: true }), 'vote')).toBe(false);
    expect(isActivityAllowed(state({ phase: 'gift_registration' }), 'vote')).toBe(false);
    expect(isActivityAllowed(state({ phase: 'completed' }), 'react')).toBe(false);
  });

  it('pairing import is disabled forever once gift opening started (milestone, not phase)', () => {
    const s = state({ phase: 'gift_registration' });
    expect(isActivityAllowed(s, 'pairing_import')).toBe(true);
    const later = state({
      phase: 'gift_registration',
      milestones: { ...s.milestones, giftOpeningStartedAt: NOW },
    });
    expect(isActivityAllowed(later, 'pairing_import')).toBe(false);
  });
});

describe('setup warnings', () => {
  it('warns when the roster cannot reach the 5-voter floor', () => {
    expect(setupWarnings(4)).toEqual(['roster_below_voter_floor']);
    expect(setupWarnings(5)).toEqual([]);
  });
});
