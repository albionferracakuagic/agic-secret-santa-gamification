import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './testing.js';
import { createEvent, EventError } from './events.js';
import { revealAllGifts, revealGift, saveOwnGift } from './gifts.js';
import { REVEAL_UNVEIL_JOB, revealNextGift, revealStage, unveilStagedGift } from './reveal.js';
import * as s from './schema.js';

let db: TestDb;
let eventId: string;
let ids: string[];
let giftIds: string[]; // by giver index
const NOW = new Date('2026-12-20T18:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof EventError ? e.code : `other:${String(e)}`),
  );

/** 5 gifts; opened in order giver 2, 0, 3, 1 (giver 4's gift stays unopened). Event in the reveal phase. */
async function setup() {
  db = await createTestDb();
  await db.insert(s.user).values({ id: 'owner', name: 'O', email: 'o@example.test' });
  const e = await createEvent(db, {
    ownerId: 'owner',
    now: NOW,
    input: { name: 'Party', startsAt: '2026-12-24T19:00:00Z', timezone: 'Europe/Rome' },
  });
  eventId = e.id;
  const rows = await db
    .insert(s.participants)
    .values(
      Array.from({ length: 5 }, (_, i) => ({
        eventId,
        displayName: `P${i}`,
        status: 'active' as const,
        source: 'import' as const,
      })),
    )
    .returning();
  ids = rows.map((r) => r.id);
  await db.insert(s.pairings).values(
    ids.map((giverId, i) => ({
      eventId,
      giverId,
      recipientId: ids[(i + 1) % ids.length]!,
      source: 'import' as const,
    })),
  );
  await db.update(s.events).set({ phase: 'gift_registration' }).where(eq(s.events.id, eventId));
  giftIds = [];
  for (let i = 0; i < 5; i++) {
    const r = await saveOwnGift(db, {
      participantId: ids[i]!,
      name: `Gift of ${i}`,
      description: null,
      now: NOW,
    });
    giftIds.push(r.gift.id);
  }
  for (const [k, i] of [2, 0, 3, 1].entries()) {
    await db
      .update(s.gifts)
      .set({ status: 'opened', openedAt: at(-60_000 + k * 1000) })
      .where(eq(s.gifts.id, giftIds[i]!));
  }
  await db
    .update(s.events)
    .set({ phase: 'reveal', revealStartedAt: NOW, currentGiftId: null })
    .where(eq(s.events.id, eventId));
}

const giftRow = async (i: number) =>
  (await db.select().from(s.gifts).where(eq(s.gifts.id, giftIds[i]!)))[0]!;
const unveilJobs = () =>
  db
    .select()
    .from(s.scheduledJobs)
    .where(and(eq(s.scheduledJobs.eventId, eventId), eq(s.scheduledJobs.kind, REVEAL_UNVEIL_JOB)));

