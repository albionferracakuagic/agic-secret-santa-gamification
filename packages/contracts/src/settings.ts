import { z } from 'zod';
import { AutopilotSettingsSchema } from './autopilot.js';

/** Phase 2 rules/rewards. XP granted from these is non-qualifying (cannot leak guess/game results into Christmas Champion). */
export const Phase2SettingsSchema = z.strictObject({
  guessCorrectXp: z.number().int().min(0).max(500).default(20),
  missionXp: z.number().int().min(0).max(500).default(30),
  gameParticipationXp: z.number().int().min(0).max(500).default(5),
  gameWinnerXp: z.number().int().min(0).max(500).default(25),
  /** Distinct guessers needed before Santa Detective / Invisible Santa may be published (floor 5, raise only). */
  detectiveMinGuessers: z.number().int().min(5).max(100).default(5),
  missionsPerParticipant: z.number().int().min(1).max(3).default(1),
  /** none = honor system (completion counts at once); organizer = the organizer verifies each submission. */
  missionVerification: z.enum(['none', 'organizer']).default('none'),
  /** How many times a participant may swap an assigned mission for another one. */
  missionSwaps: z.number().int().min(0).max(3).default(1),
});
export type Phase2Settings = z.infer<typeof Phase2SettingsSchema>;
/** Events created before Phase 2 have no phase2 block: fall back to defaults. */
export const phase2Settings = (s: { phase2?: unknown }): Phase2Settings =>
  Phase2SettingsSchema.parse(s.phase2 ?? {});

/** Santa Coin earn amounts per activity (FR-033). 0 disables an earn rule. Coins are never bought or converted. */
export const CoinRulesSchema = z.strictObject({
  game_play: z.number().int().min(0).max(1000).default(2),
  game_win: z.number().int().min(0).max(1000).default(10),
  mission_completed: z.number().int().min(0).max(1000).default(10),
  guess_correct: z.number().int().min(0).max(1000).default(5),
  achievement_unlock: z.number().int().min(0).max(1000).default(10),
});
export type CoinRules = z.infer<typeof CoinRulesSchema>;

export const AuctionRulesSchema = z.strictObject({
  /** A bid must beat the current one by at least this many coins. */
  minIncrement: z.number().int().min(1).max(1000).default(1),
  /** A bid in the last `antiSnipeSeconds` extends the deadline by `extensionSeconds` (max `maxExtensions` times). */
  antiSnipeSeconds: z.number().int().min(0).max(300).default(15),
  extensionSeconds: z.number().int().min(5).max(300).default(15),
  maxExtensions: z.number().int().min(0).max(20).default(5),
});
export type AuctionRules = z.infer<typeof AuctionRulesSchema>;

export const Phase3SettingsSchema = z.strictObject({
  coinRules: CoinRulesSchema.prefault({}),
  auction: AuctionRulesSchema.prefault({}),
});
export type Phase3Settings = z.infer<typeof Phase3SettingsSchema>;
/** Events created before Phase 3 have no `phase3` block: fall back to defaults. */
export const phase3Settings = (s: { phase3?: unknown }): Phase3Settings =>
  Phase3SettingsSchema.parse(s.phase3 ?? {});

/** Every organizer feature switch, all explicit (organizer event state + PATCH response). */
export const EventFeaturesSchema = z.strictObject({
  xpBoard: z.boolean(),
  guessSanta: z.boolean(),
  missions: z.boolean(),
  miniGames: z.boolean(),
  coins: z.boolean(),
  auction: z.boolean(),
  history: z.boolean(),
});
export type EventFeatures = z.infer<typeof EventFeaturesSchema>;
export const DEFAULT_EVENT_FEATURES: EventFeatures = {
  xpBoard: false,
  guessSanta: false,
  missions: false,
  miniGames: true,
  coins: false,
  auction: false,
  history: false,
};
export const eventFeatures = (s: {
  features?: Partial<Record<string, unknown>>;
}): EventFeatures => {
  const f = s.features ?? {};
  const pick = (k: keyof EventFeatures) =>
    typeof f[k] === 'boolean' ? (f[k] as boolean) : DEFAULT_EVENT_FEATURES[k];
  return {
    xpBoard: pick('xpBoard'),
    guessSanta: pick('guessSanta'),
    missions: pick('missions'),
    miniGames: pick('miniGames'),
    coins: pick('coins'),
    auction: pick('auction'),
    history: pick('history'),
  };
};

/**
 * PATCH /api/events/:eventId/features (organizer): flips feature switches and tunes Phase 2/3 rules.
 * Deliberately has NO key for the privacy floors (minVoters, hiddenMin, minTotalVotes, showTotals...);
 * `detectiveMinGuessers` can only be raised (schema min 5).
 */
