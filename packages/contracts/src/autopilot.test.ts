import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_PRESETS,
  AutopilotCommandSchema,
  AutopilotSettingsPatchSchema,
  AutopilotSettingsSchema,
  AutopilotStateSchema,
  EventSettingsSchema,
  OrganizerMaskedEventStateSchema,
  OutputSchemas,
  SceneSchema,
  autopilotSettings,
  defaultEventSettings,
  resolveAutopilotTimings,
} from './index.js';

const NOW = '2026-12-20T18:00:00.000Z';
const person = (id: string) => ({ participantId: id, displayName: `Name ${id}`, avatar: null });

describe('autopilot settings', () => {
  it('defaults: standard preset, extras on, no overrides', () => {
    expect(defaultEventSettings().autopilot).toEqual({ preset: 'standard', includeExtras: true });
    expect(resolveAutopilotTimings(defaultEventSettings().autopilot)).toEqual(
      AUTOPILOT_PRESETS.standard,
    );
  });

  it('backward compat: settings stored before autopilot still parse', () => {
    const legacy = { topN: 3, features: { miniGames: true }, phase2: {}, phase3: {} };
    const parsed = EventSettingsSchema.parse(legacy);
    expect(parsed.autopilot.preset).toBe('standard');
    expect(autopilotSettings({})).toEqual({ preset: 'standard', includeExtras: true });
  });

  it('rejects unknown preset, unknown keys and out-of-bounds overrides', () => {
    expect(EventSettingsSchema.safeParse({ autopilot: { preset: 'turbo' } }).success).toBe(false);
    expect(AutopilotSettingsSchema.safeParse({ preset: 'turbo' }).success).toBe(false);
    expect(AutopilotSettingsSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(AutopilotSettingsSchema.safeParse({ votingMinutes: 0 }).success).toBe(false);
    expect(AutopilotSettingsSchema.safeParse({ openingGiftSeconds: 4 }).success).toBe(false);
    expect(AutopilotSettingsSchema.safeParse({ revealGiftSeconds: 1.5 }).success).toBe(false);
  });

  it('overrides win over the preset; null clears an override', () => {
    const s = AutopilotSettingsSchema.parse({ preset: 'quick', votingMinutes: 7, gamesMinutes: null });
    expect(resolveAutopilotTimings(s)).toEqual({ ...AUTOPILOT_PRESETS.quick, votingMinutes: 7 });
  });

  it('presets are ordered quick < standard < relaxed', () => {
    for (const k of Object.keys(AUTOPILOT_PRESETS.quick) as (keyof typeof AUTOPILOT_PRESETS.quick)[]) {
      expect(AUTOPILOT_PRESETS.quick[k]).toBeLessThan(AUTOPILOT_PRESETS.standard[k]);
      expect(AUTOPILOT_PRESETS.standard[k]).toBeLessThan(AUTOPILOT_PRESETS.relaxed[k]);
    }
  });

  it('patch: non-empty subset only', () => {
    expect(AutopilotSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(AutopilotSettingsPatchSchema.safeParse({ preset: 'relaxed' }).success).toBe(true);
    expect(AutopilotSettingsPatchSchema.safeParse({ interludeSeconds: null }).success).toBe(true);
  });
});

describe('autopilot command + state', () => {
  it('command actions are a fixed set', () => {
    for (const action of ['start', 'hold', 'resume', 'stop', 'skip'])
      expect(AutopilotCommandSchema.safeParse({ action }).success).toBe(true);
    expect(AutopilotCommandSchema.safeParse({ action: 'pause' }).success).toBe(false);
    expect(AutopilotCommandSchema.safeParse({ action: 'skip', fromSeq: 3 }).success).toBe(true);
  });

  const state = {
    status: 'running',
    step: 'voting',
    seq: 4,
    stepEndsAt: NOW,
    startedAt: NOW,
    heldAt: null,
    remainingMsAtHold: null,
    timeline: [
      { step: 'opening', plannedSeconds: 400, eta: null, status: 'done' },
      { step: 'voting', plannedSeconds: 300, eta: NOW, status: 'active' },
      { step: 'games', plannedSeconds: 600, eta: null, status: 'skipped' },
    ],
    log: [{ at: NOW, code: 'tie_shared', params: { boardKey: 'best_overall', count: 2 } }],
  };

  it('valid state parses', () => {
    expect(AutopilotStateSchema.safeParse(state).success).toBe(true);
  });

  it('log params cannot carry free text (names, pairings)', () => {
    const leak = (v: unknown) => ({ ...state, log: [{ at: NOW, code: 'started', params: { x: v } }] });
    expect(AutopilotStateSchema.safeParse(leak('Alice -> Bob')).success).toBe(false);
    expect(AutopilotStateSchema.safeParse(leak('Alice')).success).toBe(false);
    expect(AutopilotStateSchema.safeParse(leak({ giverId: 'P1' })).success).toBe(false);
    expect(
      AutopilotStateSchema.safeParse({ ...state, log: [{ at: NOW, code: 'custom_text' }] }).success,
    ).toBe(false);
  });

  it('autopilot is accepted only on organizer event state, never display/participant', () => {
    const shape = OrganizerMaskedEventStateSchema.shape.organizer.shape;
    expect('autopilot' in shape).toBe(true);
    expect('autopilot' in OutputSchemas.display.eventState.shape).toBe(false);
    expect('autopilot' in OutputSchemas.participant.eventState.shape).toBe(false);
  });

  it('display presence is an exact organizer-only contract field', () => {
    const shape = OrganizerMaskedEventStateSchema.shape.organizer.shape;
    expect('displayConnected' in shape).toBe(true);
    expect('displayConnected' in OutputSchemas.display.eventState.shape).toBe(false);
    expect('displayConnected' in OutputSchemas.participant.eventState.shape).toBe(false);
  });
});

describe('reveal scene', () => {
  const core = {
    giftId: 'G1',
    alias: 'Gift 1',
    giftName: 'Socks',
    photoUrl: null,
    recipient: person('R1'),
  };
  const revealed = { ...core, giftId: 'G0', alias: 'Gift 0', giver: person('P0') };
  const scene = (current: unknown, list: unknown[] = [revealed]) => ({
    scene: 'reveal',
    reveal: { current, countdownEndsAt: NOW, revealedCount: list.length, total: 5, revealed: list },
  });

  it('drumroll then revealed', () => {
    expect(SceneSchema.safeParse(scene({ ...core, stage: 'drumroll', giver: null })).success).toBe(
      true,
    );
    expect(
      SceneSchema.safeParse(scene({ ...core, stage: 'revealed', giver: person('P1') })).success,
    ).toBe(true);
    expect(SceneSchema.safeParse(scene(null, [])).success).toBe(true);
  });

  it('forbidden: giver during drumroll, unrevealed entries, extra ids', () => {
    expect(
      SceneSchema.safeParse(scene({ ...core, stage: 'drumroll', giver: person('P1') })).success,
    ).toBe(false);
    expect(SceneSchema.safeParse(scene({ ...core, stage: 'revealed', giver: null })).success).toBe(
      false,
    );
    expect(SceneSchema.safeParse(scene(null, [{ ...revealed, giver: null }])).success).toBe(false);
    expect(
      SceneSchema.safeParse(scene({ ...core, stage: 'drumroll', giver: null, giverId: 'P1' }))
        .success,
    ).toBe(false);
    expect(SceneSchema.safeParse(scene(null, [{ ...revealed, openingOrder: 3 }])).success).toBe(
      false,
    );
  });
});
