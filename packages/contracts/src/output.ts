import { z } from 'zod';
import {
  EventFeaturesSchema,
  Phase2SettingsSchema,
  Phase3SettingsSchema,
  SETUP_WARNINGS,
} from './settings.js';
import {
  IdSchema,
  IsoDateSchema,
  ParticipantStatusSchema,
  PhaseSchema,
  type Role,
} from './common.js';

import { PersonSchema, PersonAvatarSchema as Avatar } from './person.js';
import { SpotlightSchema, GameViewSchema } from './phase2-scenes.js';
import {
  AuctionViewSchema,
  AuctionWonAnnouncementSchema,
  MysteryRevealAnnouncementSchema,
} from './auction.js';
import { AutopilotStateSchema } from './autopilot.js';

const Count = z.number().int().min(0);

const baseEventShape = {
  eventId: IdSchema,
  name: z.string(),
  description: z.string().nullable(),
  theme: z.string(),
  startsAt: IsoDateSchema,
  timezone: z.string(),
  phase: PhaseSchema,
  paused: z.boolean(),
  counts: z.strictObject({ participants: Count, giftsRegistered: Count }),
  /** Published "N voted" counter, same cadence as the board; never per-person. */
  votedCount: Count.optional(),
  /** Server timestamp: when voting auto-closes (null = no timer or not open). Countdown = this - serverNow. */
  votingEndsAt: IsoDateSchema.nullable(),
};

export const MeSchema = z.strictObject({
  participantId: IdSchema,
  displayName: z.string(),
  avatar: Avatar,
  status: ParticipantStatusSchema,
  xp: z.strictObject({ xp: Count, level: Count }),
  votes: z.array(z.strictObject({ categoryId: IdSchema, giftId: IdSchema })),
});

const organizerShape = {
  maxParticipants: Count,
  votingRound: Count,
  roster: z.strictObject({ unclaimed: Count, pending: Count, active: Count, removed: Count }),
  milestones: z.strictObject({
    giftOpeningStartedAt: IsoDateSchema.nullable(),
    votingClosedAt: IsoDateSchema.nullable(),
    revealStartedAt: IsoDateSchema.nullable(),
    ceremonyStartedAt: IsoDateSchema.nullable(),
  }),
  /** Masked organizer plays with participant parity; null if not bound to a roster entry. */
  me: MeSchema.nullable(),
  warnings: z.array(z.enum(SETUP_WARNINGS)),
  /** Event-wide reactions switch (settings.features.reactionsEnabled). */
  reactionsEnabled: z.boolean(),
  /** Every feature switch (Phase 2/3 included) so the console can render the right toggles. */
  features: EventFeaturesSchema,
  phase2: Phase2SettingsSchema,
  phase3: Phase3SettingsSchema,
  /** True while at least one authenticated display socket is subscribed for this event. */
  displayConnected: z.boolean(),
  /** Show autopilot state (organizer roles only; never on display/participant/pub projections). */
  autopilot: AutopilotStateSchema.optional(),
};

export const ParticipantEventStateSchema = z.strictObject({
  ...baseEventShape,
  role: z.literal('participant'),
  me: MeSchema,
});
export const DisplayEventStateSchema = z.strictObject({
  ...baseEventShape,
  role: z.literal('display'),
});
export const OrganizerMaskedEventStateSchema = z.strictObject({
  ...baseEventShape,
  role: z.literal('organizer_masked'),
  organizer: z.strictObject(organizerShape),
});
export const OrganizerUnmaskedEventStateSchema = z.strictObject({
  ...baseEventShape,
  role: z.literal('organizer_unmasked'),
  organizer: z.strictObject(organizerShape),
  unmask: z.strictObject({ grantId: IdSchema, expiresAt: IsoDateSchema }),
});

/** Gift DTO: random alias, no createdAt/order/opening metadata; giver only once revealed. */
const giftCore = {
  giftId: IdSchema,
  alias: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Short-lived signed URL (re-fetched on every snapshot); never a permanent blob address. */
  photoUrl: z.string().nullable(),
};
export const PublicGiftSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...giftCore, status: z.literal('opened') }),
  z.strictObject({ ...giftCore, status: z.literal('revealed'), giver: PersonSchema }),
]);
export const PublicGiftListSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('count_only'), count: Count }),
  z.strictObject({
    mode: z.literal('gallery'),
    /** Sorted by random alias number, never by registration/opening order. */
    gifts: z.array(PublicGiftSchema),
    /** The gift being opened right now (opening phase); null otherwise. Carries no history of the order. */
    currentGiftId: IdSchema.nullable(),
  }),
]);
export const UnmaskedGiftListSchema = z.strictObject({
  mode: z.literal('unmasked'),
  gifts: z.array(
    z.strictObject({
      ...giftCore,
      status: z.enum(['registered', 'opened', 'revealed']),
      giverId: IdSchema,
      recipientId: IdSchema,
    }),
  ),
});

