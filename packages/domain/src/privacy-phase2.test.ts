import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AnnouncementSchema,
  ClueAnnouncementSchema,
  ClueQueueResponseSchema,
  GameRoundViewSchema,
  GameViewSchema,
  GuessResultAnnouncementSchema,
  GuessStateResponseSchema,
  MissionCompletedAnnouncementSchema,
  MyGameResponseSchema,
  MyMissionSchema,
  OrganizerMissionsResponseSchema,
  OutputSchemas,
  PublishedPeopleSchema,
  ROLES,
  SpotlightSchema,
  guardOutput,
  scanForbidden,
  type GameViewOutput,
  type SpotlightOutput,
} from '@santa/contracts';
import {
  detectiveScores,
  invisibleSantaScores,
  projectScene,
  publishPeopleBoard,
  type EventSource,
  type SettledGuess,
} from './index.js';

const keys = (schema: unknown) =>
  Object.keys((schema as { shape: Record<string, unknown> }).shape).sort();
const element = (schema: unknown) => (schema as { element: unknown }).element;
const shapeOf = (schema: unknown) => (schema as { shape: Record<string, unknown> }).shape;

const person = (id: string) => ({ participantId: id, displayName: `N-${id}`, avatar: null });
const NOW = '2026-12-24T20:00:00.000Z';

const game: GameViewOutput = {
  gameId: 'G',
  kind: 'trivia',
  title: { en: 'Trivia' },
  rules: { en: 'Rules' },
  status: 'round_open',
  stepEndsAt: NOW,
  round: {
    index: 0,
    total: 3,
    prompt: { en: 'Q?' },
    options: [{ id: '0', label: { en: 'A' } }],
    opensAt: null,
    endsAt: NOW,
    submissionCount: 2,
    correctOptionIds: null,
  },
  results: null,
};
const spotlight: SpotlightOutput = {
  kind: 'santa_detective',
  message: null,
  entries: [{ person: person('P1'), rank: 1, tied: false }],
  at: NOW,
};

const event = (): EventSource => ({
  id: 'E',
  name: 'Party',
  description: null,
  theme: 'classic',
  startsAt: NOW,
  timezone: 'Europe/Rome',
  phase: 'games',
  paused: false,
  maxParticipants: 100,
  votingRound: 1,
  defaultLocale: 'en',
  votingEndsAt: null,
  reactionsEnabled: true,
  currentGiftId: null,
  milestones: {
    giftOpeningStartedAt: null,
    votingClosedAt: null,
    revealStartedAt: null,
    ceremonyStartedAt: null,
  },
});

