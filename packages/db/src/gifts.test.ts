import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from './testing.js';
import { createEvent, EventError } from './events.js';
import {
  getAssignment,
  getOwnGift,
  listGiftsForModeration,
  moderateGift,
  openNextGift,
  openingState,
  revealAllGifts,
  revealGift,
  saveOwnGift,
  setOpeningOrder,
  setOwnGiftPhoto,
} from './gifts.js';
import {
  BOARD_PUBLISH_JOB,
  VOTING_AUTOCLOSE_JOB,
  castVote,
  closeVoting,
  loadPublishedVotedCount,
  openVoting,
  ownVotes,
  publishVotedCounter,
} from './voting.js';
import { xpTotals } from './xp.js';
import * as s from './schema.js';

let db: TestDb;
let eventId: string;
let ids: string[]; // active participants P0..P7
const NOW = new Date('2026-12-20T18:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof EventError ? e.code : `other:${String(e)}`),
  );

async function setup(n = 8) {
  db = await createTestDb();
  await db.insert(s.user).values({ id: 'owner', name: 'O', email: 'o@example.test' });
  const e = await createEvent(db, {
    ownerId: 'owner',
    now: NOW,
    input: {
      name: 'Party',
      startsAt: '2026-12-24T19:00:00Z',
      timezone: 'Europe/Rome',
      defaultLocale: 'it',
    },
  });
  eventId = e.id;
  const rows = await db
    .insert(s.participants)
    .values(
      Array.from({ length: n }, (_, i) => ({
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
      recipientId: ids[(i + 1) % n]!,
      source: 'import' as const,
    })),
  );
}
const phase = (
  p: typeof s.events.$inferInsert.phase,
  extra: Partial<typeof s.events.$inferInsert> = {},
) =>
  db
    .update(s.events)
    .set({ phase: p, ...extra })
    .where(eq(s.events.id, eventId));
const gift = (i: number) =>
  saveOwnGift(db, { participantId: ids[i]!, name: `Gift of ${i}`, description: null, now: NOW });
const xp = async (i: number) => (await xpTotals(db, eventId)).get(ids[i]!)?.total ?? 0;

