import { z } from 'zod';
import { IdSchema, IsoDateSchema, LocaleSchema } from './common.js';

export const IdempotencyKeySchema = z.string().min(8).max(128);
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});

export const CreateEventRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  startsAt: IsoDateSchema,
  timezone: z.string().min(1).max(64),
  defaultLocale: LocaleSchema.default('en'),
});

export const JoinRequestSchema = z.strictObject({
  token: z.string().min(16).max(128).optional(),
  shortCode: z
    .string()
    .regex(/^[A-Z0-9]{6,8}$/)
    .optional(),
});

export const ClaimRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('email_link'), token: z.string().min(16).max(256) }),
  z.strictObject({
    method: z.literal('personal_code'),
    participantId: IdSchema,
    code: z.string().min(6).max(32),
  }),
  z.strictObject({ method: z.literal('organizer_approved'), participantId: IdSchema }),
]);

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
});
