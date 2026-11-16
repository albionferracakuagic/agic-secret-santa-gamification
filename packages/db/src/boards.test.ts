import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './testing.js';
import { createEvent, EventError } from './events.js';
import {
  boardAction,
  freezeBoards,
  listBoards,
  publishBoard,
  publishLiveBoards,
} from './boards.js';
import * as s from './schema.js';

let db: TestDb;
let eventId: string;
let voters: string[];
let giftIds: string[];
let funniestId: string;
const NOW = new Date('2026-12-20T18:00:00Z');
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof EventError ? e.code : `other:${String(e)}`),
  );

async function setup(n: number, votersCount = n) {
  db = await createTestDb();
  await db.insert(s.user).values({ id: 'owner', name: 'O', email: 'o@example.test' });
  const e = await createEvent(db, {
    ownerId: 'owner',
    now: NOW,
    input: {
      name: 'P',
      startsAt: '2026-12-24T19:00:00Z',
      timezone: 'Europe/Rome',
      defaultLocale: 'en',
    },
  });
  eventId = e.id;
  await db.update(s.events).set({ phase: 'voting' }).where(eq(s.events.id, eventId));
  const ps = await db
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
  voters = ps.map((p) => p.id);
  const gs = await db
    .insert(s.gifts)
    .values(
      voters.map((giverId, i) => ({
        eventId,
        giverId,
        aliasNo: i + 1,
        name: `G${i}`,
        status: 'opened' as const,
      })),
    )
    .returning();
  giftIds = gs.map((g) => g.id);
  const [c] = await db
    .select()
    .from(s.votingCategories)
    .where(and(eq(s.votingCategories.eventId, eventId), eq(s.votingCategories.key, 'funniest')));
  funniestId = c!.id;
  for (let i = 0; i < votersCount; i++) await vote(i, SPREAD[i % SPREAD.length]!);
}
// Distinct tiers (4,3,2,1,1,1) so canPublish has a safe top-3.
const SPREAD = [0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 4, 5];
const vote = (voter: number, gift: number) =>
  db
    .insert(s.votes)
    .values({ categoryId: funniestId, voterId: voters[voter]!, eventId, giftId: giftIds[gift]! })
    .onConflictDoUpdate({
      target: [s.votes.categoryId, s.votes.voterId],
      set: { giftId: giftIds[gift]! },
    });
const row = async (key = 'funniest') =>
  (
    await db
      .select()
      .from(s.boardPublications)
      .where(and(eq(s.boardPublications.eventId, eventId), eq(s.boardPublications.boardKey, key)))
  )[0];
const act = (action: Parameters<typeof boardAction>[1]['action'], extra = {}) =>
  boardAction(db, { eventId, actor: 'owner', boardKey: 'funniest', action, now: NOW, ...extra });

describe('live boards', () => {
  beforeEach(() => setup(12), 60_000);

  it('cadence publishes only changes and bumps the cursor per publication', async () => {
    await act('enable');
    const first = await row();
    expect(first?.state).toBe('live');
    expect((first?.lastPublished as { ok: boolean }).ok).toBe(true);
    const cursor = first!.cursor;
    expect(await publishLiveBoards(db, eventId, NOW)).toBe(false);
    expect((await row())!.cursor).toBe(cursor);

    await vote(0, 5);
    await vote(1, 5);
    await vote(2, 5);
    expect(await publishLiveBoards(db, eventId, NOW)).toBe(true);
    expect((await row())!.cursor).toBe(cursor + 1);
  });

  it('never publishes while hidden or paused; hide wipes the stored result', async () => {
    expect((await publishBoard(db, { eventId, boardKey: 'funniest', now: NOW })).changed).toBe(
      false,
    );
    await act('enable');
    await act('pause');
    await vote(0, 5);
    expect(await publishLiveBoards(db, eventId, NOW)).toBe(false);
    await act('hide');
    expect(await row()).toMatchObject({ state: 'hidden', lastPublished: null });
  });

  it('freezeBoards pauses live boards when voting closes', async () => {
    await act('enable');
    await freezeBoards(db, eventId);
    expect((await row())!.state).toBe('paused');
  });

  it('writes an audit entry per action and lists boards without entries', async () => {
    await act('enable');
    const list = await listBoards(db, eventId);
    expect(list.find((b) => b.boardKey === 'funniest')).toMatchObject({
      state: 'live',
      liveAllowed: true,
    });
    expect(list).toHaveLength(6);
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.action, 'board.enable'));
    expect(audit).toHaveLength(1);
  });
});

describe('small cohorts', () => {
  it('needs an explicit acknowledgement below liveBoardMinVoters and stays neutral while unsafe', async () => {
    await setup(8);
    expect(await code(act('enable'))).toBe('small_cohort_ack_required');
    expect(await code(act('enable', { acknowledgeSmallCohort: true }))).toBe('ok');
    expect((await row())!.forced).toBe(true);
  });

  it('an unsafe cohort (<5 voters) publishes nothing', async () => {
    await setup(8, 4);
    await act('enable', { acknowledgeSmallCohort: true });
    expect((await row())!.lastPublished).toBeNull();
  });

  it('xp board exists only when the feature is on', async () => {
    await setup(8);
    expect((await listBoards(db, eventId)).some((b) => b.boardKey === 'xp')).toBe(false);
    const [e] = await db.select().from(s.events).where(eq(s.events.id, eventId));
    await db
      .update(s.events)
      .set({ settings: { ...e!.settings, features: { ...e!.settings.features, xpBoard: true } } })
      .where(eq(s.events.id, eventId));
    expect((await listBoards(db, eventId)).some((b) => b.boardKey === 'xp')).toBe(true);
  });
});
