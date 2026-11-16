import { z } from 'zod';
import { IsoDateSchema } from './common.js';

/** Board keys: a voting category key, or `xp` (participant-XP board, default off). */
export const XP_BOARD_KEY = 'xp';

export const BOARD_ACTIONS = ['enable', 'pause', 'resume', 'hide', 'publish_now'] as const;

/**
 * POST /api/events/:eventId/boards/:boardKey  (organizer)
 * - enable: turn the live board on. Below `liveBoardMinVoters` (default 10) it needs `acknowledgeSmallCohort: true`.
 * - pause / resume: freeze the current publication / resume cadence.
 * - hide: remove the board from every screen. publish_now: manual publication through the same canPublish() guard.
 * Nothing here can lower the privacy floors; an unsafe board stays on the neutral `christmas_magic` fallback.
 */
export const BoardActionRequestSchema = z.strictObject({
  action: z.enum(BOARD_ACTIONS),
  acknowledgeSmallCohort: z.boolean().optional(),
});

export const OrganizerBoardSchema = z.strictObject({
  boardKey: z.string(),
  kind: z.enum(['category', 'xp']),
  label: z.record(z.string(), z.string()),
  state: z.enum(['hidden', 'live', 'paused']),
  /** Organizer explicitly enabled it despite a small cohort. */
  forced: z.boolean(),
  lastPublishedAt: IsoDateSchema.nullable(),
  /** Live boards are allowed automatically (enough voters) or forced. */
  liveAllowed: z.boolean(),
  /** canPublish() would accept the current data right now (no reasons, no totals). */
  publishableNow: z.boolean(),
});

/** GET /api/events/:eventId/boards (masked: no entries, no counts). */
export const OrganizerBoardsResponseSchema = z.strictObject({
  boards: z.array(OrganizerBoardSchema),
  cadenceSeconds: z.number().int().min(1),
});

export const BoardActionResponseSchema = z.strictObject({
  boardKey: z.string(),
  state: z.enum(['hidden', 'live', 'paused']),
});
