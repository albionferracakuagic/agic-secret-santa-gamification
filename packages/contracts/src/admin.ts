import { z } from 'zod';
import { IdSchema, IsoDateSchema, ParticipantStatusSchema, PhaseSchema } from './common.js';
import { CeremonyStatusSchema } from './output.js';

/** POST /api/events/:eventId/participants/:participantId/remove (organizer). Drops the session, hides their gift. */
export const RemoveParticipantRequestSchema = z.strictObject({
  reason: z.string().trim().max(300).optional(),
});
export const RemoveParticipantResponseSchema = z.strictObject({
  participantId: IdSchema,
  status: z.literal('removed'),
  /** Votes deleted because voting was still open (after close they stay and are flagged in the integrity review). */
  votesRemoved: z.number().int().min(0),
});

/**
 * GET /api/events/:eventId/stats (masked): counts only.
 * No names, no vote content; `votedCount` is the PUBLISHED counter.
 */
export const EventStatsSchema = z.strictObject({
  phase: PhaseSchema,
  paused: z.boolean(),
  participants: z.record(ParticipantStatusSchema, z.number().int().min(0)),
  gifts: z.strictObject({
    registered: z.number().int().min(0),
    opened: z.number().int().min(0),
    revealed: z.number().int().min(0),
    hidden: z.number().int().min(0),
  }),
  voting: z.strictObject({
    status: z.enum(['not_open', 'open', 'closed']),
    votedCount: z.number().int().min(0).nullable(),
    round: z.number().int().min(1),
  }),
  ceremony: CeremonyStatusSchema,
  reactionsEnabled: z.boolean(),
});

export const INTEGRITY_ANOMALIES = [
  'vote_from_inactive_participant',
  'vote_for_own_gift',
  'vote_for_hidden_gift',
  'vote_for_unopened_gift',
] as const;

/**
 * GET /api/events/:eventId/integrity (masked aggregates). Counts per anomaly type and per category;
 * no voter ids, no gift ids, no vote content. Details need an active unmask grant (see details endpoint).
 */
export const IntegrityReportSchema = z.strictObject({
  round: z.number().int().min(1),
  categories: z.array(
    z.strictObject({
      boardKey: z.string(),
      voters: z.number().int().min(0),
      belowPrivacyFloor: z.boolean(),
    }),
  ),
  anomalies: z.record(z.enum(INTEGRITY_ANOMALIES), z.number().int().min(0)),
  clean: z.boolean(),
});

/** GET /api/events/:eventId/integrity/details (needs x-unmask-grant; every read audited). */
export const IntegrityDetailsSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      anomaly: z.enum(INTEGRITY_ANOMALIES),
      boardKey: z.string(),
      voterId: IdSchema,
      giftId: IdSchema,
      at: IsoDateSchema,
    }),
  ),
});
