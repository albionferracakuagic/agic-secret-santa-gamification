import { eq } from 'drizzle-orm';
import { AUCTION_CLOSE_JOB, closeDueAuction, participants, type Db } from '@santa/db';
import type { JobRunner } from '../jobs/runner.js';
import type { RealtimeHub } from './hub.js';
import { broadcastScene } from './phase2.js';

const person = async (db: Db, id: string) => {
  const [p] = await db
    .select({ id: participants.id, name: participants.displayName, avatar: participants.avatar })
    .from(participants)
    .where(eq(participants.id, id));
  return p ? { participantId: p.id, displayName: p.name, avatar: p.avatar } : null;
};

/** Winner announcement (pub): positive recognition only; bidders who lost are never mentioned. */
export async function announceAuctionClosed(
  hub: RealtimeHub,
  db: Db,
  eventId: string,
  prize: { id: string; title: Record<string, string>; winnerId: string | null },
  now: Date,
) {
  if (!prize.winnerId) return;
  const winner = await person(db, prize.winnerId);
  if (!winner) return;
  hub.publish(eventId, 'pub', 'announcement', {
    type: 'auction_won',
    prizeId: prize.id,
    title: prize.title,
    winner,
    at: now.toISOString(),
  });
}

/** Mystery-box reveal: the animation cue + the content, from the stored prize (only after `reveal`). */
export async function announceMysteryReveal(
  hub: RealtimeHub,
  db: Db,
  eventId: string,
  prize: { id: string; title: Record<string, string>; reveal: Record<string, string>; winnerId: string | null },
  now: Date,
) {
  hub.publish(eventId, 'pub', 'announcement', {
    type: 'mystery_reveal',
    prizeId: prize.id,
    title: prize.title,
    reveal: prize.reveal,
    winner: prize.winnerId ? await person(db, prize.winnerId) : null,
    cue: 'box_open',
    at: now.toISOString(),
  });
}

/** Durable auction deadline (re-scheduled on every anti-snipe extension; stale deliveries are no-ops). */
export function registerAuctionJobs(
  runner: JobRunner,
  hub: RealtimeHub,
  db: Db,
  clock: () => Date = () => new Date(),
) {
  runner.register(AUCTION_CLOSE_JOB, async (job) => {
    if (!job.eventId) return;
    const { prizeId, version } = (job.payload ?? {}) as { prizeId?: string; version?: number };
    if (!prizeId || typeof version !== 'number') return;
    const now = clock();
    const r = await closeDueAuction(db, { prizeId, version, now });
    if (!r) return;
    await broadcastScene(hub, db, job.eventId);
    await announceAuctionClosed(hub, db, job.eventId, r.prize, now);
  });
}

