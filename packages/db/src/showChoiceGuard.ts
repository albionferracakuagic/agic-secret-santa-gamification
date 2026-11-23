import { and, desc, eq } from 'drizzle-orm';
import { SHOW_CHOICE_RESULT_HOLD_MS } from '@santa/contracts';
import type { Db } from './types.js';
import * as s from './schema.js';
import { EventError } from './events.js';

/** While the close job is overdue (round still open past its deadline), the autopilot re-checks this often. */
export const SHOW_CHOICE_OVERDUE_RECHECK_MS = 1000;

/**
 * Stage guard for every service that would move the reveal show on (next gift / drumroll, leaving the reveal
 * phase, side presentations): an open Snowstorm vs Sleigh Bells round owns the stage until the server closes it
 * (or the organizer cancels it). Call inside the caller's transaction AFTER it locked the event row, so it
 * serializes with `startShowChoice` (same lock). Error: choice_open.
 */
export async function assertNoOpenShowChoice(db: Db, eventId: string): Promise<void> {
  const [open] = await db
    .select({ id: s.showChoiceRounds.id })
    .from(s.showChoiceRounds)
    .where(and(eq(s.showChoiceRounds.eventId, eventId), eq(s.showChoiceRounds.status, 'open')))
    .limit(1);
  if (open) throw new EventError('choice_open');
}

/**
 * Until when the autopilot must not act because of the choice: an open round -> its deadline + result window
 * (or a short re-check once the deadline passed but the close job has not run yet); a closed / cancelled round
 * -> authoritative `closedAt` + result window. `null` = no hold (timing unchanged).
 */
export async function showChoiceHoldUntil(
  db: Db,
  eventId: string,
  now: Date,
): Promise<Date | null> {
  const [last] = await db
    .select({
      status: s.showChoiceRounds.status,
      endsAt: s.showChoiceRounds.endsAt,
      closedAt: s.showChoiceRounds.closedAt,
    })
    .from(s.showChoiceRounds)
    .where(eq(s.showChoiceRounds.eventId, eventId))
    .orderBy(desc(s.showChoiceRounds.roundNo))
    .limit(1);
  if (!last) return null;
  const t = now.getTime();
  if (last.status === 'open') {
    const until = last.endsAt.getTime() + SHOW_CHOICE_RESULT_HOLD_MS;
    return new Date(last.endsAt.getTime() > t ? until : t + SHOW_CHOICE_OVERDUE_RECHECK_MS);
  }
  const until = (last.closedAt ?? last.endsAt).getTime() + SHOW_CHOICE_RESULT_HOLD_MS;
  return until > t ? new Date(until) : null;
}