/** Board entry label: the GIFT alias ("Gift 7"), never a person (givers stay hidden until reveal). */
const LabelSchema = z.string().min(1).max(60);

/** Top-N only: no totals, no rank beyond N, no entries outside the published set. */
export const PublicLeaderboardSchema = z.strictObject({
  /** Stable key (category key or `xp`); use it as the i18n key (`boards.<boardKey>`) or read `name`. */
  boardKey: z.string(),
  /** Localized board title by locale code (`en`, `it`), from the category / XP board definition. */
  name: z.record(z.string(), z.string()),
  state: z.enum(['hidden', 'live', 'paused']),
  /** `christmas_magic` = the board is on but nothing may be shown safely (neutral fallback, no promise of a reveal). */
  message: z.enum(['christmas_magic']).nullable(),
  entries: z.array(
    z.strictObject({
      entryId: IdSchema,
      label: LabelSchema,
      rank: z.number().int().min(1),
      tied: z.boolean(),
    }),
  ),
});
/** All boards in one payload (surface `leaderboards`): snapshot + every publication. Replaces single `leaderboard`. */
export const PublicLeaderboardsSchema = z.strictObject({
  boards: z.array(PublicLeaderboardSchema),
});
export const UnmaskedLeaderboardSchema = z.strictObject({
  boardKey: z.string(),
  voterCount: Count,
  entries: z.array(
    z.strictObject({
      entryId: IdSchema,
      label: LabelSchema,
      rank: z.number().int().min(1),
      tied: z.boolean(),
      score: Count,
    }),
  ),
});

export const ProfileSchema = PersonSchema.extend({ achievements: z.array(z.string()) });

/* ---------------- award ceremony (public; synced to display + participants) ---------------- */

const CeremonyName = z.record(z.string(), z.string());
const CeremonyEntry = z.strictObject({ entryId: IdSchema, label: LabelSchema });

/** One ceremony step as shown on screen. Winners carry the giver (revealed at that step, never earlier). */
export const CeremonyStepSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('intro') }),
  z.strictObject({
    type: z.literal('category'),
    boardKey: z.string(),
    name: CeremonyName,
    grand: z.boolean(),
  }),
  /** Unsafe category: skipped with a neutral message (no promise of a later reveal). */
  z.strictObject({ type: z.literal('category_skipped'), boardKey: z.string(), name: CeremonyName }),
  /** Leading gifts, only what canPublish allowed (top-N, no totals, no last place). */
  z.strictObject({
    type: z.literal('nominees'),
    boardKey: z.string(),
    entries: z.array(CeremonyEntry),
  }),
  z.strictObject({ type: z.literal('countdown'), seconds: z.number().int().min(1) }),
  z.strictObject({
    type: z.literal('winner'),
    boardKey: z.string(),
    name: CeremonyName,
    grand: z.boolean(),
    /** Co-winners when the tie rule is "shared". */
    tied: z.boolean(),
    winners: z.array(CeremonyEntry.extend({ giver: PersonSchema })),
  }),
  z.strictObject({
    type: z.literal('achievement'),
    achievementKey: z.string(),
    recipients: z.array(PersonSchema),
  }),
  /** Participation recognition (independent of votes): each earner is also announced on their own stream. */
  z.strictObject({ type: z.literal('spirit'), recipientCount: Count }),
  z.strictObject({ type: z.literal('champion'), person: PersonSchema }),
  z.strictObject({ type: z.literal('outro') }),
]);
export const CeremonyStatusSchema = z.enum(['idle', 'running', 'paused', 'done', 'cancelled']);
export const CeremonyViewSchema = z.strictObject({
  status: CeremonyStatusSchema,
  index: z.number().int().min(0),
  total: z.number().int().min(0),
  /** Server deadline of an auto-advancing step (countdown); clients count down against server time. */
  endsAt: IsoDateSchema.nullable(),
  step: CeremonyStepSchema.nullable(),
});
export type CeremonyStepOutput = z.infer<typeof CeremonyStepSchema>;
export type CeremonyViewOutput = z.infer<typeof CeremonyViewSchema>;

