import {
  REVEAL_CHOICE_CLOSE_JOB,
  REVEAL_UNVEIL_JOB,
  closeShowChoice,
  revealNextGift as revealNextGiftDb,
  unveilStagedGift,
  type Db,
  type RevealNextResult,
} from '@santa/db';
import type { JobRunner } from '../jobs/runner.js';
import type { RealtimeHub } from './hub.js';
import { broadcastGifts } from './broadcast.js';
import { afterReveal, broadcastScene } from './phase2.js';

/**
 * Reveal show service (organizer route + autopilot): stage the next gift (drumroll, giver NOT revealed yet),
 * schedule its durable `reveal.unveil` job, push the scene. If a late drumroll was force-finished first,
 * its guesses settle too.
 */
export async function revealNextGift(
  hub: RealtimeHub,
  db: Db,
  p: { eventId: string; actor: string; now: Date },
): Promise<RevealNextResult> {
  const r = await revealNextGiftDb(db, p);
  await broadcastGifts(hub, db, p.eventId);
  if (r.unveiledGiftId) await afterReveal(hub, db, p.eventId, p.now);
  return {
    giftId: r.giftId,
    countdownEndsAt: r.countdownEndsAt,
    revealedCount: r.revealedCount,
    total: r.total,
    done: r.done,
  };
}

/** Drumroll deadline: reveal the staged giver and push. At-least-once; stale/duplicate deliveries are no-ops. */
export function registerRevealJobs(
  runner: JobRunner,
  hub: RealtimeHub,
  db: Db,
  clock: () => Date = () => new Date(),
) {
  runner.register(REVEAL_UNVEIL_JOB, async (job) => {
    if (!job.eventId) return;
    const giftId = (job.payload as { giftId?: unknown } | null)?.giftId;
    if (typeof giftId !== 'string') return;
    const now = clock();
    const r = await unveilStagedGift(db, { eventId: job.eventId, giftId, now });
    if (!r.changed) return;
    await broadcastGifts(hub, db, job.eventId); // scene: drumroll -> revealed; gallery shows the giver
    await afterReveal(hub, db, job.eventId, now); // guesses on this gift settle
  });

  /** Snowstorm vs Sleigh Bells deadline: server closes the round, stores the outcome only, pushes the scene. */
  runner.register(REVEAL_CHOICE_CLOSE_JOB, async (job) => {
    if (!job.eventId) return;
    const roundId = (job.payload as { roundId?: unknown } | null)?.roundId;
    if (typeof roundId !== 'string') return;
    const r = await closeShowChoice(db, { eventId: job.eventId, roundId, now: clock() });
    if (r.changed) await broadcastScene(hub, db, job.eventId);
  });
}
