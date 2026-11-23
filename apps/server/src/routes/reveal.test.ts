import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  REVEAL_UNVEIL_JOB,
  enqueueJob,
  events,
  gifts,
  saveOwnGift,
  scheduledJobs,
} from '@santa/db';
import { scanForbidden } from '@santa/contracts';
import { JobRunner } from '../jobs/runner.js';
import { registerRevealJobs } from '../realtime/reveal.js';
import { connected, createWorld, sleep, waitFor, type World } from '../testing/world.js';

const NAMES = ['Giulia', 'Marco', 'Sofia', 'Luca', 'Chiara', 'Paolo', 'Elena', 'Davide'];
type Msg = { stream: string; surface?: string; payload?: unknown; data?: Record<string, unknown> };
type Person = { participantId: string; displayName: string };
type RevealScene = {
  scene: 'reveal';
  reveal: {
    current: null | {
      giftId: string;
      stage: string;
      giver: Person | null;
      recipient: Person | null;
    };
    countdownEndsAt: string | null;
    revealedCount: number;
    total: number;
    revealed: Array<{ giftId: string; giver: Person }>;
  };
};

describe('reveal show over the wire: drumroll -> durable unveil -> finale', () => {
  let w: World;
  let n = 0;
  let byGiver: Array<typeof gifts.$inferSelect>;
  const openOrder = [3, 0, 5, 1, 7, 2, 6, 4]; // giver indexes in public opening order
  const call = (method: 'GET' | 'POST', url: string, body?: unknown) =>
    w.app.inject({
      method,
      url: `/api/events/${w.eventId}${url}`,
      ...(body === undefined ? {} : { payload: body as object }),
      headers: {
        'idempotency-key': `rv-${++n}-xxxxxxxx`,
        cookie: w.organizerCookie('demo-owner', 'sess-o'),
      },
    });
  let displayMsgs: Msg[];
  let guestMsgs: Msg[];
  const scenes = (msgs: Msg[]) =>
    msgs.flatMap((m) =>
      m.surface === 'scene' ? [m.payload] : m.data?.['scene'] ? [m.data['scene']] : [],
    ) as Array<{ scene: string }>;
  const lastScene = (msgs: Msg[]) => scenes(msgs).at(-1) as RevealScene;
  const runnerAt = (offsetMs: number) => {
    const clock = () => new Date(Date.now() + offsetMs);
    const r = new JobRunner(w.db, { clock });
    registerRevealJobs(r, w.app.hub!, w.db, clock);
    return r;
  };

  beforeAll(async () => {
    w = await createWorld();
    for (let i = 0; i < 8; i++)
      await saveOwnGift(w.db, {
        participantId: w.participantIds[i]!,
        name: `Gift of ${i}`,
        description: null,
        now: new Date(),
      });
    const rows = await w.db.select().from(gifts).where(eq(gifts.eventId, w.eventId));
    byGiver = w.participantIds.map((id) => rows.find((g) => g.giverId === id)!);
    const t0 = Date.now() - 600_000;
    for (const [k, i] of openOrder.entries())
      await w.db
        .update(gifts)
        .set({ status: 'opened', openedAt: new Date(t0 + k * 1000) })
        .where(eq(gifts.id, byGiver[i]!.id));
    await w.db
      .update(events)
      .set({
        phase: 'voting',
        giftOpeningStartedAt: new Date(t0),
        votingClosedAt: new Date(),
        currentGiftId: byGiver[4]!.id, // leftover from the opening: must NOT end up on the reveal stage
      })
      .where(eq(events.id, w.eventId));

    const display = w.client(await w.displayCookie());
    const g0 = w.client(await w.guestCookie(0));
    await Promise.all([connected(display), connected(g0)]);
    displayMsgs = [];
    guestMsgs = [];
    display.on('snapshot', (m: Msg) => displayMsgs.push(m));
    display.on('delta', (m: Msg) => displayMsgs.push(m));
    g0.on('snapshot', (m: Msg) => guestMsgs.push(m));
    g0.on('delta', (m: Msg) => guestMsgs.push(m));
    display.emit('subscribe', {});
    g0.emit('subscribe', {});
    await sleep(400);
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  it('entering the reveal phase shows an empty reveal stage (no leftover opening gift)', async () => {
    expect((await call('POST', '/phase', { to: 'reveal' })).statusCode).toBe(200);
    await sleep(300);
    expect(lastScene(displayMsgs)).toEqual({
      scene: 'reveal',
      reveal: {
        current: null,
        countdownEndsAt: null,
        revealedCount: 0,
        total: 8,
        revealed: [],
        lights: 0,
        choice: null,
        effect: null,
      },
    });
  });

  it('reveal/next: drumroll on display and participant streams, giver never sent before the deadline', async () => {
    const before = Date.now();
    const r = await call('POST', '/reveal/next');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ giftId: byGiver[3]!.id, revealedCount: 0, total: 8, done: false });
    expect(Object.keys(body).sort()).toEqual([
      'countdownEndsAt',
      'done',
      'giftId',
      'revealedCount',
      'total',
    ]);
    const ends = Date.parse(body.countdownEndsAt);
    expect(ends - before).toBeGreaterThanOrEqual(4_900); // ceremonyCountdownSeconds (default 5)
    expect(ends - before).toBeLessThan(7_000);
    await sleep(300);
    for (const msgs of [displayMsgs, guestMsgs]) {
      const s = lastScene(msgs);
      expect(s.reveal.current).toMatchObject({
        giftId: byGiver[3]!.id,
        stage: 'drumroll',
        giver: null,
        recipient: { displayName: NAMES[4] },
      });
      expect(s.reveal.countdownEndsAt).toBe(body.countdownEndsAt);
      // the staged giver (Luca) is nowhere on the public/participant streams
      expect(JSON.stringify(msgs)).not.toContain(NAMES[3]);
      expect(
        scanForbidden(msgs, { keys: ['giverId', 'recipientId', 'openingOrder', 'aliasNo'] }),
      ).toEqual([]);
    }
    expect(
      (await w.db.select().from(gifts).where(eq(gifts.id, byGiver[3]!.id)))[0]!.giverRevealedAt,
    ).toBeNull();

    // double click while the drumroll runs
    const again = await call('POST', '/reveal/next');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('stage_busy');

    // a reconnecting display gets the same drumroll from its snapshot (state is durable, not in memory)
    const d2 = w.client(await w.displayCookie());
    await connected(d2);
    const snap = waitFor<Msg>(d2, 'snapshot');
    d2.emit('subscribe', {});
    const s2 = (await snap).data!['scene'] as RevealScene;
    expect(s2.reveal.current).toMatchObject({ stage: 'drumroll', giver: null });
    expect(JSON.stringify(s2)).not.toContain(NAMES[3]);
  });

  it('reveal.unveil job: not before the deadline; at the deadline the giver is pushed once; duplicates are no-ops', async () => {
    expect(await runnerAt(0).tick()).toBe(0); // not due yet
    const pushes = () => scenes(displayMsgs).length;
    const before = pushes();
    expect(await runnerAt(6_000).tick()).toBe(1);
    await sleep(300);
    const s = lastScene(displayMsgs);
    expect(s.reveal.current).toMatchObject({
      giftId: byGiver[3]!.id,
      stage: 'revealed',
      giver: { displayName: NAMES[3] },
    });
    expect(s.reveal).toMatchObject({ countdownEndsAt: null, revealedCount: 1 });
    expect(s.reveal.revealed.map((x) => x.giver.displayName)).toEqual([NAMES[3]]);
    // participant 4 (recipient) sees the personal moment on the same scene: recipient = me, stage revealed
    expect(lastScene(guestMsgs).reveal.current).toMatchObject({
      stage: 'revealed',
      recipient: { participantId: w.participantIds[4] },
    });
    // other givers still hidden
    const text = JSON.stringify(s);
    for (const nm of NAMES.filter((x, i) => i !== 3 && i !== 4)) expect(text).not.toContain(nm);
    expect(pushes()).toBeGreaterThan(before);

    // at-least-once: a duplicate delivery changes nothing and pushes nothing
    await enqueueJob(w.db, {
      eventId: w.eventId,
      kind: REVEAL_UNVEIL_JOB,
      runAt: new Date(Date.now() - 1000),
      payload: { giftId: byGiver[3]!.id },
    });
    const n0 = pushes();
    expect(await runnerAt(7_000).tick()).toBe(1);
    await sleep(200);
    expect(pushes()).toBe(n0);
    const jobs = await w.db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.kind, REVEAL_UNVEIL_JOB));
    expect(jobs.every((j) => j.status === 'done')).toBe(true);
  });

  it('reveal-all -> finale (no stage, every pair revealed); next reports done', async () => {
    expect((await call('POST', '/reveal/next')).json()).toMatchObject({
      giftId: byGiver[0]!.id,
      revealedCount: 1,
    });
    expect((await call('POST', '/reveal/all')).json()).toEqual({ revealed: 7 });
    await sleep(300);
    const s = lastScene(displayMsgs);
    expect(s.reveal).toMatchObject({
      current: null,
      countdownEndsAt: null,
      revealedCount: 8,
      total: 8,
    });
    expect(s.reveal.revealed).toHaveLength(8);
    // the cancelled drumroll job never fires
    expect(await runnerAt(60_000).tick()).toBe(0);
    expect((await call('POST', '/reveal/next')).json()).toEqual({
      giftId: null,
      countdownEndsAt: null,
      revealedCount: 8,
      total: 8,
      done: true,
    });
  });

  it('participants cannot drive the reveal', async () => {
    const r = await w.app.inject({
      method: 'POST',
      url: `/api/events/${w.eventId}/reveal/next`,
      headers: { 'idempotency-key': 'rv-guest-xxxxxxxx', cookie: await w.guestCookie(1) },
    });
    expect([401, 403]).toContain(r.statusCode);
  });
});
