import { z } from 'zod';
import { IdSchema, IsoDateSchema, LocaleSchema, PhaseSchema } from './common.js';

export const IdempotencyKeySchema = z.string().min(8).max(128);
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});

/** Organizer reaction controls (event-wide switch + per-participant mute). */
export const ReactionSettingsRequestSchema = z.strictObject({ enabled: z.boolean() });
export const MuteParticipantRequestSchema = z.strictObject({ muted: z.boolean() });

/** One active selection per category; response echoes only the caller's own selection. */
export const CastVoteRequestSchema = z.strictObject({ categoryId: IdSchema, giftId: IdSchema });
export const OwnVotesResponseSchema = z.strictObject({
  votes: z.array(z.strictObject({ categoryId: IdSchema, giftId: IdSchema })),
});

export const UnmaskRequestSchema = z.strictObject({
  confirm: z.literal(true),
  reason: z.string().trim().min(8).max(500),
});
export const UnmaskGrantResponseSchema = z.strictObject({
  grantId: IdSchema,
  expiresAt: IsoDateSchema,
  /** Client must show the persistent "unmasked" banner until expiry/revocation. */
  banner: z.literal(true),
});

export const AuditEntrySchema = z.strictObject({
  id: IdSchema,
  actor: z.string(),
  action: z.string(),
  target: z.string().nullable(),
  reason: z.string().nullable(),
  at: IsoDateSchema,
});
export const AuditListResponseSchema = z.strictObject({ entries: z.array(AuditEntrySchema) });

export const UNMASK_GRANT_HEADER = 'x-unmask-grant';

const eventCore = {
  description: z.string().max(2000).nullable().optional(),
  theme: z.string().min(1).max(40).optional(),
  budgetText: z.string().max(120).nullable().optional(),
  /** Hard MVP cap (FR-004 / plan): never above 100. */
  maxParticipants: z.number().int().min(2).max(100).optional(),
};
export const CreateEventRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  startsAt: IsoDateSchema,
  timezone: z.string().min(1).max(64),
  defaultLocale: LocaleSchema.default('en'),
  ...eventCore,
  /** Partial settings; defaults fill the rest and privacy floors cannot be lowered. */
  settings: z.record(z.string(), z.unknown()).optional(),
});
export const UpdateEventRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  startsAt: IsoDateSchema.optional(),
  timezone: z.string().min(1).max(64).optional(),
  ...eventCore,
  settings: z.record(z.string(), z.unknown()).optional(),
});
export const PhaseChangeRequestSchema = z.strictObject({
  to: PhaseSchema,
  reason: z.string().trim().max(500).optional(),
});
export const PauseRequestSchema = z.strictObject({ paused: z.boolean() });
export const ReopenVotingRequestSchema = z.strictObject({
  reason: z.string().trim().min(8).max(500),
});
export const AddOrganizerRequestSchema = z.strictObject({ email: z.email() });
