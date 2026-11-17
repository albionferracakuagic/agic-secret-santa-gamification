import { z } from 'zod';
import { IdSchema } from './common.js';
import { PersonSchema } from './person.js';
import { SpotlightKindSchema } from './phase2-scenes.js';

/* ---------- FR-025 Guess Your Secret Santa ---------- */

export const CLUE_MIN_LENGTH = 5;
export const CLUE_MAX_LENGTH = 140;
export const CLUES_PER_GIFT = 3;

/** Positive-only result cue (FR-046: no failure animation, no penalty). */
export const GuessOutcomeSchema = z.strictObject({
  outcome: z.enum(['correct', 'incorrect']),
  cue: z.enum(['confetti', 'wink']),
  /** XP earned by this guess (0 when incorrect). Self-only. */
  xp: z.number().int().min(0),
});

/**
 * GET /api/me/guess (participant): everything the guess screen needs, own data only.
 * `suspects` = every active participant except the caller, alphabetical. `result` appears only once that gift's
 * giver is revealed. Other people's guesses are never exposed on any route or stream.
 */
export const GuessStateResponseSchema = z.strictObject({
  enabled: z.boolean(),
  suspects: z.array(PersonSchema),
  gifts: z.array(
    z.strictObject({
      giftId: IdSchema,
      alias: z.string(),
      /** guessable = open for guesses; own = the caller's own gift; revealed = giver revealed, guesses closed. */
      state: z.enum(['guessable', 'own', 'revealed']),
      myGuess: IdSchema.nullable(),
      result: GuessOutcomeSchema.nullable(),
      /** Approved anonymous clues for this gift. */
      clues: z.array(z.strictObject({ clueId: IdSchema, text: z.string() })),
    }),
  ),
});

/** PUT /api/me/guesses/:giftId: one editable guess per gift until that gift's giver is revealed. */
export const SetGuessRequestSchema = z.strictObject({ suspectId: IdSchema });
export const SetGuessResponseSchema = z.strictObject({ giftId: IdSchema, suspectId: IdSchema });

/** POST /api/me/clues: the caller (as giver) adds an anonymous clue to their own opened gift. */
export const SubmitClueRequestSchema = z.strictObject({
  text: z.string().trim().min(CLUE_MIN_LENGTH).max(CLUE_MAX_LENGTH),
});
export const ClueStatusSchema = z.enum(['pending', 'approved', 'rejected']);
/** GET /api/me/clues: only the author's own clues (status of their submissions). */
export const MyCluesResponseSchema = z.strictObject({
  clues: z.array(z.strictObject({ clueId: IdSchema, text: z.string(), status: ClueStatusSchema })),
});
export const SubmitClueResponseSchema = z.strictObject({
  clueId: IdSchema,
  status: z.literal('pending'),
});

/**
 * GET /api/events/:eventId/clues (organizer, masked): moderation queue. Gift alias + text only; the author is
 * never part of the projection (not even with an unmask grant).
 */
export const ClueQueueResponseSchema = z.strictObject({
  clues: z.array(
    z.strictObject({
      clueId: IdSchema,
      giftId: IdSchema,
      alias: z.string(),
      text: z.string(),
      status: ClueStatusSchema,
    }),
  ),
});
export const ClueDecisionRequestSchema = z.strictObject({ action: z.enum(['approve', 'reject']) });
export const ClueDecisionResponseSchema = z.strictObject({
  clueId: IdSchema,
  status: ClueStatusSchema,
});

/* ---------- presentations (Santa Detective / Invisible Santa / Mission Master) ---------- */

/**
 * POST /api/events/:eventId/presentations: organizer shows the board on the display and unlocks the rank-1
 * achievements. Everything goes through canPublish(); when it fails the display gets the neutral
 * `christmas_magic` message and the organizer (only) gets the reason code.
 */
export const PresentRequestSchema = z.strictObject({ kind: SpotlightKindSchema });
export const PresentResponseSchema = z.strictObject({
  kind: SpotlightKindSchema,
  published: z.boolean(),
  /** Organizer-only: why nothing was published (never reaches display/participants). */
  reason: z
    .enum([
      'insufficient_voters',
      'insufficient_votes',
      'no_safe_entries',
      'organizer_decision_required',
    ])
    .nullable(),
  achievementsUnlocked: z.number().int().min(0),
});
export const HideSpotlightResponseSchema = z.strictObject({ hidden: z.literal(true) });
