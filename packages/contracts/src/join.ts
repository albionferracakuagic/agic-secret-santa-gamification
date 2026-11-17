import { z } from 'zod';
import { IdSchema, IsoDateSchema, LocaleSchema, ParticipantStatusSchema } from './common.js';

/** Cookie names (HttpOnly, SameSite=Lax, set by the server only). */
export const GUEST_COOKIE_NAME = 'sg_p';
export const DISPLAY_COOKIE_NAME = 'sg_d';

/**
 * Short join code: 10 characters from a 32-symbol alphabet (50 bits). Display it grouped (ABCDE-FGHJK); input is
 * case-insensitive and ignores spaces/hyphens, so the grouped form can be typed or pasted as is.
 */
export const SHORT_CODE_LENGTH = 10;
export const ShortCodeSchema = z
  .string()
  .max(32)
  .transform((s) => s.toUpperCase().replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^[A-Z2-9]{10}$/));

/** Identifies the event on public join endpoints: the QR/link token OR the short code (never both). */
export const JoinTargetSchema = z.union([
  z.strictObject({ joinToken: z.string().min(16).max(128) }),
  z.strictObject({ shortCode: ShortCodeSchema }),
]);

/** POST /api/join/resolve -> what the join page shows. Public; rate-limited per IP. */
export const JoinResolveRequestSchema = JoinTargetSchema;
export const JoinResolveResponseSchema = z.strictObject({
  event: z.strictObject({
    name: z.string(),
    startsAt: IsoDateSchema,
    defaultLocale: LocaleSchema,
    joinOpen: z.boolean(),
  }),
  /** Roster names still available to pick (path c). Names only: no emails, no ids of others' data. */
  unclaimed: z.array(z.strictObject({ participantId: IdSchema, displayName: z.string() })),
});

/**
 * POST /api/join/claim. Verified paths (a,b) release secrets; pick_name (c) needs organizer approval
 * (or the auto-approve toggle, which only grants base access: `verified: false`).
 */
export const ClaimRequestSchema = z.discriminatedUnion('method', [
  /** (a) personal email claim link: token from the emailed URL `/j/claim?token=...` */
  z.strictObject({ method: z.literal('email_link'), token: z.string().min(16).max(128) }),
  /** (b) per-person claim code from the organizer's printed list; scoped to the event by the join target */
  z.strictObject({
    method: z.literal('personal_code'),
    target: JoinTargetSchema,
    code: z.string().regex(/^[A-Z2-9]{8,12}$/),
  }),
  /** (c) pick a roster name -> pending until the organizer approves in person */
  z.strictObject({
    method: z.literal('pick_name'),
    target: JoinTargetSchema,
    participantId: IdSchema,
  }),
]);

export const ClaimResponseSchema = z.strictObject({
  status: z.enum(['active', 'pending']),
  participantId: IdSchema,
  /** true only for verified claim paths / organizer approval; gates secrets (own recipient, missions). */
  verified: z.boolean(),
});

/** GET /api/me (guest cookie). `status: pending` = waiting for organizer approval. */
export const MeResponseSchema = z.strictObject({
  participantId: IdSchema,
  eventId: IdSchema,
  displayName: z.string(),
  avatar: z.string().nullable(),
  status: ParticipantStatusSchema,
  verified: z.boolean(),
  locale: LocaleSchema,
});

/** PATCH /api/me/profile. Avatar = preset id (no uploads here). 409 name_taken / profile_locked. */
export const ProfileUpdateRequestSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(40).optional(),
  avatar: z
    .string()
    .regex(/^[a-z0-9_-]{1,32}$/i)
    .nullable()
    .optional(),
  locale: LocaleSchema.optional(),
});

/** POST /api/join/display: exchange the organizer's display token for the display cookie. */
export const DisplayExchangeRequestSchema = z.strictObject({ token: z.string().min(16).max(128) });

/* ---------- organizer endpoints (session + event membership) ---------- */

/**
 * POST /api/events/:eventId/access -> mints a join link (+ short code) or a display token.
 * The token is returned ONCE (only its hash is stored). QR payload = `joinPath` (relative URL).
 */
export const CreateAccessRequestSchema = z.strictObject({
  kind: z.enum(['join', 'display']),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(72),
});
export const CreateAccessResponseSchema = z.strictObject({
  accessId: IdSchema,
  kind: z.enum(['join', 'display']),
  token: z.string(),
  /** join only: 6-8 chars, expiring, rate-limited */
  shortCode: z.string().nullable(),
  /** join: `/j/<token>`; display: `/d/<token>` */
  path: z.string(),
  expiresAt: IsoDateSchema,
});

/** POST /api/events/:eventId/claims/codes -> one-time list (name + code) for unclaimed roster entries. */
export const ClaimCodesResponseSchema = z.strictObject({
  codes: z.array(
    z.strictObject({ participantId: IdSchema, displayName: z.string(), code: z.string() }),
  ),
});

/** POST /api/events/:eventId/claims/email-links -> emails a personal link to unclaimed entries with an email. */
export const ClaimEmailLinksResponseSchema = z.strictObject({ sent: z.number().int().min(0) });

/** POST /api/events/:eventId/participants/:participantId/approve (pending -> active, verified, XP join) */
export const ApproveParticipantResponseSchema = z.strictObject({
  participantId: IdSchema,
  status: z.literal('active'),
});
