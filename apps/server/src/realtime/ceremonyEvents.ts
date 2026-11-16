import { eq } from 'drizzle-orm';
import {
  CEREMONY_STEP_JOB,
  advanceCeremony,
  participants,
  type CeremonyAnnouncement,
  type Db,
} from '@santa/db';
import type { JobRunner } from '../jobs/runner.js';
import type { RealtimeHub } from './hub.js';
import { broadcastBoards, broadcastCeremony } from './broadcast.js';

/** Scene to display + participants, then achievement announcements (pub for everyone, own stream for personal ones). */
export async function emitCeremony(
  hub: RealtimeHub,
  db: Db,
  eventId: string,
  announcements: readonly CeremonyAnnouncement[],
  now: Date,
  opts: { boards?: boolean } = {},
) {
  await broadcastCeremony(hub, db, eventId);
  if (opts.boards) await broadcastBoards(hub, db, eventId);
  for (const a of announcements) {
    const [p] = await db
      .select({ id: participants.id, name: participants.displayName, avatar: participants.avatar })
      .from(participants)
      .where(eq(participants.id, a.participantId));
    if (!p) continue;
    hub.publish(eventId, a.scope === 'pub' ? 'pub' : `p:${p.id}`, 'announcement', {
      type: 'achievement',
      key: a.key,
      person: { participantId: p.id, displayName: p.name, avatar: p.avatar },
      at: now.toISOString(),
    });
  }
}

/** Countdown timer: at-least-once delivery; a stale or early delivery is a no-op inside advanceCeremony. */
export function registerCeremonyJobs(
  runner: JobRunner,
  hub: RealtimeHub,
  db: Db,
  clock: () => Date = () => new Date(),
) {
  runner.register(CEREMONY_STEP_JOB, async (job) => {
    if (!job.eventId) return;
    const index = (job.payload as { index?: number } | null)?.index;
    if (typeof index !== 'number') return;
    const now = clock();
    const r = await advanceCeremony(db, {
      eventId: job.eventId,
      actor: 'system',
      fromIndex: index,
      now,
      auto: true,
    });
    if (r.moved) await emitCeremony(hub, db, job.eventId, r.announcements, now, { boards: r.done });
  });
}
