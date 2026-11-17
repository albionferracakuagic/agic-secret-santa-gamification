import { z } from 'zod';
import { EventFeaturesSchema, Phase2SettingsSchema, Phase3SettingsSchema } from './settings.js';

/** Response of PATCH /api/events/:eventId/features (and the shape mirrored in the organizer event state). */
export const EventFeaturesResponseSchema = z.strictObject({
  features: EventFeaturesSchema,
  phase2: Phase2SettingsSchema,
  phase3: Phase3SettingsSchema,
});
export type EventFeaturesResponse = z.infer<typeof EventFeaturesResponseSchema>;
