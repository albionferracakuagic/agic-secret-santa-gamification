import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  AUTOPILOT_TICK_JOB,
  events,
  gifts,
  loadAutopilotState,
  saveOwnGift,
  scheduledJobs,
  votes,
  votingCategories,
} from '@santa/db';
import { JobRunner } from '../jobs/runner.js';
import { registerAutopilotJobs } from '../realtime/autopilot.js';
import { registerCeremonyJobs } from '../realtime/ceremonyEvents.js';
import { registerPhase2Jobs } from '../realtime/phase2.js';
import { registerRevealJobs } from '../realtime/reveal.js';
import { registerVotingJobs } from '../realtime/votingJobs.js';
import { connected, createWorld, sleep, type World } from '../testing/world.js';

describe('show autopilot over the app (fake clock)', () => {
  let w: World;
  let n = 0;
  let now = new Date('2030-01-01T18:00:00Z');
  const clock = () => now;
  const org = () => w.organizerCookie('demo-owner', 'sess-o');
  const call = (method: 'GET' | 'POST' | 'PATCH', body?: unknown, cookie = org()) =>
    w.app.inject({
      method,
      url: `/api/events/${w.eventId}/autopilot`,
      ...(body === undefined ? {} : { payload: body as object }),
      headers: { 'idempotency-key': `ap-${++n}-xxxxxxxx`, cookie },
    });
  const phase = async () =>
    (await w.db.select().from(events).where(eq(events.id, w.eventId)))[0]!.phase;
  let runner: JobRunner;
  let seeded = false;
  const wire = { org: [] as string[], display: [] as string[], guest: [] as string[] };

  /** Advance the fake clock and deliver every due job (autopilot + the show's own durable timers). */
  const step = async (sec = 6) => {
    now = new Date(now.getTime() + sec * 1000);
    await runner.tick();
    if (!seeded && (await phase()) === 'voting') {
      seeded = true;
      const cats = await w.db.select().from(votingCategories).where(eq(votingCategories.eventId, w.eventId));
      const gs = await w.db.select().from(gifts).where(eq(gifts.eventId, w.eventId));
      const target = gs.find((g) => g.giverId === w.participantIds[7])!;
      for (const c of cats.slice(0, 2))
        for (const i of [0, 1, 2, 3, 4, 5])
          await w.db
            .insert(votes)
            .values({ categoryId: c.id, voterId: w.participantIds[i]!, eventId: w.eventId, giftId: target.id })
            .onConflictDoNothing();
    }
  };

  beforeAll(async () => {
    w = await createWorld();
    for (let i = 0; i < 8; i++)
      await saveOwnGift(w.db, {
        participantId: w.participantIds[i]!,
        name: `Gift ${i}`,
        description: null,
        now,
      });
    await w.db.update(events).set({ phase: 'gift_opening' }).where(eq(events.id, w.eventId));
    const sockets = {
      org: w.client(org()),
      display: w.client(await w.displayCookie()),
      guest: w.client(await w.guestCookie(0)),
    };
    await Promise.all(Object.values(sockets).map(connected));
    for (const [k, s] of Object.entries(sockets) as Array<[keyof typeof wire, (typeof sockets)['org']]>) {
      for (const ev of ['snapshot', 'delta']) s.on(ev, (m: unknown) => wire[k].push(JSON.stringify(m)));
      s.emit('subscribe', { eventId: w.eventId });
    }
    await sleep(300);
    runner = new JobRunner(w.db, { clock });
    registerAutopilotJobs(runner, w.app.hub!, w.db, clock);
    registerRevealJobs(runner, w.app.hub!, w.db, clock);
    registerCeremonyJobs(runner, w.app.hub!, w.db, clock);
    registerPhase2Jobs(runner, w.app.hub!, w.db, clock);
    registerVotingJobs(runner, w.app.hub!, w.db, clock);
  });
  afterAll(async () => w.close());

  it('authz: participants/guests cannot read or command; organizer GET is idle', async () => {
    for (const cookie of [await w.guestCookie(0), '']) {
      expect([401, 403]).toContain((await call('GET', undefined, cookie)).statusCode);
      expect([401, 403]).toContain((await call('POST', { action: 'start' }, cookie)).statusCode);
      expect([401, 403]).toContain((await call('PATCH', { preset: 'quick' }, cookie)).statusCode);
    }
    const r = await call('GET');
    expect(r.statusCode).toBe(200);
    expect(r.json().state.status).toBe('idle');
  });

  it('rejects an invalid body, start before gift_opening, bad commands', async () => {
    expect((await call('POST', { action: 'nope' })).statusCode).toBe(400);
    expect((await call('POST', { action: 'hold' })).json().error.code).toBe('autopilot_not_running');
    await w.db.update(events).set({ phase: 'gift_registration' }).where(eq(events.id, w.eventId));
    const r = await call('POST', { action: 'start' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('autopilot_phase_not_allowed');
    await w.db.update(events).set({ phase: 'gift_opening' }).where(eq(events.id, w.eventId));
  });

  it('runs the whole show gift_opening -> completed; hold/resume/stale seq; org-only surface', async () => {
    expect((await call('PATCH', { preset: 'quick' })).statusCode).toBe(200);
    const started = await call('POST', { action: 'start' });
    expect(started.statusCode).toBe(200);
    const s0 = started.json().state;
    expect(s0.status).toBe('running');
    expect((await call('POST', { action: 'start' })).json().error.code).toBe('autopilot_active');
    expect((await call('POST', { action: 'hold', fromSeq: s0.seq - 1 })).json().error.code).toBe('stale_seq');

    // hold freezes progress, resume continues
    for (let i = 0; i < 3; i++) await step();
    const held = await call('POST', { action: 'hold' });
    expect(held.json().state.status).toBe('held');
    const phaseHeld = await phase();
    const seqHeld = held.json().state.seq;
    for (let i = 0; i < 20; i++) await step(30);
    expect(await phase()).toBe(phaseHeld);
    expect((await loadAutopilotState(w.db, w.eventId))!.seq).toBe(seqHeld);
    expect((await call('POST', { action: 'resume' })).json().state.status).toBe('running');

    for (let i = 0; i < 600 && (await phase()) !== 'completed'; i++) await step(i < 400 ? 6 : 30);
    expect(await phase()).toBe('completed');
    for (let i = 0; i < 5; i++) await step();
    const st = await call('GET');
    expect(st.json().state.status).toBe('done');
    const log = st.json().state.log as Array<{ code: string; params?: { step?: string } }>;
    expect(log.some((l) => l.code === 'completed')).toBe(true);
    const steps = log.filter((l) => l.code === 'step_started').map((l) => l.params?.step);
    expect(steps).toEqual(expect.arrayContaining(['voting', 'reveal', 'awards']));
    const pending = await w.db.select().from(scheduledJobs).where(eq(scheduledJobs.kind, AUTOPILOT_TICK_JOB));
    expect(pending.filter((j) => j.status === 'pending')).toHaveLength(0);
    // every gift opened and revealed
    const gs = await w.db.select().from(gifts).where(eq(gifts.eventId, w.eventId));
    expect(gs.every((g) => g.status !== 'registered' && g.revealedAt !== null)).toBe(true);
  }, 240_000);

  it('privacy: autopilot only in the organizer eventState, never display/participant streams', async () => {
    await sleep(300);
    expect(wire.display.length).toBeGreaterThan(0);
    expect(wire.guest.length).toBeGreaterThan(0);
    expect(wire.org.some((m) => m.includes('"autopilot"'))).toBe(true);
    for (const m of [...wire.display, ...wire.guest]) {
      expect(m).not.toContain('autopilot');
    }
    const r = await w.app.inject({
      method: 'GET',
      url: `/api/events/${w.eventId}/organizer-state`,
      headers: { cookie: org() },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('"autopilot"');
  });
});
describe('autopilot: freeze + manual override + stop', () => {
  let w: World;
  let now = new Date('2030-02-01T18:00:00Z');
  const clock = () => now;
  const org = () => w.organizerCookie('demo-owner', 'sess-o');
  let n = 0;
  const post = (body: unknown) =>
    w.app.inject({
      method: 'POST',
      url: `/api/events/${w.eventId}/autopilot`,
      payload: body as object,
      headers: { 'idempotency-key': `fz-${++n}-xxxxxxxx`, cookie: org() },
    });
  let runner: JobRunner;
  const step = async (sec = 6) => {
    now = new Date(now.getTime() + sec * 1000);
    await runner.tick();
  };

  beforeAll(async () => {
    w = await createWorld();
    for (let i = 0; i < 8; i++)
      await saveOwnGift(w.db, {
        participantId: w.participantIds[i]!,
        name: `Gift ${i}`,
        description: null,
        now,
      });
    await w.db.update(events).set({ phase: 'gift_opening' }).where(eq(events.id, w.eventId));
    runner = new JobRunner(w.db, { clock });
    registerAutopilotJobs(runner, w.app.hub!, w.db, clock);
  });
  afterAll(async () => w.close());

  it('manual organizer action mid-show does not break the plan (resync, no duplicate effect)', async () => {
    expect((await post({ action: 'start' })).statusCode).toBe(200);
    // organizer opens a gift by hand just before the tick
    const m = await w.app.inject({
      method: 'POST',
      url: `/api/events/${w.eventId}/opening/next`,
      headers: { 'idempotency-key': `mo-${++n}-xxxxxxxx`, cookie: org() },
    });
    expect(m.statusCode).toBe(200);
    for (let i = 0; i < 6; i++) await step();
    const opened = (await w.db.select().from(gifts).where(eq(gifts.eventId, w.eventId))).filter(
      (g) => g.status === 'opened',
    );
    expect(new Set(opened.map((g) => g.id)).size).toBe(opened.length);
    expect((await loadAutopilotState(w.db, w.eventId))!.status).toBe('running');
  });

  it('event frozen -> tick holds with frozen_held; resume rejected while paused; resumes after unfreeze', async () => {
    await w.db.update(events).set({ paused: true }).where(eq(events.id, w.eventId));
    for (let i = 0; i < 3; i++) await step();
    const st = (await loadAutopilotState(w.db, w.eventId))!;
    expect(st.status).toBe('held');
    expect(st.log.some((l) => l.code === 'frozen_held')).toBe(true);
    expect((await post({ action: 'resume' })).json().error.code).toBe('paused');
    await w.db.update(events).set({ paused: false }).where(eq(events.id, w.eventId));
    expect((await post({ action: 'resume' })).json().state.status).toBe('running');
  });

  it('stop ends it; further ticks are no-ops', async () => {
    expect((await post({ action: 'stop' })).statusCode).toBe(200);
    const before = (await loadAutopilotState(w.db, w.eventId))!;
    for (let i = 0; i < 3; i++) await step(60);
    expect(await loadAutopilotState(w.db, w.eventId)).toEqual(before);
    expect((await post({ action: 'stop' })).statusCode).toBe(409);
  });
});