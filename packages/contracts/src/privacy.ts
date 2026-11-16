import { z } from 'zod';
import { IdSchema } from './common.js';

/** DELETE /api/me: the caller anonymises their own data (immediate, irreversible). */
export const DeleteMeResponseSchema = z.strictObject({
  anonymized: z.literal(true),
  /** What was erased/anonymised, for the confirmation screen. */
  erased: z.array(
    z.enum(['name', 'avatar', 'email', 'session', 'gift_photo', 'gift_text', 'claim_credentials']),
  ),
});

/** POST /api/admin/events/:eventId/takedown and /restore (platform admin only; audited). */
export const TakedownRequestSchema = z.strictObject({ reason: z.string().trim().min(8).max(500) });
export const TakedownResponseSchema = z.strictObject({
  eventId: IdSchema,
  suspended: z.boolean(),
});
/** POST /api/admin/gifts/:giftId/takedown: removes a gift's text + photo for abuse (platform admin only). */
export const GiftTakedownResponseSchema = z.strictObject({
  giftId: IdSchema,
  removed: z.literal(true),
});

/** Legal documents shipped as static markdown under doc/legal/ (owner review required before launch). */
export const LEGAL_DOCUMENTS = ['privacy', 'terms', 'cookies'] as const;
