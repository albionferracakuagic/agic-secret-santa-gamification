import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  AUTOPILOT_TICK_JOB,
  ACTIVE_GAME_STATUSES,
  advanceCeremony,
  changePhase,
  closeVoting,
  createGame,
  finalizeEvent,
  gameAction,
  miniGames,
  openNextGift,
  openVoting,
  resolveTiesShared,
  runAutopilotTick,
  startCeremony,
  type AutopilotExecutor,
  type Db,
} from '@santa/db';
import type { JobRunner } from '../jobs/runner.js';
import type { RealtimeHub } from './hub.js';
import { broadcastEventState, broadcastGifts } from './broadcast.js';
import { emitCeremony } from './ceremonyEvents.js';
import { broadcastScene, emitAnnouncements } from './phase2.js';
import { revealNextGift } from './reveal.js';

const SYSTEM = 'system';

/** Organizer-only surface (`eventState.organizer.autopilot` on `org`/`grant:` streams). */
export const broadcastAutopilot = (hub: RealtimeHub, db: Db, eventId: string) =>
  broadcastEventState(hub, db, eventId);

/**
 * Autopilot side effects: the SAME services the organizer routes call, actor `system`, each followed by the
 * same realtime pushes. Runs outside any transaction (services open their own).
 */
export function createAutopilotExecutor(hub: RealtimeHub, db: Db): AutopilotExecutor {
  return async (action, { eventId, now }) => {
    switch (action.type) {
      case 'open_next_gift':
        await openNextGift(db, { eventId, actor: SYSTEM, now });
        await broadcastGifts(hub, db, eventId);
        return;
      case 'open_voting':
        await openVoting(db, { eventId, actor: SYSTEM, durationMinutes: action.minutes, now });
        await broadcastEventState(hub, db, eventId);
        return;
      case 'close_voting': {
        const r = await closeVoting(db, { eventId, actor: SYSTEM, now });
        if (!r.alreadyClosed) await broadcastEventState(hub, db, eventId);
        return;
      }
      case 'start_game': {
        const [draft] = await db
          .select({ id: miniGames.id })
          .from(miniGames)
          .where(and(eq(miniGames.eventId, eventId), eq(miniGames.status, 'draft')))
          .orderBy(asc(miniGames.createdAt));
        const gameId =
          draft?.id ?? (await createGame(db, { eventId, actor: SYSTEM, kind: 'trivia', now })).gameId;
        await gameAction(db, { eventId, gameId, action: 'start', actor: SYSTEM, now });
        await broadcastScene(hub, db, eventId);
        return;
      }
      case 'end_game': {
        const [g] = await db
          .select({ id: miniGames.id, status: miniGames.status })
          .from(miniGames)
          .where(
            and(
              eq(miniGames.eventId, eventId),
              inArray(miniGames.status, [...ACTIVE_GAME_STATUSES]),
            ),
          );
        if (!g) return;
        if (g.status !== 'results')
          await gameAction(db, { eventId, gameId: g.id, action: 'show_results', actor: SYSTEM, now });
        const r = await gameAction(db, { eventId, gameId: g.id, action: 'finish', actor: SYSTEM, now });
        await broadcastScene(hub, db, eventId);
        if (r.announcements.length) await emitAnnouncements(hub, db, eventId, r.announcements, now);
        await broadcastEventState(hub, db, eventId);
        return;
      }
      case 'reveal_next_gift':
        await revealNextGift(hub, db, { eventId, actor: SYSTEM, now });
        return;
      case 'resolve_ties':
        await resolveTiesShared(db, { eventId, actor: SYSTEM, now });
        await broadcastEventState(hub, db, eventId);
        return;
      case 'start_ceremony': {
        const r = await startCeremony(db, { eventId, actor: SYSTEM, now });
        await emitCeremony(hub, db, eventId, r?.announcements ?? [], now, { boards: true });
        return;
      }
      case 'advance_ceremony': {
        const r = await advanceCeremony(db, {
          eventId,
          actor: SYSTEM,
          fromIndex: action.fromIndex,
          now,
        });
        await emitCeremony(hub, db, eventId, r.announcements, now, { boards: r.done });
        return;
      }
      case 'advance_phase': {
        const r = await changePhase(db, { eventId, actor: SYSTEM, to: action.to, now });
        await broadcastEventState(hub, db, eventId);
        await broadcastScene(hub, db, eventId);
        if (r.phase === 'completed') await finalizeEvent(db, eventId, now).catch(() => undefined);
        return;
      }
      case 'complete':
        return;
    }
  };
}

export function registerAutopilotJobs(
  runner: JobRunner,
  hub: RealtimeHub,
  db: Db,
  clock: () => Date = () => new Date(),
) {
  const execute = createAutopilotExecutor(hub, db);
  runner.register(AUTOPILOT_TICK_JOB, async (job) => {
    const seq = Number((job.payload as { seq?: unknown } | null)?.seq);
    const eventId = job.eventId;
    if (!eventId || !Number.isInteger(seq)) return;
    const r = await runAutopilotTick(db, { eventId, seq, now: clock(), execute });
    if (r.ran || r.reason === 'frozen_held') await broadcastAutopilot(hub, db, eventId);
  });
}
