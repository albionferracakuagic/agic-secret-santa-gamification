import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { EventError } from './events.js';
import { cancelJobs, enqueueJob } from './jobs.js';

export const RETENTION_JOB = 'retention.daily';
const DAY_MS = 86_400_000;

const FORMER = { en: 'Former player', it: 'Ex partecipante' } as const;

export type ErasedField =
  'name' | 'avatar' | 'email' | 'session' | 'gift_photo' | 'gift_text' | 'claim_credentials';

/**
 * Delete-my-data: anonymises the participant. Votes they cast stay as anonymous ballots (aggregates would
 * otherwise change); everything personal goes. The caller deletes the returned blobs from storage.
 */
export async function anonymizeParticipant(
  db: Db,
  p: { participantId: string; now: Date },
): Promise<{ eventId: string; erased: ErasedField[]; photoKeys: string[] }> {
  return db.transaction(async (tx) => {
    const [me] = await tx
      .select()
      .from(s.participants)
      .where(eq(s.participants.id, p.participantId));
    if (!me) throw new EventError('not_found');
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, me.eventId));
    const locale = e?.defaultLocale === 'it' ? 'it' : 'en';
    await tx
      .update(s.participants)
      .set({
        displayName: FORMER[locale],
        avatar: null,
        email: null,
        sessionTokenHash: null,
        claimCodeHash: null,
        claimVerifiedAt: null,
        userId: null,
        prefs: {},
        status: 'removed',
        anonymizedAt: p.now,
      })
      .where(eq(s.participants.id, me.id));
    await tx.delete(s.claimTokens).where(eq(s.claimTokens.participantId, me.id));
    const gs = await tx.select().from(s.gifts).where(eq(s.gifts.giverId, me.id));
    const photoKeys = gs.flatMap((g) => (g.photoKey ? [g.photoKey] : []));
    if (gs.length)
      await tx
        .update(s.gifts)
        .set({ name: 'Gift', description: null, photoKey: null })
        .where(eq(s.gifts.giverId, me.id));
    await writeAudit(tx, {
      eventId: me.eventId,
      actor: `participant:${me.id}`,
      action: 'participant.anonymize',
      target: me.id,
      at: p.now,
    });
    const erased: ErasedField[] = ['name', 'avatar', 'session', 'claim_credentials'];
    if (me.email) erased.push('email');
    if (photoKeys.length) erased.push('gift_photo');
    if (gs.length) erased.push('gift_text');
    return { eventId: me.eventId, erased, photoKeys };
  });
}

export async function isPlatformAdmin(db: Db, userId: string): Promise<boolean> {
  const [u] = await db
    .select({ a: s.user.isPlatformAdmin })
    .from(s.user)
    .where(eq(s.user.id, userId));
  return u?.a === true;
}

/** Suspends/restores an event: participant and display access stops while suspended. Audited with the reason. */
export async function setEventSuspended(
  db: Db,
  p: { eventId: string; actor: string; suspended: boolean; reason: string; now: Date },
) {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    await tx
      .update(s.events)
      .set({ suspendedAt: p.suspended ? p.now : null, updatedAt: p.now })
      .where(eq(s.events.id, p.eventId));
    if (p.suspended) await cancelJobs(tx, p.eventId);
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: p.suspended ? 'platform.takedown' : 'platform.restore',
      reason: p.reason,
      at: p.now,
    });
    return { eventId: p.eventId, suspended: p.suspended };
  });
}

/** Abuse takedown of one gift (text + photo). Returns the blob key for the caller to delete. */
export async function takedownGift(
  db: Db,
  p: { giftId: string; actor: string; now: Date },
): Promise<{ eventId: string; photoKey: string | null }> {
  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(s.gifts).where(eq(s.gifts.id, p.giftId));
    if (!g) throw new EventError('not_found');
    await tx
      .update(s.gifts)
      .set({ name: 'Removed', description: null, photoKey: null, hidden: true })
      .where(eq(s.gifts.id, g.id));
    await writeAudit(tx, {
      eventId: g.eventId,
      actor: p.actor,
      action: 'platform.gift_takedown',
      target: g.id,
      at: p.now,
    });
    return { eventId: g.eventId, photoKey: g.photoKey };
  });
}

/**
 * Daily retention: photos are deleted `photoDays` after completion and roster emails erased `emailDays` after.
 * Idempotent: a blob is nulled in the DB only after its deletion succeeded, so a crash retries safely.
 */
export async function sweepRetention(
  db: Db,
  p: { now: Date; deleteBlob: (key: string) => Promise<void> },
): Promise<{ photosDeleted: number; emailsErased: number }> {
  const done = await db.select().from(s.events).where(isNotNull(s.events.completedAt));
  let photosDeleted = 0;
  let emailsErased = 0;
  for (const e of done) {
    const completed = e.completedAt!.getTime();
    if (p.now.getTime() >= completed + e.settings.retention.photoDays * DAY_MS) {
      const gs = await db
        .select({ id: s.gifts.id, key: s.gifts.photoKey })
        .from(s.gifts)
        .where(and(eq(s.gifts.eventId, e.id), isNotNull(s.gifts.photoKey)));
      for (const g of gs) {
        await p.deleteBlob(g.key!);
        await db.update(s.gifts).set({ photoKey: null }).where(eq(s.gifts.id, g.id));
        photosDeleted++;
      }
    }
    if (p.now.getTime() >= completed + e.settings.retention.emailDays * DAY_MS) {
      const rows = await db
        .update(s.participants)
        .set({ email: null })
        .where(and(eq(s.participants.eventId, e.id), isNotNull(s.participants.email)))
        .returning({ id: s.participants.id });
      emailsErased += rows.length;
    }
  }
  return { photosDeleted, emailsErased };
}

/** Keeps exactly one pending daily job alive (startup + after each run). */
export async function ensureRetentionJob(db: Db, now: Date) {
  const pending = await db
    .select({ id: s.scheduledJobs.id })
    .from(s.scheduledJobs)
    .where(
      and(
        eq(s.scheduledJobs.kind, RETENTION_JOB),
        inArray(s.scheduledJobs.status, ['pending', 'running']),
      ),
    );
  if (pending.length) return false;
  await enqueueJob(db, { kind: RETENTION_JOB, runAt: new Date(now.getTime() + DAY_MS) });
  return true;
}
