import { z } from 'zod';

export const TieBreakSchema = z.enum(['shared', 'secondary', 'organizer']);

/** Floors are non-overridable: schema only accepts equal-or-stricter values (ADR-0003). */
export const EventSettingsSchema = z.strictObject({
  topN: z.number().int().min(1).max(10).default(3),
  hiddenMin: z.number().int().min(2).default(2),
  minVoters: z.number().int().min(5).default(5),
  minTotalVotes: z.number().int().min(5).default(5),
  cadenceSeconds: z.number().int().min(5).max(120).default(10),
  tieBreak: TieBreakSchema.default('shared'),
  showTotals: z.boolean().default(false),
  liveBoardMinVoters: z.number().int().min(5).default(10),
  xpValues: z
    .strictObject({
      joined: z.number().int().min(0).default(10),
      gift_registered: z.number().int().min(0).default(20),
      voted: z.number().int().min(0).default(10),
    })
    .prefault({}),
  features: z.strictObject({ xpBoard: z.boolean().default(false) }).prefault({}),
  retention: z.strictObject({ photoDays: z.number().int().min(1).default(90) }).prefault({}),
});
export type EventSettings = z.infer<typeof EventSettingsSchema>;

export const defaultEventSettings = (): EventSettings => EventSettingsSchema.parse({});

/** Default voting categories (EN/IT) created with every event; all vote-derived output goes via canPublish(). */
export const DEFAULT_CATEGORIES = [
  { key: 'best_gift', name: { en: 'Best Gift', it: 'Miglior Regalo' } },
  { key: 'most_creative', name: { en: 'Most Creative', it: 'Più Creativo' } },
  { key: 'funniest', name: { en: 'Funniest', it: 'Più Divertente' } },
  { key: 'best_presentation', name: { en: 'Best Presentation', it: 'Miglior Confezione' } },
  { key: 'biggest_surprise', name: { en: 'Biggest Surprise', it: 'Più Sorprendente' } },
  { key: 'best_overall', name: { en: 'Best Overall', it: 'Miglior Regalo in Assoluto' } },
] as const;

export const SETUP_WARNINGS = ['roster_below_voter_floor'] as const;
export type SetupWarning = (typeof SETUP_WARNINGS)[number];
