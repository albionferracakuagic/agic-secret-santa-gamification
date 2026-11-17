import { eq, inArray } from 'drizzle-orm';
import type { Db } from './types.js';
import * as s from './schema.js';
import { EventError } from './events.js';

export type EventRow = typeof s.events.$inferSelect;
export type ParticipantRow = typeof s.participants.$inferSelect;

export async function loadEventRow(db: Db, eventId: string, lock = false): Promise<EventRow> {
  const q = db.select().from(s.events).where(eq(s.events.id, eventId));
  const [e] = await (lock ? q.for('update') : q);
  if (!e) throw new EventError('not_found');
  return e;
}

/** The caller's own roster row; only active participants take part in Phase 2 activities. */
export async function loadActiveParticipant(
  db: Db,
  participantId: string,
): Promise<ParticipantRow> {
  const [p] = await db.select().from(s.participants).where(eq(s.participants.id, participantId));
  if (!p || p.status !== 'active') throw new EventError('not_found');
  return p;
}

export const guessEnabled = (e: Pick<EventRow, 'settings'>) =>
  e.settings.features.guessSanta === true;
/** Mini-games are on unless the organizer switched them off (default on). */
export const miniGamesEnabled = (e: Pick<EventRow, 'settings'>) =>
  (e.settings.features as { miniGames?: boolean }).miniGames !== false;
export const missionsEnabled = (e: Pick<EventRow, 'settings'>) =>
  e.settings.features.missions === true;

/** Display data for people ids (current name: anonymised participants show their erased placeholder). */
export async function personMap(db: Db, ids: readonly string[]) {
  if (ids.length === 0)
    return new Map<string, { participantId: string; displayName: string; avatar: string | null }>();
  const rows = await db
    .select({
      id: s.participants.id,
      name: s.participants.displayName,
      avatar: s.participants.avatar,
    })
    .from(s.participants)
    .where(inArray(s.participants.id, [...ids]));
  return new Map(
    rows.map((r) => [r.id, { participantId: r.id, displayName: r.name, avatar: r.avatar }]),
  );
}

/** Ranked published entries (canPublish result) -> public people payload. Unknown ids are dropped. */
export async function publishedPeople(
  db: Db,
  result:
    { ok: true; entries: Array<{ entryId: string; rank: number; tied: boolean }> } | { ok: false },
) {
  if (!result.ok) return { message: 'christmas_magic' as const, entries: [] };
  const people = await personMap(
    db,
    result.entries.map((e) => e.entryId),
  );
  return {
    message: null,
    entries: result.entries.flatMap((e) => {
      const person = people.get(e.entryId);
      return person ? [{ person, rank: e.rank, tied: e.tied }] : [];
    }),
  };
}

/**
 * Erases everything a participant did in Phase 2 (guesses, authored clues, missions, opt-out, game answers, bingo
 * card/marks, personal scores). Used by delete-my-data and by organizer removal. Published results (stored
 * canPublish snapshots, announced achievements) are not rewritten, like locked vote awards.
 */
export async function purgePhase2Personal(tx: Db, participantId: string) {
  await tx.delete(s.santaGuesses).where(eq(s.santaGuesses.guesserId, participantId));
  await tx.delete(s.santaClues).where(eq(s.santaClues.giverId, participantId));
  await tx
    .delete(s.missionAssignments)
    .where(eq(s.missionAssignments.participantId, participantId));
  await tx.delete(s.missionOptOuts).where(eq(s.missionOptOuts.participantId, participantId));
  await tx.delete(s.gameSubmissions).where(eq(s.gameSubmissions.participantId, participantId));
  await tx.delete(s.gameBingoMarks).where(eq(s.gameBingoMarks.participantId, participantId));
  await tx.delete(s.gameBingoCards).where(eq(s.gameBingoCards.participantId, participantId));
  await tx.delete(s.gameScores).where(eq(s.gameScores.participantId, participantId));
  // Phase 3: coins and bids are personal too (a won prize stays recorded without a person)
  await tx.delete(s.auctionBids).where(eq(s.auctionBids.bidderId, participantId));
  await tx.delete(s.coinLedger).where(eq(s.coinLedger.participantId, participantId));
}
