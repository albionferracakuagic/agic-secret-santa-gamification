import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { EventError } from './events.js';
import { enqueueJob } from './jobs.js';

/**
 * Giver reveal show (one gift at a time). State lives in the DB, never in memory:
 * - `events.current_gift_id` (reveal phase) = the gift on stage (cleared when the reveal phase starts and on reveal-all);
 * - the `reveal.unveil` scheduled job for that gift carries the drumroll deadline (`run_at`).
 * The giver is written (`giver_revealed_at`) only when the drumroll ends, so nothing before that can leak it.
 * Drumroll length = `settings.ceremonyCountdownSeconds` (3..30 s, default 5): same "suspense" timer as the ceremony.
 */
export const REVEAL_UNVEIL_JOB = 'reveal.unveil';

export interface RevealNextResult {
  /** Gift now in drumroll; null = nothing left (finale: stage cleared). */
  giftId: string | null;
  countdownEndsAt: Date | null;
  revealedCount: number;
  total: number;
  done: boolean;
}

/** Revealable gifts = visible gifts that have been opened (status opened|revealed). */
async function counts(tx: Db, eventId: string) {
  const [r] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      revealed: sql<number>`count(*) filter (where ${s.gifts.status} = 'revealed')::int`,
    })
    .from(s.gifts)
    .where(
      and(
        eq(s.gifts.eventId, eventId),
        eq(s.gifts.hidden, false),
        ne(s.gifts.status, 'registered'),
      ),
    );
  return { total: Number(r?.total ?? 0), revealed: Number(r?.revealed ?? 0) };
}

/** Latest (non-cancelled) unveil job for a staged gift: its run_at is the drumroll deadline. */
async function drumrollDeadline(db: Db, eventId: string, giftId: string): Promise<Date | null> {
  const [j] = await db
    .select({ runAt: s.scheduledJobs.runAt })
    .from(s.scheduledJobs)
    .where(
      and(
        eq(s.scheduledJobs.eventId, eventId),
        eq(s.scheduledJobs.kind, REVEAL_UNVEIL_JOB),
        ne(s.scheduledJobs.status, 'cancelled'),
        sql`${s.scheduledJobs.payload}->>'giftId' = ${giftId}`,
      ),
    )
    .orderBy(desc(s.scheduledJobs.runAt))
    .limit(1);
  return j?.runAt ?? null;
}