export const FeaturesPatchSchema = z
  .strictObject({
    guessSanta: z.boolean().optional(),
    missions: z.boolean().optional(),
    miniGames: z.boolean().optional(),
    coins: z.boolean().optional(),
    auction: z.boolean().optional(),
    history: z.boolean().optional(),
    phase2: Phase2SettingsSchema.partial().optional(),
    phase3: z
      .strictObject({
        coinRules: CoinRulesSchema.partial().optional(),
        auction: AuctionRulesSchema.partial().optional(),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'empty patch' });

export type FeaturesPatch = z.infer<typeof FeaturesPatchSchema>;

export const TieBreakSchema = z.enum(['shared', 'secondary', 'organizer']);

/** Floors are non-overridable: schema only accepts equal-or-stricter values (ADR-0003). */
export const EventSettingsSchema = z.strictObject({
  topN: z.number().int().min(1).max(10).default(3),
  hiddenMin: z.number().int().min(2).default(2),
  minVoters: z.number().int().min(5).default(5),
  minTotalVotes: z.number().int().min(5).default(5),
  cadenceSeconds: z.number().int().min(5).max(120).default(10),
  tieBreak: TieBreakSchema.default('shared'),
  /** Gift opening order: shuffled (default) or organizer-defined. Changed via POST .../opening/order. */
  openingMode: z.enum(['random', 'manual']).default('random'),
  showTotals: z.boolean().default(false),
  liveBoardMinVoters: z.number().int().min(5).default(10),
  /** Display countdown before a gift being opened is shown (seconds, 0 = none). Server-driven. */
  openingCountdownSeconds: z.number().int().min(0).max(10).default(3),
  xpValues: z
    .strictObject({
      joined: z.number().int().min(0).default(10),
      gift_registered: z.number().int().min(0).default(20),
      voted: z.number().int().min(0).default(15),
    })
    .prefault({}),
  features: z
    .strictObject({
      xpBoard: z.boolean().default(false),
      reactionsEnabled: z.boolean().default(true),
      /** Auto-approve picked roster names: base access only, never secrets (`verified: false`). */
      autoApproveJoin: z.boolean().default(false),
      /** Phase 2 (FR-025..027): Guess Your Secret Santa, giver clues, Santa Detective. */
      guessSanta: z.boolean().default(false),
      /** Phase 2 (FR-028..030): secret missions. */
      missions: z.boolean().default(false),
      /** Mini-games (FR-031/032): the organizer can switch the whole feature off. */
      miniGames: z.boolean().default(true),
      /** Phase 3 (FR-033): Santa Coins. Never purchasable, never convertible. */
      coins: z.boolean().default(false),
      /** Phase 3 (FR-034): mystery reward auction (needs coins). */
      auction: z.boolean().default(false),
      /** Phase 3 (FR-042..044): keep an archive + Hall of Fame entry when the event completes. */
      history: z.boolean().default(false),
    })
    .prefault({}),
  retention: z
    .strictObject({
      /** Gift photos are deleted this many days after the event completes (default 90). */
      photoDays: z.number().int().min(1).default(90),
      /** Roster emails are erased this many days after completion (data minimisation). */
      emailDays: z.number().int().min(1).default(30),
      /** The history archive snapshot is deleted this many days after completion (default 2 years). */
      archiveDays: z.number().int().min(1).default(730),
    })
    .prefault({}),
  /** Category whose winner is the Grand Champion in the ceremony. */
  grandChampionBoard: z.string().default('best_overall'),
  ceremonyCountdownSeconds: z.number().int().min(3).max(30).default(5),
  phase2: Phase2SettingsSchema.prefault({}),
  phase3: Phase3SettingsSchema.prefault({}),
  /** Show autopilot timings (preset + per-step overrides). Absent on older events: defaults apply. */
  autopilot: AutopilotSettingsSchema.prefault({}),
});
export type EventSettings = z.infer<typeof EventSettingsSchema>;

export const defaultEventSettings = (): EventSettings => EventSettingsSchema.parse({});

/** Default voting categories (EN/IT) created with every event; all vote-derived output goes via canPublish(). */
export const DEFAULT_CATEGORIES = [
  { key: 'most_thoughtful', name: { en: 'Most Thoughtful', it: 'Più Premuroso' } },
  { key: 'most_creative', name: { en: 'Most Creative', it: 'Più Creativo' } },
  { key: 'funniest', name: { en: 'Funniest', it: 'Più Divertente' } },
  { key: 'best_presentation', name: { en: 'Best Presentation', it: 'Miglior Confezione' } },
  { key: 'biggest_surprise', name: { en: 'Biggest Surprise', it: 'Più Sorprendente' } },
  { key: 'best_overall', name: { en: 'Best Overall', it: 'Miglior Regalo in Assoluto' } },
] as const;

export const SETUP_WARNINGS = ['roster_below_voter_floor'] as const;
export type SetupWarning = (typeof SETUP_WARNINGS)[number];
