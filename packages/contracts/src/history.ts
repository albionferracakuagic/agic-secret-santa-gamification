import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';
import { PersonSchema } from './person.js';
import { LocalizedTextSchema, PublishedPeopleSchema } from './phase2-scenes.js';

/* ---------- FR-042..044 History, returning participants, Hall of Fame ---------- */

/** One public result: a winning gift, its (revealed) giver, and the category. Only locked, publishable awards. */
const ArchivedWinnerSchema = z.strictObject({
  boardKey: z.string(),
  name: LocalizedTextSchema,
  grand: z.boolean(),
  giftLabel: z.string(),
  giftName: z.string(),
  /** Null once the photo retention window has passed (the photo itself is deleted by the retention sweep). */
  photoUrl: z.string().nullable(),
  giver: PersonSchema,
});

/**
 * The archive of a COMPLETED event: public results only. It never contains votes, nominees below rank 1,
 * totals, XP, guesses, missions, clue authors or anyone's bids (FR-042). Everything here was already public
 * on the display during the event.
 */
export const EventArchiveSchema = z.strictObject({
  eventId: IdSchema,
  name: z.string(),
  year: z.number().int(),
  completedAt: IsoDateSchema,
  participants: z.array(PersonSchema),
  winners: z.array(ArchivedWinnerSchema),
  achievements: z.array(z.strictObject({ key: z.string(), person: PersonSchema })),
  games: z.array(
    z.strictObject({
      kind: z.string(),
      title: LocalizedTextSchema,
      /** Published top-N of that game (canPublish), neutral fallback when it could not be shown. */
      winners: PublishedPeopleSchema,
    }),
  ),
  /** Christmas Champion (participation XP) when the event had one. */
  champion: PersonSchema.nullable(),
  /** The snapshot is deleted this many days after completion (data-retention settings). */
  expiresAt: IsoDateSchema,
});
export type EventArchiveOutput = z.infer<typeof EventArchiveSchema>;

/** GET /api/events/:eventId/archive and GET /api/me/history. `archive` is null until the event completed. */
export const ArchiveResponseSchema = z.strictObject({
  enabled: z.boolean(),
  archive: EventArchiveSchema.nullable(),
});

const HofEventSchema = z.strictObject({
  name: z.string(),
  champions: z.array(
    z.strictObject({
      /** grand_champion | christmas_champion | category_winner | achievement */
      kind: z.enum(['grand_champion', 'christmas_champion', 'category_winner', 'achievement']),
      title: LocalizedTextSchema,
      person: PersonSchema,
    }),
  ),
});

/**
 * Hall of Fame of the organizer's events (FR-044): positive accomplishments only; nobody appears for being
 * low-ranked. `seasons` = seasonal top-N of linked accounts through canPublish() (>= 5 contributors, no totals).
 */
export const HallOfFameResponseSchema = z.strictObject({
  enabled: z.boolean(),
  years: z.array(z.strictObject({ year: z.number().int(), events: z.array(HofEventSchema) })),
  seasons: z.array(z.strictObject({ year: z.number().int(), board: PublishedPeopleSchema })),
});

/* ---------- guest -> account claim (magic link) ---------- */

/** POST /api/me/account-link: emails a one-time link (30 min); needs a VERIFIED claim, never an auto-approved one. */
export const AccountLinkStartRequestSchema = z.strictObject({ email: z.email().max(254) });
export const AccountLinkStartResponseSchema = z.strictObject({ sent: z.literal(true) });
/** POST /api/account-link/confirm (public, rate-limited, single-use token). */
export const AccountLinkConfirmRequestSchema = z.strictObject({ token: z.string().min(20).max(200) });
export const AccountLinkConfirmResponseSchema = z.strictObject({ linked: z.literal(true) });

/** Lifetime titles of a linked account: positive only (FR-043). */
export const LifetimeProfileSchema = z.strictObject({
  displayName: z.string(),
  events: z.number().int().min(0),
  /** Annual participation badges (one per season attended). */
  participationYears: z.array(z.number().int()),
  titles: z.array(
    z.strictObject({
      key: z.string(),
      title: LocalizedTextSchema,
      eventName: z.string(),
      year: z.number().int(),
      /** Previous Santa Champion style trophies. */
      trophy: z.boolean(),
    }),
  ),
  totalAchievements: z.number().int().min(0),
});
/** GET /api/me/lifetime (guest) and GET /api/account/profile (signed-in account). */
export const LifetimeResponseSchema = z.strictObject({
  linked: z.boolean(),
  profile: LifetimeProfileSchema.nullable(),
});
