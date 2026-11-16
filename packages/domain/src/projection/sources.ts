import type { Locale, Phase } from '@santa/contracts';
import type { PublishResult } from '../ranking.js';

/** Row-level inputs the server loads from the DB. Projectors are the ONLY path from these to payloads. */
export interface EventSource {
  id: string;
  name: string;
  description: string | null;
  theme: string;
  startsAt: string;
  timezone: string;
  phase: Phase;
  paused: boolean;
  maxParticipants: number;
  votingRound: number;
  defaultLocale: Locale;
  milestones: {
    giftOpeningStartedAt: string | null;
    votingClosedAt: string | null;
    revealStartedAt: string | null;
    ceremonyStartedAt: string | null;
  };
}

export interface ParticipantSource {
  id: string;
  displayName: string;
  avatar: string | null;
  status: 'unclaimed' | 'pending' | 'active' | 'removed';
  /** Total XP (self-only in projections). Champion ranking must use qualifying XP instead. */
  xp: number;
}

export interface GiftSource {
  id: string;
  aliasNo: number;
  name: string;
  description: string | null;
  photoUrl: string | null;
  status: 'registered' | 'opened' | 'revealed';
  giverId: string;
  recipientId: string;
  openingOrder: number | null;
  createdAt: string;
  openedAt: string | null;
}

export interface BoardSource {
  boardKey: string;
  state: 'hidden' | 'live' | 'paused';
  /** Only the last published result is ever projected (reconnect cannot bypass cadence). */
  lastPublished: PublishResult | null;
}

export interface Grant {
  grantId: string;
  expiresAt: string;
}

export type Viewer =
  | { role: 'participant'; participantId: string }
  | { role: 'display' }
  | { role: 'organizer_masked'; participantId: string | null }
  | { role: 'organizer_unmasked'; participantId: string | null; grant: Grant };

export class ProjectionForbiddenError extends Error {}

export function assertActiveGrant(viewer: Viewer, now: Date): Grant {
  if (viewer.role !== 'organizer_unmasked')
    throw new ProjectionForbiddenError('unmask grant required');
  if (new Date(viewer.grant.expiresAt).getTime() <= now.getTime()) {
    throw new ProjectionForbiddenError('unmask grant expired');
  }
  return viewer.grant;
}
