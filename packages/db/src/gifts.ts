import { randomInt } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { isActivityAllowed, planAward } from '@santa/domain';
import type { Db } from './types.js';
import * as s from './schema.js';
import { writeAudit } from './audit.js';
import { awardXp } from './xp.js';
import { EventError } from './events.js';
import { cancelJobs } from './jobs.js';
import { REVEAL_UNVEIL_JOB } from './reveal.js';

type Event = typeof s.events.$inferSelect;

const stateOf = (e: Event) => ({
  phase: e.phase,
  paused: e.paused,
  milestones: {
    giftOpeningStartedAt: e.giftOpeningStartedAt,
    votingClosedAt: e.votingClosedAt,
    revealStartedAt: e.revealStartedAt,
    ceremonyStartedAt: e.ceremonyStartedAt,
  },
});

const pgCode = (e: unknown): string | undefined => {
  const x = e as { code?: string; cause?: { code?: string } };
  return x.code ?? x.cause?.code;
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/* ---------- giver: own gift ---------- */

export async function getOwnGift(db: Db, participantId: string) {
  const [me] = await db.select().from(s.participants).where(eq(s.participants.id, participantId));
  if (!me) throw new EventError('not_found');
  const [e] = await db.select().from(s.events).where(eq(s.events.id, me.eventId));
  const [gift] = await db
    .select()
    .from(s.gifts)
    .where(and(eq(s.gifts.eventId, me.eventId), eq(s.gifts.giverId, participantId)));
  const st = stateOf(e!);
  const editable = gift
    ? gift.status === 'registered' && isActivityAllowed(st, 'gift_edit')
    : isActivityAllowed(st, 'gift_register');
  return { gift: gift ?? null, editable, eventId: me.eventId };
}

/**
 * Creates (first save: random alias, +20 XP once) or edits the caller's single gift.
 * Requires a pairing (the recipient is derived from it, never stored on the gift).
 */
export async function saveOwnGift(
  db: Db,
  p: { participantId: string; name: string; description: string | null; now: Date },
): Promise<{ gift: typeof s.gifts.$inferSelect; created: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [me] = await tx
          .select()
          .from(s.participants)
          .where(eq(s.participants.id, p.participantId))
          .for('update');
        if (!me || me.status !== 'active') throw new EventError('not_found');
        const [e] = await tx.select().from(s.events).where(eq(s.events.id, me.eventId));
        const st = stateOf(e!);

        const [paired] = await tx
          .select({ id: s.pairings.id })
          .from(s.pairings)
          .where(and(eq(s.pairings.eventId, me.eventId), eq(s.pairings.giverId, me.id)));
        if (!paired) throw new EventError('no_pairing');

        const [existing] = await tx
          .select()
          .from(s.gifts)
          .where(and(eq(s.gifts.eventId, me.eventId), eq(s.gifts.giverId, me.id)));
        if (existing) {
          if (existing.status !== 'registered' || !isActivityAllowed(st, 'gift_edit')) {
            throw new EventError('gift_locked');
          }
          const [u] = await tx
            .update(s.gifts)
            .set({ name: p.name, description: p.description })
            .where(eq(s.gifts.id, existing.id))
            .returning();
          return { gift: u!, created: false };
        }

        if (!isActivityAllowed(st, 'gift_register')) throw new EventError('gift_locked');
        const used = new Set(
          (
            await tx
              .select({ n: s.gifts.aliasNo })
              .from(s.gifts)
              .where(eq(s.gifts.eventId, me.eventId))
          ).map((r) => r.n),
        );
        const range = Math.max(200, e!.maxParticipants * 2);
        const free: number[] = [];
        for (let n = 1; n <= range; n++) if (!used.has(n)) free.push(n);
        const aliasNo = free[randomInt(free.length)]!; // random: alias reveals nothing about registration order

        const [g] = await tx
          .insert(s.gifts)
          .values({
            eventId: me.eventId,
            giverId: me.id,
            aliasNo,
            name: p.name,
            description: p.description,
            createdAt: p.now,
          })
          .returning();
        await awardXp(tx, {
          eventId: me.eventId,
          participantId: me.id,
          award: planAward('gift_registered', e!.settings.xpValues),
        });
        return { gift: g!, created: true };
      });
    } catch (err) {
      if (pgCode(err) === '23505' && attempt < 4) continue; // alias race: pick again
      throw err;
    }
  }
}

