import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './testing.js';
import { createEvent, EventError } from './events.js';
import {
  AUTOPILOT_TICK_JOB,
  autopilotOrphans,
  autopilotView,
  buildAutopilotSnapshot,
  holdAutopilot,
  loadAutopilotState,
  resolveTiesShared,
  resumeAutopilot,
  runAutopilotTick,
  skipAutopilotStep,
  startAutopilot,
  stopAutopilot,
  updateAutopilotSettings,
  type AutopilotExecutor,
} from './autopilot.js';
import * as s from './schema.js';

let db: TestDb;
let eventId: string;
const T0 = new Date('2026-12-24T21:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof EventError ? e.code : `other:${String(e)}`),
  );

async function setup(phase: (typeof s.events.$inferInsert)['phase'] = 'gift_opening', gifts = 3) {
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
  await db.update(s.events).set({ phase }).where(eq(s.events.id, eventId));
  if (gifts) {
    const ps = await db
      .insert(s.participants)
      .values(
        Array.from({ length: gifts }, (_, i) => ({
          eventId,
          displayName: `P${i}`,
          status: 'active' as const,
          source: 'import' as const,
        })),
      )
      .returning();
    await db.insert(s.gifts).values(
      ps.map((p, i) => ({ eventId, giverId: p.id, aliasNo: i + 1, name: `G${i}` })),
    );
  }
}

const pending = () =>
  db
    .select()
    .from(s.scheduledJobs)
    .where(
      and(
        eq(s.scheduledJobs.eventId, eventId),
        eq(s.scheduledJobs.kind, AUTOPILOT_TICK_JOB),
        eq(s.scheduledJobs.status, 'pending'),
      ),
    );

const cmd = (now: Date, fromSeq?: number) => ({ eventId, actor: 'owner', now, fromSeq });
function recorder(): { calls: string[]; exec: AutopilotExecutor } {
  const calls: string[] = [];
  return {
    calls,
    exec: async (a) => {
      calls.push(a.type);
    },
  };
}

beforeEach(() => setup());

describe('autopilot: start / persistence', () => {
  it('starts in gift_opening: running state, one tick at now carrying seq, audit entry', async () => {
    const st = await startAutopilot(db, cmd(T0));
    expect(st).toMatchObject({ status: 'running', step: 'opening', seq: 1 });
    const jobs = await pending();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ seq: 1 });
    expect(jobs[0]!.runAt.getTime()).toBe(T0.getTime());
    expect(await loadAutopilotState(db, eventId)).toEqual(st);
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.action, 'autopilot.start'));
    expect(audit).toHaveLength(1);
    expect(await autopilotOrphans(db)).toEqual([]);
  });

  it('rejects start twice, before the show, after completion, and while frozen', async () => {
    await startAutopilot(db, cmd(T0));
    expect(await code(startAutopilot(db, cmd(T0)))).toBe('autopilot_active');
    for (const phase of ['preparation', 'registration', 'gift_registration', 'completed'] as const) {
      await setup(phase);
      expect(await code(startAutopilot(db, cmd(T0)))).toBe('autopilot_phase_not_allowed');
    }
    await setup();
    await db.update(s.events).set({ paused: true }).where(eq(s.events.id, eventId));
    expect(await code(startAutopilot(db, cmd(T0)))).toBe('paused');
  });

  it('allows start from a later show phase (resync adopts it) and honours fromSeq', async () => {
    await setup('reveal');
    expect(await code(startAutopilot(db, cmd(T0, 5)))).toBe('stale_seq');
    const st = await startAutopilot(db, cmd(T0, 0));
    expect(st.status).toBe('running');
    const r = recorder();
    const out = await runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: r.exec });
    expect(out).toMatchObject({ ran: true, action: 'resync' });
    expect(r.calls).toEqual([]); // resync = no side effect
    expect((await loadAutopilotState(db, eventId)).step).toBe('reveal');
  });

  it('snapshot reflects real data (counts only)', async () => {
    const snap = await buildAutopilotSnapshot(db, eventId);
    expect(snap).toMatchObject({
      phase: 'gift_opening',
      paused: false,
      opening: { total: 3, opened: 0 },
      voting: { closed: false, belowFloor: true },
      reveal: { revealable: 0, revealed: 0 },
      ceremony: { status: 'idle', pendingDecisions: 0 },
    });
    await db.update(s.gifts).set({ status: 'opened' }).where(eq(s.gifts.aliasNo, 1));
    const snap2 = await buildAutopilotSnapshot(db, eventId);
    expect(snap2.opening).toMatchObject({ total: 3, opened: 1 });
    expect(snap2.reveal.revealable).toBe(1);
  });
});

