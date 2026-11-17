import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';
import { PersonSchema } from './person.js';
import { LocalizedTextSchema } from './phase2-scenes.js';

/* ---------- FR-034 Mystery reward auction ---------- */

export const PRIZE_STATUSES = ['draft', 'open', 'closed', 'revealed', 'cancelled'] as const;
export const PrizeStatusSchema = z.enum(PRIZE_STATUSES);
export type PrizeStatus = z.infer<typeof PrizeStatusSchema>;

/**
 * Public view of the prize on stage (display + participants, identical for everybody).
 * Bids are shown WITHOUT bidders: only the current price. The winner is named once the auction closes (positive
 * recognition); the mystery content (`reveal`) appears only at the reveal step, never before.
 */
export const AuctionViewSchema = z.strictObject({
  prizeId: IdSchema,
  title: LocalizedTextSchema,
  status: z.enum(['open', 'closed', 'revealed']),
  /** Server deadline (countdown = endsAt - serverNow); moves forward on anti-snipe extensions. */
  endsAt: IsoDateSchema.nullable(),
  /** Current price (null until the first bid). No bidder, no bid count, no history. */
  currentBid: z.number().int().min(0).nullable(),
  /** What the next bid must reach at least. */
  minNextBid: z.number().int().min(1),
  /** Set once closed (null = nobody bid). */
  winner: PersonSchema.nullable(),
  /** Mystery box content; only after the reveal. */
  reveal: LocalizedTextSchema.nullable(),
});
export type AuctionViewOutput = z.infer<typeof AuctionViewSchema>;

/** GET /api/me/auction: the public view + the caller's own position (never anyone else's). */
export const MyAuctionResponseSchema = z.strictObject({
  enabled: z.boolean(),
  balance: z.number().int(),
  prize: AuctionViewSchema.nullable(),
  you: z
    .strictObject({
      /** "You are leading": the only bidder information any participant ever gets. */
      leading: z.boolean(),
      myBid: z.number().int().min(0).nullable(),
    })
    .nullable(),
});

/** POST /api/me/auction/bids: hold `amount` coins on the prize on stage (the previous leader's hold is released). */
export const PlaceBidRequestSchema = z.strictObject({ amount: z.number().int().min(1).max(1_000_000) });
export const PlaceBidResponseSchema = z.strictObject({
  prizeId: IdSchema,
  amount: z.number().int(),
  leading: z.literal(true),
  endsAt: IsoDateSchema,
  /** The bid landed in the closing window and pushed the deadline (anti-snipe). */
  extended: z.boolean(),
});

/* organizer */

export const CreatePrizeRequestSchema = z.strictObject({
  /** Public label of the mystery box, e.g. "Mystery Box 1". */
  title: LocalizedTextSchema.refine((t) => typeof t['en'] === 'string' && t['en'].length > 0),
  /** What is really inside: organizer-only until the reveal. */
  reveal: LocalizedTextSchema.refine((t) => typeof t['en'] === 'string' && t['en'].length > 0),
  minBid: z.number().int().min(1).max(100_000).default(1),
});
export const UpdatePrizeRequestSchema = z.strictObject({
  title: LocalizedTextSchema.optional(),
  reveal: LocalizedTextSchema.optional(),
  minBid: z.number().int().min(1).max(100_000).optional(),
});
export const OrganizerPrizeSchema = z.strictObject({
  prizeId: IdSchema,
  title: LocalizedTextSchema,
  reveal: LocalizedTextSchema,
  status: PrizeStatusSchema,
  onStage: z.boolean(),
  minBid: z.number().int(),
  endsAt: IsoDateSchema.nullable(),
  currentBid: z.number().int().nullable(),
  /** Set after the close (the winner is announced then anyway). */
  winner: PersonSchema.nullable(),
});
export const OrganizerPrizesResponseSchema = z.strictObject({
  enabled: z.boolean(),
  prizes: z.array(OrganizerPrizeSchema),
});
export const PRIZE_ACTIONS = ['open', 'close', 'reveal', 'dismiss', 'cancel'] as const;
export const PrizeActionRequestSchema = z.strictObject({
  action: z.enum(PRIZE_ACTIONS),
  /** `open` only: auction length. */
  durationSeconds: z.number().int().min(10).max(3600).optional(),
});
export const PrizeActionResponseSchema = z.strictObject({
  prizeId: IdSchema,
  status: PrizeStatusSchema,
  onStage: z.boolean(),
});

/** Announcement payloads (pub stream). */
export const AuctionWonAnnouncementSchema = z.strictObject({
  type: z.literal('auction_won'),
  prizeId: IdSchema,
  title: LocalizedTextSchema,
  winner: PersonSchema,
  at: IsoDateSchema,
});
/** Mystery-box reveal animation trigger + content. */
export const MysteryRevealAnnouncementSchema = z.strictObject({
  type: z.literal('mystery_reveal'),
  prizeId: IdSchema,
  title: LocalizedTextSchema,
  reveal: LocalizedTextSchema,
  winner: PersonSchema.nullable(),
  cue: z.literal('box_open'),
  at: IsoDateSchema,
});
