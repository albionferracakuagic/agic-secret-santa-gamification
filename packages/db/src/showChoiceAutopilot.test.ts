import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { SHOW_CHOICE_RESULT_HOLD_MS, SHOW_CHOICE_SECONDS } from '@santa/contracts';
import { createTestDb, type TestDb } from './testing.js';
import { changePhase, createEvent, EventError } from './events.js';
import {
  AUTOPILOT_TICK_JOB,
  autopilotOrphans,
  loadAutopilotState,
  runAutopilotTick,
  startAutopilot,
  type AutopilotExecutor,
} from './autopilot.js';
import { revealNextGift } from './reveal.js';
import { presentSpotlight } from './spotlight.js';
import {
  REVEAL_CHOICE_CLOSE_JOB,
  cancelShowChoice,
  closeShowChoice,
  startShowChoice,
} from './revealShow.js';
import { showChoiceHoldUntil } from './showChoiceGuard.js';
import * as s from './schema.js';

/**
 * Regression (real E2E): autopilot (quick preset) advanced the reveal show while a Snowstorm vs Sleigh Bells round
 * was open, so the display never showed the result. The open round + its result window now own the stage.
 */
let db: TestDb;
let eventId: string;
const T0 = new Date('2026-12-24T22:00:00Z');
const ms = (base: Date, d: number) => new Date(base.getTime() + d);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof EventError ? e.code : `other:${String(e)}`),
  );
const cmd = (now: Date) => ({ eventId, actor: 'owner', now });

beforeEach(async () => {
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
    .set({ phase: 'reveal', revealStartedAt: T0, votingClosedAt: T0, currentGiftId: null })
    .where(eq(s.events.id, eventId));
  const ps = await db
    .insert(s.participants)
    .values(
      Array.from({ length: 3 }, (_, i) => ({
        eventId,
        displayName: `P${i}`,
        status: 'active' as const,
        source: 'import' as const,
      })),
    )
    .returning();
  await db
    .insert(s.gifts)
    .values(
      ps.map((p, i) => ({
        eventId,
        giverId: p.id,
        aliasNo: i + 1,
        name: `G${i}`,
        status: 'opened' as const,
      })),
    );
});

const pendingTicks = () =>
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
const pendingClose = () =>
  db
    .select()
    .from(s.scheduledJobs)
    .where(
      and(eq(s.scheduledJobs.kind, REVEAL_CHOICE_CLOSE_JOB), eq(s.scheduledJobs.status, 'pending')),
    );

function recorder(): { calls: string[]; exec: AutopilotExecutor } {
  const calls: string[] = [];
  return { calls, exec: async (a) => void calls.push(a.type) };
}

/** Autopilot running on the reveal step; returns the seq + when its next (reveal) tick is due. */
async function runningOnReveal() {
  const st = await startAutopilot(db, cmd(T0));
  const r = recorder();
  expect(
    await runAutopilotTick(db, { eventId, seq: st.seq, now: T0, execute: r.exec }),
  ).toMatchObject({
    ran: true,
    action: 'resync',
  });
  const cur = await loadAutopilotState(db, eventId);
  const [tick] = await pendingTicks();
  return { seq: cur.seq, dueAt: tick!.runAt };
}

