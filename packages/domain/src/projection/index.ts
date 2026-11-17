import type {
  EventStateOutput,
  PublicGiftListOutput,
  PublicGiftOutput,
  PublicLeaderboardOutput,
  SceneOutput,
  CeremonyViewOutput,
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
import { setupWarnings } from '../phases.js';

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
    votingEndsAt: e.votingEndsAt,
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
    warnings: setupWarnings(input.participants.filter((p) => p.status !== 'removed').length),
    reactionsEnabled: e.reactionsEnabled,
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
  currentGiftId: string | null = null,
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
    return {
      mode: 'count_only',
      count: phase === 'gift_registration' ? gifts.filter((g) => !g.hidden).length : 0,
    };
  }
  const visible = byAlias.filter((g) => g.status !== 'registered' && !g.hidden);
  return {
    mode: 'gallery',
    gifts: visible.map((g) => toPublicGift(g, people)),
    currentGiftId: visible.some((g) => g.id === currentGiftId) ? currentGiftId : null,
  };
}

/** Public gift DTO; the giver appears only for revealed gifts. */
export function toPublicGift(
  g: GiftSource,
  people: readonly ParticipantSource[],
): PublicGiftOutput {
  const core = {
    giftId: g.id,
    alias: `Gift ${g.aliasNo}`,
    name: g.name,
    description: g.description,
    photoUrl: g.photoUrl,
  };
  const giver = g.status === 'revealed' ? people.find((p) => p.id === g.giverId) : undefined;
  if (!giver) return { ...core, status: 'opened' };
  return {
    ...core,
    status: 'revealed',
    giver: { participantId: giver.id, displayName: giver.displayName, avatar: giver.avatar },
  };
}

export const giftLabel = (g: Pick<GiftSource, 'aliasNo'>) => `Gift ${g.aliasNo}`;

/** Public boards come only from `lastPublished`; scores/totals are dropped. Labels are GIFT aliases. */
export function projectLeaderboard(
  board: BoardSource,
  labels: Readonly<Record<string, string>> = {},
): PublicLeaderboardOutput {
  const published =
    board.state !== 'hidden' && board.lastPublished?.ok ? board.lastPublished : null;
  return {
    boardKey: board.boardKey,
    name: board.name ?? { en: board.boardKey },
    state: board.state,
    // live but nothing may be shown safely => neutral fallback (no promise of a later reveal)
    message: board.state !== 'hidden' && !published ? 'christmas_magic' : null,
    entries: published
      ? published.entries.map((e) => ({
          entryId: e.entryId,
          label: labels[e.entryId] ?? 'Gift',
          rank: e.rank,
          tied: e.tied,
        }))
      : [],
  };
}

/** All visible boards (hidden boards are omitted entirely). */
export function projectLeaderboards(
  boards: readonly BoardSource[],
  labelsFor: (boardKey: string) => Readonly<Record<string, string>>,
): { boards: PublicLeaderboardOutput[] } {
  return {
    boards: boards
      .filter((b) => b.state !== 'hidden')
      .map((b) => projectLeaderboard(b, labelsFor(b.boardKey))),
  };
}

export function projectLeaderboardUnmasked(
  viewer: Viewer,
  boardKey: string,
  scores: readonly Score[],
  voterCount: number,
  now = new Date(),
  labels: Readonly<Record<string, string>> = {},
): UnmaskedLeaderboardOutput {
  assertActiveGrant(viewer, now);
  return {
    boardKey,
    voterCount,
    entries: fullRanking(scores).map((e) => ({ ...e, label: labels[e.entryId] ?? 'Gift' })),
  };
}

export interface SceneInput {
  event: EventSource;
  activeParticipants: number;
  gifts: readonly GiftSource[];
  people: readonly ParticipantSource[];
  /** Newest active join access (short code is stored in clear; tokens are hash-only). */
  join: { url: string; shortCode: string } | null;
  /** Published counter (cadence). */
  votedCount: number | null;
  /** Ceremony view (public payload) when one is running/finished. */
  ceremony?: CeremonyViewOutput | null;
}

/** What the display should show now. Public data only; identical for every role. */
export function projectScene(i: SceneInput): SceneOutput {
  const { event: e } = i;
  if (i.ceremony && i.ceremony.status !== 'idle' && i.ceremony.status !== 'cancelled') {
    return { scene: 'ceremony', ceremony: i.ceremony };
  }
  if (e.phase === 'preparation' || e.phase === 'registration' || e.phase === 'gift_registration') {
    return {
      scene: 'lobby',
      participants: i.activeParticipants,
      joinUrl: i.join?.url ?? null,
      shortCode: i.join?.shortCode ?? null,
    };
  }
  if (e.phase === 'gift_opening') {
    const real = i.gifts.filter((g) => !g.hidden);
    const current = real.find((g) => g.id === e.currentGiftId && g.status !== 'registered');
    const seconds = e.openingCountdownSeconds ?? 0;
    return {
      scene: 'opening',
      openedCount: real.filter((g) => g.status !== 'registered').length,
      total: real.length,
      current: current ? toPublicGift(current, i.people) : null,
      countdownSeconds: seconds,
      countdownEndsAt:
        current?.openedAt && seconds > 0
          ? new Date(Date.parse(current.openedAt) + seconds * 1000).toISOString()
          : null,
    };
  }
  if (e.phase === 'voting') {
    return {
      scene: 'voting',
      endsAt: e.votingEndsAt,
      votedCount: i.votedCount,
      closed: e.milestones.votingClosedAt !== null,
    };
  }
  return { scene: 'phase', phase: e.phase };
}
