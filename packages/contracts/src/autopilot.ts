import { z } from 'zod';
import { IsoDateSchema } from './common.js';

/**
 * Show autopilot (ADR-0009, plan A): once the organizer presses "Start show" in gift_opening, the server runs
 * opening -> voting -> games (if enabled) -> reveal -> awards -> completed via durable `autopilot.tick` jobs.
 * "Hold" pauses the timeline only; it is independent of the event freeze (`paused`).
 */

export const AUTOPILOT_PRESET_KEYS = ['quick', 'standard', 'relaxed'] as const;
export const AutopilotPresetSchema = z.enum(AUTOPILOT_PRESET_KEYS);
export type AutopilotPreset = z.infer<typeof AutopilotPresetSchema>;

export interface AutopilotTimings {
  /** Seconds each gift stays on stage during opening (after its countdown). */
  openingGiftSeconds: number;
  votingMinutes: number;
  /** Time box for the games block (mini-games / auction / spotlight when enabled). */
  gamesMinutes: number;
  /** Seconds per gift during the giver reveal (drumroll + reveal moment). */
  revealGiftSeconds: number;
  /** Pause between steps (title card / breathing room). */
  interludeSeconds: number;
}

/** Preset timings; per-step overrides in `AutopilotSettings` win over these. */
export const AUTOPILOT_PRESETS: Readonly<Record<AutopilotPreset, Readonly<AutopilotTimings>>> = {
  quick: {
    openingGiftSeconds: 20,
    votingMinutes: 3,
    gamesMinutes: 5,
    revealGiftSeconds: 12,
    interludeSeconds: 5,
  },
  standard: {
    openingGiftSeconds: 40,
    votingMinutes: 5,
    gamesMinutes: 10,
    revealGiftSeconds: 20,
    interludeSeconds: 10,
  },
  relaxed: {
    openingGiftSeconds: 60,
    votingMinutes: 10,
    gamesMinutes: 15,
    revealGiftSeconds: 30,
    interludeSeconds: 20,
  },
};

/** Override bounds (inclusive). `null`/absent = use the preset value (null lets a settings patch clear it). */
const override = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();
export const AutopilotOverridesShape = {
  openingGiftSeconds: override(5, 600),
  votingMinutes: override(1, 120),
  gamesMinutes: override(1, 120),
  revealGiftSeconds: override(5, 300),
  interludeSeconds: override(0, 120),
};

/** `settings.autopilot`: optional block with defaults so events created before autopilot still parse. */
export const AutopilotSettingsSchema = z.strictObject({
  preset: AutopilotPresetSchema.default('standard'),
  ...AutopilotOverridesShape,
  /** Include mini-games / auction / spotlight in the games step when their feature flags are on. */
  includeExtras: z.boolean().default(true),
});
export type AutopilotSettings = z.infer<typeof AutopilotSettingsSchema>;

/** Settings patch (PATCH .../autopilot or via event settings): any subset; null clears an override. */
export const AutopilotSettingsPatchSchema = z
  .strictObject({
    preset: AutopilotPresetSchema.optional(),
    ...AutopilotOverridesShape,
    includeExtras: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'empty patch' });
export type AutopilotSettingsPatch = z.infer<typeof AutopilotSettingsPatchSchema>;

/** Events stored before autopilot have no `autopilot` block: fall back to defaults. */
export const autopilotSettings = (s: { autopilot?: unknown }): AutopilotSettings =>
  AutopilotSettingsSchema.parse(s.autopilot ?? {});

/** Effective timings: preset values, each replaced by its override when set. */
export function resolveAutopilotTimings(s: AutopilotSettings): AutopilotTimings {
  const p = AUTOPILOT_PRESETS[s.preset];
  return {
    openingGiftSeconds: s.openingGiftSeconds ?? p.openingGiftSeconds,
    votingMinutes: s.votingMinutes ?? p.votingMinutes,
    gamesMinutes: s.gamesMinutes ?? p.gamesMinutes,
    revealGiftSeconds: s.revealGiftSeconds ?? p.revealGiftSeconds,
    interludeSeconds: s.interludeSeconds ?? p.interludeSeconds,
  };
}

export const AUTOPILOT_STATUSES = ['idle', 'running', 'held', 'done'] as const;
export const AutopilotStatusSchema = z.enum(AUTOPILOT_STATUSES);

