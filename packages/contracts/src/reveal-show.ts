import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';

/**
 * Reveal-show extras (ADR-0007 reveal lifecycle):
 * - Light the Tree: one optional tap per participant per revealed gift; the display shows ONLY the cumulative
 *   event-wide total (`lights`). No per-gift count, no person, no timer.
 * - Snowstorm vs Sleigh Bells: organizer-triggered, fixed 10 s, server-closed (durable job), one vote per
 *   participant per round. Public output is ONLY the outcome after close (never live tallies or voters); the
 *   outcome passes the >=5-voter floor, ties / below floor / no votes => `none` (indistinguishable, no effect).
 */
export const SHOW_CHOICE_OPTIONS = ['snowstorm', 'sleigh_bells'] as const;
export const ShowChoiceOptionSchema = z.enum(SHOW_CHOICE_OPTIONS);
export type ShowChoiceOption = z.infer<typeof ShowChoiceOptionSchema>;
export const ShowChoiceResultSchema = z.enum([...SHOW_CHOICE_OPTIONS, 'none']);
export type ShowChoiceResult = z.infer<typeof ShowChoiceResultSchema>;
/** Fixed round length (not configurable). */
export const SHOW_CHOICE_SECONDS = 10;
/**
 * After a round closes (or is cancelled) the result owns the display this long (from the authoritative close
 * time) before the autopilot may move the show on. Manual organizer actions are not delayed by it.
 */
export const SHOW_CHOICE_RESULT_HOLD_MS = 2500;

const Round = z.number().int().min(1);

/** Latest round (public). `open`: countdown to `endsAt` (server time), no result. `closed`: outcome only. */
export const ShowChoiceViewSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('open'),
    round: Round,
    endsAt: IsoDateSchema,
    result: z.null(),
  }),
  z.strictObject({
    status: z.literal('closed'),
    round: Round,
    endsAt: IsoDateSchema,
    result: ShowChoiceResultSchema,
  }),
]);
export type ShowChoiceViewOutput = z.infer<typeof ShowChoiceViewSchema>;

/** Public reveal-show extras, embedded in `RevealViewSchema` (scene `reveal`). */
export const RevealShowExtrasShape = {
  /** Light the Tree: cumulative durable total of taps (whole event). */
  lights: z.number().int().min(0),
  /** Latest Snowstorm vs Sleigh Bells round (null = never started). */
  choice: ShowChoiceViewSchema.nullable(),
  /** Durable ambient effect = winner of the latest CLOSED round (null = none / tie / below floor / no round). */
  effect: ShowChoiceOptionSchema.nullable(),
};

/* ---------------- REST ---------------- */

/** POST /api/me/reveal/gifts/:giftId/light (participant). Repeat taps are harmless (lit stays true, no double count). */
export const TreeLightResponseSchema = z.strictObject({
  giftId: IdSchema,
  lit: z.literal(true),
  lights: z.number().int().min(0),
});
export type TreeLightResponse = z.infer<typeof TreeLightResponseSchema>;

/** POST /api/me/reveal/choice (participant): one vote per open round, final (409 already_submitted on a repeat). */
export const ShowChoiceVoteRequestSchema = z.strictObject({
  round: Round,
  choice: ShowChoiceOptionSchema,
});
export const ShowChoiceVoteResponseSchema = z.strictObject({
  round: Round,
  choice: ShowChoiceOptionSchema,
});
export type ShowChoiceVoteRequest = z.infer<typeof ShowChoiceVoteRequestSchema>;

/** GET /api/me/reveal/show (participant): ONLY the caller's own selections. */
export const MyRevealShowResponseSchema = z.strictObject({
  /** Revealed gifts the caller has already lit (to render the tapped state). */
  litGiftIds: z.array(IdSchema),
  /** The open round and the caller's own vote in it (null = not voted yet); null when no round is open. */
  choice: z.strictObject({ round: Round, myChoice: ShowChoiceOptionSchema.nullable() }).nullable(),
});
export type MyRevealShowResponse = z.infer<typeof MyRevealShowResponseSchema>;

/** POST /api/events/:eventId/reveal/choice (organizer) and GET /api/events/:eventId/reveal/show (organizer). */
export const RevealShowStateSchema = z.strictObject(RevealShowExtrasShape);
export type RevealShowStateOutput = z.infer<typeof RevealShowStateSchema>;
