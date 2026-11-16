import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './testing.js';
import { createEvent, EventError } from './events.js';
import { closeVoting } from './voting.js';
import {
  CEREMONY_STEP_JOB,
  advanceCeremony,
  cancelCeremony,
  ceremonyView,
  decideAward,
  organizerCeremonyState,
  pauseCeremony,
  resumeCeremony,
  restartCeremony,
  startCeremony,
} from './ceremony.js';
import { myAchievements } from './achievements.js';
import * as s from './schema.js';

let db: TestDb;
let eventId: string;
let voters: string[];
let giftIds: string[];
const T0 = new Date('2026-12-24T21:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof EventError ? e.code : `other:${String(e)}`),
  );
const SPREADS: Record<string, number[]> = {
  funniest: [0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 4, 5],
  best_overall: [5, 5, 5, 5, 4, 4, 4, 3, 3, 2, 1, 0],
};

async function setup(
  opts: { tieBreak?: 'shared' | 'organizer'; spreads?: Record<string, number[]> } = {},
) {
  db = await createTestDb();
  await db.insert(s.user).values({ id: 'owner', name: 'O', email: 'o@example.test' });
  const e = await createEvent(db, {
    ownerId: 'owner',
    now: T0,
    input: {
      name: 'P',
      startsAt: '2026-12-24T19:00:00Z',
      timezone: 'Europe/Rome',
      defaultLocale: 'en',
    },
  });
  eventId = e.id;
  await db
    .update(s.events)
    .set({ phase: 'voting', settings: { ...e.settings, tieBreak: opts.tieBreak ?? 'shared' } })
    .where(eq(s.events.id, eventId));
  const ps = await db
    .insert(s.participants)
    .values(
      Array.from({ length: 12 }, (_, i) => ({
        eventId,
        displayName: `P${i}`,
        status: 'active' as const,
        source: 'import' as const,
      })),
    )
    .returning();
  voters = ps.map((p) => p.id);
  giftIds = (
    await db
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
      .returning()
  ).map((g) => g.id);
  const cats = await db
    .select()
    .from(s.votingCategories)
    .where(eq(s.votingCategories.eventId, eventId));
  for (const [key, spread] of Object.entries(opts.spreads ?? SPREADS)) {
    const cat = cats.find((c) => c.key === key)!;
    await db.insert(s.votes).values(
      spread.map((g, i) => ({
        categoryId: cat.id,
        voterId: voters[i]!,
        eventId,
        giftId: giftIds[g]!,
      })),
    );
  }
  // P3 did every participation activity (spirit + champion); everyone joined
  const xp = (participantId: string, k: string, amount: number) => ({
    eventId,
    participantId,
    activity: k,
    amount,
    rewardKey: k,
    qualifying: true,
  });
  await db
    .insert(s.xpLedger)
    .values([
      ...voters.map((id) => xp(id, 'joined', 10)),
      xp(voters[3]!, 'gift_registered', 20),
      xp(voters[3]!, 'voted', 15),
    ]);
  await closeVoting(db, { eventId, actor: 'owner', now: T0 });
  await db
    .update(s.events)
    .set({ phase: 'awards', revealStartedAt: T0 })
    .where(eq(s.events.id, eventId));
}

const next = (fromIndex: number, now = at(1), auto = false) =>
  advanceCeremony(db, { eventId, actor: 'owner', fromIndex, now, auto });
const giftRow = async (i: number) =>
  (await db.select().from(s.gifts).where(eq(s.gifts.id, giftIds[i]!)))[0]!;
const achievements = async (i: number) => (await myAchievements(db, voters[i]!)).map((a) => a.key);
const pendingTimers = () =>
  db
    .select()
    .from(s.scheduledJobs)
    .where(and(eq(s.scheduledJobs.kind, CEREMONY_STEP_JOB), eq(s.scheduledJobs.status, 'pending')));
const stepType = async () => (await ceremonyView(db, eventId))!.step!.type;
async function walkTo(type: string) {
  let idx = 0;
  while ((await stepType()) !== type) {
    await next(idx);
    idx++;
  }
  return idx;
}