/** Swaps the stored photo key; returns the previous key (caller deletes the blob). */
export async function setOwnGiftPhoto(
  db: Db,
  p: { participantId: string; photoKey: string | null; mime?: string; size?: number },
): Promise<{ oldKey: string | null; giftId: string }> {
  return db.transaction(async (tx) => {
    const [me] = await tx
      .select()
      .from(s.participants)
      .where(eq(s.participants.id, p.participantId));
    if (!me || me.status !== 'active') throw new EventError('not_found');
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, me.eventId));
    const [g] = await tx
      .select()
      .from(s.gifts)
      .where(and(eq(s.gifts.eventId, me.eventId), eq(s.gifts.giverId, me.id)))
      .for('update');
    if (!g) throw new EventError('not_found');
    if (g.status !== 'registered' || !isActivityAllowed(stateOf(e!), 'gift_edit')) {
      throw new EventError('gift_locked');
    }
    await tx.update(s.gifts).set({ photoKey: p.photoKey }).where(eq(s.gifts.id, g.id));
    if (p.photoKey) {
      await tx.insert(s.media).values({
        eventId: me.eventId,
        key: p.photoKey,
        ownerId: me.id,
        kind: 'gift_photo',
        mime: p.mime ?? 'image/jpeg',
        size: p.size ?? 0,
      });
    }
    if (g.photoKey) {
      await tx.update(s.media).set({ deletedAt: new Date() }).where(eq(s.media.key, g.photoKey));
    }
    return { oldKey: g.photoKey, giftId: g.id };
  });
}

export async function getAssignment(db: Db, participantId: string) {
  const [row] = await db
    .select({
      verified: s.participants.claimVerifiedAt,
      eventId: s.participants.eventId,
    })
    .from(s.participants)
    .where(eq(s.participants.id, participantId));
  if (!row) throw new EventError('not_found');
  const [pair] = await db
    .select({
      id: s.participants.id,
      displayName: s.participants.displayName,
      avatar: s.participants.avatar,
    })
    .from(s.pairings)
    .innerJoin(s.participants, eq(s.participants.id, s.pairings.recipientId))
    .where(and(eq(s.pairings.eventId, row.eventId), eq(s.pairings.giverId, participantId)));
  return { verified: row.verified !== null, recipient: pair ?? null };
}

/* ---------- organizer: moderation ---------- */

export async function listGiftsForModeration(db: Db, eventId: string) {
  return db
    .select({
      id: s.gifts.id,
      aliasNo: s.gifts.aliasNo,
      name: s.gifts.name,
      description: s.gifts.description,
      photoKey: s.gifts.photoKey,
      status: s.gifts.status,
      hidden: s.gifts.hidden,
    })
    .from(s.gifts)
    .where(eq(s.gifts.eventId, eventId))
    .orderBy(asc(s.gifts.aliasNo)); // alias order only: no registration/opening metadata
}

export async function moderateGift(
  db: Db,
  p: {
    eventId: string;
    giftId: string;
    actor: string;
    now: Date;
    patch: {
      name?: string | undefined;
      description?: string | null | undefined;
      removePhoto?: boolean | undefined;
      hidden?: boolean | undefined;
    };
  },
): Promise<{ oldPhotoKey: string | null }> {
  return db.transaction(async (tx) => {
    const [g] = await tx
      .select()
      .from(s.gifts)
      .where(and(eq(s.gifts.id, p.giftId), eq(s.gifts.eventId, p.eventId)))
      .for('update');
    if (!g) throw new EventError('not_found');
    const { patch } = p;
    await tx
      .update(s.gifts)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
        ...(patch.removePhoto ? { photoKey: null } : {}),
      })
      .where(eq(s.gifts.id, g.id));
    if (patch.removePhoto && g.photoKey) {
      await tx.update(s.media).set({ deletedAt: p.now }).where(eq(s.media.key, g.photoKey));
    }
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'gift.moderate',
      target: g.id,
      data: { fields: Object.keys(patch) },
      at: p.now,
    });
    return { oldPhotoKey: patch.removePhoto ? g.photoKey : null };
  });
}