/* ---------------- giver reveal (public; one gift at a time on the display) ---------------- */

const revealGiftCore = {
  giftId: IdSchema,
  alias: z.string(),
  giftName: z.string(),
  /** Short-lived signed URL, same rules as the gallery. */
  photoUrl: z.string().nullable(),
  /** Who received the gift (they opened it in front of everyone); null if not resolvable. */
  recipient: PersonSchema.nullable(),
};
/**
 * The gift on stage. `drumroll`: giver is ALWAYS null (countdown running, not yet revealed server-side).
 * `revealed`: the giver is revealed (giverRevealedAt set) and may be shown (ADR-0003/0007: giver only once revealed).
 */
export const RevealCurrentSchema = z.discriminatedUnion('stage', [
  z.strictObject({ ...revealGiftCore, stage: z.literal('drumroll'), giver: z.null() }),
  z.strictObject({ ...revealGiftCore, stage: z.literal('revealed'), giver: PersonSchema }),
]);
/** An already-revealed pair (finale grid / recap). Unrevealed gifts never appear here. */
export const RevealedPairSchema = z.strictObject({
  ...revealGiftCore,
  giver: PersonSchema,
});
export const RevealViewSchema = z.strictObject({
  current: RevealCurrentSchema.nullable(),
  /** Server deadline of the drumroll for `current` (null when none running). */
  countdownEndsAt: IsoDateSchema.nullable(),
  revealedCount: Count,
  total: Count,
  /** Only already-revealed pairs, sorted by alias number (never by pairing/registration order). */
  revealed: z.array(RevealedPairSchema),
});
export type RevealViewOutput = z.infer<typeof RevealViewSchema>;

/**
 * Display/pub "scene" payload: what the big screen should show now. Public data only
 * (same schema for every role; contains no secrets).
 */
export const SceneSchema = z.discriminatedUnion('scene', [
  z.strictObject({
    scene: z.literal('lobby'),
    participants: Count,
    /** Absolute join URL (`<base>/j?code=<shortCode>`) from the newest active join access; null if none. */
    joinUrl: z.string().nullable(),
    shortCode: z.string().nullable(),
  }),
  z.strictObject({
    scene: z.literal('opening'),
    openedCount: Count,
    total: Count,
    current: PublicGiftSchema.nullable(),
    /** Server-driven reveal countdown for `current` (same semantics as OpeningState). */
    countdownSeconds: z.number().int().min(0).max(10),
    countdownEndsAt: IsoDateSchema.nullable(),
  }),
  z.strictObject({
    scene: z.literal('voting'),
    endsAt: IsoDateSchema.nullable(),
    /** Published counter only (cadence); null until first publish. */
    votedCount: Count.nullable(),
    closed: z.boolean(),
  }),
  z.strictObject({ scene: z.literal('phase'), phase: PhaseSchema }),
  /** Award ceremony in progress/finished: full-screen show driven by the organizer + durable timers. */
  z.strictObject({ scene: z.literal('ceremony'), ceremony: CeremonyViewSchema }),
  /** Giver reveal, one gift at a time (drumroll -> revealed) + already-revealed pairs. */
  z.strictObject({ scene: z.literal('reveal'), reveal: RevealViewSchema }),
  /** Phase 2: the active mini-game (intro, rounds, timers, submission counter, published winners). */
  z.strictObject({ scene: z.literal('game'), game: GameViewSchema }),
  /** Phase 2: Santa Detective / Invisible Santa / Mission Master presentation (canPublish-gated). */
  z.strictObject({ scene: z.literal('spotlight'), spotlight: SpotlightSchema }),
  /** Phase 3: the mystery-box auction on stage (price only, never bidders). */
  z.strictObject({ scene: z.literal('auction'), auction: AuctionViewSchema }),
]);

/**
 * One-off achievement announcement for the display/participants (celebration + ARIA text).
 * `person` is only included for achievements that are public by design (participation recognition,
 * canPublish-gated winners).
 */
export const AnnouncementSchema = z.strictObject({
  type: z.literal('achievement'),
  key: z.string().min(1).max(60),
  person: PersonSchema,
  at: IsoDateSchema,
});

/** Approved anonymous giver clue (FR-025): gift alias + text only; the author is never part of the payload. */
export const ClueAnnouncementSchema = z.strictObject({
  type: z.literal('clue'),
  giftId: IdSchema,
  alias: z.string(),
  text: z.string().min(1).max(200),
  at: IsoDateSchema,
});

