import { describe, expect, it, vi } from 'vitest';
import {
  OutputSchemas,
  PHASES,
  ROLES,
  SURFACES,
  guardOutput,
  scanForbidden,
  type Role,
  type Phase,
  type Surface,
} from '@santa/contracts';
import {
  ProjectionForbiddenError,
  canPublishBallots,
  projectEventState,
  projectGiftList,
  projectScene,
  projectLeaderboard,
  projectLeaderboardUnmasked,
  type BoardSource,
  type EventSource,
  type GiftSource,
  type ParticipantSource,
  type Viewer,
} from './index.js';

const FUTURE = new Date(Date.now() + 600_000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

const people: ParticipantSource[] = [
  { id: 'P-ME', displayName: 'Me Self', avatar: null, status: 'active', xp: 130 },
  {
    id: 'P-GIVER-SECRET',
    displayName: 'SECRET_GIVER_NAME',
    avatar: null,
    status: 'active',
    xp: 990,
  },
  { id: 'P-REVEALED', displayName: 'Revealed Rita', avatar: null, status: 'active', xp: 400 },
  { id: 'P-OTHER', displayName: 'Other Olaf', avatar: null, status: 'pending', xp: 777 },
];

const gifts: GiftSource[] = [
  {
    id: 'G-1',
    aliasNo: 3,
    name: 'Mug',
    description: null,
    photoUrl: null,
    status: 'revealed',
    giverId: 'P-REVEALED',
    recipientId: 'P-ME',
    openingOrder: 7,
    createdAt: '2026-12-01T10:00:00Z',
    openedAt: '2026-12-24T20:00:00Z',
    hidden: false,
  },
  {
    id: 'G-2',
    aliasNo: 1,
    name: 'Scarf',
    description: 'warm',
    photoUrl: null,
    status: 'opened',
    giverId: 'P-GIVER-SECRET',
    recipientId: 'P-OTHER',
    openingOrder: 2,
    createdAt: '2026-12-01T09:00:00Z',
    openedAt: '2026-12-24T20:05:00Z',
    hidden: false,
  },
  {
    id: 'G-LASTPLACE',
    aliasNo: 2,
    name: 'Socks',
    description: null,
    photoUrl: null,
    status: 'registered',
    giverId: 'P-GIVER-SECRET',
    recipientId: 'P-REVEALED',
    openingOrder: null,
    createdAt: '2026-12-01T08:00:00Z',
    openedAt: null,
    hidden: false,
  },
];

const event = (phase: Phase): EventSource => ({
  id: 'E-1',
  name: 'Office Party',
  description: null,
  theme: 'classic',
  startsAt: '2026-12-24T19:00:00Z',
  timezone: 'Europe/Rome',
  phase,
  paused: false,
  maxParticipants: 100,
  votingRound: 1,
  defaultLocale: 'it',
  votingEndsAt: null,
  currentGiftId: null,
  reactionsEnabled: true,
  milestones: {
    giftOpeningStartedAt: null,
    votingClosedAt: null,
    revealStartedAt: null,
    ceremonyStartedAt: null,
  },
});

const result = canPublishBallots(
  ['G-2', 'G-2', 'G-2', 'G-1', 'G-LASTPLACE', 'G-LASTPLACE', 'G-X', 'G-Y'].map((entryId, i) => ({
    voterId: `VOTER-${i}`,
    entryId,
  })),
  { topN: 1, showTotals: true },
);
const board = (state: BoardSource['state']): BoardSource => ({
  boardKey: 'best_gift',
  state,
  lastPublished: result,
});

const viewers: Record<Role, Viewer> = {
  participant: { role: 'participant', participantId: 'P-ME' },
  display: { role: 'display' },
  organizer_masked: { role: 'organizer_masked', participantId: null },
  organizer_unmasked: {
    role: 'organizer_unmasked',
    participantId: null,
    grant: { grantId: 'GR-1', expiresAt: FUTURE },
  },
};

function project(role: Role, surface: Surface, phase: Phase): unknown {
  const v = viewers[role];
  if (surface === 'eventState') {
    return projectEventState(v, {
      event: event(phase),
      participants: people,
      giftsRegistered: gifts.length,
      ownVotes: [{ categoryId: 'C-1', giftId: 'G-1' }],
    });
  }
  if (surface === 'giftList') return projectGiftList(v, phase, gifts, people);
  if (surface === 'scene') {
    return projectScene({
      event: event(phase),
      activeParticipants: 3,
      gifts,
      people,
      join: { url: 'https://santa.test/j?code=ABCDEFG', shortCode: 'ABCDEFG' },
      votedCount: 4,
    });
  }
  if (surface === 'announcement') {
    return {
      type: 'achievement',
      key: 'christmas_spirit',
      person: { participantId: 'P-REVEALED', displayName: 'Revealed Rita', avatar: null },
      at: '2026-12-24T21:00:00Z',
    };
  }
  if (role === 'organizer_unmasked') {
    return projectLeaderboardUnmasked(
      v,
      'best_gift',
      [
        { entryId: 'G-2', score: 3 },
        { entryId: 'G-LASTPLACE', score: 1 },
      ],
      8,
      new Date(),
      { 'G-2': 'Gift 1', 'G-LASTPLACE': 'Gift 2' },
    );
  }
  return projectLeaderboard(board('live'), { 'G-2': 'Gift 1', 'G-1': 'Gift 3' });
}

describe('contract: every role x phase x surface validates and leaks nothing', () => {
  const secrets = {
    values: ['SECRET_GIVER_NAME', 'P-GIVER-SECRET', 'VOTER-', 'P-OTHER', 'Other Olaf'],
  };
  const unmaskedOnlyKeys = ['giverId', 'recipientId', 'score', 'voterCount', 'unmask'];
  const orderingKeys = ['createdAt', 'openedAt', 'openingOrder', 'aliasNo', 'voterId'];

  for (const role of ROLES) {
    for (const surface of SURFACES) {
      it.each(PHASES)(`${role}/${surface} @ %s`, (phase) => {
        const payload = project(role, surface, phase);
        expect(() => OutputSchemas[role][surface].parse(payload)).not.toThrow();
        const unmasked = role === 'organizer_unmasked';
        const keys = [...orderingKeys, ...(unmasked ? [] : unmaskedOnlyKeys)];
        const hits = scanForbidden(payload, { keys, ...(unmasked ? {} : secrets) });
        expect(hits).toEqual([]);
        if (role === 'display') {
          expect(scanForbidden(payload, { keys: ['xp', 'votes', 'me'] })).toEqual([]);
        }
      });
    }
  }

  it('non-top / last place never appears on public boards', () => {
    for (const role of ['participant', 'display', 'organizer_masked'] as const) {
      const payload = project(role, 'leaderboard', 'voting');
      expect(scanForbidden(payload, { values: ['G-LASTPLACE'], keys: ['score'] })).toEqual([]);
      expect(JSON.stringify(payload)).toContain('G-2');
    }
  });

  it('gift list: counts only during gift_registration; giver only when revealed', () => {
    expect(projectGiftList(viewers.participant, 'gift_registration', gifts, people)).toEqual({
      mode: 'count_only',
      count: 3,
    });
    expect(projectGiftList(viewers.display, 'registration', gifts, people)).toEqual({
      mode: 'count_only',
      count: 0,
    });
    const gallery = projectGiftList(viewers.participant, 'voting', gifts, people);
    expect(gallery.mode === 'gallery' && gallery.gifts.map((g) => [g.alias, g.status])).toEqual([
      ['Gift 1', 'opened'],
      ['Gift 3', 'revealed'],
    ]);
  });

  it('own XP self-only: other participants XP never in any non-unmasked payload', () => {
    for (const role of ['participant', 'display', 'organizer_masked'] as const) {
      for (const surface of SURFACES) {
        const s = JSON.stringify(project(role, surface, 'voting'));
        for (const xp of ['990', '400', '777']) expect(s).not.toContain(`"xp":${xp}`);
      }
    }
    const mine = projectEventState(viewers.participant, {
      event: event('voting'),
      participants: people,
      giftsRegistered: 3,
      ownVotes: [],
    });
    expect(mine.role === 'participant' && mine.me.xp).toEqual({ xp: 130, level: 2 });
    const disp = projectEventState(viewers.display, {
      event: event('voting'),
      participants: people,
      giftsRegistered: 3,
      ownVotes: [],
    });
    expect(scanForbidden(disp, { keys: ['xp', 'me'] })).toEqual([]);
  });

  it('hidden board projects no entries even if lastPublished exists', () => {
    expect(projectLeaderboard(board('hidden')).entries).toEqual([]);
  });

  it('unmasked projections require an active grant', () => {
    const noGrant = viewers.participant;
    const expired: Viewer = {
      role: 'organizer_unmasked',
      participantId: null,
      grant: { grantId: 'GR-0', expiresAt: PAST },
    };
    for (const v of [noGrant, viewers.organizer_masked, expired]) {
      expect(() => projectLeaderboardUnmasked(v, 'b', [], 0)).toThrow(ProjectionForbiddenError);
    }
    expect(() => projectGiftList(viewers.organizer_masked, 'voting', gifts, people)).not.toThrow();
    expect(() => projectGiftList(expired, 'voting', gifts, people)).toThrow(
      ProjectionForbiddenError,
    );
    expect(() =>
      projectEventState(expired, {
        event: event('voting'),
        participants: people,
        giftsRegistered: 3,
        ownVotes: [],
      }),
    ).toThrow(ProjectionForbiddenError);
  });
});

describe('send guard', () => {
  const good = project('display', 'eventState', 'voting');
  const leaky = { ...(good as object), giverId: 'P-GIVER-SECRET' };

  it('dev/test throws on unknown/leaky keys and alerts', () => {
    const alert = vi.fn();
    expect(() => guardOutput('display', 'eventState', leaky, { env: 'test', alert })).toThrow();
    expect(alert).toHaveBeenCalledOnce();
  });

  it('production strips unknown keys and alerts, delivering a clean payload', () => {
    const alert = vi.fn();
    const out = guardOutput('display', 'eventState', leaky, { env: 'production', alert });
    expect(scanForbidden(out, { keys: ['giverId'] })).toEqual([]);
    expect(alert).toHaveBeenCalledOnce();
  });

  it('production strips nested leaks, but drops (throws) structurally invalid payloads', () => {
    const nested = {
      mode: 'gallery',
      currentGiftId: null,
      gifts: [
        {
          ...(project('display', 'giftList', 'voting') as { gifts: object[] }).gifts[0],
          giverId: 'P-GIVER-SECRET',
        },
      ],
    };
    const out = guardOutput('display', 'giftList', nested, { env: 'production' });
    expect(scanForbidden(out, { keys: ['giverId'] })).toEqual([]);
    expect(() => guardOutput('participant', 'eventState', good, { env: 'production' })).toThrow();
  });

  it('a participant-role guard rejects an unmasked leaderboard shape', () => {
    const unmasked = project('organizer_unmasked', 'leaderboard', 'voting');
    expect(() => guardOutput('participant', 'leaderboard', unmasked, { env: 'test' })).toThrow();
  });
});