/* ---------- opening ---------- */

export interface OpeningState {
  mode: 'random' | 'manual';
  openedCount: number;
  total: number;
  currentGiftId: string | null;
  allOpened: boolean;
  /** Server-driven pre-reveal countdown (0 = none) and its absolute deadline for the current gift. */
  countdownSeconds: number;
  countdownEndsAt: string | null;
}

export async function openingState(db: Db, eventId: string): Promise<OpeningState> {
  const [e] = await db.select().from(s.events).where(eq(s.events.id, eventId));
  if (!e) throw new EventError('not_found');
  const rows = await db
    .select({ id: s.gifts.id, status: s.gifts.status, openedAt: s.gifts.openedAt })
    .from(s.gifts)
    .where(and(eq(s.gifts.eventId, eventId), eq(s.gifts.hidden, false)));
  const opened = rows.filter((r) => r.status !== 'registered').length;
  const seconds = e.settings.openingCountdownSeconds;
  const current = rows.find((r) => r.id === e.currentGiftId);
  return {
    mode: e.settings.openingMode,
    openedCount: opened,
    total: rows.length,
    currentGiftId: e.currentGiftId,
    allOpened: rows.length > 0 && opened === rows.length,
    countdownSeconds: seconds,
    countdownEndsAt:
      current?.openedAt && seconds > 0
        ? new Date(current.openedAt.getTime() + seconds * 1000).toISOString()
        : null,
  };
}

export async function setOpeningOrder(
  db: Db,
  p: { eventId: string; actor: string; now: Date; mode: 'random' | 'manual'; order?: string[] },
): Promise<OpeningState> {
  await db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    if (e.phase !== 'gift_registration' && e.phase !== 'gift_opening') {
      throw new EventError('opening_not_available');
    }
    const unopened = await tx
      .select({ id: s.gifts.id })
      .from(s.gifts)
      .where(
        and(
          eq(s.gifts.eventId, p.eventId),
          eq(s.gifts.status, 'registered'),
          eq(s.gifts.hidden, false),
        ),
      );
    const ids = unopened.map((g) => g.id);
    let order: string[];
    if (p.mode === 'manual') {
      const given = p.order ?? [];
      const ok =
        given.length === ids.length &&
        new Set(given).size === given.length &&
        given.every((id) => ids.includes(id));
      if (!ok) throw new EventError('invalid_order');
      order = given;
    } else {
      order = shuffle(ids);
    }
    for (const [i, id] of order.entries()) {
      await tx
        .update(s.gifts)
        .set({ openingOrder: i + 1 })
        .where(eq(s.gifts.id, id));
    }
    await tx
      .update(s.events)
      .set({ settings: { ...e.settings, openingMode: p.mode }, updatedAt: p.now })
      .where(eq(s.events.id, p.eventId));
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'opening.order',
      data: { mode: p.mode },
      at: p.now,
    });
  });
  return openingState(db, p.eventId);
}

