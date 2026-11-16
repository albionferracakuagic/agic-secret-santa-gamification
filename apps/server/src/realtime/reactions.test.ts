import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { events } from '@santa/db';
import { REACTION_KINDS } from '@santa/contracts';
import { ReactionService } from './reactions.js';
import { collect, connected, createWorld, sleep, type World } from '../testing/world.js';

describe('ReactionService', () => {
  const setup = (over: Partial<ConstructorParameters<typeof ReactionService>[0]> = {}) => {
    let t = 0;
    const out: Array<{ eventId: string; kind: string; count: number }> = [];
    const svc = new ReactionService({
      perParticipantPerSec: 3,
      windowMs: 1_000_000, // flushed manually
      policy: async () => true,
      emit: (eventId, b) => out.push({ eventId, ...b }),
      now: () => t,
      ...over,
    });
    return { svc, out, advance: (ms: number) => (t += ms) };
  };

  it('aggregates per kind into one burst per flush; carries no identity', async () => {
    const { svc, out } = setup({ perParticipantPerSec: 100 });
    await svc.submit('e1', 'p1', 'love');
    await svc.submit('e1', 'p2', 'love');
    await svc.submit('e1', 'p1', 'applause');
    svc.flush();
    expect(out).toEqual([
      { eventId: 'e1', kind: 'love', count: 2 },
      { eventId: 'e1', kind: 'applause', count: 1 },
    ]);
    expect(Object.keys(out[0]!).sort()).toEqual(['count', 'eventId', 'kind']);
    svc.close();
  });

  it('token bucket is per PARTICIPANT (several tabs share it) and refills over time', async () => {
    const { svc, out, advance } = setup();
    for (let i = 0; i < 10; i++) await svc.submit('e1', 'p1', 'wow'); // "10 tabs" of one person
    svc.flush();
    expect(out[0]!.count).toBe(3);
    out.length = 0;
    advance(1000);
    for (let i = 0; i < 10; i++) await svc.submit('e1', 'p1', 'wow');
    svc.flush();
    expect(out[0]!.count).toBe(3);
    // another participant has their own budget
    out.length = 0;
    await svc.submit('e1', 'p2', 'wow');
    svc.flush();
    expect(out[0]!.count).toBe(1);
    svc.close();
  });

  it('policy denial drops silently; invalidatePolicy applies organizer changes immediately', async () => {
    let allowed = false;
    const { svc, out } = setup({ policy: async () => allowed, perParticipantPerSec: 100 });
    await svc.submit('e1', 'p1', 'love');
    svc.flush();
    expect(out).toEqual([]);
    allowed = true;
    await svc.submit('e1', 'p1', 'love'); // still cached as denied
    svc.flush();
    expect(out).toEqual([]);
    svc.invalidatePolicy('e1');
    await svc.submit('e1', 'p1', 'love');
    svc.flush();
    expect(out).toEqual([{ eventId: 'e1', kind: 'love', count: 1 }]);
    svc.close();
  });
});

describe('reactions over sockets + organizer controls', () => {
  let w: World;
  let n = 0;
  const OWNER = () => w.organizerCookie('demo-owner', 'sess-o');
  beforeAll(async () => {
    w = await createWorld({
      reactionWindowMs: 60,
      rate: { messagesPerSec: 200, reactionsPerSec: 4 },
    });
    await w.db.update(events).set({ phase: 'voting' }).where(eq(events.id, w.eventId));
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  const post = (url: string, body: unknown) =>
    w.app.inject({
      method: 'POST',
      url,
      payload: body as object,
      headers: { cookie: OWNER(), 'idempotency-key': `r-${++n}-xxxxxxxx` },
    });

  async function setupSockets(i: number) {
    const guest = w.client(await w.guestCookie(i));
    const display = w.client(await w.displayCookie().catch(() => 'sg_d=display-token'));
    await Promise.all([connected(guest), connected(display)]);
    guest.emit('subscribe', {});
    display.emit('subscribe', {});
    await sleep(250);
    const bursts = collect(display, 'reaction') as Array<{ kind: string; count: number }>;
    const peers = collect(guest, 'reaction') as Array<{ kind: string; count: number }>;
    return { guest, bursts, peers };
  }
  const total = (b: Array<{ count: number }>) => b.reduce((a, x) => a + x.count, 0);

  it('6 positive kinds only; aggregated bursts reach display AND participants; spam is capped', async () => {
    expect(REACTION_KINDS).toEqual(['love', 'hilarious', 'amazing', 'wow', 'spirit', 'applause']);
    const { guest, bursts, peers } = await setupSockets(0);
    for (let i = 0; i < 30; i++) guest.emit('reaction.send', { kind: 'love' });
    guest.emit('reaction.send', { kind: 'boo' });
    guest.emit('reaction.send', { kind: 'heart' }); // retired kind
    await sleep(400);
    expect(total(bursts)).toBeGreaterThanOrEqual(1);
    expect(total(bursts)).toBeLessThanOrEqual(5); // bucket 4/s (+ refill)
    expect(
      bursts.every((b) => Object.keys(b).sort().join() === 'count,kind' && b.kind === 'love'),
    ).toBe(true);
    expect(total(peers)).toBe(total(bursts)); // participants get the same aggregate
  });

  it('organizer event switch and per-participant mute silence reactions immediately', async () => {
    const { guest, bursts } = await setupSockets(1);
    const send = async () => {
      bursts.length = 0;
      guest.emit('reaction.send', { kind: 'wow' });
      await sleep(250);
      return total(bursts);
    };
    await sleep(1100); // refill bucket
    expect(await send()).toBe(1);

    expect(
      (await post(`/api/events/${w.eventId}/reactions/settings`, { enabled: false })).statusCode,
    ).toBe(200);
    await sleep(1100);
    expect(await send()).toBe(0);
    await post(`/api/events/${w.eventId}/reactions/settings`, { enabled: true });
    await sleep(1100);
    expect(await send()).toBe(1);

    const mute = await post(`/api/events/${w.eventId}/participants/${w.participantIds[1]}/mute`, {
      muted: true,
    });
    expect(mute.json()).toEqual({ muted: true });
    await sleep(1100);
    expect(await send()).toBe(0);
    await post(`/api/events/${w.eventId}/participants/${w.participantIds[1]}/mute`, {
      muted: false,
    });
    await sleep(1100);
    expect(await send()).toBe(1);
  });

  it('reactions are ignored outside reaction phases (matrix) and by non-participants', async () => {
    await w.db.update(events).set({ phase: 'gift_registration' }).where(eq(events.id, w.eventId));
    const { guest, bursts } = await setupSockets(2);
    guest.emit('reaction.send', { kind: 'love' });
    await sleep(300);
    expect(bursts).toHaveLength(0);
    await w.db.update(events).set({ phase: 'voting' }).where(eq(events.id, w.eventId));

    const display = w.client('sg_d=display-token');
    await connected(display);
    display.emit('subscribe', {});
    await sleep(150);
    const got = collect(display, 'reaction');
    display.emit('reaction.send', { kind: 'love' }); // display principal cannot react
    await sleep(250);
    expect(got).toHaveLength(0);
  });

  it('organizer controls require organizer membership', async () => {
    const res = await w.app.inject({
      method: 'POST',
      url: `/api/events/${w.eventId}/reactions/settings`,
      payload: { enabled: false },
      headers: { cookie: w.organizerCookie('stranger', 's'), 'idempotency-key': 'zz-xxxxxxxx' },
    });
    expect(res.statusCode).toBe(403);
  });
});
