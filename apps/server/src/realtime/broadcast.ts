import { and, eq } from 'drizzle-orm';
import { votes, type Db } from '@santa/db';
import { projectEventState } from '@santa/domain';
import type { RealtimeHub } from './hub.js';
import { publicSurfaces } from './snapshots.js';
import { loadEventContext } from './state.js';

/**
 * Push fresh state to every stream after a phase/pause/settings/voted-counter change. Each stream gets its own
 * projection (pub = display role, p:{id} = that participant only). Also refreshes the display scene.
 * The shared org stream is projected without a bound player entry; organizers keep `me` from their snapshot.
 */
export async function broadcastEventState(hub: RealtimeHub, db: Db, eventId: string) {
  const c = await loadEventContext(db, eventId, hub.ctx);
  const allVotes = await db
    .select({ voterId: votes.voterId, categoryId: votes.categoryId, giftId: votes.giftId })
    .from(votes)
    .where(and(eq(votes.eventId, eventId)));
  const base = {
    event: c.event,
    participants: c.people,
    giftsRegistered: c.gifts.length,
    ...(c.votedCount === null ? {} : { votedCount: c.votedCount }),
  };
  hub.publish(
    eventId,
    'pub',
    'eventState',
    projectEventState({ role: 'display' }, { ...base, ownVotes: [] }),
  );
  const pub = publicSurfaces(c);
  hub.publish(eventId, 'pub', 'scene', pub['scene']);
  hub.publish(eventId, 'pub', 'giftList', pub['giftList']); // count_only <-> gallery flips with the phase
  hub.publish(
    eventId,
    'org',
    'eventState',
    projectEventState({ role: 'organizer_masked', participantId: null }, { ...base, ownVotes: [] }),
  );
  for (const p of c.people.filter((x) => x.status === 'active')) {
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

/** After opening / reveal / moderation: gallery (public projection) + scene to the pub stream. */
export async function broadcastGifts(hub: RealtimeHub, db: Db, eventId: string) {
  const c = await loadEventContext(db, eventId, hub.ctx);
  const s = publicSurfaces(c);
  hub.publish(eventId, 'pub', 'giftList', s['giftList']);
  hub.publish(eventId, 'pub', 'scene', s['scene']);
}
