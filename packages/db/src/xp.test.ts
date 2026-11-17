import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { projectEventState, type EventSource } from '@santa/domain';
import { createTestDb, type TestDb } from './testing.js';
import type { Db } from './types.js';
import { seedDemoEvent } from './seed.js';
import { awardXp, loadParticipantSources, withXp, xpTotals } from './xp.js';
import { planAchievementAward } from '@santa/domain';
import * as s from './schema.js';

let db: TestDb;
let eventId: string;
let ids: string[];

beforeAll(async () => {
  db = await createTestDb();
  ({ eventId, participantIds: ids } = await seedDemoEvent(db));
}, 60_000);

describe('xp ledger', () => {
  it('awards once; a repeated request (fresh idempotency key) does not re-award', async () => {
    const castVote = async (tx: Db) => {
      const [cat] = await tx
        .select()
        .from(s.votingCategories)
        .where(eq(s.votingCategories.eventId, eventId));
      const [gift] = await tx
        .insert(s.gifts)
        .values({ eventId, giverId: ids[7]!, aliasNo: 1, name: 'G' })
        .onConflictDoNothing()
        .returning();
      void gift;
      return cat!.id;
    };
    const first = await withXp(
      db,
      { eventId, participantId: ids[0]!, activity: 'voted' },
      castVote,
    );
    const replay = await withXp(
      db,
      { eventId, participantId: ids[0]!, activity: 'voted' },
      castVote,
    );
    expect(first.awarded).toBe(true);
    expect(replay.awarded).toBe(false);
    const totals = await xpTotals(db, eventId);
    // 10 from seed `joined` + 15 configured `voted`
    expect(totals.get(ids[0]!)).toEqual({ total: 25, qualifying: 25 });
  });

  it('rolls back XP when the qualifying action fails (same transaction)', async () => {
    await expect(
      withXp(db, { eventId, participantId: ids[1]!, activity: 'gift_registered' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await xpTotals(db, eventId)).get(ids[1]!)?.total).toBe(10);
  });

  it('uses configurable values from event settings', async () => {
    const [ev] = await db.select().from(s.events).where(eq(s.events.id, eventId));
    await db
      .update(s.events)
      .set({
        settings: { ...ev!.settings, xpValues: { ...ev!.settings.xpValues, gift_registered: 35 } },
      })
      .where(eq(s.events.id, eventId));
    const r = await withXp(
      db,
      { eventId, participantId: ids[2]!, activity: 'gift_registered' },
      async () => 'ok',
    );
    expect(r.awarded).toBe(true);
    expect((await xpTotals(db, eventId)).get(ids[2]!)?.total).toBe(45);
  });

  it('achievement XP is non-qualifying and excluded from qualifying total', async () => {
    await awardXp(db, {
      eventId,
      participantId: ids[3]!,
      award: planAchievementAward('best_gift', 50),
    });
    expect((await xpTotals(db, eventId)).get(ids[3]!)).toEqual({ total: 60, qualifying: 10 });
  });

  it('wires XP into projections: self-only', async () => {
    const people = await loadParticipantSources(db, eventId);
    const [ev] = await db.select().from(s.events).where(eq(s.events.id, eventId));
    const source: EventSource = {
      id: eventId,
      name: ev!.name,
      description: null,
      theme: 'classic',
      startsAt: ev!.startsAt.toISOString(),
      timezone: 'Europe/Rome',
      phase: 'voting',
      paused: false,
      maxParticipants: 100,
      votingRound: 1,
      defaultLocale: 'it',
      votingEndsAt: null,
      currentGiftId: null,
      reactionsEnabled: true,
      milestones: {
        giftOpeningStartedAt: null,
        votingClosedAt: null,
        revealStartedAt: null,
        ceremonyStartedAt: null,
      },
    };
    const input = { event: source, participants: people, giftsRegistered: 0, ownVotes: [] };
    const mine = projectEventState({ role: 'participant', participantId: ids[3]! }, input);
    expect(mine.role === 'participant' && mine.me.xp).toEqual({ xp: 60, level: 1 });
    const display = JSON.stringify(projectEventState({ role: 'display' }, input));
    expect(display).not.toContain('"xp"');
    const other = JSON.stringify(
      projectEventState({ role: 'participant', participantId: ids[4]! }, input),
    );
    expect(other).not.toContain('"xp":60');
  });
});
