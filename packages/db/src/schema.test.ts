import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { createTestDb, type TestDb } from './testing.js';
import { seedDemoEvent } from './seed.js';
import * as s from './schema.js';

let db: TestDb;
let eventId: string;
let ids: string[];

beforeAll(async () => {
  db = await createTestDb();
  ({ eventId, participantIds: ids } = await seedDemoEvent(db));
}, 60_000);

/** Postgres error codes may sit on `cause` depending on driver wrapping. */
async function expectPgError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: { code?: string; cause?: { code?: string } }) => e,
  );
  expect(err, 'expected a database error').toBeDefined();
  expect(err?.code ?? err?.cause?.code).toBe(code);
}

const UNIQUE = '23505';

describe('schema constraints', () => {
  it('seed: EN/IT categories, ring pairings, events settings with privacy floors', async () => {
    const cats = await db
      .select()
      .from(s.votingCategories)
      .where(eq(s.votingCategories.eventId, eventId));
    expect(cats.map((c) => c.name['it']).sort()).toEqual([
      'Miglior Regalo',
      'Più Creativo',
      'Più Divertente',
    ]);
    const pairs = await db.select().from(s.pairings).where(eq(s.pairings.eventId, eventId));
    expect(pairs).toHaveLength(8);
    const [ev] = await db.select().from(s.events).where(eq(s.events.id, eventId));
    expect(ev).toMatchObject({ votingRound: 1, phase: 'gift_registration' });
    expect(ev!.settings).toMatchObject({ minVoters: 5, hiddenMin: 2 });
  });

  it('gifts have no recipient column (derived from pairings)', () => {
    expect(Object.keys(getTableColumns(s.gifts)).some((c) => /recipient/i.test(c))).toBe(false);
  });

  it('one pairing per giver', async () => {
    await expectPgError(
      db
        .insert(s.pairings)
        .values({ eventId, giverId: ids[0]!, recipientId: ids[3]!, source: 'manual' }),
      UNIQUE,
    );
  });

  it('one vote per voter per category (PK), upsert replaces the selection', async () => {
    const [cat] = await db
      .select()
      .from(s.votingCategories)
      .where(eq(s.votingCategories.eventId, eventId));
    const [g1, g2] = await db
      .insert(s.gifts)
      .values([
        { eventId, giverId: ids[0]!, aliasNo: 1, name: 'A' },
        { eventId, giverId: ids[1]!, aliasNo: 2, name: 'B' },
      ])
      .returning();
    const vote = (giftId: string) => ({ categoryId: cat!.id, voterId: ids[2]!, eventId, giftId });
    await db.insert(s.votes).values(vote(g1!.id));
    await expectPgError(db.insert(s.votes).values(vote(g2!.id)), UNIQUE);
    await db
      .insert(s.votes)
      .values(vote(g2!.id))
      .onConflictDoUpdate({
        target: [s.votes.categoryId, s.votes.voterId],
        set: { giftId: g2!.id },
      });
    const rows = await db
      .select()
      .from(s.votes)
      .where(and(eq(s.votes.categoryId, cat!.id), eq(s.votes.voterId, ids[2]!)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.giftId).toBe(g2!.id);
  });

  it('unique reward key per participant per event (XP idempotency)', async () => {
    const row = {
      eventId,
      participantId: ids[0]!,
      activity: 'voted',
      amount: 10,
      rewardKey: 'voted',
    };
    await db.insert(s.xpLedger).values(row);
    await expectPgError(db.insert(s.xpLedger).values(row), UNIQUE);
    const again = await db.insert(s.xpLedger).values(row).onConflictDoNothing().returning();
    expect(again).toHaveLength(0);
  });

  it('one gift per giver, unique alias, one achievement per participant', async () => {
    await expectPgError(
      db.insert(s.gifts).values({ eventId, giverId: ids[0]!, aliasNo: 99, name: 'dup giver' }),
      UNIQUE,
    );
    await expectPgError(
      db.insert(s.gifts).values({ eventId, giverId: ids[4]!, aliasNo: 1, name: 'dup alias' }),
      UNIQUE,
    );
    const a = { eventId, participantId: ids[0]!, key: 'christmas_spirit', source: 'participation' };
    await db.insert(s.participantAchievements).values(a);
    await expectPgError(db.insert(s.participantAchievements).values(a), UNIQUE);
  });

  it('claim: a session token maps to one roster entry', async () => {
    await db
      .update(s.participants)
      .set({ sessionTokenHash: 'hash-1' })
      .where(eq(s.participants.id, ids[0]!));
    await expectPgError(
      db
        .update(s.participants)
        .set({ sessionTokenHash: 'hash-1' })
        .where(eq(s.participants.id, ids[1]!)),
      UNIQUE,
    );
  });

  it('covers every plan table', () => {
    const names = Object.values(s)
      .filter(
        (v) => typeof v === 'object' && v !== null && Symbol.for('drizzle:IsDrizzleTable') in v,
      )
      .map((t) => getTableName(t as never));
    expect(names).toEqual(
      expect.arrayContaining([
        'user',
        'session',
        'account',
        'verification',
        'events',
        'event_organizers',
        'event_access',
        'participants',
        'pairing_imports',
        'pairings',
        'gifts',
        'voting_categories',
        'votes',
        'board_publications',
        'xp_ledger',
        'participant_achievements',
        'awards',
        'ceremony_state',
        'scheduled_jobs',
        'audit_log',
        'media',
        'unmask_grants',
      ]),
    );
  });
});