/** FR-030: the ONLY thing the display learns about missions; no person, no mission, no counter. */
export const MissionCompletedAnnouncementSchema = z.strictObject({
  type: z.literal('mission_completed'),
  at: IsoDateSchema,
});

/** Announcement surface for display / organizer / the pub stream: switch on `type`. */
export const PublicAnnouncementSchema = z.discriminatedUnion('type', [
  AnnouncementSchema,
  ClueAnnouncementSchema,
  MissionCompletedAnnouncementSchema,
  AuctionWonAnnouncementSchema,
  MysteryRevealAnnouncementSchema,
]);
/**
 * Personal announcements, delivered only on the participant's own p:<id> stream and accepted ONLY by the
 * participant role schema (FR-025: guesses are visible only to their owner). Positive cues only (FR-046).
 */
export const GuessResultAnnouncementSchema = z.strictObject({
  type: z.literal('guess_result'),
  giftId: IdSchema,
  alias: z.string(),
  outcome: z.enum(['correct', 'incorrect']),
  cue: z.enum(['confetti', 'wink']),
  xp: Count,
  at: IsoDateSchema,
});
export const ParticipantAnnouncementSchema = z.discriminatedUnion('type', [
  AnnouncementSchema,
  ClueAnnouncementSchema,
  MissionCompletedAnnouncementSchema,
  AuctionWonAnnouncementSchema,
  MysteryRevealAnnouncementSchema,
  GuessResultAnnouncementSchema,
]);
export const SURFACES = [
  'eventState',
  'giftList',
  'leaderboard',
  'leaderboards',
  'scene',
  'announcement',
] as const;
export type Surface = (typeof SURFACES)[number];

export type EventStateOutput =
  | z.infer<typeof ParticipantEventStateSchema>
  | z.infer<typeof DisplayEventStateSchema>
  | z.infer<typeof OrganizerMaskedEventStateSchema>
  | z.infer<typeof OrganizerUnmaskedEventStateSchema>;
export type PublicGiftListOutput = z.infer<typeof PublicGiftListSchema>;
export type PublicGiftOutput = z.infer<typeof PublicGiftSchema>;
export type UnmaskedGiftListOutput = z.infer<typeof UnmaskedGiftListSchema>;
export type PublicLeaderboardOutput = z.infer<typeof PublicLeaderboardSchema>;
export type UnmaskedLeaderboardOutput = z.infer<typeof UnmaskedLeaderboardSchema>;
export type SceneOutput = z.infer<typeof SceneSchema>;
export type AnnouncementOutput = z.infer<typeof AnnouncementSchema>;
export type ClueAnnouncementOutput = z.infer<typeof ClueAnnouncementSchema>;
export type GuessResultAnnouncementOutput = z.infer<typeof GuessResultAnnouncementSchema>;
/** Everything the nnouncement surface can carry (switch on 	ype). */
export type AnyAnnouncementOutput = z.infer<typeof ParticipantAnnouncementSchema>;

export const OutputSchemas = {
  participant: {
    eventState: ParticipantEventStateSchema,
    giftList: PublicGiftListSchema,
    leaderboard: PublicLeaderboardSchema,
    leaderboards: PublicLeaderboardsSchema,
    scene: SceneSchema,
    announcement: ParticipantAnnouncementSchema,
  },
  display: {
    eventState: DisplayEventStateSchema,
    giftList: PublicGiftListSchema,
    leaderboard: PublicLeaderboardSchema,
    leaderboards: PublicLeaderboardsSchema,
    scene: SceneSchema,
    announcement: PublicAnnouncementSchema,
  },
  organizer_masked: {
    eventState: OrganizerMaskedEventStateSchema,
    giftList: PublicGiftListSchema,
    leaderboard: PublicLeaderboardSchema,
    leaderboards: PublicLeaderboardsSchema,
    scene: SceneSchema,
    announcement: PublicAnnouncementSchema,
  },
  organizer_unmasked: {
    eventState: OrganizerUnmaskedEventStateSchema,
    giftList: UnmaskedGiftListSchema,
    leaderboard: UnmaskedLeaderboardSchema,
    leaderboards: PublicLeaderboardsSchema,
    scene: SceneSchema,
    announcement: PublicAnnouncementSchema,
  },
} as const satisfies Record<Role, Record<Surface, z.ZodType>>;
