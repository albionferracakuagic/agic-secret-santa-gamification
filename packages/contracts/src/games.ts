import { z } from 'zod';
import { IdSchema } from './common.js';
import {
  GameKindSchema,
  GameStatusSchema,
  GameViewSchema,
  LocalizedTextSchema,
} from './phase2-scenes.js';

/* ---------- FR-031/032 Mini-games ---------- */

export const CustomQuestionSchema = z
  .strictObject({
    prompt: z.strictObject({
      en: z.string().trim().min(3).max(200),
      it: z.string().trim().min(3).max(200).optional(),
    }),
    options: z
      .array(
        z.strictObject({
          en: z.string().trim().min(1).max(80),
          it: z.string().trim().min(1).max(80).optional(),
        }),
      )
      .min(2)
      .max(4),
    correctIndex: z.number().int().min(0).max(3),
  })
  .refine((q) => q.correctIndex < q.options.length, { path: ['correctIndex'] });

/** Rules, timers and rewards of one game. Rewards are XP (non-qualifying); winners always go through canPublish(). */
export const GameConfigSchema = z.strictObject({
  rounds: z.number().int().min(1).max(20).optional(),
  introSeconds: z.number().int().min(0).max(60).default(5),
  roundSeconds: z.number().int().min(5).max(1800).default(20),
  /** How long a closed round (answer reveal / feedback) stays on screen before the next round opens. */
  revealSeconds: z.number().int().min(0).max(60).default(6),
  /** Trivia only: organizer questions used first, the in-house EN/IT bank fills the rest. */
  customQuestions: z.array(CustomQuestionSchema).max(20).optional(),
  /** guess_the_gift / mystery_santa: restrict the rounds to these gifts (default: all opened gifts, shuffled). */
  giftIds: z.array(IdSchema).max(40).optional(),
  /** Overrides of the event reward XP for this game only. */
  rewards: z
    .strictObject({
      participationXp: z.number().int().min(0).max(500).optional(),
      winnerXp: z.number().int().min(0).max(500).optional(),
    })
    .optional(),
});
export type GameConfig = z.infer<typeof GameConfigSchema>;

export const CreateGameRequestSchema = z.strictObject({
  kind: GameKindSchema,
  title: LocalizedTextSchema.optional(),
  config: GameConfigSchema.default(() => GameConfigSchema.parse({})),
});

export const OrganizerGameSchema = z.strictObject({
  gameId: IdSchema,
  kind: GameKindSchema,
  status: GameStatusSchema,
  title: LocalizedTextSchema,
  roundIndex: z.number().int().min(-1),
  totalRounds: z.number().int().min(0),
  config: GameConfigSchema,
});
export const OrganizerGamesResponseSchema = z.strictObject({
  games: z.array(OrganizerGameSchema),
  /** In-house content available for the organizer UI. */
  catalog: z.strictObject({
    triviaQuestions: z.number().int().min(0),
    bingoSquares: z.number().int().min(0),
  }),
});

export const GAME_ACTIONS = ['start', 'next', 'show_results', 'finish', 'cancel'] as const;
export const GameActionRequestSchema = z.strictObject({ action: z.enum(GAME_ACTIONS) });
export const GameActionResponseSchema = z.strictObject({
  gameId: IdSchema,
  status: GameStatusSchema,
  roundIndex: z.number().int().min(-1),
});

/** Participant view of the active game: the public view plus the caller's own state (never anyone else's). */
export const MyGameResponseSchema = z.strictObject({
  game: GameViewSchema.nullable(),
  me: z
    .strictObject({
      /** Answered / tapped the current round. */
      submitted: z.boolean(),
      answerId: z.string().nullable(),
      /** Own points so far (self-only; public output is top-N only, no totals). */
      score: z.number().int().min(0),
      /** Feedback for the last closed round; positive cue only. */
      lastRound: z
        .strictObject({
          outcome: z.enum(['correct', 'incorrect', 'none']),
          cue: z.enum(['confetti', 'wink']),
          points: z.number().int().min(0),
        })
        .nullable(),
      card: z
        .strictObject({
          cells: z.array(
            z.strictObject({
              cell: z.number().int().min(0).max(24),
              label: LocalizedTextSchema,
              free: z.boolean(),
              mark: z.enum(['none', 'pending', 'confirmed']),
            }),
          ),
          lines: z.number().int().min(0),
        })
        .nullable(),
    })
    .nullable(),
});

export const SubmitAnswerRequestSchema = z.strictObject({ answerId: z.string().min(1).max(64) });
export const SubmitAnswerResponseSchema = z.strictObject({
  roundIndex: z.number().int().min(0),
  accepted: z.literal(true),
});

export const BingoMarkRequestSchema = z.strictObject({ cell: z.number().int().min(0).max(24) });
export const BingoMarkResponseSchema = z.strictObject({
  cell: z.number().int().min(0).max(24),
  mark: z.enum(['pending', 'confirmed']),
});

/** GET /api/events/:eventId/games/:gameId/bingo (organizer): mark requests awaiting confirmation. */
export const BingoPendingResponseSchema = z.strictObject({
  marks: z.array(
    z.strictObject({
      markId: IdSchema,
      displayName: z.string(),
      cell: z.number().int().min(0).max(24),
      label: LocalizedTextSchema,
    }),
  ),
});
export const BingoDecisionRequestSchema = z.strictObject({ action: z.enum(['confirm', 'reject']) });
export const BingoDecisionResponseSchema = z.strictObject({
  markId: IdSchema,
  status: z.enum(['confirmed', 'rejected']),
});

/* ---------- FR-041 certificates ---------- */

export const CertificateQuerySchema = z.strictObject({ locale: z.enum(['en', 'it']).optional() });
/** GET /api/me/certificates: one downloadable PNG award card per unlocked achievement (own only). */
export const MyCertificatesResponseSchema = z.strictObject({
  certificates: z.array(
    z.strictObject({
      key: z.string(),
      title: LocalizedTextSchema,
      /** Relative URL; append `?locale=en|it`. Content-Type image/png, never cached. */
      url: z.string(),
    }),
  ),
});

export type MyGameResponse = z.infer<typeof MyGameResponseSchema>;