async function markRevealed(
  tx: Db,
  p: { eventId: string; giftId: string; actor: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(s.gifts)
    .set({ status: 'revealed', giverRevealedAt: p.now })
    .where(
      and(
        eq(s.gifts.id, p.giftId),
        eq(s.gifts.eventId, p.eventId),
        eq(s.gifts.status, 'opened'),
        eq(s.gifts.hidden, false),
        isNull(s.gifts.giverRevealedAt),
      ),
    )
    .returning({ id: s.gifts.id });
  if (!rows.length) return false;
  await writeAudit(tx, {
    eventId: p.eventId,
    actor: p.actor,
    action: 'reveal.gift',
    target: p.giftId,
    at: p.now,
  });
  return true;
}

/**
 * Puts the next unrevealed gift on stage (drumroll) and schedules its unveil. Order = public opening order
 * (`opened_at`), then alias number. If the previous drumroll's deadline has passed but its job has not run yet,
 * that gift is unveiled first (so a late job never blocks the show). With nothing left the stage is cleared (finale).
 * Errors: reveal_not_started, invalid_step (not in the reveal phase), paused, stage_busy (drumroll still running).
 * Used by the organizer route and by the autopilot.
 */
export async function revealNextGift(
  db: Db,
  p: { eventId: string; actor: string; now: Date },
): Promise<RevealNextResult & { unveiledGiftId: string | null }> {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    if (!e.revealStartedAt) throw new EventError('reveal_not_started');
    if (e.phase !== 'reveal') throw new EventError('invalid_step');
    if (e.paused) throw new EventError('paused');

    let unveiledGiftId: string | null = null;
    if (e.currentGiftId) {
      const [cur] = await tx
        .select({ id: s.gifts.id, revealedAt: s.gifts.giverRevealedAt, hidden: s.gifts.hidden })
        .from(s.gifts)
        .where(eq(s.gifts.id, e.currentGiftId));
      if (cur && !cur.revealedAt && !cur.hidden) {
        const ends = await drumrollDeadline(tx, p.eventId, cur.id);
        if (ends && ends.getTime() > p.now.getTime()) throw new EventError('stage_busy');
        if (
          await markRevealed(tx, {
            eventId: p.eventId,
            giftId: cur.id,
            actor: 'system',
            now: p.now,
          })
        )
          unveiledGiftId = cur.id;
      }
    }

    const [next] = await tx
      .select({ id: s.gifts.id })
      .from(s.gifts)
      .where(
        and(
          eq(s.gifts.eventId, p.eventId),
          eq(s.gifts.status, 'opened'),
          eq(s.gifts.hidden, false),
          isNull(s.gifts.giverRevealedAt),
        ),
      )
      .orderBy(sql`${s.gifts.openedAt} asc nulls last`, asc(s.gifts.aliasNo))
      .limit(1);

    const c = await counts(tx, p.eventId);
    if (!next) {
      await tx
        .update(s.events)
        .set({ currentGiftId: null, updatedAt: p.now })
        .where(eq(s.events.id, p.eventId));
      return {
        giftId: null,
        countdownEndsAt: null,
        revealedCount: c.revealed,
        total: c.total,
        done: true,
        unveiledGiftId,
      };
    }
    const endsAt = new Date(p.now.getTime() + e.settings.ceremonyCountdownSeconds * 1000);
    await tx
      .update(s.events)
      .set({ currentGiftId: next.id, updatedAt: p.now })
      .where(eq(s.events.id, p.eventId));
    await enqueueJob(tx, {
      eventId: p.eventId,
      kind: REVEAL_UNVEIL_JOB,
      runAt: endsAt,
      payload: { giftId: next.id },
    });
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'reveal.stage',
      target: next.id,
      at: p.now,
    });
    return {
      giftId: next.id,
      countdownEndsAt: endsAt,
      revealedCount: c.revealed,
      total: c.total,
      done: false,
      unveiledGiftId,
    };
  });
}

/**
 * `reveal.unveil` job body: drumroll over -> the staged gift's giver is revealed. Idempotent and stale-safe:
 * no-op if the gift is no longer on stage (reveal-all / another gift staged), already revealed, or the event
 * left the reveal phase. Never reveals early (deadline re-checked).
 */
export async function unveilStagedGift(
  db: Db,
  p: { eventId: string; giftId: string; now: Date },
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e || e.phase !== 'reveal' || e.currentGiftId !== p.giftId) return { changed: false };
    const ends = await drumrollDeadline(tx, p.eventId, p.giftId);
    if (ends && ends.getTime() > p.now.getTime()) return { changed: false };
    const changed = await markRevealed(tx, {
      eventId: p.eventId,
      giftId: p.giftId,
      actor: 'system',
      now: p.now,
    });
    return { changed };
  });
}

/** What is on stage now (reveal phase only): gift + drumroll deadline. Public-safe ids only, no giver. */
export async function revealStage(
  db: Db,
  eventId: string,
): Promise<{ giftId: string | null; countdownEndsAt: Date | null } | null> {
  const [e] = await db
    .select({ phase: s.events.phase, currentGiftId: s.events.currentGiftId })
    .from(s.events)
    .where(eq(s.events.id, eventId));
  if (!e || e.phase !== 'reveal') return null;
  if (!e.currentGiftId) return { giftId: null, countdownEndsAt: null };
  return {
    giftId: e.currentGiftId,
    countdownEndsAt: await drumrollDeadline(db, eventId, e.currentGiftId),
  };
}