describe('autopilot: tick idempotency', () => {
  it('runs the effect once, commits seq+1 and enqueues the next tick with the new seq', async () => {
    const st = await startAutopilot(db, cmd(T0));
    const r = recorder();
    const out = await runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: r.exec });
    expect(out).toMatchObject({ ran: true, action: 'open_next_gift' });
    expect(r.calls).toEqual(['open_next_gift']);
    const cur = await loadAutopilotState(db, eventId);
    expect(cur.seq).toBe(2);
    const jobs = await pending();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ seq: 2 });
  });

  it('duplicate / stale delivery of the same seq is a no-op', async () => {
    const st = await startAutopilot(db, cmd(T0));
    const r = recorder();
    await runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: r.exec });
    const again = await runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: r.exec });
    expect(again).toEqual({ ran: false, reason: 'stale' });
    expect(r.calls).toHaveLength(1);
  });

  it('concurrent deliveries of the same seq run the effect at most once', async () => {
    const st = await startAutopilot(db, cmd(T0));
    const r = recorder();
    const slow: AutopilotExecutor = async (a, c) => {
      await new Promise((res) => setTimeout(res, 30));
      return r.exec(a, c);
    };
    const outs = await Promise.all([
      runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: slow }),
      runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: slow }),
    ]);
    expect(r.calls).toHaveLength(1);
    expect(outs.filter((o) => o.ran)).toHaveLength(1);
  });

  it('a crashed claim (stale lock) is recoverable after the TTL', async () => {
    const st = await startAutopilot(db, cmd(T0));
    await db
      .update(s.autopilotState)
      .set({ claimSeq: st.seq, claimedAt: T0 })
      .where(eq(s.autopilotState.eventId, eventId));
    const r = recorder();
    expect(await runAutopilotTick(db, { eventId, seq: st.seq, now: at(10), execute: r.exec })).toEqual({
      ran: false,
      reason: 'claimed',
    });
    const out = await runAutopilotTick(db, { eventId, seq: st.seq, now: at(120), execute: r.exec });
    expect(out.ran).toBe(true);
    expect(r.calls).toEqual(['open_next_gift']);
  });

  it('an EventError from the effect (organizer raced us) releases the claim and re-ticks shortly', async () => {
    const st = await startAutopilot(db, cmd(T0));
    // the delivered job is `running` (not pending) in production
    await db
      .update(s.scheduledJobs)
      .set({ status: 'running' })
      .where(eq(s.scheduledJobs.eventId, eventId));
    const boom: AutopilotExecutor = async () => {
      throw new EventError('nothing_to_open');
    };
    const out = await runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: boom });
    expect(out).toMatchObject({ ran: true, retry: true });
    expect((await loadAutopilotState(db, eventId)).seq).toBe(st.seq);
    const jobs = await pending();
    expect(jobs.some((j) => j.runAt.getTime() === T0.getTime() + 5000)).toBe(true);
    const r = recorder();
    expect((await runAutopilotTick(db, { eventId, seq: st.seq, now: at(5), execute: r.exec })).ran).toBe(true);
  });

  it('a non-domain error releases the claim and propagates (job retry works)', async () => {
    const st = await startAutopilot(db, cmd(T0));
    await expect(
      runAutopilotTick(db, {
        eventId,
        seq: st.seq,
        now: T0,
        execute: async () => {
          throw new Error('db down');
        },
      }),
    ).rejects.toThrow('db down');
    const r = recorder();
    expect((await runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: r.exec })).ran).toBe(true);
  });

  it('a hold during the effect wins: commit is rejected, state stays held', async () => {
    const st = await startAutopilot(db, cmd(T0));
    const holdDuring: AutopilotExecutor = async () => {
      await holdAutopilot(db, cmd(at(1)));
    };
    const out = await runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: holdDuring });
    expect(out).toEqual({ ran: false, reason: 'stale' });
    expect((await loadAutopilotState(db, eventId)).status).toBe('held');
    expect(await pending()).toHaveLength(0);
  });
});

