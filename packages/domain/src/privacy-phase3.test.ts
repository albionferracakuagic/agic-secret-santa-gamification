import { describe, expect, it } from 'vitest';
import {
  AuctionViewSchema,
  AuctionWonAnnouncementSchema,
  ArchiveResponseSchema,
  EventArchiveSchema,
  EventFeaturesSchema,
  FeaturesPatchSchema,
  HallOfFameResponseSchema,
  LifetimeProfileSchema,
  MyAuctionResponseSchema,
  MyCoinsResponseSchema,
  MysteryRevealAnnouncementSchema,
  OrganizerCoinsResponseSchema,
  OrganizerPrizeSchema,
  OutputSchemas,
  ROLES,
  ParticipantAnnouncementSchema,
  defaultEventSettings,
  guardOutput,
  scanForbidden,
  type AuctionViewOutput,
} from '@santa/contracts';
import {
  antiSnipe,
  coinsForActivity,
  minNextBid,
  projectEventState,
  projectScene,
  type EventSource,
} from './index.js';

const keys = (schema: unknown) => Object.keys((schema as { shape: Record<string, unknown> }).shape).sort();
const NOW = '2026-12-24T20:00:00.000Z';
const person = (id: string) => ({ participantId: id, displayName: `N-${id}`, avatar: null });

const auction: AuctionViewOutput = {
  prizeId: 'PZ',
  title: { en: 'Mystery Box 1' },
  status: 'open',
  endsAt: NOW,
  currentBid: 15,
  minNextBid: 16,
  winner: null,
  reveal: null,
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
  milestones: { giftOpeningStartedAt: null, votingClosedAt: null, revealStartedAt: null, ceremonyStartedAt: null },
});

describe('coin rules and auction maths (pure)', () => {
  const rules = defaultEventSettings().phase3;
  it('only the five activity sources earn coins; a zero rule earns nothing', () => {
    expect(coinsForActivity('game_win', rules.coinRules)).toBe(10);
    expect(coinsForActivity('achievement_unlock', rules.coinRules)).toBe(10);
    for (const a of ['joined', 'voted', 'gift_registered', 'purchase', '']) expect(coinsForActivity(a, rules.coinRules)).toBe(0);
    expect(coinsForActivity('game_play', { ...rules.coinRules, game_play: 0 })).toBe(0);
  });
  it('next bid: prize minimum first, then current + increment', () => {
    expect(minNextBid({ currentBid: null, minBid: 10, rules: { minIncrement: 5 } })).toBe(10);
    expect(minNextBid({ currentBid: 10, minBid: 10, rules: { minIncrement: 5 } })).toBe(15);
  });
  it('anti-snipe: only inside the window, bounded by maxExtensions', () => {
    const r = { antiSnipeSeconds: 15, extensionSeconds: 20, maxExtensions: 2 };
    const end = new Date('2026-12-24T20:01:00Z');
    expect(antiSnipe({ now: new Date('2026-12-24T20:00:00Z'), endsAt: end, extensions: 0, rules: r })).toEqual({ endsAt: end, extended: false });
    const hit = antiSnipe({ now: new Date('2026-12-24T20:00:50Z'), endsAt: end, extensions: 0, rules: r });
    expect(hit).toEqual({ endsAt: new Date('2026-12-24T20:01:20Z'), extended: true });
    expect(antiSnipe({ now: new Date('2026-12-24T20:00:59Z'), endsAt: end, extensions: 2, rules: r }).extended).toBe(false);
    expect(antiSnipe({ now: new Date('2026-12-24T20:00:59Z'), endsAt: end, extensions: 0, rules: { ...r, antiSnipeSeconds: 0 } }).extended).toBe(false);
  });
});

