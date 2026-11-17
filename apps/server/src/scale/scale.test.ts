import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as connectClient } from 'socket.io-client';
import { eq } from 'drizzle-orm';
import { enqueueJob, enqueueOutbox, scheduledJobs } from '@santa/db';
import { buildApp } from '../app.js';
import { JobRunner } from '../jobs/runner.js';
import { connected, createWorld, sleep, type World } from '../testing/world.js';
import { DISPLAY_COOKIE } from '../principal.js';
import { InMemoryFanoutBus, createLinkedBuses, HUB_DELTA_TOPIC } from './bus.js';
import { OutboxDispatcher } from './outbox.js';

describe('fan-out bus (in-memory default)', () => {
  it('delivers to every subscriber, supports unsubscribe, and isolates payloads', async () => {
    const bus = new InMemoryFanoutBus('i-1');
    const a: unknown[] = [];
    const b: Array<{ n: number }> = [];
    const off = bus.subscribe<{ n: number }>('t', (m) => a.push(m));
    bus.subscribe<{ n: number }>('t', (m) => {
      m.n = 99; // a hostile/buggy subscriber must not change what others see
      b.push(m);
    });
    await bus.publish('t', { n: 1 });
    await sleep(10);
    expect(a).toEqual([{ n: 1 }]);
    off();
    await bus.publish('t', { n: 2 });
    await sleep(10);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    await bus.close();
    await bus.publish('t', { n: 3 });
    await sleep(10);
    expect(b).toHaveLength(2);
  });
});

describe('two instances share realtime deltas through the bus', () => {
  let w: World;
  let app2: ReturnType<typeof buildApp>;
  let port2: number;
  const [bus1, bus2] = createLinkedBuses(2) as [InMemoryFanoutBus, InMemoryFanoutBus];

  beforeAll(async () => {
    w = await createWorld({ bus: bus1 });
    app2 = buildApp({
      db: w.db,
      organizerSessions: w.organizers,
      guardEnv: 'test',
      storage: w.storage,
      bus: bus2,
    });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    port2 = (app2.server.address() as AddressInfo).port;
  }, 60_000);
  afterAll(async () => {
    await app2.close();
    await w.close();
  });

  it("a delta published on instance 1 reaches a display connected to instance 2 (same payload, no loop)", async () => {
    await w.displayCookie(); // registers the display token
    const c = connectClient(`http://127.0.0.1:${port2}`, {
      transports: ['websocket'],
      extraHeaders: { cookie: `${DISPLAY_COOKIE}=display-token` },
      reconnection: false,
      forceNew: true,
    });
    const deltas: Array<{ stream: string; cursor: number; surface: string; payload: unknown }> = [];
    try {
      await connected(c);
      c.on('delta', (m) => deltas.push(m));
      c.emit('subscribe', {});
      await sleep(300);
      w.app.hub!.publish(w.eventId, 'pub', 'scene', { scene: 'phase', phase: 'games' });
      await sleep(300);
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ stream: 'pub', surface: 'scene', payload: { scene: 'phase', phase: 'games' } });
      // instance 2's own cursor follows the origin's (no regression, no echo back)
      expect(app2.hub!.currentCursor(w.eventId, 'pub')).toBe(deltas[0]!.cursor);
      expect(w.app.hub!.currentCursor(w.eventId, 'pub')).toBe(deltas[0]!.cursor);
    } finally {
      c.close();
    }
  });

  it('unmasked grant channels never cross instances; leaky payloads are still refused at the origin', async () => {
    const seen: unknown[] = [];
    bus2.subscribe(HUB_DELTA_TOPIC, (m) => seen.push(m));
    const grant = await w.grant();
    await w.app.hub!.publishToGrant(grant, 'eventState', { role: 'organizer_unmasked' }).catch(() => undefined);
    expect(() => w.app.hub!.publish(w.eventId, 'pub', 'scene', { scene: 'phase', phase: 'games', score: 1 })).toThrow();
    await sleep(100);
    expect(seen).toEqual([]);
  });
});

describe('outbox relay and multi-instance timers', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  it('two dispatchers relay every outbox message exactly once, in order', async () => {
    const [b1] = createLinkedBuses(2) as [InMemoryFanoutBus, InMemoryFanoutBus];
    const got: number[] = [];
    b1.subscribe<{ payload: { n: number } }>('chat', (m) => got.push(m.payload.n));
    for (const n of [1, 2, 3, 4, 5]) await enqueueOutbox(w.db, { eventId: w.eventId, topic: 'chat', payload: { n } });
    const d1 = new OutboxDispatcher(w.db, b1, { batch: 2 });
    const d2 = new OutboxDispatcher(w.db, b1, { batch: 2 });
    for (let i = 0; i < 4; i++) await Promise.all([d1.tick(), d2.tick()]);
    await sleep(50);
    expect(got.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(got).toHaveLength(5);
  });

  it('several runners never run the same timer twice; a crashed worker\'s lease is recovered', async () => {
    const ran: string[] = [];
    const mk = (id: string) => {
      const r = new JobRunner(w.db, { workerId: id, leaseMs: 1_000, clock: () => new Date(Date.now() + clockSkew) });
      r.register('scale.test', async (job) => {
        ran.push(`${(job.payload as { n: number }).n}`);
      });
      return r;
    };
    let clockSkew = 0;
    const [r1, r2, r3] = [mk('w1'), mk('w2'), mk('w3')];
    for (let n = 0; n < 9; n++) await enqueueJob(w.db, { eventId: w.eventId, kind: 'scale.test', runAt: new Date(Date.now() - 1000), payload: { n } });
    for (let i = 0; i < 4; i++) await Promise.all([r1.tick(), r2.tick(), r3.tick()]);
    expect(ran.sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    // a worker that died while 'running': after the lease expires a sibling takes it over (no blanket requeue needed)
    await enqueueJob(w.db, { eventId: w.eventId, kind: 'scale.test', runAt: new Date(Date.now() - 1000), payload: { n: 100 } });
    await w.db
      .update(scheduledJobs)
      .set({ status: 'running', lockedBy: 'dead-worker', lockedAt: new Date() })
      .where(eq(scheduledJobs.status, 'pending'));
    await r1.tick();
    expect(ran).not.toContain('100'); // lease still valid: not stolen
    clockSkew = 5_000;
    await r2.tick();
    expect(ran).toContain('100');
    expect(ran.filter((x) => x === '100')).toHaveLength(1);
  });
});