describe('reveal show: revealNextGift + reveal.unveil', () => {
  beforeEach(() => setup(), 60_000);

  it('stages gifts in public opening order with a drumroll; the giver is written only at the deadline', async () => {
    const seconds = (await db.select().from(s.events))[0]!.settings.ceremonyCountdownSeconds;
    expect(seconds).toBe(5);
    expect(await revealStage(db, eventId)).toEqual({ giftId: null, countdownEndsAt: null });

    const r = await revealNextGift(db, { eventId, actor: 'owner', now: NOW });
    expect(r).toMatchObject({
      giftId: giftIds[2],
      revealedCount: 0,
      total: 4, // unopened gift is not part of the show
      done: false,
      unveiledGiftId: null,
    });
    expect(r.countdownEndsAt).toEqual(at(5000));
    expect((await giftRow(2)).giverRevealedAt).toBeNull(); // drumroll: nothing revealed server-side
    expect(await revealStage(db, eventId)).toEqual({
      giftId: giftIds[2],
      countdownEndsAt: at(5000),
    });
    const jobs = await unveilJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ runAt: at(5000), payload: { giftId: giftIds[2] } });

    // double click during the drumroll
    expect(await code(revealNextGift(db, { eventId, actor: 'owner', now: at(1000) }))).toBe(
      'stage_busy',
    );
    // an early delivery never reveals
    expect(await unveilStagedGift(db, { eventId, giftId: giftIds[2]!, now: at(4999) })).toEqual({
      changed: false,
    });
    expect((await giftRow(2)).giverRevealedAt).toBeNull();
    // deadline: revealed once; duplicate deliveries are no-ops
    expect(await unveilStagedGift(db, { eventId, giftId: giftIds[2]!, now: at(5000) })).toEqual({
      changed: true,
    });
    expect(await unveilStagedGift(db, { eventId, giftId: giftIds[2]!, now: at(6000) })).toEqual({
      changed: false,
    });
    const g2 = await giftRow(2);
    expect(g2).toMatchObject({ status: 'revealed', giverRevealedAt: at(5000) });

    const order: string[] = [giftIds[2]!];
    let t = 6000;
    for (;;) {
      const n = await revealNextGift(db, { eventId, actor: 'owner', now: at(t) });
      if (n.done) {
        expect(n).toMatchObject({
          giftId: null,
          countdownEndsAt: null,
          revealedCount: 4,
          total: 4,
        });
        break;
      }
      order.push(n.giftId!);
      t += 5000;
      expect(await unveilStagedGift(db, { eventId, giftId: n.giftId!, now: at(t) })).toEqual({
        changed: true,
      });
    }
    expect(order).toEqual([giftIds[2], giftIds[0], giftIds[3], giftIds[1]]);
    expect(await revealStage(db, eventId)).toEqual({ giftId: null, countdownEndsAt: null }); // finale
    expect((await giftRow(4)).status).toBe('registered');
    // audit: the stage and the system reveal are both recorded
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.eventId, eventId));
    expect(audit.filter((a) => a.action === 'reveal.stage')).toHaveLength(4);
    expect(audit.filter((a) => a.action === 'reveal.gift' && a.actor === 'system')).toHaveLength(4);
  });

  it('a late job never blocks the show: next call after the deadline unveils the staged gift first', async () => {
    await revealNextGift(db, { eventId, actor: 'owner', now: NOW });
    const r = await revealNextGift(db, { eventId, actor: 'owner', now: at(5000) });
    expect(r).toMatchObject({ giftId: giftIds[0], unveiledGiftId: giftIds[2], revealedCount: 1 });
    expect((await giftRow(2)).giverRevealedAt).toEqual(at(5000));
    // the old job fires later: gift no longer on stage -> no-op
    expect(await unveilStagedGift(db, { eventId, giftId: giftIds[2]!, now: at(9000) })).toEqual({
      changed: false,
    });
  });

  it('reveal-all clears the stage and cancels pending drumrolls; a stale unveil is a no-op', async () => {
    await revealNextGift(db, { eventId, actor: 'owner', now: NOW });
    expect(await revealAllGifts(db, { eventId, actor: 'owner', now: at(1000) })).toEqual({
      revealed: 4,
    });
    expect(await revealStage(db, eventId)).toEqual({ giftId: null, countdownEndsAt: null });
    expect((await unveilJobs()).map((j) => j.status)).toEqual(['cancelled']);
    expect(await unveilStagedGift(db, { eventId, giftId: giftIds[2]!, now: at(5000) })).toEqual({
      changed: false,
    });
    expect((await revealNextGift(db, { eventId, actor: 'owner', now: at(6000) })).done).toBe(true);
  });

  it('instant per-gift reveal puts that gift on stage (already revealed); the drumroll gift is re-staged later', async () => {
    await revealNextGift(db, { eventId, actor: 'owner', now: NOW });
    await revealGift(db, { eventId, giftId: giftIds[3]!, actor: 'owner', now: at(1000) });
    expect((await revealStage(db, eventId))!.giftId).toBe(giftIds[3]);
    expect(await unveilStagedGift(db, { eventId, giftId: giftIds[2]!, now: at(5000) })).toEqual({
      changed: false,
    });
    const r = await revealNextGift(db, { eventId, actor: 'owner', now: at(6000) });
    expect(r.giftId).toBe(giftIds[2]); // still unrevealed: first in opening order again
    // the old job for the same gift cannot cut the new drumroll short
    expect(await unveilStagedGift(db, { eventId, giftId: giftIds[2]!, now: at(7000) })).toEqual({
      changed: false,
    });
    expect(await unveilStagedGift(db, { eventId, giftId: giftIds[2]!, now: at(11_000) })).toEqual({
      changed: true,
    });
  });

  it('hidden gifts are skipped; guards: phase, milestone, pause', async () => {
    await db.update(s.gifts).set({ hidden: true }).where(eq(s.gifts.id, giftIds[2]!));
    const r = await revealNextGift(db, { eventId, actor: 'owner', now: NOW });
    expect(r).toMatchObject({ giftId: giftIds[0], total: 3 });

    await db.update(s.events).set({ paused: true }).where(eq(s.events.id, eventId));
    expect(await code(revealNextGift(db, { eventId, actor: 'o', now: at(9000) }))).toBe('paused');
    await db
      .update(s.events)
      .set({ paused: false, phase: 'awards' })
      .where(eq(s.events.id, eventId));
    expect(await code(revealNextGift(db, { eventId, actor: 'o', now: at(9000) }))).toBe(
      'invalid_step',
    );
    expect(await revealStage(db, eventId)).toBeNull(); // not the reveal phase: no reveal scene
    // staged gift is not revealed by a job once the reveal phase is over
    expect(await unveilStagedGift(db, { eventId, giftId: giftIds[0]!, now: at(9000) })).toEqual({
      changed: false,
    });
    await db
      .update(s.events)
      .set({ phase: 'voting', revealStartedAt: null })
      .where(eq(s.events.id, eventId));
    expect(await code(revealNextGift(db, { eventId, actor: 'o', now: at(9000) }))).toBe(
      'reveal_not_started',
    );
  });
});
