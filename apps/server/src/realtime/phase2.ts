import { eq } from 'drizzle-orm';
import {
  GAME_GO_JOB,
  GAME_STEP_JOB,
  MISSION_ANNOUNCE_JOB,
  advanceGameAuto,
  claimMissionAnnouncements,
  participants,
  settleGuesses,
  type CeremonyAnnouncement,
  type Db,
} from '@santa/db';
import type { JobRunner } from '../jobs/runner.js';
import type { RealtimeHub } from './hub.js';
import { broadcastEventState } from './broadcast.js';
import { publicSurfaces } from './snapshots.js';
import { loadEventContext } from './state.js';

/** Achievement announcements: `pub` for everyone, the winner's own `p:` stream for personal ones. */
export async function emitAnnouncements(
  hub: RealtimeHub,
  db: Db,
  eventId: string,
  announcements: readonly CeremonyAnnouncement[],
  now: Date,
) {
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

/** Display scene (game / presentation / phase) to the pub stream. */
export async function broadcastScene(hub: RealtimeHub, db: Db, eventId: string) {
  const c = await loadEventContext(db, eventId, hub.ctx);
  hub.publish(eventId, 'pub', 'scene', publicSurfaces(c)['scene']);
}

/**
 * Coalesces bursts (every participant answering at once) into at most one scene push per second per event.
 * Only a display refresh: timers and state live in the DB, so losing a pending push on restart is harmless.
 */
const pending = new Map<string, ReturnType<typeof setTimeout>>();
export function broadcastSceneSoon(hub: RealtimeHub, db: Db, eventId: string, ms = 1000) {
  if (pending.has(eventId)) return;
  const t = setTimeout(() => {
    pending.delete(eventId);
    void broadcastScene(hub, db, eventId).catch(() => undefined);
  }, ms);
  t.unref();
  pending.set(eventId, t);
}

/**
 * After a giver reveal (route, reveal-all or a ceremony winner step): settle the guesses on revealed gifts and push
 * each guesser their OWN playful result on their own stream; refresh XP for everyone who earned some.
 */
export async function afterReveal(hub: RealtimeHub, db: Db, eventId: string, now: Date) {
  const settled = await settleGuesses(db, eventId, now);
  if (settled.length === 0) return;
  for (const r of settled)
    hub.publish(eventId, `p:${r.guesserId}`, 'announcement', {
      type: 'guess_result',
      giftId: r.giftId,
      alias: r.alias,
      outcome: r.correct ? 'correct' : 'incorrect',
      cue: r.correct ? 'confetti' : 'wink',
      xp: r.xp,
      at: now.toISOString(),
    });
  if (settled.some((r) => r.xp > 0)) await broadcastEventState(hub, db, eventId);
}

/** Durable Phase 2 timers (at-least-once; every handler is idempotent). */
export function registerPhase2Jobs(
  runner: JobRunner,
  hub: RealtimeHub,
  db: Db,
  clock: () => Date = () => new Date(),
) {
  runner.register(GAME_STEP_JOB, async (job) => {
    if (!job.eventId) return;
    const { gameId, version } = (job.payload ?? {}) as { gameId?: string; version?: number };
    if (!gameId || typeof version !== 'number') return;
    const now = clock();
    const r = await advanceGameAuto(db, { gameId, version, now });
    if (!r.moved) return;
    await broadcastScene(hub, db, job.eventId);
    if (r.announcements.length) {
      await emitAnnouncements(hub, db, job.eventId, r.announcements, now);
      await broadcastEventState(hub, db, job.eventId); // XP changed
    }
  });

  runner.register(GAME_GO_JOB, async (job) => {
    if (job.eventId) await broadcastScene(hub, db, job.eventId);
  });

  runner.register(MISSION_ANNOUNCE_JOB, async (job) => {
    if (!job.eventId) return;
    const now = clock();
    const n = await claimMissionAnnouncements(db, job.eventId, now);
    for (let i = 0; i < n; i++)
      hub.publish(job.eventId, 'pub', 'announcement', {
        type: 'mission_completed',
        at: now.toISOString(),
      });
  });
}
