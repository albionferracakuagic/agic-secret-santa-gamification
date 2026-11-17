import { z } from 'zod';
import { IdSchema, ReactionKindSchema } from './common.js';

export const StreamIdSchema = z.string().regex(/^(pub|org|p:[\w-]+|grant:[\w-]+)$/);

export const SurfaceNameSchema = z.enum([
  'eventState',
  'giftList',
  'leaderboard',
  'leaderboards',
  'scene',
  'announcement',
]);

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

/**
 * Which stream carries which surface (ADR-0002). Streams: `pub` (everyone in the event incl. the display),
 * `p:<participantId>` (one participant), `org` (organizers, masked), `grant:<id>` (unmasked, one socket).
 * A participant socket is subscribed to `pub` AND its own `p:<id>`; the display only to `pub`.
 *
 * - eventState   : pub (display role), p:<id> (participant role: own XP/level, own votes), org (masked)
 * - giftList     : pub (aliases only; counts-only during registration), grant:<id> (unmasked)
 * - scene        : pub only (lobby/opening/voting/phase/ceremony; identical for every viewer)
 * - leaderboards : pub only (top-N published boards; identical for every viewer). "Is this entry mine?" =
 *                  `entry.entryId === GET /api/me/gift .giftId`; there is no per-person board payload.
 * - announcement : pub (achievements earned by a named winner/champion) and p:<id> (personal ones such as
 *                  Christmas Spirit, delivered only to that participant)
 * - leaderboard  : deprecated single-board alias of `leaderboards[0]`, pub only
 * Reactions are a separate `reaction` event to the pub room (aggregated, no identity).
 */
export const SURFACE_STREAMS = {
  eventState: ['pub', 'p', 'org', 'grant'],
  giftList: ['pub', 'grant'],
  scene: ['pub'],
  leaderboards: ['pub'],
  leaderboard: ['pub'],
  announcement: ['pub', 'p'],
} as const;
