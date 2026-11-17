import { describe, expect, it } from 'vitest';
import {
  AnnouncementSchema,
  CeremonyViewSchema,
  EventStatsSchema,
  IntegrityDetailsSchema,
  IntegrityReportSchema,
  MyAchievementsResponseSchema,
  OrganizerBoardSchema,
  OrganizerCeremonyStateSchema,
  OutputSchemas,
  PHASES,
  ProfileSchema,
  PublicLeaderboardSchema,
  ROLES,
  guardOutput,
  scanForbidden,
  type CeremonyStepOutput,
} from '@santa/contracts';
import { projectScene, type EventSource, type SceneInput } from './index.js';

const person = (id: string, name = id) => ({ participantId: id, displayName: name, avatar: null });
const steps: CeremonyStepOutput[] = [
  { type: 'intro' },
  { type: 'category', boardKey: 'funniest', name: { en: 'Funniest' }, grand: false },
  { type: 'category_skipped', boardKey: 'funniest', name: { en: 'Funniest' } },
  { type: 'nominees', boardKey: 'funniest', entries: [{ entryId: 'G1', label: 'Gift 1' }] },
  { type: 'countdown', seconds: 5 },
  { type: 'achievement', achievementKey: 'comedy_santa', recipients: [person('P-WIN')] },
  { type: 'spirit', recipientCount: 2 },
  { type: 'champion', person: person('P-CHAMP') },
  { type: 'outro' },
];
const winner: CeremonyStepOutput = {
  type: 'winner',
  boardKey: 'funniest',
  name: { en: 'Funniest' },
  grand: false,
  tied: false,
  winners: [{ entryId: 'G1', label: 'Gift 1', giver: person('P-WIN') }],
};

const event = (phase: (typeof PHASES)[number]): EventSource => ({
  id: 'E',
  name: 'Party',
  description: null,
  theme: 'classic',
  startsAt: '2026-12-24T19:00:00Z',
  timezone: 'Europe/Rome',
  phase,
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
});
const sceneFor = (phase: (typeof PHASES)[number], step: CeremonyStepOutput) => {
  const i: SceneInput = {
    event: event(phase),
    activeParticipants: 3,
    gifts: [],
    people: [],
    join: null,
    votedCount: null,
    ceremony: { status: 'running', index: 1, total: 9, endsAt: null, step },
  };
  return projectScene(i);
};

describe('ceremony scenes: role x phase x step', () => {
  for (const role of ROLES) {
    for (const phase of PHASES) {
      it(`${role} @ ${phase}: validates, leaks no vote/pairing/order data, giver only in the winner step`, () => {
        for (const step of [...steps, winner]) {
          const scene = guardOutput(role, 'scene', sceneFor(phase, step), { env: 'test' });
          expect(
            scanForbidden(scene, {
              keys: [
                'giverId',
                'recipientId',
                'voterId',
                'score',
                'votes',
                'xp',
                'rank',
                'openingOrder',
                'createdAt',
                'ranking',
              ],
            }),
          ).toEqual([]);
          const text = JSON.stringify(scene);
          if (step.type !== 'winner') expect(text).not.toContain('"giver"');
        }
      });
    }
  }

  it('winners list only carries the giver as a public person (no ids of pairings, no scores)', () => {
    const w = CeremonyViewSchema.parse({
      status: 'running',
      index: 4,
      total: 9,
      endsAt: null,
      step: winner,
    });
    expect(Object.keys((w.step as { winners: Array<object> }).winners[0]!).sort()).toEqual([
      'entryId',
      'giver',
      'label',
    ]);
  });

  it('strict: a leaking key on any step is rejected', () => {
    for (const leak of ['score', 'voterId', 'rank', 'votes', 'xp']) {
      const bad = {
        ...winner,
        winners: [{ ...(winner as { winners: object[] }).winners[0], [leak]: 1 }],
      };
      expect(
        CeremonyViewSchema.safeParse({
          status: 'running',
          index: 0,
          total: 1,
          endsAt: null,
          step: bad,
        }).success,
      ).toBe(false);
    }
    expect(
      CeremonyViewSchema.safeParse({
        status: 'running',
        index: 0,
        total: 1,
        endsAt: null,
        step: { type: 'nominees', boardKey: 'b', entries: [{ entryId: 'a', label: 'x', rank: 1 }] },
      }).success,
    ).toBe(false);
  });
});

/** Key allowlists: adding a field to any of these surfaces must be a conscious, reviewed change. */
describe('allowlists for new surfaces', () => {
  const keys = (s: { shape: Record<string, unknown> }) => Object.keys(s.shape).sort();
  it('exact key sets', () => {
    expect(keys(PublicLeaderboardSchema)).toEqual(['boardKey', 'entries', 'message', 'state']);
    expect(keys(AnnouncementSchema)).toEqual(['at', 'key', 'person', 'type']);
    expect(keys(ProfileSchema)).toEqual(['achievements', 'avatar', 'displayName', 'participantId']);
    expect(keys(MyAchievementsResponseSchema)).toEqual(['achievements']);
    expect(keys(OrganizerBoardSchema)).toEqual([
      'boardKey',
      'forced',
      'kind',
      'label',
      'lastPublishedAt',
      'liveAllowed',
      'publishableNow',
      'state',
    ]);
    expect(keys(OrganizerCeremonyStateSchema)).toEqual([
      'blockers',
      'canStart',
      'index',
      'outline',
      'pendingDecisions',
      'status',
      'total',
    ]);
    expect(keys(EventStatsSchema)).toEqual([
      'ceremony',
      'gifts',
      'participants',
      'paused',
      'phase',
      'reactionsEnabled',
      'voting',
    ]);
    expect(keys(IntegrityReportSchema)).toEqual(['anomalies', 'categories', 'clean', 'round']);
    expect(keys(IntegrityDetailsSchema)).toEqual(['items']);
  });

  it('public leaderboard entries have no score/total/percentile; only rank + tie flag', () => {
    const entry = (
      PublicLeaderboardSchema.shape.entries.element as { shape: Record<string, unknown> }
    ).shape;
    expect(Object.keys(entry).sort()).toEqual(['entryId', 'label', 'rank', 'tied']);
  });

  it('masked stats and integrity reports contain no ids/names even when the source object has them', () => {
    expect(
      EventStatsSchema.safeParse({
        phase: 'voting',
        paused: false,
        participants: { active: 1 },
        gifts: { registered: 1, opened: 1, revealed: 0, hidden: 0 },
        voting: { status: 'open', votedCount: null, round: 1 },
        ceremony: 'idle',
        reactionsEnabled: true,
        voterIds: ['x'],
      }).success,
    ).toBe(false);
    expect(
      IntegrityReportSchema.safeParse({
        round: 1,
        categories: [],
        anomalies: {},
        clean: true,
        items: [],
      }).success,
    ).toBe(false);
  });

  it('every role can validate every announcement and none accepts an unknown key', () => {
    const a = { type: 'achievement', key: 'x', person: person('P'), at: '2026-12-24T21:00:00Z' };
    for (const role of ROLES) {
      expect(OutputSchemas[role].announcement.safeParse(a).success).toBe(true);
      expect(OutputSchemas[role].announcement.safeParse({ ...a, score: 3 }).success).toBe(false);
    }
  });
});