describe('gift registration', () => {
  beforeEach(() => setup(), 60_000);

  it('creates one gift per giver with a random unique alias, +20 XP once; edits keep alias and XP', async () => {
    await phase('gift_registration');
    const results = await Promise.all(ids.map((_, i) => gift(i)));
    expect(results.every((r) => r.created)).toBe(true);
    const aliases = results.map((r) => r.gift.aliasNo);
    expect(new Set(aliases).size).toBe(ids.length);
    // random alias: not simply registration order (1..n)
    expect(aliases).not.toEqual([...aliases].sort((a, b) => a - b).map((_, i) => i + 1));

    expect(await xp(0)).toBe(20);
    const edit = await saveOwnGift(db, {
      participantId: ids[0]!,
      name: 'Renamed',
      description: 'warm',
      now: NOW,
    });
    expect(edit).toMatchObject({
      created: false,
      gift: { name: 'Renamed', aliasNo: results[0]!.gift.aliasNo },
    });
    expect(await xp(0)).toBe(20);
    expect(
      Object.keys(
        await db
          .select()
          .from(s.gifts)
          .then((r) => r[0]!),
      ).some((k) => /recipient/i.test(k)),
    ).toBe(false);
  });

  it('needs a pairing, an active participant and the registration phase; locks once opened', async () => {
    await phase('gift_registration');
    await db.delete(s.pairings).where(eq(s.pairings.giverId, ids[1]!));
    expect(await code(gift(1))).toBe('no_pairing');
    await db
      .update(s.participants)
      .set({ status: 'pending' })
      .where(eq(s.participants.id, ids[2]!));
    expect(await code(gift(2))).toBe('not_found');

    await gift(0);
    await phase('gift_opening');
    expect(await code(gift(0))).toBe('gift_locked'); // edit after registration phase
    expect(await code(gift(3))).toBe('gift_locked'); // new gift after registration phase
    expect((await getOwnGift(db, ids[0]!)).editable).toBe(false);
  });

  it('photo key swap returns the old key and records media', async () => {
    await phase('gift_registration');
    await gift(0);
    expect(
      (
        await setOwnGiftPhoto(db, {
          participantId: ids[0]!,
          photoKey: `gifts/${eventId}/a.jpg`,
          size: 10,
        })
      ).oldKey,
    ).toBeNull();
    const second = await setOwnGiftPhoto(db, {
      participantId: ids[0]!,
      photoKey: `gifts/${eventId}/b.jpg`,
      size: 12,
    });
    expect(second.oldKey).toBe(`gifts/${eventId}/a.jpg`);
    const media = await db.select().from(s.media);
    expect(media.find((m) => m.key.endsWith('a.jpg'))!.deletedAt).not.toBeNull();
    expect(media.find((m) => m.key.endsWith('b.jpg'))!.deletedAt).toBeNull();
  });

  it('recipient is derived from pairings and exposed only with a verified claim flag', async () => {
    const a = await getAssignment(db, ids[0]!);
    expect(a).toMatchObject({ verified: false, recipient: { id: ids[1] } });
    await db
      .update(s.participants)
      .set({ claimVerifiedAt: NOW })
      .where(eq(s.participants.id, ids[0]!));
    expect((await getAssignment(db, ids[0]!)).verified).toBe(true);
  });

  it('moderation lists by alias without giver/ordering fields; hide + remove photo are audited', async () => {
    await phase('gift_registration');
    const { gift: g } = await gift(0);
    await setOwnGiftPhoto(db, { participantId: ids[0]!, photoKey: `gifts/${eventId}/a.jpg` });
    const list = await listGiftsForModeration(db, eventId);
    expect(Object.keys(list[0]!).sort()).toEqual([
      'aliasNo',
      'description',
      'hidden',
      'id',
      'name',
      'photoKey',
      'status',
    ]);
    const r = await moderateGift(db, {
      eventId,
      giftId: g.id,
      actor: 'owner',
      now: NOW,
      patch: { name: 'Clean', removePhoto: true, hidden: true },
    });
    expect(r.oldPhotoKey).toBe(`gifts/${eventId}/a.jpg`);
    const [after] = await db.select().from(s.gifts).where(eq(s.gifts.id, g.id));
    expect(after).toMatchObject({ name: 'Clean', photoKey: null, hidden: true });
    const log = await db.select().from(s.auditLog).where(eq(s.auditLog.action, 'gift.moderate'));
    expect(JSON.stringify(log[0]!.data)).toBe('{"fields":["name","removePhoto","hidden"]}');
  });
});

