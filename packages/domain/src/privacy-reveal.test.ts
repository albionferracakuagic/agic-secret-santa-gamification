import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  OutputSchemas,
  ROLES,
  RevealCurrentSchema,
  RevealNextResponseSchema,
  RevealViewSchema,
  RevealedPairSchema,
  guardOutput,
  scanForbidden,
} from '@santa/contracts';
import {
  projectReveal,
  projectScene,
  type EventSource,
  type GiftSource,
  type ParticipantSource,
} from './index.js';

const NOW = '2026-12-24T20:00:00.000Z';
const keys = (schema: unknown) =>
  Object.keys((schema as { shape: Record<string, unknown> }).shape).sort();

const people: ParticipantSource[] = Array.from({ length: 6 }, (_, i) => ({
  id: `P${i}`,
  displayName: `Name${i}x`,
  avatar: null,
  status: 'active',
  xp: 10 * i,
}));
const gift = (
  i: number,
  status: GiftSource['status'],
  extra: Partial<GiftSource> = {},
): GiftSource => ({
  id: `G${i}`,
  aliasNo: 6 - i, // alias order != giver order
  name: `Gift name ${i}`,
  description: null,
  photoUrl: null,
  status,
  giverId: `P${i}`,
  recipientId: `P${(i + 1) % 6}`,
  openingOrder: i + 1,
  createdAt: NOW,
  openedAt: status === 'registered' ? null : NOW,
  hidden: false,
  ...extra,
});
const event = (phase: EventSource['phase'] = 'reveal'): EventSource => ({
  id: 'E',
  name: 'Party',
  description: null,
  theme: 'classic',
  startsAt: NOW,
  timezone: 'Europe/Rome',
  phase,
  paused: false,
  maxParticipants: 100,
  votingRound: 1,
  defaultLocale: 'en',
  votingEndsAt: null,
  reactionsEnabled: true,
  currentGiftId: null,
  milestones: {
    giftOpeningStartedAt: NOW,
    votingClosedAt: NOW,
    revealStartedAt: NOW,
    ceremonyStartedAt: null,
  },
});
const base = (phase: EventSource['phase'] = 'reveal') => ({
  event: event(phase),
  activeParticipants: 6,
  gifts: [],
  people,
  join: null,
  votedCount: null,
});

