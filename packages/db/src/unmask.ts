import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { enqueueJob } from './jobs.js';

export const UNMASK_TTL_MS = 10 * 60_000;
export const GRANT_EXPIRE_JOB = 'grant.expire';

/**
 * Audit unmask: fixed 10-minute grant, NOT extendable. A new grant needs a fresh confirm + reason
 * and writes a fresh audit row. Expiry is a durable job (hub also re-checks on every send).
 */
export async function createUnmaskGrant(
  db: Db,
  p: { eventId: string; userId: string; reason: string; now: Date },
): Promise<{ grantId: string; expiresAt: Date }> {
  return db.transaction(async (tx) => {
    const expiresAt = new Date(p.now.getTime() + UNMASK_TTL_MS);
    const [g] = await tx
      .insert(s.unmaskGrants)
      .values({
        eventId: p.eventId,
        userId: p.userId,
        reason: p.reason,
        expiresAt,
        createdAt: p.now,
      })
      .returning({ id: s.unmaskGrants.id });
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.userId,
      action: 'unmask.grant',
      target: g!.id,
      reason: p.reason,
      at: p.now,
    });
    await enqueueJob(tx, {
      eventId: p.eventId,
      kind: GRANT_EXPIRE_JOB,
      runAt: expiresAt,
      payload: { grantId: g!.id },
    });
    return { grantId: g!.id, expiresAt };
  });
}

/** Returns true if an active grant was revoked. */
export async function revokeUnmaskGrant(
  db: Db,
  p: { eventId: string; grantId: string; userId: string; now: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(s.unmaskGrants)
      .set({ revokedAt: p.now })
      .where(
        and(
          eq(s.unmaskGrants.id, p.grantId),
          eq(s.unmaskGrants.eventId, p.eventId),
          eq(s.unmaskGrants.userId, p.userId),
          isNull(s.unmaskGrants.revokedAt),
          gt(s.unmaskGrants.expiresAt, p.now),
        ),
      )
      .returning({ id: s.unmaskGrants.id });
    if (rows.length) {
      await writeAudit(tx, {
        eventId: p.eventId,
        actor: p.userId,
        action: 'unmask.revoke',
        target: p.grantId,
        at: p.now,
      });
    }
    return rows.length > 0;
  });
}

/** Only callable behind an active grant; every read is audited. */
export async function loadPairingsUnmasked(
  db: Db,
  eventId: string,
  actor: string,
  grantId: string,
) {
  const rows = await db
    .select({
      giverId: s.pairings.giverId,
      recipientId: s.pairings.recipientId,
      source: s.pairings.source,
    })
    .from(s.pairings)
    .where(eq(s.pairings.eventId, eventId));
  await writeAudit(db, {
    eventId,
    actor,
    action: 'unmask.read_pairings',
    target: grantId,
    data: { count: rows.length },
  });
  return rows;
}