describe('Phase 2 output contracts (FR-025..032, FR-046)', () => {
  it('exact key allowlists: a new field must be added here consciously', () => {
    expect(keys(GameViewSchema)).toEqual([
      'gameId',
      'kind',
      'results',
      'round',
      'rules',
      'status',
      'stepEndsAt',
      'title',
    ]);
    expect(keys(GameRoundViewSchema)).toEqual([
      'correctOptionIds',
      'endsAt',
      'index',
      'opensAt',
      'options',
      'prompt',
      'submissionCount',
      'total',
    ]);
    expect(keys(PublishedPeopleSchema)).toEqual(['entries', 'message']);
    expect(Object.keys(shapeOf(element(shapeOf(PublishedPeopleSchema)['entries']))).sort()).toEqual(
      ['person', 'rank', 'tied'],
    );
    expect(keys(SpotlightSchema)).toEqual(['at', 'entries', 'kind', 'message']);
    expect(keys(AnnouncementSchema)).toEqual(['at', 'key', 'person', 'type']);
    expect(keys(ClueAnnouncementSchema)).toEqual(['alias', 'at', 'giftId', 'text', 'type']);
    expect(keys(MissionCompletedAnnouncementSchema)).toEqual(['at', 'type']);
    expect(keys(GuessResultAnnouncementSchema)).toEqual([
      'alias',
      'at',
      'cue',
      'giftId',
      'outcome',
      'type',
      'xp',
    ]);
    // private, own-data-only payloads
    expect(keys(GuessStateResponseSchema)).toEqual(['enabled', 'gifts', 'suspects']);
    expect(
      Object.keys(shapeOf(element(shapeOf(GuessStateResponseSchema)['gifts']))).sort(),
    ).toEqual(['alias', 'clues', 'giftId', 'myGuess', 'result', 'state']);
    expect(keys(MyGameResponseSchema)).toEqual(['game', 'me']);
    expect(keys(MyMissionSchema)).toEqual([
      'assignmentId',
      'completed',
      'description',
      'status',
      'swapsLeft',
      'title',
    ]);
    // organizer views are masked: no authors, no guesses, no unsubmitted missions
    expect(Object.keys(shapeOf(element(shapeOf(ClueQueueResponseSchema)['clues']))).sort()).toEqual(
      ['alias', 'clueId', 'giftId', 'status', 'text'],
    );
    expect(keys(OrganizerMissionsResponseSchema)).toEqual([
      'counts',
      'enabled',
      'pending',
      'verification',
    ]);
    expect(
      Object.keys(shapeOf(element(shapeOf(OrganizerMissionsResponseSchema)['pending']))).sort(),
    ).toEqual(['assignmentId', 'displayName', 'note', 'submittedAt', 'title']);
  });

  it('the guess result is a personal announcement: only the participant schema accepts it', () => {
    const result = {
      type: 'guess_result',
      giftId: 'G',
      alias: 'Gift 1',
      outcome: 'incorrect',
      cue: 'wink',
      xp: 0,
      at: NOW,
    };
    expect(OutputSchemas.participant.announcement.safeParse(result).success).toBe(true);
    for (const role of ROLES.filter((r) => r !== 'participant'))
      expect(OutputSchemas[role].announcement.safeParse(result).success).toBe(false);
    // positive cues only: there is no failure/negative cue to send
    expect(GuessResultAnnouncementSchema.safeParse({ ...result, cue: 'sad' }).success).toBe(false);
  });

  it('every role accepts the same public game / spotlight scenes and nothing richer', () => {
    for (const role of ROLES) {
      const scene = OutputSchemas[role].scene;
      expect(scene.safeParse({ scene: 'game', game }).success).toBe(true);
      expect(scene.safeParse({ scene: 'spotlight', spotlight }).success).toBe(true);
      // leaks are rejected, not stripped silently
      expect(
        scene.safeParse({
          scene: 'game',
          game: { ...game, round: { ...game.round!, correctIds: ['0'] } },
        }).success,
      ).toBe(false);
      expect(scene.safeParse({ scene: 'game', game: { ...game, scores: {} } }).success).toBe(false);
      expect(
        scene.safeParse({
          scene: 'spotlight',
          spotlight: { ...spotlight, entries: [{ ...spotlight.entries[0]!, score: 3 }] },
        }).success,
      ).toBe(false);
      const ann = OutputSchemas[role].announcement;
      expect(ann.safeParse({ type: 'mission_completed', at: NOW }).success).toBe(true);
      expect(
        ann.safeParse({ type: 'mission_completed', at: NOW, person: person('P') }).success,
      ).toBe(false);
      expect(ann.safeParse({ type: 'mission_completed', at: NOW, missionKey: 'x' }).success).toBe(
        false,
      );
      expect(
        ann.safeParse({
          type: 'clue',
          giftId: 'G',
          alias: 'Gift 1',
          text: 'hi',
          at: NOW,
          giverId: 'P',
        }).success,
      ).toBe(false);
    }
  });

  it('send guard: a leaky Phase 2 payload throws in test and is stripped + alerted in production', () => {
    const leaky = {
      scene: 'spotlight',
      spotlight: { ...spotlight, entries: [{ ...spotlight.entries[0]!, score: 9 }] },
    };
    expect(() => guardOutput('display', 'scene', leaky, { env: 'test' })).toThrow();
    const alerts: unknown[] = [];
    const out = guardOutput('display', 'scene', leaky, {
      env: 'production',
      alert: (v) => alerts.push(v),
    });
    expect(alerts).toHaveLength(1);
    expect(scanForbidden(out, { keys: ['score'] })).toEqual([]);
  });

  it('scene priority: ceremony > game > spotlight > phase scene; identical for every viewer', () => {
    const base = {
      event: event(),
      activeParticipants: 8,
      gifts: [],
      people: [],
      join: null,
      votedCount: null,
    };
    expect(projectScene({ ...base, game, spotlight })).toEqual({ scene: 'game', game });
    expect(projectScene({ ...base, spotlight })).toEqual({ scene: 'spotlight', spotlight });
    expect(projectScene({ ...base })).toEqual({ scene: 'phase', phase: 'games' });
    const shown = projectScene({ ...base, game });
    expect(
      scanForbidden(shown, {
        keys: ['correctIds', 'giftId', 'giverId', 'suspectId', 'guesserId', 'score', 'points'],
      }),
    ).toEqual([]);
  });
});