describe('autopilot vs Snowstorm vs Sleigh Bells', () => {
  it('without a choice round the timing is unchanged (no hold)', async () => {
    const { seq, dueAt } = await runningOnReveal();
    expect(await showChoiceHoldUntil(db, eventId, dueAt)).toBeNull();
    const r = recorder();
    const out = await runAutopilotTick(db, { eventId, seq, now: dueAt, execute: r.exec });
    expect(out).toMatchObject({ ran: true, action: 'reveal_next_gift' });
    expect(r.calls).toEqual(['reveal_next_gift']);
  });

  it('a due tick during the open round is deferred (same seq) to close + result window, then runs', async () => {
    const { seq, dueAt } = await runningOnReveal();
    const start = ms(dueAt, -1000); // organizer opens the poll 1 s before the autopilot step is due
    const round = await startShowChoice(db, cmd(start));
    const r = recorder();

    // due tick while open -> held, no effect, no state change, one pending tick at deadline + window
    const held = await runAutopilotTick(db, { eventId, seq, now: dueAt, execute: r.exec });
    expect(held).toEqual({ ran: false, reason: 'choice_hold' });
    expect(r.calls).toEqual([]);
    expect((await loadAutopilotState(db, eventId)).seq).toBe(seq);
    let ticks = await pendingTicks();
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.payload).toEqual({ seq });
    expect(ticks[0]!.runAt.getTime()).toBe(round.endsAt.getTime() + SHOW_CHOICE_RESULT_HOLD_MS);
    expect(await autopilotOrphans(db)).toEqual([]);
    // the close is its own durable job: untouched by the autopilot
    expect(await pendingClose()).toHaveLength(1);

    // the close job runs late (simultaneously due with the tick): the round closes; authoritative closedAt
    const closedAt = ms(round.endsAt, 400);
    expect(
      (await closeShowChoice(db, { eventId, roundId: round.roundId, now: closedAt })).changed,
    ).toBe(true);
    // tick at the originally planned time: still inside the result window (measured from closedAt) -> held again
    const planned = ms(round.endsAt, SHOW_CHOICE_RESULT_HOLD_MS);
    expect(await runAutopilotTick(db, { eventId, seq, now: planned, execute: r.exec })).toEqual({
      ran: false,
      reason: 'choice_hold',
    });
    ticks = await pendingTicks();
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.runAt.getTime()).toBe(closedAt.getTime() + SHOW_CHOICE_RESULT_HOLD_MS);

    // window over -> the step runs normally
    const after = ms(closedAt, SHOW_CHOICE_RESULT_HOLD_MS);
    expect(await runAutopilotTick(db, { eventId, seq, now: after, execute: r.exec })).toMatchObject(
      {
        ran: true,
        action: 'reveal_next_gift',
      },
    );
    expect(r.calls).toEqual(['reveal_next_gift']);
  });

  it('close job overdue: a tick past the deadline with the round still open re-checks shortly, never runs', async () => {
    const { seq } = await runningOnReveal();
    const round = await startShowChoice(db, cmd(ms(T0, 1000)));
    const late = ms(round.endsAt, 5000);
    const r = recorder();
    expect(await runAutopilotTick(db, { eventId, seq, now: late, execute: r.exec })).toEqual({
      ran: false,
      reason: 'choice_hold',
    });
    expect((await pendingTicks())[0]!.runAt.getTime()).toBe(late.getTime() + 1000);
    expect(r.calls).toEqual([]);
  });

  it('cancellation: the window counts from the cancel time', async () => {
    const { seq, dueAt } = await runningOnReveal();
    await startShowChoice(db, cmd(ms(dueAt, -1000)));
    const cancelAt = ms(dueAt, 500);
    await cancelShowChoice(db, cmd(cancelAt));
    const r = recorder();
    expect(
      await runAutopilotTick(db, { eventId, seq, now: ms(dueAt, 1000), execute: r.exec }),
    ).toEqual({
      ran: false,
      reason: 'choice_hold',
    });
    expect((await pendingTicks())[0]!.runAt.getTime()).toBe(
      cancelAt.getTime() + SHOW_CHOICE_RESULT_HOLD_MS,
    );
    const out = await runAutopilotTick(db, {
      eventId,
      seq,
      now: ms(cancelAt, SHOW_CHOICE_RESULT_HOLD_MS),
      execute: r.exec,
    });
    expect(out).toMatchObject({ ran: true, action: 'reveal_next_gift' });
  });

  it('race: a round opened between the hold check and the effect -> service refuses (choice_open), tick retries then holds', async () => {
    const { seq, dueAt } = await runningOnReveal();
    let round: Awaited<ReturnType<typeof startShowChoice>> | undefined;
    const racing: AutopilotExecutor = async (a, c) => {
      round = await startShowChoice(db, cmd(c.now)); // organizer wins the event lock first
      if (a.type === 'reveal_next_gift')
        await revealNextGift(db, { eventId, actor: 'system', now: c.now });
    };
    const out = await runAutopilotTick(db, { eventId, seq, now: dueAt, execute: racing });
    expect(out).toMatchObject({ ran: true, action: 'wait', retry: true });
    const [e] = await db.select().from(s.events).where(eq(s.events.id, eventId));
    expect(e!.currentGiftId).toBeNull(); // nothing staged over the poll
    const [retry] = await pendingTicks();
    const r = recorder();
    expect(
      await runAutopilotTick(db, { eventId, seq, now: retry!.runAt, execute: r.exec }),
    ).toEqual({
      ran: false,
      reason: 'choice_hold',
    });
    expect((await pendingTicks())[0]!.runAt.getTime()).toBe(
      round!.endsAt.getTime() + SHOW_CHOICE_RESULT_HOLD_MS,
    );
    expect(r.calls).toEqual([]);
  });

  it('while a round is open the stage cannot be moved on by anyone (choice_open); allowed again after close', async () => {
    const start = ms(T0, 1000);
    const round = await startShowChoice(db, cmd(start));
    expect(await code(revealNextGift(db, { eventId, actor: 'owner', now: ms(start, 1) }))).toBe(
      'choice_open',
    );
    expect(
      await code(changePhase(db, { eventId, actor: 'owner', to: 'awards', now: ms(start, 1) })),
    ).toBe('choice_open');
    expect(
      await code(
        presentSpotlight(db, {
          eventId,
          kind: 'mission_master',
          actor: 'owner',
          now: ms(start, 1),
        }),
      ),
    ).toBe('choice_open');
    await closeShowChoice(db, {
      eventId,
      roundId: round.roundId,
      now: ms(start, SHOW_CHOICE_SECONDS * 1000),
    });
    // manual organizer actions are not delayed by the result window (autopilot only)
    expect(
      await code(
        revealNextGift(db, {
          eventId,
          actor: 'owner',
          now: ms(start, SHOW_CHOICE_SECONDS * 1000 + 1),
        }),
      ),
    ).toBe('ok');
  });
});
