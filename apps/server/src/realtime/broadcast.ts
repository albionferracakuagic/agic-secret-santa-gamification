import { and, eq } from 'drizzle-orm';
import { loadParticipantSources, votes, type Db } from '@santa/db';
import { projectEventState } from '@santa/domain';
import type { RealtimeHub } from './hub.js';
import { loadEventSource, loadGiftSources } from './snapshots.js';

/**
 * Push the new event state to every stream after a phase/pause/settings change.
 * Each stream gets its own projection (pub = display role, p:{id} = that participant only).
 * The shared org stream is projected without a bound player entry; organizers keep `me` from their snapshot.
 */
export async function broadcastEventState(hub: RealtimeHub, db: Db, eventId: string) {
  const [event, participants, gifts, allVotes] = await Promise.all([
    loadEventSource(db, eventId),
    loadParticipantSources(db, eventId),
    loadGiftSources(db, eventId),
    db
      .select({ voterId: votes.voterId, categoryId: votes.categoryId, giftId: votes.giftId })
      .from(votes)
      .where(and(eq(votes.eventId, eventId))),
  ]);
  const base = { event, participants, giftsRegistered: gifts.length };
  hub.publish(
    eventId,
    'pub',
    'eventState',
    projectEventState({ role: 'display' }, { ...base, ownVotes: [] }),
  );
  hub.publish(
    eventId,
    'org',
    'eventState',
    projectEventState({ role: 'organizer_masked', participantId: null }, { ...base, ownVotes: [] }),
  );
  for (const p of participants.filter((x) => x.status === 'active')) {
    const ownVotes = allVotes
      .filter((v) => v.voterId === p.id)
      .map((v) => ({ categoryId: v.categoryId, giftId: v.giftId }));
    hub.publish(
      eventId,
      `p:${p.id}`,
      'eventState',
      projectEventState({ role: 'participant', participantId: p.id }, { ...base, ownVotes }),
    );
  }
}