/** Opens the next unopened gift (visible to everyone from now) and makes it the current gift. */
export async function openNextGift(
  db: Db,
  p: { eventId: string; actor: string; now: Date },
): Promise<OpeningState> {
  await db.transaction(async (tx) => {
    const [e] = await tx.select().from(s.events).where(eq(s.events.id, p.eventId)).for('update');
    if (!e) throw new EventError('not_found');
    if (e.phase !== 'gift_opening') throw new EventError('opening_not_available');
    if (e.paused) throw new EventError('paused');
    const unopened = await tx
      .select()
      .from(s.gifts)
      .where(
        and(
          eq(s.gifts.eventId, p.eventId),
          eq(s.gifts.status, 'registered'),
          eq(s.gifts.hidden, false),
        ),
      );
    if (!unopened.length) throw new EventError('nothing_to_open');
    // gifts without an order (registered late) get a random position after the ordered ones
    const ordered = unopened
      .filter((g) => g.openingOrder !== null)
      .sort((a, b) => a.openingOrder! - b.openingOrder!);
    const rest = shuffle(unopened.filter((g) => g.openingOrder === null));
    const next = [...ordered, ...rest][0]!;
    await tx
      .update(s.gifts)
      .set({ status: 'opened', openedAt: p.now })
      .where(eq(s.gifts.id, next.id));
    await tx
      .update(s.events)
      .set({ currentGiftId: next.id, updatedAt: p.now })
      .where(eq(s.events.id, p.eventId));
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'opening.next',
      target: next.id,
      at: p.now,
    });
  });
  return openingState(db, p.eventId);
}

/* ---------- giver reveal (irreversible) ---------- */

async function requireRevealStarted(tx: Db, eventId: string) {
  const [e] = await tx.select().from(s.events).where(eq(s.events.id, eventId)).for('update');
  if (!e) throw new EventError('not_found');
  if (!e.revealStartedAt) throw new EventError('reveal_not_started');
  return e;
}

/** Reveals one giver. Idempotent; there is no un-reveal (DB trigger enforces it too). */
export async function revealGift(
  db: Db,
  p: { eventId: string; giftId: string; actor: string; now: Date },
): Promise<{ giftId: string; revealedAt: Date; changed: boolean }> {
  return db.transaction(async (tx) => {
    const e = await requireRevealStarted(tx, p.eventId);
    const [g] = await tx
      .select()
      .from(s.gifts)
      .where(
        and(eq(s.gifts.id, p.giftId), eq(s.gifts.eventId, p.eventId), eq(s.gifts.hidden, false)),
      )
      .for('update');
    if (!g) throw new EventError('not_found');
    if (g.giverRevealedAt) return { giftId: g.id, revealedAt: g.giverRevealedAt, changed: false };
    if (g.status !== 'opened') throw new EventError('gift_not_opened');
    await tx
      .update(s.gifts)
      .set({ status: 'revealed', giverRevealedAt: p.now })
      .where(eq(s.gifts.id, g.id));
    // instant reveal (no drumroll): the gift goes on the display stage already revealed
    if (e.phase === 'reveal') {
      await tx
        .update(s.events)
        .set({ currentGiftId: g.id, updatedAt: p.now })
        .where(eq(s.events.id, p.eventId));
    }
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'reveal.gift',
      target: g.id,
      at: p.now,
    });
    return { giftId: g.id, revealedAt: p.now, changed: true };
  });
}

export async function revealAllGifts(
  db: Db,
  p: { eventId: string; actor: string; now: Date },
): Promise<{ revealed: number }> {
  return db.transaction(async (tx) => {
    await requireRevealStarted(tx, p.eventId);
    const rows = await tx
      .update(s.gifts)
      .set({ status: 'revealed', giverRevealedAt: p.now })
      .where(
        and(
          eq(s.gifts.eventId, p.eventId),
          eq(s.gifts.status, 'opened'),
          eq(s.gifts.hidden, false),
          isNull(s.gifts.giverRevealedAt),
        ),
      )
      .returning({ id: s.gifts.id });
    // finale: clear the reveal stage, drop pending drumrolls (their gifts are revealed now)
    await tx
      .update(s.events)
      .set({ currentGiftId: null, updatedAt: p.now })
      .where(eq(s.events.id, p.eventId));
    await cancelJobs(tx, p.eventId, [REVEAL_UNVEIL_JOB]);
    await writeAudit(tx, {
      eventId: p.eventId,
      actor: p.actor,
      action: 'reveal.all',
      data: { count: rows.length },
      at: p.now,
    });
    return { revealed: rows.length };
  });
}