describe('ceremony', () => {
  beforeEach(() => setup(), 60_000);

  it('plays the whole script: giver revealed only at the winner step, achievements only at their step', async () => {
    const st0 = await organizerCeremonyState(db, eventId);
    expect(st0).toMatchObject({ canStart: true, blockers: [] });
    expect(JSON.stringify(st0)).not.toMatch(/winner|giver/);

    await startCeremony(db, { eventId, actor: 'owner', now: at(0) });
    expect((await giftRow(0)).giverRevealedAt).toBeNull();
    expect(await achievements(0)).toEqual([]);

    const seen: string[] = [];
    for (let idx = 0; idx < 60; idx++) {
      const v = (await ceremonyView(db, eventId))!;
      const step = v.step!;
      seen.push(step.type);
      if (step.type === 'winner' && step.boardKey === 'funniest') {
        expect((await giftRow(0)).giverRevealedAt).not.toBeNull();
        expect(step.winners[0]!.giver.displayName).toBe('P0');
        expect(await achievements(0)).toEqual([]);
      }
      if (step.type === 'achievement' && step.achievementKey === 'comedy_santa')
        expect(await achievements(0)).toContain('comedy_santa');
      if (step.type === 'nominees') {
        expect(step.entries.length).toBeLessThanOrEqual(3);
        expect(JSON.stringify(step)).not.toMatch(/score|rank|total/);
      }
      await next(idx);
      if ((await ceremonyView(db, eventId))!.status === 'done') break;
    }
    expect((await ceremonyView(db, eventId))!.status).toBe('done');
    expect(seen.filter((x) => x === 'winner')).toHaveLength(2);
    expect(seen.filter((x) => x === 'category_skipped')).toHaveLength(4);
    expect(seen.lastIndexOf('winner')).toBeGreaterThan(seen.indexOf('spirit'));
    expect(await achievements(5)).toContain('legendary_santa');
    expect(await achievements(3)).toEqual(
      expect.arrayContaining(['christmas_spirit', 'christmas_champion']),
    );
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.eventId, eventId));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['ceremony.start', 'ceremony.done']),
    );
  });

  it('rejects stale next; a countdown advances only after its deadline and repeats are no-ops', async () => {
    await startCeremony(db, { eventId, actor: 'owner', now: at(0) });
    expect(await code(next(3))).toBe('stale_step');
    const idx = await walkTo('countdown');
    const v = (await ceremonyView(db, eventId))!;
    expect(v.endsAt).not.toBeNull();
    expect(await pendingTimers()).toHaveLength(1);
    expect((await next(idx, at(1), true)).moved).toBe(false);
    const due = Date.parse(v.endsAt!);
    expect((await next(idx, new Date(due + 1), true)).moved).toBe(true);
    expect((await next(idx, new Date(due + 2), true)).moved).toBe(false);
  });

  it('pause cancels the timer, resume re-arms it, cancel stops the show, restart begins again', async () => {
    await startCeremony(db, { eventId, actor: 'owner', now: at(0) });
    const idx = await walkTo('countdown');
    await pauseCeremony(db, { eventId, actor: 'owner', now: at(5) });
    expect(await code(next(idx))).toBe('ceremony_not_running');
    expect(await pendingTimers()).toHaveLength(0);
    await resumeCeremony(db, { eventId, actor: 'owner', now: at(6) });
    expect((await ceremonyView(db, eventId))!.endsAt).not.toBeNull();
    await cancelCeremony(db, { eventId, actor: 'owner', now: at(7) });
    expect((await organizerCeremonyState(db, eventId)).status).toBe('cancelled');
    await restartCeremony(db, { eventId, actor: 'owner', now: at(8) });
    expect(await ceremonyView(db, eventId)).toMatchObject({ status: 'running', index: 0 });
  });

  it('is blocked outside the awards phase', async () => {
    await db.update(s.events).set({ phase: 'reveal' }).where(eq(s.events.id, eventId));
    expect(await code(startCeremony(db, { eventId, actor: 'owner', now: at(0) }))).toBe(
      'not_in_awards_phase',
    );
  });
});

describe('ceremony ties and unsafe categories', () => {
  it('organizer-decides tie blocks the start until decided, only among candidates, audited', async () => {
    await setup({
      tieBreak: 'organizer',
      spreads: { funniest: [0, 0, 0, 1, 1, 1, 2, 3, 4, 5, 6, 7] }, // gifts 0 and 1 tie
    });
    const st = await organizerCeremonyState(db, eventId);
    expect(st.canStart).toBe(false);
    expect(st.blockers).toContain('decisions_pending');
    expect(st.pendingDecisions[0]!.candidates.map((c) => c.label).sort()).toEqual([
      'Gift 1',
      'Gift 2',
    ]);
    const decide = (giftId: string) =>
      decideAward(db, { eventId, actor: 'owner', boardKey: 'funniest', giftId, now: at(0) });
    expect(await code(decide(giftIds[5]!))).toBe('not_a_candidate');
    await decide(giftIds[1]!);
    expect((await organizerCeremonyState(db, eventId)).blockers).not.toContain('decisions_pending');
    await startCeremony(db, { eventId, actor: 'owner', now: at(1) });
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.action, 'award.decide'));
    expect(audit).toHaveLength(1);
  });

  it('shared ties give co-winners; a category below the floor is skipped without winner data', async () => {
    await setup({
      spreads: { funniest: [0, 0, 0, 1, 1, 1, 2, 3, 4, 5, 6, 7], best_overall: [0, 1, 2, 3] },
    });
    await startCeremony(db, { eventId, actor: 'owner', now: at(0) });
    const outline = (await organizerCeremonyState(db, eventId)).outline;
    expect(outline.filter((x) => x === 'category_skipped')).toHaveLength(5);
    expect(outline.filter((x) => x === 'winner')).toHaveLength(1);
    await walkTo('winner');
    const w = (await ceremonyView(db, eventId))!.step as { tied: boolean; winners: unknown[] };
    expect(w.tied).toBe(true);
    expect(w.winners).toHaveLength(2);
  });
});