describe('Phase 3 output contracts (FR-033/034/042..044, FR-046)', () => {
  it('exact key allowlists: a new field must be added here consciously', () => {
    expect(keys(AuctionViewSchema)).toEqual(['currentBid', 'endsAt', 'minNextBid', 'prizeId', 'reveal', 'status', 'title', 'winner']);
    expect(keys(AuctionWonAnnouncementSchema)).toEqual(['at', 'prizeId', 'title', 'type', 'winner']);
    expect(keys(MysteryRevealAnnouncementSchema)).toEqual(['at', 'cue', 'prizeId', 'reveal', 'title', 'type', 'winner']);
    expect(keys(MyAuctionResponseSchema)).toEqual(['balance', 'enabled', 'prize', 'you']);
    expect(keys(MyCoinsResponseSchema)).toEqual(['balance', 'enabled', 'entries', 'held']);
    expect(keys(OrganizerCoinsResponseSchema)).toEqual(['enabled', 'issued', 'rules']); // never a per-person balance
    expect(keys(OrganizerPrizeSchema)).toEqual(['currentBid', 'endsAt', 'minBid', 'onStage', 'prizeId', 'reveal', 'status', 'title', 'winner']);
    expect(keys(EventArchiveSchema)).toEqual(['achievements', 'champion', 'completedAt', 'eventId', 'expiresAt', 'games', 'name', 'participants', 'winners', 'year']);
    expect(keys(ArchiveResponseSchema)).toEqual(['archive', 'enabled']);
    expect(keys(HallOfFameResponseSchema)).toEqual(['enabled', 'seasons', 'years']);
    expect(keys(LifetimeProfileSchema)).toEqual(['displayName', 'events', 'participationYears', 'titles', 'totalAchievements']);
    expect(keys(EventFeaturesSchema)).toEqual(['auction', 'coins', 'guessSanta', 'history', 'miniGames', 'missions', 'xpBoard']);
  });

  it('no coin/auction payload has a bidder, a leaderboard or a per-person total on a public surface', () => {
    for (const bad of ['bidderId', 'bids', 'bidCount', 'balances', 'leaderboard', 'rank', 'score']) {
      expect(keys(AuctionViewSchema)).not.toContain(bad);
      expect(keys(OrganizerCoinsResponseSchema)).not.toContain(bad);
    }
    for (const role of ROLES) {
      const scene = OutputSchemas[role].scene;
      expect(scene.safeParse({ scene: 'auction', auction }).success).toBe(true);
      expect(scene.safeParse({ scene: 'auction', auction: { ...auction, bidderId: 'P1' } }).success).toBe(false);
      expect(scene.safeParse({ scene: 'auction', auction: { ...auction, bids: [] } }).success).toBe(false);
      const ann = OutputSchemas[role].announcement;
      const won = { type: 'auction_won', prizeId: 'PZ', title: { en: 'Box' }, winner: person('W'), at: NOW };
      expect(ann.safeParse(won).success).toBe(true);
      expect(ann.safeParse({ ...won, amount: 12, losers: [] }).success).toBe(false);
    }
    expect(ParticipantAnnouncementSchema.safeParse({ type: 'bid_leading', prizeId: 'PZ', at: NOW }).success).toBe(false);
  });

  it('send guard: a leaky auction payload throws in test and is stripped + alerted in production', () => {
    const leaky = { scene: 'auction', auction: { ...auction, bidderId: 'P1' } };
    expect(() => guardOutput('display', 'scene', leaky, { env: 'test' })).toThrow();
    const alerts: unknown[] = [];
    const out = guardOutput('display', 'scene', leaky, { env: 'production', alert: (v) => alerts.push(v) });
    expect(alerts).toHaveLength(1);
    expect(scanForbidden(out, { keys: ['bidderId'] })).toEqual([]);
  });

  it('scene priority: game > auction > spotlight > phase; identical for every viewer', () => {
    const base = { event: event(), activeParticipants: 8, gifts: [], people: [], join: null, votedCount: null };
    expect(projectScene({ ...base, auction })).toEqual({ scene: 'auction', auction });
    const spot = { kind: 'santa_detective' as const, message: null, entries: [], at: NOW };
    expect(projectScene({ ...base, auction, spotlight: spot })).toEqual({ scene: 'auction', auction });
    expect(projectScene({ ...base, spotlight: spot })).toMatchObject({ scene: 'spotlight' });
  });

  it('the archive schema holds public results only', () => {
    const archive = {
      eventId: 'E',
      name: 'Party',
      year: 2026,
      completedAt: NOW,
      participants: [person('A')],
      winners: [{ boardKey: 'best_overall', name: { en: 'Best' }, grand: true, giftLabel: 'Gift 1', giftName: 'Scarf', photoUrl: null, giver: person('A') }],
      achievements: [],
      games: [],
      champion: null,
      expiresAt: NOW,
    };
    expect(EventArchiveSchema.safeParse(archive).success).toBe(true);
    for (const extra of [{ votes: [] }, { xp: 3 }, { nominees: [] }, { missions: [] }, { guesses: [] }, { bids: [] }])
      expect(EventArchiveSchema.safeParse({ ...archive, ...extra }).success).toBe(false);
    expect(EventArchiveSchema.safeParse({ ...archive, winners: [{ ...archive.winners[0], rank: 2 }] }).success).toBe(false);
  });

  it('the feature patch cannot reach a privacy floor and the organizer projection carries the flags', () => {
    for (const bad of [{ minVoters: 1 }, { hiddenMin: 1 }, { minTotalVotes: 1 }, { showTotals: true }, { settings: {} }, { phase2: { detectiveMinGuessers: 4 } }, { phase3: { coinRules: { buy: 1 } } }])
      expect(FeaturesPatchSchema.safeParse(bad).success).toBe(false);
    expect(FeaturesPatchSchema.safeParse({ phase2: { detectiveMinGuessers: 9 }, coins: true }).success).toBe(true);
    const e = event();
    const masked = projectEventState({ role: 'organizer_masked', participantId: null }, { event: { ...e, features: { xpBoard: false, guessSanta: true, missions: false, miniGames: true, coins: true, auction: false, history: false } }, participants: [], giftsRegistered: 0, ownVotes: [] });
    expect(masked).toMatchObject({ role: 'organizer_masked', organizer: { features: { guessSanta: true, coins: true }, phase2: { detectiveMinGuessers: 5 } } });
    // display/participant states never carry the switches
    expect(projectEventState({ role: 'display' }, { event: e, participants: [], giftsRegistered: 0, ownVotes: [] })).not.toHaveProperty('organizer');
  });
});
