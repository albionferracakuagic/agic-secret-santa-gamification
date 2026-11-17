import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';
import { PersonSchema } from './person.js';

/** Localized text by locale code (`en`, `it`). */
export const LocalizedTextSchema = z.record(z.string(), z.string());
const Count = z.number().int().min(0);

export const GAME_KINDS = ['trivia', 'guess_the_gift', 'bingo', 'speed', 'mystery_santa'] as const;
export const GameKindSchema = z.enum(GAME_KINDS);
export type GameKind = z.infer<typeof GameKindSchema>;

/** `draft` and `cancelled` are organizer-only; they never reach a public surface. */
export const GAME_STATUSES = [
  'draft',
  'intro',
  'round_open',
  'round_closed',
  'results',
  'finished',
  'cancelled',
] as const;
export const GameStatusSchema = z.enum(GAME_STATUSES);
export type GameStatus = z.infer<typeof GameStatusSchema>;

/** A published top-N list (canPublish): rank only inside the published set, no scores, no totals. */
export const PublishedPeopleSchema = z.strictObject({
  /** `christmas_magic` = nothing may be shown safely (neutral fallback, no promise of a later reveal). */
  message: z.enum(['christmas_magic']).nullable(),
  entries: z.array(
    z.strictObject({ person: PersonSchema, rank: z.number().int().min(1), tied: z.boolean() }),
  ),
});
export type PublishedPeopleOutput = z.infer<typeof PublishedPeopleSchema>;

export const GameRoundViewSchema = z.strictObject({
  index: Count,
  total: z.number().int().min(1),
  prompt: LocalizedTextSchema,
  /** Answer choices; empty for speed/bingo rounds. Ids are opaque strings (option index, giftId or participantId). */
  options: z.array(z.strictObject({ id: z.string().max(64), label: LocalizedTextSchema })),
  /** Speed rounds: server time when tapping starts (false starts are ignored, never punished). */
  opensAt: IsoDateSchema.nullable(),
  /** Server deadline of the round (countdown = endsAt - serverNow). */
  endsAt: IsoDateSchema.nullable(),
  /** Plain "N answered" counter (not a vote: games are not covered by FR-013). */
  submissionCount: Count,
  /** Set once the round is closed: ids of the correct options (null while open / not applicable). */
  correctOptionIds: z.array(z.string()).nullable(),
});

/** What the display shows for the active mini-game (identical for every viewer; no per-person data). */
export const GameViewSchema = z.strictObject({
  gameId: IdSchema,
  kind: GameKindSchema,
  title: LocalizedTextSchema,
  rules: LocalizedTextSchema,
  status: z.enum(['intro', 'round_open', 'round_closed', 'results']),
  stepEndsAt: IsoDateSchema.nullable(),
  round: GameRoundViewSchema.nullable(),
  results: PublishedPeopleSchema.nullable(),
});
export type GameViewOutput = z.infer<typeof GameViewSchema>;

export const SPOTLIGHT_KINDS = ['santa_detective', 'invisible_santa', 'mission_master'] as const;
export const SpotlightKindSchema = z.enum(SPOTLIGHT_KINDS);
export type SpotlightKind = z.infer<typeof SpotlightKindSchema>;

/** Phase 2 advanced presentation (Santa Detective / Invisible Santa / Mission Master), canPublish-gated. */
export const SpotlightSchema = PublishedPeopleSchema.extend({
  kind: SpotlightKindSchema,
  at: IsoDateSchema,
});
export type SpotlightOutput = z.infer<typeof SpotlightSchema>;
