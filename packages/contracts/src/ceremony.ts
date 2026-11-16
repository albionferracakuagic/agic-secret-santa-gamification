import { z } from 'zod';
import { IdSchema } from './common.js';
import { CeremonyStatusSchema } from './output.js';

export const CEREMONY_BLOCKERS = [
  'not_in_awards_phase',
  'voting_not_closed',
  'decisions_pending',
  'nothing_to_show',
] as const;

/**
 * Organizer ceremony console state. MASKED: no winners, no counts. Tie candidates are listed by alias only,
 * and only when the tie rule is "organizer decides".
 */
export const OrganizerCeremonyStateSchema = z.strictObject({
  status: CeremonyStatusSchema,
  index: z.number().int().min(0),
  total: z.number().int().min(0),
  canStart: z.boolean(),
  blockers: z.array(z.enum(CEREMONY_BLOCKERS)),
  /** Step types only (no content) so the organizer can see the show's shape. */
  outline: z.array(z.string()),
  pendingDecisions: z.array(
    z.strictObject({
      boardKey: z.string(),
      candidates: z.array(z.strictObject({ giftId: IdSchema, label: z.string() })),
    }),
  ),
});

/** POST .../ceremony/next: `fromIndex` makes double-clicks harmless (409 when the show already moved on). */
export const CeremonyNextRequestSchema = z.strictObject({ fromIndex: z.number().int().min(0) });

/** POST .../awards/:boardKey/decide: organizer picks ONE winner among the tied candidates (audited). */
export const AwardDecisionRequestSchema = z.strictObject({ giftId: IdSchema });
export const AwardDecisionResponseSchema = z.strictObject({
  boardKey: z.string(),
  decided: z.literal(true),
});
