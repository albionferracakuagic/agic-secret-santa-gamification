import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';
import { PersonSchema } from './person.js';

/** Photo upload cap (multipart field `photo`); processed server-side (resize + EXIF strip). */
export const GIFT_MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export const GiftStatusSchema = z.enum(['registered', 'opened', 'revealed']);

/** PUT /api/me/gift (guest session, phase gift_registration). First save registers the gift (+20 XP once). */
export const GiftInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
});

/** The giver's OWN gift (before opening only the giver sees it). GET/PUT /api/me/gift, photo endpoints. */
export const OwnGiftSchema = z.strictObject({
  giftId: IdSchema,
  alias: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  photoUrl: z.string().nullable(),
  status: GiftStatusSchema,
});
export const OwnGiftResponseSchema = z.strictObject({
  gift: OwnGiftSchema.nullable(),
  /** false once gift registration is over or the gift was opened. */
  editable: z.boolean(),
});

/**
 * GET /api/me/assignment: who the caller gives to, derived from pairings (never copied onto the gift).
 * 403 `verification_required` unless the claim was verified (email link, personal code, organizer approval).
 */
export const MyAssignmentResponseSchema = z.strictObject({
  recipient: PersonSchema,
});

/** Organizer moderation view: content only, by alias. No giver, no recipient, no order metadata. */
export const OrganizerGiftSchema = z.strictObject({
  giftId: IdSchema,
  alias: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  photoUrl: z.string().nullable(),
  status: GiftStatusSchema,
  hidden: z.boolean(),
});
export const OrganizerGiftListResponseSchema = z.strictObject({
  gifts: z.array(OrganizerGiftSchema),
});

/** PATCH /api/events/:eventId/gifts/:giftId. `hidden` removes the gift from opening, gallery and voting. */
export const GiftModerationRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  removePhoto: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

/** POST /api/events/:eventId/opening/order. `random` reshuffles unopened gifts; `manual` = full permutation of unopened gift ids. */
export const OpeningOrderRequestSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('random') }),
  z.strictObject({ mode: z.literal('manual'), order: z.array(IdSchema).min(1).max(200) }),
]);

/** GET /api/events/:eventId/opening, POST .../opening/order, POST .../opening/next (organizer). */
export const OpeningStateSchema = z.strictObject({
  mode: z.enum(['random', 'manual']),
  openedCount: z.number().int().min(0),
  total: z.number().int().min(0),
  /** Gift being opened right now (opened gifts are visible to everyone). */
  currentGiftId: IdSchema.nullable(),
  allOpened: z.boolean(),
  /**
   * Server-driven reveal countdown for the gift being opened: show "3-2-1" until `countdownEndsAt`
   * (absolute server time; use /api/time for clock offset). 0 / null = reveal immediately.
   */
  countdownSeconds: z.number().int().min(0).max(10),
  countdownEndsAt: IsoDateSchema.nullable(),
});

/** POST /api/events/:eventId/reveal/gifts/:giftId and /reveal/all (phase reveal; irreversible, idempotent). */
export const RevealGiftResponseSchema = z.strictObject({
  giftId: IdSchema,
  status: z.literal('revealed'),
  revealedAt: IsoDateSchema,
});
export const RevealAllResponseSchema = z.strictObject({ revealed: z.number().int().min(0) });
