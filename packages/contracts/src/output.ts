import { z } from 'zod';
import {
  IdSchema,
  IsoDateSchema,
  ParticipantStatusSchema,
  PhaseSchema,
  type Role,
} from './common.js';

const Avatar = z.string().max(256).nullable();
const Count = z.number().int().min(0);

/** Public person info: name + avatar only (FR-046; XP/level are self-only). */
export const PersonSchema = z.strictObject({
  participantId: IdSchema,
  displayName: z.string(),
  avatar: Avatar,
});

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
  photoUrl: z.string().nullable(),
};
export const PublicGiftSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...giftCore, status: z.literal('opened') }),
  z.strictObject({ ...giftCore, status: z.literal('revealed'), giver: PersonSchema }),
]);
export const PublicGiftListSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('count_only'), count: Count }),
  z.strictObject({ mode: z.literal('gallery'), gifts: z.array(PublicGiftSchema) }),
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

/** Top-N only: no totals, no rank beyond N, no entries outside the published set. */
export const PublicLeaderboardSchema = z.strictObject({
  boardKey: z.string(),
  state: z.enum(['hidden', 'live', 'paused']),
  entries: z.array(
    z.strictObject({ entryId: IdSchema, rank: z.number().int().min(1), tied: z.boolean() }),
  ),
});
export const UnmaskedLeaderboardSchema = z.strictObject({
  boardKey: z.string(),
  voterCount: Count,
  entries: z.array(
    z.strictObject({
      entryId: IdSchema,
      rank: z.number().int().min(1),
      tied: z.boolean(),
      score: Count,
    }),
  ),
});

export const ProfileSchema = PersonSchema.extend({ achievements: z.array(z.string()) });

export const SURFACES = ['eventState', 'giftList', 'leaderboard'] as const;
export type Surface = (typeof SURFACES)[number];

export type EventStateOutput =
  | z.infer<typeof ParticipantEventStateSchema>
  | z.infer<typeof DisplayEventStateSchema>
  | z.infer<typeof OrganizerMaskedEventStateSchema>
  | z.infer<typeof OrganizerUnmaskedEventStateSchema>;
export type PublicGiftListOutput = z.infer<typeof PublicGiftListSchema>;
export type UnmaskedGiftListOutput = z.infer<typeof UnmaskedGiftListSchema>;
export type PublicLeaderboardOutput = z.infer<typeof PublicLeaderboardSchema>;
export type UnmaskedLeaderboardOutput = z.infer<typeof UnmaskedLeaderboardSchema>;

export const OutputSchemas = {
  participant: {
    eventState: ParticipantEventStateSchema,
    giftList: PublicGiftListSchema,
    leaderboard: PublicLeaderboardSchema,
  },
  display: {
    eventState: DisplayEventStateSchema,
    giftList: PublicGiftListSchema,
    leaderboard: PublicLeaderboardSchema,
  },
  organizer_masked: {
    eventState: OrganizerMaskedEventStateSchema,
    giftList: PublicGiftListSchema,
    leaderboard: PublicLeaderboardSchema,
  },
  organizer_unmasked: {
    eventState: OrganizerUnmaskedEventStateSchema,
    giftList: UnmaskedGiftListSchema,
    leaderboard: UnmaskedLeaderboardSchema,
  },
} as const satisfies Record<Role, Record<Surface, z.ZodType>>;
