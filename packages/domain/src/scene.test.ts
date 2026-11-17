import { describe, expect, it } from 'vitest';
import {
  projectGiftList,
  projectLeaderboard,
  projectLeaderboards,
  projectScene,
  giftLabel,
  type EventSource,
  type GiftSource,
  type ParticipantSource,
  type SceneInput,
} from './index.js';
import { OutputSchemas } from '@santa/contracts';
import { canPublishBallots } from './ranking.js';

const people: ParticipantSource[] = [
  { id: 'P1', displayName: 'Secret Giver', avatar: null, status: 'active', xp: 0 },
  { id: 'P2', displayName: 'Other', avatar: null, status: 'active', xp: 0 },
];
const g = (
  id: string,
  aliasNo: number,
  status: GiftSource['status'],
  over: Partial<GiftSource> = {},
): GiftSource => ({
  id,
  aliasNo,
  name: `n${id}`,
  description: null,
  photoUrl: null,
  status,
  giverId: 'P1',
  recipientId: 'P2',
  openingOrder: null,
  createdAt: '2026-12-01T10:00:00Z',
  openedAt: status === 'registered' ? null : '2026-12-24T20:00:00Z',
  hidden: false,
  ...over,
});
const event = (over: Partial<EventSource> = {}): EventSource => ({
  id: 'E',
  name: 'Party',
  description: null,
  theme: 'classic',
  startsAt: '2026-12-24T19:00:00Z',
  timezone: 'Europe/Rome',
  phase: 'gift_opening',
  paused: false,
  maxParticipants: 100,
  votingRound: 1,
  defaultLocale: 'en',
  votingEndsAt: null,
  currentGiftId: null,
  reactionsEnabled: true,
  milestones: {
    giftOpeningStartedAt: null,
    votingClosedAt: null,
    revealStartedAt: null,
    ceremonyStartedAt: null,
  },
  ...over,
});
const scene = (over: Partial<SceneInput> = {}) =>
  projectScene({
    event: event(),
    activeParticipants: 2,
    gifts: [],
    people,
    join: null,
    votedCount: null,
    ...over,
  });

describe('display scenes', () => {
  it('lobby carries the join URL + short code (never a token) until opening starts', () => {
    const s = scene({
      event: event({ phase: 'registration' }),
      join: { url: 'https://santa.test/j?code=ABCDEFG', shortCode: 'ABCDEFG' },
    });
    expect(s).toEqual({
      scene: 'lobby',
      participants: 2,
      joinUrl: 'https://santa.test/j?code=ABCDEFG',
      shortCode: 'ABCDEFG',
    });
    expect(scene({ event: event({ phase: 'gift_registration' }) })).toMatchObject({
      scene: 'lobby',
      joinUrl: null,
      shortCode: null,
    });
  });

  it('opening: current gift is public data without giver; counts exclude hidden gifts', () => {
    const gifts = [
      g('A', 1, 'opened'),
      g('B', 2, 'registered'),
      g('C', 3, 'opened', { hidden: true }),
    ];
    const s = scene({ event: event({ currentGiftId: 'A' }), gifts });
    expect(s).toMatchObject({
      scene: 'opening',
      openedCount: 1,
      total: 2,
      current: { giftId: 'A', alias: 'Gift 1', status: 'opened' },
    });
    expect(JSON.stringify(s)).not.toMatch(/Secret Giver|giver|P1/);
    // a current pointer to an unopened/hidden gift shows nothing
    expect(scene({ event: event({ currentGiftId: 'B' }), gifts })).toMatchObject({ current: null });
    expect(scene({ event: event({ currentGiftId: 'C' }), gifts })).toMatchObject({ current: null });
  });

  it('voting: server deadline + published counter only; closed flag from milestone', () => {
    const open = scene({
      event: event({ phase: 'voting', votingEndsAt: '2026-12-24T20:30:00Z' }),
      votedCount: 3,
    });
    expect(open).toEqual({
      scene: 'voting',
      endsAt: '2026-12-24T20:30:00Z',
      votedCount: 3,
      closed: false,
    });
    const closed = scene({
      event: event({
        phase: 'voting',
        milestones: {
          giftOpeningStartedAt: null,
          votingClosedAt: '2026-12-24T20:31:00Z',
          revealStartedAt: null,
          ceremonyStartedAt: null,
        },
      }),
    });
    expect(closed).toMatchObject({ votedCount: null, closed: true });
    expect(scene({ event: event({ phase: 'reveal' }) })).toEqual({
      scene: 'phase',
      phase: 'reveal',
    });
  });
});

