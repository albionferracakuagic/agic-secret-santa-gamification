import { z } from 'zod';
import { IdSchema } from './common.js';

export const PersonAvatarSchema = z.string().max(256).nullable();

/** Public person info: name + avatar only (FR-046; XP/level are self-only). */
export const PersonSchema = z.strictObject({
  participantId: IdSchema,
  displayName: z.string(),
  avatar: PersonAvatarSchema,
});
