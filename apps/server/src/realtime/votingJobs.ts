import { eq } from 'drizzle-orm';
import {
  BOARD_PUBLISH_JOB,
  EventError,
  VOTING_AUTOCLOSE_JOB,
  closeVoting,
  enqueueJob,
  events,
  publishLiveBoards,
  publishVotedCounter,
  votingIsClosed,
  type Db,
} from '@santa/db';
import type { JobRunner } from '../jobs/runner.js';
import type { RealtimeHub } from './hub.js';
import { broadcastBoards, broadcastEventState } from './broadcast.js';

/**
 * Durable voting timers. Handlers are idempotent (at-least-once delivery):
 * - voting.autoclose: closes + locks awards if still open (no-op when already closed).
 * - board.publish: cadence tick for the "N voted" counter; re-schedules itself while voting is open.
 */
export function registerVotingJobs(
  runner: JobRunner,
  hub: RealtimeHub,
  db: Db,
  clock: () => Date = () => new Date(),
) {
  runner.register(VOTING_AUTOCLOSE_JOB, async (job) => {
    if (!job.eventId) return;
    try {
      const r = await closeVoting(db, { eventId: job.eventId, actor: 'system', now: clock() });
      if (!r.alreadyClosed) await broadcastEventState(hub, db, job.eventId);
    } catch (e) {
      if (e instanceof EventError && (e.code === 'voting_not_open' || e.code === 'not_found'))
        return;
      throw e;
    }
  });

  runner.register(BOARD_PUBLISH_JOB, async (job) => {
    if (!job.eventId) return;
    const now = clock();
    const [e] = await db.select().from(events).where(eq(events.id, job.eventId));
    if (!e || e.phase !== 'voting' || votingIsClosed(e, now)) return; // final publish happens at close
    const r = await publishVotedCounter(db, job.eventId, now);
    // live boards: only republished when the projection changed AND canPublish passes
    const boardsChanged = await publishLiveBoards(db, job.eventId, now);
    if (r.changed) await broadcastEventState(hub, db, job.eventId);
    else if (boardsChanged) await broadcastBoards(hub, db, job.eventId);
    await enqueueJob(db, {
      eventId: job.eventId,
      kind: BOARD_PUBLISH_JOB,
      runAt: new Date(now.getTime() + e.settings.cadenceSeconds * 1000),
    });
  });
}
