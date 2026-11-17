import { z } from 'zod';
import { IdSchema } from './common.js';
import { LocalizedTextSchema } from './phase2-scenes.js';

/* ---------- p3-customization: custom categories and achievements (organizer editor) ---------- */

const LocalizedName = LocalizedTextSchema.refine(
  (t) => typeof t['en'] === 'string' && t['en'].trim().length >= 2 && Object.values(t).every((v) => v.length <= 80),
  { message: 'name needs an English text (2..80 chars)' },
);
const LocalizedDesc = LocalizedTextSchema.refine((t) => Object.values(t).every((v) => v.length <= 200));

/** Custom category key: `c_` + slug, so it can never collide with a built-in key. */
export const CustomKeySchema = z.string().regex(/^c_[a-z0-9_]{2,30}$/);

export const OrganizerCategorySchema = z.strictObject({
  categoryId: IdSchema,
  key: z.string(),
  name: LocalizedTextSchema,
  description: LocalizedTextSchema.nullable(),
  enabled: z.boolean(),
  sort: z.number().int(),
  custom: z.boolean(),
});
export const OrganizerCategoriesResponseSchema = z.strictObject({
  categories: z.array(OrganizerCategorySchema),
  /** Editable only before voting opens; afterwards the set is frozen (ballot integrity). */
  editable: z.boolean(),
});
export const CreateCategoryRequestSchema = z.strictObject({
  key: CustomKeySchema,
  name: LocalizedName,
  description: LocalizedDesc.optional(),
});
export const UpdateCategoryRequestSchema = z
  .strictObject({
    name: LocalizedName.optional(),
    description: LocalizedDesc.nullable().optional(),
    enabled: z.boolean().optional(),
    sort: z.number().int().min(0).max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0);

/**
 * Organizer-defined achievements. `categoryKey` = awarded to the giver of the (canPublish-gated) winner of that
 * category at the ceremony; without it the organizer awards it by hand (recognition, independent of votes).
 */
export const CustomAchievementSchema = z.strictObject({
  achievementId: IdSchema,
  key: z.string(),
  name: LocalizedTextSchema,
  description: LocalizedTextSchema,
  categoryKey: z.string().nullable(),
});
export const CustomAchievementsResponseSchema = z.strictObject({
  achievements: z.array(CustomAchievementSchema),
});
export const CreateCustomAchievementRequestSchema = z.strictObject({
  key: CustomKeySchema,
  name: LocalizedName,
  description: LocalizedDesc,
  categoryKey: z.string().min(1).max(40).optional(),
});
export const UpdateCustomAchievementRequestSchema = z
  .strictObject({ name: LocalizedName.optional(), description: LocalizedDesc.optional() })
  .refine((v) => Object.keys(v).length > 0);
/** POST .../custom-achievements/:id/awards: manual awards (only for achievements without a category). */
export const AwardCustomAchievementRequestSchema = z.strictObject({
  participantIds: z.array(IdSchema).min(1).max(100),
});
export const AwardCustomAchievementResponseSchema = z.strictObject({ awarded: z.number().int().min(0) });
