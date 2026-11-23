import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MyRevealShowResponseSchema,
  RevealShowStateSchema,
  SceneSchema,
  ShowChoiceViewSchema,
  TreeLightResponseSchema,
  guardOutput,
  scanForbidden,
} from '@santa/contracts';
import {
  MIN_VOTERS_FLOOR,
  decideShowChoice,
  projectReveal,
  type ShowChoiceBallot,
} from './index.js';

const NOW = '2026-12-24T20:00:00.000Z';
const keys = (schema: unknown) =>
  Object.keys((schema as { shape: Record<string, unknown> }).shape).sort();
const ballots = (snow: number, bells: number): ShowChoiceBallot[] => [
  ...Array.from({ length: snow }, (_, i) => ({ voterId: `S${i}`, choice: 'snowstorm' as const })),
  ...Array.from({ length: bells }, (_, i) => ({
    voterId: `B${i}`,
    choice: 'sleigh_bells' as const,
  })),
];
const reveal = (extra: Record<string, unknown>) => ({
  scene: 'reveal',
  reveal: {
    current: null,
    countdownEndsAt: null,
    revealedCount: 0,
    total: 3,
    revealed: [],
    lights: 0,
    choice: null,
    effect: null,
    ...extra,
  },
});

describe('Snowstorm vs Sleigh Bells outcome (FR-013 floor, neutral fallback)', () => {
  it('majority wins only with >= 5 distinct voters; ties / below floor / none => none', () => {
    expect(decideShowChoice([])).toBe('none');
    expect(decideShowChoice(ballots(4, 0))).toBe('none'); // unanimous but below the floor
    expect(decideShowChoice(ballots(3, 2))).toBe('snowstorm');
    expect(decideShowChoice(ballots(1, 4))).toBe('sleigh_bells');
    expect(decideShowChoice(ballots(3, 3))).toBe('none');
    expect(decideShowChoice(ballots(4, 3), 8)).toBe('none'); // stricter event setting honoured
    expect(decideShowChoice(ballots(4, 3), 1)).toBe('snowstorm'); // ...but never below the global floor
    expect(decideShowChoice(ballots(2, 2), 1)).toBe('none');
  });

  it('duplicate ballots from one voter never count twice', () => {
    const dup = Array.from({ length: 9 }, () => ({ voterId: 'X', choice: 'snowstorm' as const }));
    expect(decideShowChoice([...dup, ...ballots(0, 3)])).toBe('none'); // 4 distinct voters: below the floor
    expect(decideShowChoice([...dup, ...ballots(0, 4)])).toBe('sleigh_bells'); // X counts once: 1 vs 4
  });

  it('property: winner only with floor met and a strict majority; output is never a count', () => {
    fc.assert(
      fc.property(fc.nat(12), fc.nat(12), fc.integer({ min: 0, max: 10 }), (a, b, min) => {
        const r = decideShowChoice(ballots(a, b), min);
        const floor = Math.max(min, MIN_VOTERS_FLOOR);
        if (a + b < floor || a === b) expect(r).toBe('none');
        else expect(r).toBe(a > b ? 'snowstorm' : 'sleigh_bells');
        expect(['snowstorm', 'sleigh_bells', 'none']).toContain(r);
      }),
      { numRuns: 300 },
    );
  });

  it('knowing your own vote and the outcome does not identify any other vote', () => {
    const actions = [null, 'snowstorm', 'sleigh_bells'] as const;
    for (let size = 5; size <= 12; size++) {
      for (const own of actions) {
        const possible = new Map<string, Set<(typeof actions)[number]>>();
        for (const other of actions) {
          // Other participants are interchangeable; enumerate their counts, including abstentions.
          for (let snow = 0; snow <= size - 2; snow++) {
            for (let bells = 0; bells <= size - 2 - snow; bells++) {
              const inputs = ballots(snow, bells);
              if (own) inputs.push({ voterId: 'own', choice: own });
              if (other) inputs.push({ voterId: 'other', choice: other });
              const result = decideShowChoice(inputs);
              const actionsForResult = possible.get(result) ?? new Set();
              actionsForResult.add(other);
              possible.set(result, actionsForResult);
            }
          }
        }
        expect(possible.size).toBe(size === 5 && own === null ? 1 : 3);
        for (const actionsForResult of possible.values()) {
          expect(actionsForResult.has('snowstorm')).toBe(true);
          expect(actionsForResult.has('sleigh_bells')).toBe(true);
        }
      }
    }
  });
});

describe('reveal-show public contract: no tallies, no voters, no per-gift counts', () => {
  it('field allowlists', () => {
    expect(keys(RevealShowStateSchema)).toEqual(['choice', 'effect', 'lights']);
    expect(keys(TreeLightResponseSchema)).toEqual(['giftId', 'lights', 'lit']);
    expect(keys(MyRevealShowResponseSchema)).toEqual(['choice', 'litGiftIds']);
    for (const o of ShowChoiceViewSchema.options)
      expect(keys(o)).toEqual(['endsAt', 'result', 'round', 'status']);
  });

  it('scene accepts the extras and rejects every leak shape', () => {
    const open = { status: 'open', round: 1, endsAt: NOW, result: null };
    const closed = { status: 'closed', round: 1, endsAt: NOW, result: 'snowstorm' };
    expect(SceneSchema.safeParse(reveal({ lights: 7, choice: open })).success).toBe(true);
    expect(SceneSchema.safeParse(reveal({ choice: closed, effect: 'snowstorm' })).success).toBe(
      true,
    );
    const leaks: Array<Record<string, unknown>> = [
      { choice: { ...open, result: 'snowstorm' } }, // live result
      { choice: { ...open, counts: { snowstorm: 3, sleigh_bells: 2 } } }, // live tally
      { choice: { ...closed, votes: 5 } }, // final tally
      { choice: { ...closed, voters: ['P1'] } }, // identities
      { choice: { ...closed, result: 'tie' } }, // tie distinguishable from none
      { lights: -1 },
      { lights: 2, lightsByGift: { G1: 2 } }, // per-gift count
      { lighters: ['P1'] },
      { effect: 'none' },
    ];
    for (const l of leaks)
      expect(SceneSchema.safeParse(reveal(l)).success, JSON.stringify(l)).toBe(false);
    // the send guard refuses to emit a tally on any public stream
    const tally = reveal({ choice: { ...open, counts: { snowstorm: 3 } } });
    expect(() => guardOutput('display', 'scene', tally, { env: 'test' })).toThrow();
    expect(() => guardOutput('participant', 'scene', tally, { env: 'test' })).toThrow();
  });

  it('projectReveal copies extras verbatim and forces result=null on an open round', () => {
    const v = projectReveal({
      gifts: [],
      people: [],
      currentGiftId: null,
      countdownEndsAt: null,
      show: {
        lights: 4,
        // a buggy caller passing a result on an open round must not leak it
        choice: { status: 'open', round: 2, endsAt: NOW, result: null },
        effect: 'sleigh_bells',
      },
    });
    expect(v).toMatchObject({
      lights: 4,
      effect: 'sleigh_bells',
      choice: { status: 'open', result: null },
    });
    expect(SceneSchema.safeParse({ scene: 'reveal', reveal: v }).success).toBe(true);
    expect(scanForbidden(v, { keys: ['voterId', 'participantId', 'counts', 'votes'] })).toEqual([]);
    // without extras the view keeps its historical shape
    expect(
      Object.keys(
        projectReveal({ gifts: [], people: [], currentGiftId: null, countdownEndsAt: null }),
      ),
    ).not.toContain('lights');
  });
});
