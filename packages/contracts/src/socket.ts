import { z } from 'zod';
import { IdSchema, ReactionKindSchema } from './common.js';

export const StreamIdSchema = z.string().regex(/^(pub|org|p:[\w-]+|grant:[\w-]+)$/);

export const SurfaceNameSchema = z.enum(['eventState', 'giftList', 'leaderboard', 'reaction']);

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
  reaction: z.strictObject({ kind: ReactionKindSchema }),
  'grant.revoked': z.strictObject({
    grantId: IdSchema,
    reason: z.enum(['expired', 'revoked', 'membership', 'session']),
  }),
  'time.sync': z.strictObject({ clientTime: z.number(), serverTime: z.number() }),
} as const;

/** client -> server: ephemeral only; all state changes go through REST. */
export const ClientEvents = {
  subscribe: z.strictObject({
    resume: z.record(StreamIdSchema, z.number().int().min(0)).optional(),
  }),
  'reaction.send': z.strictObject({ kind: ReactionKindSchema }),
  'time.ping': z.strictObject({ clientTime: z.number() }),
} as const;

export type ServerEventName = keyof typeof ServerEvents;
export type ClientEventName = keyof typeof ClientEvents;