describe('giver reveal scene (FR-046 rule 6: no giver before the reveal)', () => {
  it('exact key allowlists', () => {
    expect(keys(RevealViewSchema)).toEqual([
      'countdownEndsAt',
      'current',
      'revealed',
      'revealedCount',
      'total',
    ]);
    expect(keys(RevealedPairSchema)).toEqual([
      'alias',
      'giftId',
      'giftName',
      'giver',
      'photoUrl',
      'recipient',
    ]);
    expect(keys(RevealNextResponseSchema)).toEqual([
      'countdownEndsAt',
      'done',
      'giftId',
      'revealedCount',
      'total',
    ]);
  });

  it('drumroll: staged gift has giver null; contract refuses a giver during the drumroll', () => {
    const gifts = [gift(0, 'opened'), gift(1, 'revealed'), gift(3, 'registered')];
    const v = projectReveal({ gifts, people, currentGiftId: 'G0', countdownEndsAt: NOW });
    expect(v.current).toMatchObject({
      giftId: 'G0',
      stage: 'drumroll',
      giver: null,
      alias: 'Gift 6',
    });
    expect(v.current!.recipient).toEqual({
      participantId: 'P1',
      displayName: 'Name1x',
      avatar: null,
    });
    expect(v).toMatchObject({ countdownEndsAt: NOW, revealedCount: 1, total: 2 });
    expect(v.revealed.map((r) => r.giftId)).toEqual(['G1']);
    expect(JSON.stringify(v)).not.toContain('Name0x'); // giver of the staged gift
    expect(JSON.stringify(v)).not.toContain('Name3x'); // unopened gift's giver
    expect(
      RevealCurrentSchema.safeParse({
        ...v.current,
        giver: { participantId: 'P0', displayName: 'x', avatar: null },
      }).success,
    ).toBe(false);
    expect(
      RevealCurrentSchema.safeParse({ ...v.current, stage: 'revealed', giver: null }).success,
    ).toBe(false);
  });

  it('revealed: giver shown once revealed server-side; no countdown; hidden/unopened gifts never appear', () => {
    const gifts = [gift(0, 'revealed'), gift(2, 'revealed', { hidden: true }), gift(3, 'revealed')];
    const v = projectReveal({ gifts, people, currentGiftId: 'G0', countdownEndsAt: NOW });
    expect(v.current).toMatchObject({ stage: 'revealed', giver: { participantId: 'P0' } });
    expect(v.countdownEndsAt).toBeNull();
    expect(v.revealed.map((r) => r.alias)).toEqual(['Gift 3', 'Gift 6']); // by alias, not giver/opening order
    expect(v.total).toBe(2);
    expect(JSON.stringify(v)).not.toContain('Name2x'); // hidden gift's giver
    // staged gift that got hidden: nothing on stage
    expect(
      projectReveal({ gifts, people, currentGiftId: 'G2', countdownEndsAt: null }).current,
    ).toBeNull();
  });

  it('property: no unrevealed giver ever appears; output always passes every role scene schema', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<GiftSource['status']>('registered', 'opened', 'revealed'), {
          minLength: 6,
          maxLength: 6,
        }),
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        fc.option(fc.integer({ min: 0, max: 5 })),
        (statuses, hidden, cur) => {
          const gifts = statuses.map((st, i) => gift(i, st, { hidden: hidden[i]! }));
          const v = projectReveal({
            gifts,
            people,
            currentGiftId: cur === null ? null : `G${cur}`,
            countdownEndsAt: NOW,
          });
          const scene = projectScene({ ...base(), reveal: v });
          for (const role of ROLES)
            expect(OutputSchemas[role].scene.safeParse(scene).success).toBe(true);
          const shownGivers = new Set<string>();
          const walk = (x: unknown): void => {
            if (Array.isArray(x)) x.forEach(walk);
            else if (x && typeof x === 'object') {
              const o = x as Record<string, unknown>;
              if (o['giver'] && typeof o['giver'] === 'object')
                shownGivers.add((o['giver'] as { participantId: string }).participantId);
              Object.values(o).forEach(walk);
            }
          };
          walk(scene);
          const allowed = new Set(
            gifts.filter((g) => g.status === 'revealed' && !g.hidden).map((g) => g.giverId),
          );
          for (const p of shownGivers) expect(allowed.has(p)).toBe(true);
          // a name appears only as a revealed giver or as a (public) recipient of an opened gift
          const text = JSON.stringify(scene);
          const visibleNames = new Set<string>();
          for (const g of gifts.filter((x) => !x.hidden && x.status !== 'registered')) {
            visibleNames.add(`Name${g.recipientId.slice(1)}x`);
            if (g.status === 'revealed') visibleNames.add(`Name${g.giverId.slice(1)}x`);
          }
          for (const p of people)
            if (!visibleNames.has(p.displayName)) expect(text).not.toContain(p.displayName);
          expect(
            scanForbidden(scene, {
              keys: ['giverId', 'recipientId', 'openingOrder', 'aliasNo', 'xp'],
            }),
          ).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('scene: reveal only in the reveal phase; a running drumroll wins over side presentations', () => {
    const v = projectReveal({
      gifts: [gift(0, 'opened')],
      people,
      currentGiftId: 'G0',
      countdownEndsAt: NOW,
    });
    const spotlight = { kind: 'santa_detective' as const, message: null, entries: [], at: NOW };
    expect(projectScene({ ...base(), reveal: v, spotlight })).toEqual({
      scene: 'reveal',
      reveal: v,
    });
    const done = projectReveal({
      gifts: [gift(0, 'revealed')],
      people,
      currentGiftId: 'G0',
      countdownEndsAt: null,
    });
    expect(done.current?.stage).toBe('revealed');
    expect(projectScene({ ...base(), reveal: done, spotlight })).toMatchObject({
      scene: 'spotlight',
    });
    expect(projectScene({ ...base(), reveal: done })).toEqual({ scene: 'reveal', reveal: done });
    const idle = projectReveal({
      gifts: [gift(0, 'opened')],
      people,
      currentGiftId: null,
      countdownEndsAt: null,
    });
    expect(projectScene({ ...base(), reveal: idle, spotlight })).toMatchObject({
      scene: 'spotlight',
    });
    expect(projectScene({ ...base(), reveal: idle })).toEqual({ scene: 'reveal', reveal: idle });
    expect(projectScene({ ...base('awards'), reveal: v })).toEqual({
      scene: 'phase',
      phase: 'awards',
    });
    expect(projectScene({ ...base() })).toEqual({ scene: 'phase', phase: 'reveal' });
  });

  it('send guard: a drumroll payload carrying a giver throws in test, is dropped + alerted in production', () => {
    const v = projectReveal({
      gifts: [gift(0, 'opened')],
      people,
      currentGiftId: 'G0',
      countdownEndsAt: NOW,
    });
    const leaky = {
      scene: 'reveal',
      reveal: {
        ...v,
        current: {
          ...v.current,
          giver: { participantId: 'P0', displayName: 'Name0x', avatar: null },
        },
      },
    };
    expect(() => guardOutput('display', 'scene', leaky, { env: 'test' })).toThrow();
    expect(() => guardOutput('participant', 'scene', leaky, { env: 'test' })).toThrow();
    const alerts: unknown[] = [];
    // a wrong-typed giver is not a strippable extra key: the whole push is dropped (never emitted)
    expect(() =>
      guardOutput('display', 'scene', leaky, { env: 'production', alert: (a) => alerts.push(a) }),
    ).toThrow();
    expect(alerts).toHaveLength(1);
  });
});