describe('opening + reveal', () => {
  beforeEach(async () => {
    await setup();
    await phase('gift_registration');
    for (let i = 0; i < 6; i++) await gift(i);
  }, 60_000);

  it('random order is a full permutation; hidden gifts never open; next opens one at a time and tracks current', async () => {
    const [h] = await listGiftsForModeration(db, eventId);
    await moderateGift(db, {
      eventId,
      giftId: h!.id,
      actor: 'owner',
      now: NOW,
      patch: { hidden: true },
    });
    const st = await setOpeningOrder(db, { eventId, actor: 'owner', now: NOW, mode: 'random' });
    expect(st).toMatchObject({ mode: 'random', total: 5, openedCount: 0, allOpened: false });
    const orders = (
      await db
        .select()
        .from(s.gifts)
        .where(and(eq(s.gifts.eventId, eventId), eq(s.gifts.hidden, false)))
    ).map((g) => g.openingOrder);
    expect([...orders].sort()).toEqual([1, 2, 3, 4, 5]);

    expect(await code(openNextGift(db, { eventId, actor: 'owner', now: NOW }))).toBe(
      'opening_not_available',
    ); // still registration
    await phase('gift_opening', { giftOpeningStartedAt: NOW });
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s2 = await openNextGift(db, { eventId, actor: 'owner', now: later(i) });
      seen.push(s2.currentGiftId!);
      expect(s2.openedCount).toBe(i + 1);
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).not.toContain(h!.id);
    expect((await openingState(db, eventId)).allOpened).toBe(true);
    expect(await code(openNextGift(db, { eventId, actor: 'owner', now: NOW }))).toBe(
      'nothing_to_open',
    );
  });

  it('manual order must be an exact permutation of unopened gifts and is honored', async () => {
    const all = (await listGiftsForModeration(db, eventId)).map((g) => g.id);
    expect(
      await code(
        setOpeningOrder(db, {
          eventId,
          actor: 'owner',
          now: NOW,
          mode: 'manual',
          order: all.slice(1),
        }),
      ),
    ).toBe('invalid_order');
    expect(
      await code(
        setOpeningOrder(db, {
          eventId,
          actor: 'owner',
          now: NOW,
          mode: 'manual',
          order: [...all.slice(1), all[1]!],
        }),
      ),
    ).toBe('invalid_order');
    const order = [...all].reverse();
    await setOpeningOrder(db, { eventId, actor: 'owner', now: NOW, mode: 'manual', order });
    await phase('gift_opening', { giftOpeningStartedAt: NOW });
    const first = await openNextGift(db, { eventId, actor: 'owner', now: NOW });
    expect(first.currentGiftId).toBe(order[0]);
    expect(first.mode).toBe('manual');
  });

  it('reveal needs the reveal phase, only opened gifts, is idempotent, and can never be undone (DB trigger)', async () => {
    await phase('gift_opening', { giftOpeningStartedAt: NOW });
    await openNextGift(db, { eventId, actor: 'owner', now: NOW });
    const [opened] = await db.select().from(s.gifts).where(eq(s.gifts.status, 'opened'));
    const [unopened] = await db.select().from(s.gifts).where(eq(s.gifts.status, 'registered'));
    expect(
      await code(revealGift(db, { eventId, giftId: opened!.id, actor: 'owner', now: NOW })),
    ).toBe('reveal_not_started');

    await phase('reveal', { revealStartedAt: later(1000) });
    expect(
      await code(revealGift(db, { eventId, giftId: unopened!.id, actor: 'owner', now: NOW })),
    ).toBe('gift_not_opened');
    const r1 = await revealGift(db, {
      eventId,
      giftId: opened!.id,
      actor: 'owner',
      now: later(2000),
    });
    expect(r1.changed).toBe(true);
    const r2 = await revealGift(db, {
      eventId,
      giftId: opened!.id,
      actor: 'owner',
      now: later(9000),
    });
    expect(r2).toMatchObject({ changed: false, revealedAt: later(2000) });

    // irreversible at the database level, not just in code
    await expect(
      db.update(s.gifts).set({ status: 'opened' }).where(eq(s.gifts.id, opened!.id)),
    ).rejects.toThrow();
    await expect(
      db.update(s.gifts).set({ giverRevealedAt: null }).where(eq(s.gifts.id, opened!.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(s.gifts)
        .set({ giverRevealedAt: later(5) })
        .where(eq(s.gifts.id, opened!.id)),
    ).rejects.toThrow();
    // consistency check: cannot mark revealed without a timestamp
    await expect(
      db.update(s.gifts).set({ status: 'revealed' }).where(eq(s.gifts.id, unopened!.id)),
    ).rejects.toThrow();
  });

  it('reveal all reveals every opened gift once', async () => {
    await phase('gift_opening', { giftOpeningStartedAt: NOW });
    for (let i = 0; i < 4; i++) await openNextGift(db, { eventId, actor: 'owner', now: NOW });
    await phase('reveal', { revealStartedAt: NOW });
    expect(await revealAllGifts(db, { eventId, actor: 'owner', now: later(1) })).toEqual({
      revealed: 4,
    });
    expect(await revealAllGifts(db, { eventId, actor: 'owner', now: later(2) })).toEqual({
      revealed: 0,
    });
  });
});

describe('voting', () => {
  let gifts: Array<typeof s.gifts.$inferSelect>;
  let cats: Array<typeof s.votingCategories.$inferSelect>;

  beforeEach(async () => {
    await setup();
    await phase('gift_registration');
    for (let i = 0; i < 8; i++) await gift(i);
    await phase('gift_opening', { giftOpeningStartedAt: NOW });
    await db
      .update(s.gifts)
      .set({ status: 'opened', openedAt: NOW })
      .where(eq(s.gifts.eventId, eventId));
    const rows = await db.select().from(s.gifts).where(eq(s.gifts.eventId, eventId));
    gifts = ids.map((id) => rows.find((g) => g.giverId === id)!);
    cats = await db
      .select()
      .from(s.votingCategories)
      .where(eq(s.votingCategories.eventId, eventId))
      .orderBy(s.votingCategories.sort);
  }, 60_000);

  const vote = (voter: number, giftOf: number, cat = 0, at = NOW) =>
    castVote(db, {
      participantId: ids[voter]!,
      categoryId: cats[cat]!.id,
      giftId: gifts[giftOf]!.id,
      now: at,
    });

  it('open moves gift_opening -> voting, schedules timer + cadence jobs; only then are votes accepted', async () => {
    expect(await code(vote(0, 1))).toBe('voting_not_open');
    await openVoting(db, { eventId, actor: 'owner', durationMinutes: 10, now: NOW });
    const [e] = await db.select().from(s.events).where(eq(s.events.id, eventId));
    expect(e).toMatchObject({ phase: 'voting', votingEndsAt: later(600_000) });
    const jobs = await db
      .select()
      .from(s.scheduledJobs)
      .where(eq(s.scheduledJobs.eventId, eventId));
    expect(jobs.map((j) => j.kind).sort()).toEqual([BOARD_PUBLISH_JOB, VOTING_AUTOCLOSE_JOB]);
    expect(jobs.find((j) => j.kind === VOTING_AUTOCLOSE_JOB)!.runAt).toEqual(later(600_000));
    expect(await code(openVoting(db, { eventId, actor: 'owner', now: NOW }))).toBe('same_phase'); // already voting
  });

  it('rules: own gift blocked, hidden/unopened/foreign gifts rejected, inactive voters rejected, upsert keeps ONE selection', async () => {
    await openVoting(db, { eventId, actor: 'owner', now: NOW });
    expect(await code(vote(0, 0))).toBe('own_gift');
    await db.update(s.gifts).set({ hidden: true }).where(eq(s.gifts.id, gifts[2]!.id));
    expect(await code(vote(0, 2))).toBe('gift_not_votable');
    await db.update(s.gifts).set({ status: 'registered' }).where(eq(s.gifts.id, gifts[3]!.id));
    expect(await code(vote(0, 3))).toBe('gift_not_votable');
    await db
      .update(s.participants)
      .set({ status: 'pending' })
      .where(eq(s.participants.id, ids[7]!));
    expect(await code(vote(7, 1))).toBe('not_found');

    expect((await vote(0, 1)).xpAwarded).toBe(true);
    expect((await vote(0, 1)).xpAwarded).toBe(false); // idempotent repeat
    await vote(0, 4); // change of mind
    expect(await ownVotes(db, ids[0]!)).toEqual([
      { categoryId: cats[0]!.id, giftId: gifts[4]!.id },
    ]);
    await vote(0, 5, 1); // another category
    expect(await ownVotes(db, ids[0]!)).toHaveLength(2);
    expect(await xp(0)).toBe(20 + 15); // +20 gift registered, +15 voted (once)
  });

  it('server time wins: after endsAt votes are refused even if the close job has not run; organizer close also refuses', async () => {
    await openVoting(db, { eventId, actor: 'owner', durationMinutes: 1, now: NOW });
    await vote(0, 1, 0, later(30_000));
    expect(await code(vote(1, 2, 0, later(60_000)))).toBe('voting_closed');
    await closeVoting(db, { eventId, actor: 'owner', now: later(61_000) });
    expect(await code(vote(2, 3, 0, later(62_000)))).toBe('voting_closed');
  });

  it('close locks winners via canPublish: publishable only with >=5 voters and enough eligible gifts; otherwise neutral fallback', async () => {
    await openVoting(db, { eventId, actor: 'owner', now: NOW });
    // category 0: 6 voters, 3 distinct gifts voted -> publishable, winner = gift 1
    for (const [v, g] of [
      [0, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 3],
      [6, 1],
    ] as const)
      await vote(v, g, 0);
    // category 1: only 3 voters -> below the 5-voter floor
    for (const [v, g] of [
      [0, 1],
      [2, 1],
      [3, 2],
    ] as const)
      await vote(v, g, 1);

    const r = await closeVoting(db, { eventId, actor: 'owner', now: later(1000) });
    expect(r).toMatchObject({
      categoriesLocked: 6,
      categoriesPublishable: 1,
      alreadyClosed: false,
    });
    const awards = await db.select().from(s.awards).where(eq(s.awards.eventId, eventId));
    const a0 = awards.find((a) => a.boardKey === cats[0]!.key)!;
    expect(a0).toMatchObject({
      publishable: true,
      winners: [gifts[1]!.id],
      votingRound: 1,
      lockedAt: later(1000),
    });
    const a1 = awards.find((a) => a.boardKey === cats[1]!.key)!;
    expect(a1).toMatchObject({ publishable: false, winners: [] });

    // idempotent: second close (e.g. job + organizer) changes nothing
    expect(await closeVoting(db, { eventId, actor: 'system', now: later(5000) })).toMatchObject({
      alreadyClosed: true,
      categoriesPublishable: 1,
    });
    expect(await db.select().from(s.awards).where(eq(s.awards.eventId, eventId))).toHaveLength(6);
    const [e] = await db.select().from(s.events).where(eq(s.events.id, eventId));
    expect(e!.votingClosedAt).toEqual(later(1000));
    expect(
      await code(
        closeVoting(db, { eventId, actor: 'owner', now: NOW }).then(() => {
          throw new EventError('ok');
        }),
      ),
    ).not.toBe('voting_not_open');
  });

  it('autoclose job is cancelled by an organizer close; "N voted" is published only when it changed (cadence)', async () => {
    await openVoting(db, { eventId, actor: 'owner', durationMinutes: 5, now: NOW });
    expect(await loadPublishedVotedCount(db, eventId)).toBeNull();
    await vote(0, 1);
    expect(await loadPublishedVotedCount(db, eventId)).toBeNull(); // not live: nothing published yet
    expect(await publishVotedCounter(db, eventId, later(10_000))).toEqual({
      changed: true,
      count: 1,
    });
    expect(await publishVotedCounter(db, eventId, later(20_000))).toEqual({
      changed: false,
      count: 1,
    });
    await vote(0, 4); // same voter again: still 1 voted
    expect(await publishVotedCounter(db, eventId, later(30_000))).toEqual({
      changed: false,
      count: 1,
    });
    await vote(2, 1);
    expect(await publishVotedCounter(db, eventId, later(40_000))).toEqual({
      changed: true,
      count: 2,
    });

    await closeVoting(db, { eventId, actor: 'owner', now: later(50_000) });
    const timer = (
      await db.select().from(s.scheduledJobs).where(eq(s.scheduledJobs.kind, VOTING_AUTOCLOSE_JOB))
    )[0]!;
    expect(timer.status).toBe('cancelled');
  });

  it('reopening voting invalidates locked awards and allows a fresh round', async () => {
    await openVoting(db, { eventId, actor: 'owner', now: NOW });
    for (const [v, g] of [
      [0, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 3],
    ] as const)
      await vote(v, g, 0);
    await closeVoting(db, { eventId, actor: 'owner', now: later(1000) });
    const { reopenVoting } = await import('./events.js');
    await reopenVoting(db, {
      eventId,
      actor: 'owner',
      reason: 'organizer mistake',
      now: later(2000),
    });
    expect(
      (await db.select().from(s.awards).where(eq(s.awards.eventId, eventId))).every(
        (a) => a.invalidatedAt !== null,
      ),
    ).toBe(true);
    await vote(6, 1, 0, later(3000)); // accepted again (round 2)
    const r = await closeVoting(db, { eventId, actor: 'owner', now: later(4000) });
    expect(r.alreadyClosed).toBe(false);
    const live = await db
      .select()
      .from(s.awards)
      .where(and(eq(s.awards.eventId, eventId), eq(s.awards.votingRound, 2)));
    expect(live).toHaveLength(6);
    void sql;
  });
});