export const AUTOPILOT_STEPS = ['opening', 'voting', 'games', 'reveal', 'awards', 'complete'] as const;
export const AutopilotStepSchema = z.enum(AUTOPILOT_STEPS);
export type AutopilotStep = z.infer<typeof AutopilotStepSchema>;

export const AutopilotTimelineItemSchema = z.strictObject({
  step: AutopilotStepSchema,
  /** Planned duration of the whole step (seconds), from the resolved preset + overrides and current counts. */
  plannedSeconds: z.number().int().min(0),
  /** Estimated start (pending) / end (active) time; null when unknown (held, done, skipped). */
  eta: IsoDateSchema.nullable(),
  status: z.enum(['pending', 'active', 'done', 'skipped']),
});

/** Codes for the organizer-facing auto-resolve log (i18n key `autopilot.log.<code>`). */
export const AUTOPILOT_LOG_CODES = [
  'started',
  'held',
  'resumed',
  'stopped',
  'completed',
  'step_started',
  'step_skipped',
  'step_empty_skipped',
  'tie_shared',
  'voting_below_floor',
  'manual_override_resync',
  'frozen_held',
] as const;
export const AutopilotLogCodeSchema = z.enum(AUTOPILOT_LOG_CODES);

/**
 * Log params are deliberately coarse: integers, booleans, step names and slugs (board keys) only.
 * The slug pattern rejects free text, so names, pairings, votes or missions cannot be smuggled in (FR-046).
 */
const LogParamValue = z.union([
  z.number().int(),
  z.boolean(),
  z
    .string()
    .max(60)
    .regex(/^[a-z0-9_]+$/),
]);
export const AutopilotLogEntrySchema = z.strictObject({
  at: IsoDateSchema,
  code: AutopilotLogCodeSchema,
  params: z
    .record(
      z
        .string()
        .max(40)
        .regex(/^[a-zA-Z0-9_]+$/),
      LogParamValue,
    )
    .optional(),
});

/** Organizer-only autopilot state (organizer projection + GET .../autopilot). Never on pub/participant streams. */
export const AutopilotStateSchema = z.strictObject({
  status: AutopilotStatusSchema,
  /** Current step (null when idle and never started). */
  step: AutopilotStepSchema.nullable(),
  /** Monotonic tick counter: a job carries (step, seq) and stale/duplicate deliveries are no-ops. */
  seq: z.number().int().min(0),
  /** Server deadline of the current step/sub-step; clients count down against server time. */
  stepEndsAt: IsoDateSchema.nullable(),
  startedAt: IsoDateSchema.nullable(),
  heldAt: IsoDateSchema.nullable(),
  /** Remaining time of the current step when held; resume re-plans stepEndsAt = now + this. */
  remainingMsAtHold: z.number().int().min(0).nullable(),
  timeline: z.array(AutopilotTimelineItemSchema),
  /** Most recent entries (server caps the length). */
  log: z.array(AutopilotLogEntrySchema).max(200),
});
export type AutopilotState = z.infer<typeof AutopilotStateSchema>;

export const AUTOPILOT_ACTIONS = ['start', 'hold', 'resume', 'stop', 'skip'] as const;
/**
 * POST /api/events/:eventId/autopilot (organizer, idempotency-keyed, audited).
 * `fromSeq` (optional) makes double-clicks harmless: 409 when the autopilot already moved on.
 */
export const AutopilotCommandSchema = z.strictObject({
  action: z.enum(AUTOPILOT_ACTIONS),
  fromSeq: z.number().int().min(0).optional(),
});
export type AutopilotCommand = z.infer<typeof AutopilotCommandSchema>;

/** GET/POST .../autopilot response: stored settings, effective timings, state. */
export const AutopilotResponseSchema = z.strictObject({
  settings: AutopilotSettingsSchema,
  timings: z.strictObject({
    openingGiftSeconds: z.number().int().min(0),
    votingMinutes: z.number().int().min(0),
    gamesMinutes: z.number().int().min(0),
    revealGiftSeconds: z.number().int().min(0),
    interludeSeconds: z.number().int().min(0),
  }),
  state: AutopilotStateSchema,
});
export type AutopilotResponse = z.infer<typeof AutopilotResponseSchema>;
