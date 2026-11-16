import type {
  EventStateOutput,
  PublicGiftListOutput,
  PublicLeaderboardOutput,
  UnmaskedGiftListOutput,
  UnmaskedLeaderboardOutput,
} from '@santa/contracts';
import { fullRanking, type Score } from '../ranking.js';
import {
  assertActiveGrant,
  ProjectionForbiddenError,
  type BoardSource,
  type EventSource,
  type GiftSource,
  type ParticipantSource,
  type Viewer,
} from './sources.js';

import { levelFromXp } from '../xp.js';

export interface EventStateInput {
  event: EventSource;
  participants: readonly ParticipantSource[];
  giftsRegistered: number;
  /** Published "N voted" (same cadence as boards). Omit when not published. */
  votedCount?: number;
  /** Caller loads ONLY the viewer's own selections. */
  ownVotes: ReadonlyArray<{ categoryId: string; giftId: string }>;
}

function me(input: EventStateInput, participantId: string | null) {
  const p = participantId ? input.participants.find((x) => x.id === participantId) : undefined;
  if (!p) return null;
  return {
    participantId: p.id,
    displayName: p.displayName,
    avatar: p.avatar,
    status: p.status,
    xp: { xp: p.xp, level: levelFromXp(p.xp) },
    votes: input.ownVotes.map((v) => ({ categoryId: v.categoryId, giftId: v.giftId })),
  };
}

export function projectEventState(
  viewer: Viewer,
  input: EventStateInput,
  now = new Date(),
): EventStateOutput {
  const { event: e } = input;
  const base = {
    eventId: e.id,
    name: e.name,
    description: e.description,
    theme: e.theme,
    startsAt: e.startsAt,
    timezone: e.timezone,
    phase: e.phase,
    paused: e.paused,
    counts: {
      participants: input.participants.filter((p) => p.status === 'active').length,
      giftsRegistered: input.giftsRegistered,
    },
    ...(input.votedCount === undefined ? {} : { votedCount: input.votedCount }),
  };
  if (viewer.role === 'display') return { ...base, role: 'display' };
  if (viewer.role === 'participant') {
    const m = me(input, viewer.participantId);
    if (!m) throw new ProjectionForbiddenError('unknown participant');
    return { ...base, role: 'participant', me: m };
  }
  const count = (s: ParticipantSource['status']) =>
    input.participants.filter((p) => p.status === s).length;
  const organizer = {
    maxParticipants: e.maxParticipants,
    votingRound: e.votingRound,
    roster: {
      unclaimed: count('unclaimed'),
      pending: count('pending'),
      active: count('active'),
      removed: count('removed'),
    },
    milestones: { ...e.milestones },
    me: me(input, viewer.participantId),
  };
  if (viewer.role === 'organizer_masked') return { ...base, role: 'organizer_masked', organizer };
  const grant = assertActiveGrant(viewer, now);
  return {
    ...base,
    role: 'organizer_unmasked',
    organizer,
    unmask: { grantId: grant.grantId, expiresAt: grant.expiresAt },
  };
}

const GALLERY_PHASES: ReadonlyArray<EventSource['phase']> = [
  'gift_opening',
  'voting',
  'games',
  'reveal',
  'awards',
  'completed',
];

export function projectGiftList(
  viewer: Viewer,
  phase: EventSource['phase'],
  gifts: readonly GiftSource[],
  people: readonly ParticipantSource[],
  now = new Date(),
): PublicGiftListOutput | UnmaskedGiftListOutput {
  // Stable order by random alias: never registration/opening order.
  const byAlias = [...gifts].sort((a, b) => a.aliasNo - b.aliasNo);
  if (viewer.role === 'organizer_unmasked') {
    assertActiveGrant(viewer, now);
    return {
      mode: 'unmasked',
      gifts: byAlias.map((g) => ({
        giftId: g.id,
        alias: `Gift ${g.aliasNo}`,
        name: g.name,
        description: g.description,
        photoUrl: g.photoUrl,
        status: g.status,
        giverId: g.giverId,
        recipientId: g.recipientId,
      })),
    };
  }
  if (!GALLERY_PHASES.includes(phase)) {
    return { mode: 'count_only', count: phase === 'gift_registration' ? gifts.length : 0 };
  }
  return {
    mode: 'gallery',
    gifts: byAlias
      .filter((g) => g.status !== 'registered')
      .map((g) => {
        const core = {
          giftId: g.id,
          alias: `Gift ${g.aliasNo}`,
          name: g.name,
          description: g.description,
          photoUrl: g.photoUrl,
        };
        const giver = g.status === 'revealed' ? people.find((p) => p.id === g.giverId) : undefined;
        if (!giver) return { ...core, status: 'opened' as const };
        return {
          ...core,
          status: 'revealed' as const,
          giver: { participantId: giver.id, displayName: giver.displayName, avatar: giver.avatar },
        };
      }),
  };
}

/** Public boards come only from `lastPublished`; scores/totals are dropped. */
export function projectLeaderboard(board: BoardSource): PublicLeaderboardOutput {
  const published =
    board.state !== 'hidden' && board.lastPublished?.ok ? board.lastPublished : null;
  return {
    boardKey: board.boardKey,
    state: board.state,
    entries: published
      ? published.entries.map((e) => ({ entryId: e.entryId, rank: e.rank, tied: e.tied }))
      : [],
  };
}

export function projectLeaderboardUnmasked(
  viewer: Viewer,
  boardKey: string,
  scores: readonly Score[],
  voterCount: number,
  now = new Date(),
): UnmaskedLeaderboardOutput {
  assertActiveGrant(viewer, now);
  return { boardKey, voterCount, entries: fullRanking(scores) };
}
