import { z } from 'zod';
import { IdSchema, ReactionKindSchema } from './common.js';

export const StreamIdSchema = z.string().regex(/^(pub|org|p:[\w-]+|grant:[\w-]+)$/);

export const SurfaceNameSchema = z.enum(['eventState', 'giftList', 'leaderboard']);

/** server -> client. Payloads are produced by role projectors and validated before emit. */
export const ServerEvents = {
  snapshot: z.strictObject({
    stream: StreamIdSchema,
    cursor: z.number().int().min(0),
    data: z.record(z.string(), z.unknown()),
  }),
  delta: z.strictObject({
    stream: StreamIdSchema,
    cursor: z.number().int().min(1),
    surface: SurfaceNameSchema,
    payload: z.unknown(),
  }),
  /**
   * Aggregated cheer burst (FR-037): `count` reactions of one kind in the last flush window.
   * Sent to the pub room (participants + display). Never tied to a person or a gift.
   */
  reaction: z.strictObject({ kind: ReactionKindSchema, count: z.number().int().min(1).max(500) }),
  'grant.revoked': z.strictObject({
    grantId: IdSchema,
    reason: z.enum(['expired', 'revoked', 'membership', 'session']),
  }),
  'time.sync': z.strictObject({ clientTime: z.number(), serverTime: z.number() }),
  error: z.strictObject({ code: z.enum(['forbidden', 'bad_request', 'rate_limited']) }),
} as const;

/** client -> server: ephemeral only; all state changes go through REST. */
export const ClientEvents = {
  /** Organizers must name the event; guests/displays are bound to theirs by their session. */
  subscribe: z.strictObject({ eventId: IdSchema.optional() }),
  /** Joins the grant-scoped unmasked channel; authz is re-checked before every send. */
  'grant.subscribe': z.strictObject({ grantId: IdSchema }),
  'reaction.send': z.strictObject({ kind: ReactionKindSchema }),
  'time.ping': z.strictObject({ clientTime: z.number() }),
} as const;

export type ServerEventName = keyof typeof ServerEvents;
export type ClientEventName = keyof typeof ClientEvents;
