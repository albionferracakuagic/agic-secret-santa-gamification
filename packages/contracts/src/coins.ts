import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';
import { CoinRulesSchema } from './settings.js';

/* ---------- FR-033 Santa Coins ---------- */

/**
 * Why a ledger entry exists. There is deliberately no `purchase`, `transfer`, `convert` or `cash_out` reason:
 * coins are only earned (rules below or organizer grants) and only spent on auction bids.
 */
export const COIN_REASONS = [
  'game_play',
  'game_win',
  'mission_completed',
  'guess_correct',
  'achievement_unlock',
  'organizer_grant',
  'bid_hold',
  'bid_release',
] as const;
export const CoinReasonSchema = z.enum(COIN_REASONS);
export type CoinReason = z.infer<typeof CoinReasonSchema>;

/**
 * GET /api/me/coins (participant): the caller's OWN balance and ledger. There is no coin board, no total across
 * people and no route that shows anyone else's balance.
 */
export const MyCoinsResponseSchema = z.strictObject({
  enabled: z.boolean(),
  /** Spendable now (earned - held - spent). */
  balance: z.number().int(),
  /** Locked by bids where the caller currently leads. */
  held: z.number().int().min(0),
  entries: z.array(
    z.strictObject({
      reason: CoinReasonSchema,
      /** Signed: earnings are positive, bid holds negative, released holds positive. */
      amount: z.number().int(),
      at: IsoDateSchema,
    }),
  ),
});

/** POST /api/events/:eventId/coins/grants: organizer-defined earning (idempotent per `key` and participant). */
export const CoinGrantRequestSchema = z.strictObject({
  /** Idempotency of the grant itself: repeating the same key never pays twice. */
  key: z.string().trim().min(3).max(40).regex(/^[\w-]+$/),
  amount: z.number().int().min(1).max(1000),
  /** Default: every active participant. */
  participantIds: z.array(IdSchema).min(1).max(100).optional(),
});
export const CoinGrantResponseSchema = z.strictObject({ granted: z.number().int().min(0) });

/** GET /api/events/:eventId/coins (organizer, masked): rules + one aggregate, never a person's balance. */
export const OrganizerCoinsResponseSchema = z.strictObject({
  enabled: z.boolean(),
  rules: CoinRulesSchema,
  issued: z.number().int().min(0),
});
