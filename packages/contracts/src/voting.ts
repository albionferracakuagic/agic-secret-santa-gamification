import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';

export const VotingCategorySchema = z.strictObject({
  id: IdSchema,
  key: z.string(),
  name: z.record(z.string(), z.string()),
  description: z.record(z.string(), z.string()).nullable(),
});

export const VotingStatusSchema = z.enum(['not_open', 'open', 'closed']);

/**
 * GET /api/me/voting (participant) and POST /api/events/:eventId/voting/open (organizer).
 * `endsAt` is a SERVER timestamp (countdown = endsAt - serverNow; the server closes at that instant).
 * `votedCount` is the published counter (cadence), never live and never per person.
 */
export const VotingStateSchema = z.strictObject({
  status: VotingStatusSchema,
  endsAt: IsoDateSchema.nullable(),
  votedCount: z.number().int().min(0).nullable(),
  categories: z.array(VotingCategorySchema),
});

/** POST /api/events/:eventId/voting/open: moves gift_opening -> voting; optional timer closes it automatically. */
export const OpenVotingRequestSchema = z.strictObject({
  durationMinutes: z.number().int().min(1).max(240).optional(),
});

/** POST /api/events/:eventId/voting/close: locks winners (via canPublish) and rejects further votes. */
export const CloseVotingResponseSchema = z.strictObject({
  closedAt: IsoDateSchema,
  categoriesLocked: z.number().int().min(0),
  /** Categories that passed the privacy policy (others get the neutral fallback). */
  categoriesPublishable: z.number().int().min(0),
});

/** POST /api/me/votes (body: CastVoteRequestSchema in rest.ts). Echoes only the caller's own selection. */
export const CastVoteResponseSchema = z.strictObject({
  categoryId: IdSchema,
  giftId: IdSchema,
  /** true only on the first vote of the event (+15 XP, once). */
  xpAwarded: z.boolean(),
});
