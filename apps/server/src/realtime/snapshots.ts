import { and, eq } from 'drizzle-orm';
import {
  boardPublications,
  events,
  gifts,
  loadParticipantSources,
  pairings,
  unmaskGrants,
  votes,
  eventOrganizers,
  type Db,
} from '@santa/db';
import {
  projectEventState,
  projectGiftList,
  projectLeaderboard,
  type EventSource,
  type GiftSource,
  type PublishResult,
  type Viewer,
} from '@santa/domain';
import type { Principal } from '../principal.js';
import type { SnapshotProvider } from './hub.js';

export async function loadEventSource(db: Db, eventId: string): Promise<EventSource> {
  const [e] = await db.select().from(events).where(eq(events.id, eventId));
  if (!e) throw new Error('event not found');
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    theme: e.theme,
    startsAt: e.startsAt.toISOString(),
    timezone: e.timezone,
    phase: e.phase,
    paused: e.paused,
    maxParticipants: e.maxParticipants,
    votingRound: e.votingRound,
    defaultLocale: e.defaultLocale === 'it' ? 'it' : 'en',
    milestones: {
      giftOpeningStartedAt: iso(e.giftOpeningStartedAt),
      votingClosedAt: iso(e.votingClosedAt),
      revealStartedAt: iso(e.revealStartedAt),
      ceremonyStartedAt: iso(e.ceremonyStartedAt),
    },
  };
}

/** Recipient is derived from `pairings` (never stored on the gift). */
export async function loadGiftSources(db: Db, eventId: string): Promise<GiftSource[]> {
  const rows = await db
    .select({ g: gifts, recipientId: pairings.recipientId })
    .from(gifts)
    .innerJoin(
      pairings,
      and(eq(pairings.eventId, gifts.eventId), eq(pairings.giverId, gifts.giverId)),
    )
    .where(eq(gifts.eventId, eventId));
  return rows.map(({ g, recipientId }) => ({
    id: g.id,
    aliasNo: g.aliasNo,
    name: g.name,
    description: g.description,
    photoUrl: null,
    status: g.status,
    giverId: g.giverId,
    recipientId,
    openingOrder: g.openingOrder,
    createdAt: g.createdAt.toISOString(),
    openedAt: g.openedAt?.toISOString() ?? null,
  }));
}

export class DbSnapshotProvider implements SnapshotProvider {
  constructor(private readonly db: Db) {}

  async snapshot(p: Principal, eventId: string, stream: string): Promise<Record<string, unknown>> {
    const [event, people, giftRows] = await Promise.all([
      loadEventSource(this.db, eventId),
      loadParticipantSources(this.db, eventId),
      loadGiftSources(this.db, eventId),
    ]);

    if (stream === 'pub') {
      const out: Record<string, unknown> = {
        giftList: projectGiftList({ role: 'display' }, event.phase, giftRows, people),
      };
      const [board] = await this.db
        .select()
        .from(boardPublications)
        .where(eq(boardPublications.eventId, eventId));
      if (board) {
        out['leaderboard'] = projectLeaderboard({
          boardKey: board.boardKey,
          state: board.state,
          lastPublished: board.lastPublished as PublishResult | null,
        });
      }
      return out;
    }

    const base = {
      event,
      participants: people,
      giftsRegistered: giftRows.length,
    };

    if (stream.startsWith('p:') && p.kind === 'guest') {
      const own = await this.db
        .select({ categoryId: votes.categoryId, giftId: votes.giftId })
        .from(votes)
        .where(and(eq(votes.eventId, eventId), eq(votes.voterId, p.participantId)));
      const viewer: Viewer = { role: 'participant', participantId: p.participantId };
      return { eventState: projectEventState(viewer, { ...base, ownVotes: own }) };
    }

    if (p.kind === 'organizer') {
      const [membership] = await this.db
        .select({ participantId: eventOrganizers.participantId })
        .from(eventOrganizers)
        .where(and(eq(eventOrganizers.eventId, eventId), eq(eventOrganizers.userId, p.userId)));
      const participantId = membership?.participantId ?? null;
      const own = participantId
        ? await this.db
            .select({ categoryId: votes.categoryId, giftId: votes.giftId })
            .from(votes)
            .where(and(eq(votes.eventId, eventId), eq(votes.voterId, participantId)))
        : [];
      if (stream === 'org') {
        return {
          eventState: projectEventState(
            { role: 'organizer_masked', participantId },
            { ...base, ownVotes: own },
          ),
        };
      }
      if (stream.startsWith('grant:')) {
        const grantId = stream.slice('grant:'.length);
        const [g] = await this.db.select().from(unmaskGrants).where(eq(unmaskGrants.id, grantId));
        if (!g) throw new Error('grant not found');
        const viewer: Viewer = {
          role: 'organizer_unmasked',
          participantId,
          grant: { grantId, expiresAt: g.expiresAt.toISOString() },
        };
        return {
          eventState: projectEventState(viewer, { ...base, ownVotes: own }),
          giftList: projectGiftList(viewer, event.phase, giftRows, people),
        };
      }
    }
    throw new Error('stream not available for principal');
  }
}
