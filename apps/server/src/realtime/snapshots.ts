import { and, eq } from 'drizzle-orm';
import { eventOrganizers, unmaskGrants, votes, type Db } from '@santa/db';
import {
  projectEventState,
  projectGiftList,
  projectLeaderboard,
  projectScene,
  type Viewer,
} from '@santa/domain';
import type { Principal } from '../principal.js';
import type { SnapshotProvider } from './hub.js';
import { loadEventContext, type EventContext, type RealtimeContext } from './state.js';

export { loadEventSource, loadGiftSources } from './state.js';

const sceneOf = (c: EventContext) =>
  projectScene({
    event: c.event,
    activeParticipants: c.people.filter((p) => p.status === 'active').length,
    gifts: c.gifts,
    people: c.people,
    join: c.join,
    votedCount: c.votedCount,
  });

/** Public (display-role) projections shared by the pub stream: gifts, board, scene. */
export function publicSurfaces(c: EventContext, now = new Date()) {
  const out: Record<string, unknown> = {
    giftList: projectGiftList(
      { role: 'display' },
      c.event.phase,
      c.gifts,
      c.people,
      now,
      c.event.currentGiftId,
    ),
    scene: sceneOf(c),
  };
  const board = c.boards[0];
  if (board) out['leaderboard'] = projectLeaderboard(board, c.labels);
  return out;
}

export class DbSnapshotProvider implements SnapshotProvider {
  constructor(
    private readonly db: Db,
    private readonly ctx: RealtimeContext = { baseUrl: 'http://localhost:3000' },
  ) {}

  async snapshot(p: Principal, eventId: string, stream: string): Promise<Record<string, unknown>> {
    const c = await loadEventContext(this.db, eventId, this.ctx);
    if (stream === 'pub') return publicSurfaces(c);

    const base = {
      event: c.event,
      participants: c.people,
      giftsRegistered: c.gifts.length,
      ...(c.votedCount === null ? {} : { votedCount: c.votedCount }),
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
          giftList: projectGiftList(viewer, c.event.phase, c.gifts, c.people),
        };
      }
    }
    throw new Error('stream not available for principal');
  }
}