describe('Phase 2 derived boards obey canPublish() (property tests)', () => {
  const guessArb = fc
    .record({
      guessers: fc.integer({ min: 1, max: 12 }),
      gifts: fc.integer({ min: 2, max: 12 }),
      seed: fc.array(fc.boolean(), { minLength: 150, maxLength: 150 }),
    })
    .map(({ guessers, gifts, seed }) => {
      const out: SettledGuess[] = [];
      let k = 0;
      for (let g = 0; g < guessers; g++)
        for (let f = 0; f < gifts; f++)
          if (seed[k++ % seed.length])
            out.push({
              giftId: `f${f}`,
              giverId: `s${f % 12}`,
              guesserId: `g${g}`,
              correct: seed[k++ % seed.length]!,
            });
      return out;
    });
  const cfg = { topN: 3, minContributors: 5 };

  it('Santa Detective: <5 guessers never publishes; published = top-N, hidden tail >=2, no totals', () => {
    fc.assert(
      fc.property(guessArb, (guesses) => {
        const { scores, contributors } = detectiveScores(guesses);
        const r = publishPeopleBoard(scores, contributors, cfg);
        if (contributors < 5) expect(r.ok).toBe(false);
        if (!r.ok) return;
        const eligible = scores.filter((s) => s.score > 0).length;
        expect(eligible - r.entries.length).toBeGreaterThanOrEqual(2);
        expect(r.entries.every((e) => e.rank >= 1 && !('score' in e))).toBe(true);
        // rank 1 really is the maximum
        const best = Math.max(...scores.map((s) => s.score));
        expect(scores.find((s) => s.entryId === r.entries[0]!.entryId)!.score).toBe(best);
      }),
      { numRuns: 300 },
    );
  });

  it('Invisible Santa: only givers that nobody guessed right, under the same floors', () => {
    fc.assert(
      fc.property(guessArb, (guesses) => {
        const { scores, contributors } = invisibleSantaScores(guesses);
        const r = publishPeopleBoard(scores, contributors, cfg);
        if (contributors < 5) expect(r.ok).toBe(false);
        // every listed giver has at least one gift that was guessed, always wrongly
        for (const { entryId } of scores) {
          const mine = guesses.filter((g) => g.giverId === entryId);
          const byGift = new Map<string, SettledGuess[]>();
          for (const g of mine) byGift.set(g.giftId, [...(byGift.get(g.giftId) ?? []), g]);
          expect([...byGift.values()].some((rows) => rows.every((x) => !x.correct))).toBe(true);
        }
        if (r.ok) expect(scanForbidden(r, { keys: ['score', 'total'] })).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