describe('autopilot: hold / resume / stop / skip', () => {
  it('hold cancels queued ticks; a stale tick no-ops; resume re-plans from the remaining time', async () => {
    const st = await startAutopilot(db, cmd(T0));
    const r = recorder();
    // opens gift 1 -> stepEndsAt = T0 + 3s countdown + 40s (standard)
    await runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: r.exec });
    const running = await loadAutopilotState(db, eventId);
    const ends = new Date(running.stepEndsAt!).getTime();

    const held = await holdAutopilot(db, cmd(at(10)));
    expect(held).toMatchObject({ status: 'held', stepEndsAt: null });
    expect(held.remainingMsAtHold).toBe(ends - at(10).getTime());
    expect(await pending()).toHaveLength(0);
    expect(await runAutopilotTick(db, { eventId, seq: running.seq, now: at(100), execute: r.exec })).toEqual({
      ran: false,
      reason: 'not_running',
    });
    expect(await code(holdAutopilot(db, cmd(at(11))))).toBe('autopilot_not_running');

    const resumed = await resumeAutopilot(db, cmd(at(500)));
    expect(resumed.status).toBe('running');
    expect(new Date(resumed.stepEndsAt!).getTime()).toBe(at(500).getTime() + held.remainingMsAtHold!);
    const jobs = await pending();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.runAt.toISOString()).toBe(resumed.stepEndsAt);
    expect(jobs[0]!.payload).toEqual({ seq: resumed.seq });
    expect(await code(resumeAutopilot(db, cmd(at(501))))).toBe('autopilot_not_held');
    expect(await autopilotOrphans(db)).toEqual([]);
  });

  it('skip ends the wait now (new seq, tick at now); only while running', async () => {
    const st = await startAutopilot(db, cmd(T0));
    const r = recorder();
    await runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: r.exec });
    const before = await loadAutopilotState(db, eventId);
    const skipped = await skipAutopilotStep(db, cmd(at(5), before.seq));
    expect(skipped.seq).toBe(before.seq + 1);
    expect(skipped.stepEndsAt).toBe(at(5).toISOString());
    expect((await pending())[0]!.runAt.getTime()).toBe(at(5).getTime());
    expect(await code(skipAutopilotStep(db, cmd(at(6), before.seq)))).toBe('stale_seq');
    // the skipped tick acts immediately (opens the next gift before the 43 s dwell elapsed)
    const out = await runAutopilotTick(db, { eventId, seq: skipped.seq, now: at(5), execute: r.exec });
    expect(out).toMatchObject({ ran: true, action: 'open_next_gift' });
    await holdAutopilot(db, cmd(at(6)));
    expect(await code(skipAutopilotStep(db, cmd(at(7))))).toBe('autopilot_not_running');
  });

  it('stop returns to idle and cancels ticks', async () => {
    await startAutopilot(db, cmd(T0));
    const st = await stopAutopilot(db, cmd(at(1)));
    expect(st.status).toBe('idle');
    expect(await pending()).toHaveLength(0);
    expect(await code(stopAutopilot(db, cmd(at(2))))).toBe('autopilot_not_active');
    expect((await startAutopilot(db, cmd(at(3)))).seq).toBeGreaterThan(st.seq); // restart keeps seq monotonic
  });

  it('freeze: tick turns into frozen_held (no effect); resume refused until unfrozen', async () => {
    const st = await startAutopilot(db, cmd(T0));
    await db.update(s.events).set({ paused: true }).where(eq(s.events.id, eventId));
    const r = recorder();
    const out = await runAutopilotTick(db, { eventId, seq: st.seq, now: at(1), execute: r.exec });
    expect(out).toEqual({ ran: false, reason: 'frozen_held' });
    expect(r.calls).toEqual([]);
    const held = await loadAutopilotState(db, eventId);
    expect(held.status).toBe('held');
    expect(held.log.at(-1)?.code).toBe('frozen_held');
    expect(await code(resumeAutopilot(db, cmd(at(2))))).toBe('paused');
    await db.update(s.events).set({ paused: false }).where(eq(s.events.id, eventId));
    expect((await resumeAutopilot(db, cmd(at(3)))).status).toBe('running');
  });
});

describe('autopilot: settings', () => {
  it('patches preset/overrides (null clears), view returns effective timings', async () => {
    await updateAutopilotSettings(db, {
      eventId,
      actor: 'owner',
      now: T0,
      patch: { preset: 'quick', votingMinutes: 7 },
    });
    let v = await autopilotView(db, eventId);
    expect(v.settings).toMatchObject({ preset: 'quick', votingMinutes: 7 });
    expect(v.timings).toMatchObject({ votingMinutes: 7, openingGiftSeconds: 20 });
    await updateAutopilotSettings(db, { eventId, actor: 'owner', now: T0, patch: { votingMinutes: null } });
    v = await autopilotView(db, eventId);
    expect(v.timings.votingMinutes).toBe(3);
    expect(v.state.status).toBe('idle');
    expect(
      await code(
        updateAutopilotSettings(db, { eventId, actor: 'owner', now: T0, patch: { votingMinutes: 999 } }),
      ),
    ).not.toBe('ok');
  });
});

describe('autopilot: auto-resolve ties', () => {
  it('publishable awards awaiting a decision become shared; idempotent; not after the ceremony started', async () => {
    const gs = await db.select().from(s.gifts).where(eq(s.gifts.eventId, eventId));
    const cands = gs.slice(0, 2).map((g) => g.id);
    await db.insert(s.awards).values([
      {
        eventId,
        boardKey: 'funniest',
        winners: [],
        publishable: true,
        tieInfo: { tied: true, needsDecision: true, candidates: cands },
      },
      { eventId, boardKey: 'best_overall', winners: [gs[2]!.id], publishable: true, tieInfo: {} },
    ]);
    const a = { eventId, actor: 'system', now: T0 };
    expect(await resolveTiesShared(db, a)).toEqual({ resolved: 1 });
    const [row] = await db.select().from(s.awards).where(eq(s.awards.boardKey, 'funniest'));
    expect(row!.winners).toEqual(cands);
    expect(row!.tieInfo).toMatchObject({ needsDecision: false, tied: true });
    expect(await resolveTiesShared(db, a)).toEqual({ resolved: 0 });
    await db.insert(s.ceremonyState).values({ eventId, status: 'running' });
    expect(await code(resolveTiesShared(db, a))).toBe('ceremony_started');
  });
});