describe('gallery + board labels', () => {
  it('currentGiftId only when that gift is visible; hidden gifts and registered gifts never appear', () => {
    const gifts = [
      g('A', 2, 'opened'),
      g('B', 1, 'registered'),
      g('C', 3, 'opened', { hidden: true }),
    ];
    const list = projectGiftList(
      { role: 'display' },
      'gift_opening',
      gifts,
      people,
      new Date(),
      'A',
    );
    expect(list).toMatchObject({ mode: 'gallery', currentGiftId: 'A' });
    expect(list.mode === 'gallery' && list.gifts.map((x) => x.giftId)).toEqual(['A']);
    expect(
      projectGiftList({ role: 'display' }, 'gift_opening', gifts, people, new Date(), 'C'),
    ).toMatchObject({ currentGiftId: null });
    // registration phase: counts only, hidden excluded
    expect(projectGiftList({ role: 'display' }, 'gift_registration', gifts, people)).toEqual({
      mode: 'count_only',
      count: 2,
    });
  });

  it('gallery is sorted by random alias, never by opening order; no ordering fields leak', () => {
    const gifts = [
      g('A', 9, 'opened', { openingOrder: 1 }),
      g('B', 2, 'opened', { openingOrder: 2 }),
    ];
    const list = projectGiftList(
      { role: 'participant', participantId: 'P2' },
      'voting',
      gifts,
      people,
    );
    expect(list.mode === 'gallery' && list.gifts.map((x) => x.alias)).toEqual(['Gift 2', 'Gift 9']);
    expect(JSON.stringify(list)).not.toMatch(/openingOrder|createdAt|openedAt|aliasNo/);
  });

  it('board labels are gift aliases (never givers); unknown ids fall back to a neutral label', () => {
    const result = canPublishBallots(
      ['A', 'A', 'A', 'B', 'C', 'D', 'D'].map((entryId, i) => ({ voterId: `V${i}`, entryId })),
      { topN: 2 },
    );
    const board = projectLeaderboard(
      { boardKey: 'best_gift', state: 'live', lastPublished: result },
      { A: giftLabel({ aliasNo: 7 }) },
    );
    expect(board.entries.map((e) => e.label)).toEqual(['Gift 7', 'Gift']); // D has no label -> neutral fallback
    expect(JSON.stringify(board)).not.toMatch(/Secret Giver|P1/);
    const unknown = projectLeaderboard({ boardKey: 'b', state: 'live', lastPublished: result });
    expect(unknown.entries[0]!.label).toBe('Gift');
  });
});

describe('board message + ceremony scene', () => {
  const unsafe = canPublishBallots(
    ['A', 'B', 'C'].map((entryId, i) => ({ voterId: `V${i}`, entryId })),
    { topN: 3 },
  );

  it('a live board that is unsafe shows the neutral message and no entries; hidden boards are omitted', () => {
    const live = projectLeaderboard({ boardKey: 'funniest', state: 'live', lastPublished: unsafe });
    expect(live).toMatchObject({ message: 'christmas_magic', entries: [] });
    const all = projectLeaderboards(
      [
        { boardKey: 'a', state: 'live', lastPublished: unsafe },
        { boardKey: 'b', state: 'hidden', lastPublished: null },
      ],
      () => ({}),
    );
    expect(all.boards.map((b) => b.boardKey)).toEqual(['a']);
  });

  it('a running ceremony replaces the phase scene; idle/cancelled shows the normal scene', () => {
    const base: SceneInput = {
      event: event({ phase: 'awards' }),
      activeParticipants: 2,
      gifts: [],
      people,
      join: null,
      votedCount: null,
    };
    const step = {
      status: 'running',
      index: 1,
      total: 5,
      endsAt: null,
      step: { type: 'intro' },
    } as const;
    expect(projectScene({ ...base, ceremony: step })).toMatchObject({ scene: 'ceremony' });
    expect(projectScene({ ...base, ceremony: { ...step, status: 'cancelled' } }).scene).not.toBe(
      'ceremony',
    );
    expect(
      OutputSchemas.display.scene.parse(projectScene({ ...base, ceremony: step })),
    ).toBeTruthy();
  });
});

describe('opening countdown (server-driven)', () => {
  const base = (seconds: number | undefined): SceneInput => ({
    event: event({
      phase: 'gift_opening',
      currentGiftId: 'G1',
      ...(seconds === undefined ? {} : { openingCountdownSeconds: seconds }),
    }),
    activeParticipants: 2,
    gifts: [g('G1', 1, 'opened', { openedAt: '2026-12-24T20:00:00.000Z' })],
    people,
    join: null,
    votedCount: null,
  });

  it('deadline = openedAt + countdownSeconds; 0/unset means reveal immediately', () => {
    expect(projectScene(base(3))).toMatchObject({
      scene: 'opening',
      countdownSeconds: 3,
      countdownEndsAt: '2026-12-24T20:00:03.000Z',
    });
    expect(projectScene(base(0))).toMatchObject({ countdownSeconds: 0, countdownEndsAt: null });
    expect(projectScene(base(undefined))).toMatchObject({ countdownEndsAt: null });
  });

  it('the payload validates and exposes no opening-order metadata', () => {
    const scene = projectScene(base(3));
    expect(OutputSchemas.display.scene.parse(scene)).toBeTruthy();
    expect(JSON.stringify(scene)).not.toMatch(/openedAt|openingOrder|createdAt/);
  });
});
