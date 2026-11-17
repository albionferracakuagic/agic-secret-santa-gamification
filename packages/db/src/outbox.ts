import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from './types.js';
import * as s from './schema.js';

export interface OutboxMessage {
  id: string;
  eventId: string | null;
  topic: string;
  payload: unknown;
  attempts: number;
}

/**
 * Transactional outbox: call inside the SAME transaction as the state change, so a message exists iff the change
 * committed. A dispatcher relays it to the realtime bus (at-least-once; consumers must be idempotent).
 */
export async function enqueueOutbox(
  db: Db,
  m: { eventId?: string | null; topic: string; payload: unknown },
): Promise<string> {
  const [row] = await db
    .insert(s.outboxEvents)
    .values({ eventId: m.eventId ?? null, topic: m.topic, payload: m.payload })
    .returning({ id: s.outboxEvents.id });
  return row!.id;
}

/**
 * Claims pending messages in order, runs `publish` on each inside the claiming transaction (rows locked with
 * SKIP LOCKED, so several instances never relay the same message) and marks them dispatched. A throwing
 * publish leaves that message (and everything after it) pending with `attempts` bumped.
 */
export async function dispatchOutbox(
  db: Db,
  o: { limit: number; now: Date; maxAttempts?: number; publish: (m: OutboxMessage) => Promise<void> },
): Promise<{ dispatched: number; failed: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(s.outboxEvents)
      .where(and(isNull(s.outboxEvents.dispatchedAt), lt(s.outboxEvents.attempts, o.maxAttempts ?? 10)))
      .orderBy(asc(s.outboxEvents.seq))
      .limit(o.limit)
      .for('update', { skipLocked: true });
    let dispatched = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        await o.publish({ id: r.id, eventId: r.eventId, topic: r.topic, payload: r.payload, attempts: r.attempts });
        await tx.update(s.outboxEvents).set({ dispatchedAt: o.now }).where(eq(s.outboxEvents.id, r.id));
        dispatched++;
      } catch {
        await tx
          .update(s.outboxEvents)
          .set({ attempts: sql`${s.outboxEvents.attempts} + 1` })
          .where(eq(s.outboxEvents.id, r.id));
        failed++;
        break; // keep ordering: never skip past a message that failed
      }
    }
    return { dispatched, failed };
  });
}

/** Housekeeping: dispatched rows older than `before` are deleted. */
export async function purgeOutbox(db: Db, before: Date): Promise<number> {
  const gone = await db
    .delete(s.outboxEvents)
    .where(and(sql`${s.outboxEvents.dispatchedAt} is not null`, lt(s.outboxEvents.dispatchedAt, before)))
    .returning({ id: s.outboxEvents.id });
  return gone.length;
}
