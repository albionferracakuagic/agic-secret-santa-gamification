/**
 * Local load harness (ADR-0006). Boots the real server in-process on a random port with PGlite, seeds E events
 * with C participants each, opens C socket.io clients per event and runs:
 *   connect -> vote burst (REST mutations + reads) -> board publish push -> phase push -> reconnect storm.
 * Reports p95 for REST / push / connect / reconnect against the ADR-0006 targets.
 *
 * Caveat: server and ALL clients share one Node process and CPU, so numbers are pessimistic for the server
 * but cannot show network latency. Use k6-socket.js against a deployed environment for that.
 *
 *   npx tsx e2e/load/harness.ts --events 5 --clients 100 --strict
 */
import { performance } from 'node:perf_hooks';
import { eq } from 'drizzle-orm';
import { io as connectClient, type Socket } from 'socket.io-client';
import { createEvent, eventAccess, events, gifts, participants, votingCategories } from '@santa/db';
import { createWorld } from '../../apps/server/src/testing/world.ts';
import { hashToken } from '../../apps/server/src/tokens.ts';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const EVENTS = arg('events', 5);
const CLIENTS = arg('clients', 100);
const RECONNECT_RATIO = arg('reconnect', 0.3);
const BATCH = arg('batch', 25);
const STRICT = process.argv.includes('--strict');

/** ADR-0006 targets (milliseconds unless noted). */
const TARGETS = {
  restReadP95: 300,
  restMutationP95: 400,
  mutationErrorRate: 0.005,
  connectSnapshotP95: 1500,
  pushP95: 1000,
  pushMax: 3000,
  reconnectP95: 3000,
} as const;

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const round = (n: number) => Math.round(n * 10) / 10;
const stats = (xs: number[]) => ({
  n: xs.length,
  p50: round(pct(xs, 50)),
  p95: round(pct(xs, 95)),
  p99: round(pct(xs, 99)),
  max: round(xs.length ? Math.max(...xs) : NaN),
});

interface Client {
  socket: Socket;
  cookie: string;
  eventIdx: number;
  index: number;
}

const world = await createWorld({
  rateLimitMax: 10_000_000,
  rate: { messagesPerSec: 1000, reactionsPerSec: 100 },
});
const base = `http://127.0.0.1:${world.port}`;
const owner = world.organizerCookie('demo-owner', 'load-owner');

/* ---------- seed ---------- */
console.log(`seeding ${EVENTS} events x ${CLIENTS} participants...`);
const eventIds: string[] = [];
const roster: Client[][] = [];
const giftIdsByEvent: string[][] = [];
const categoryIdsByEvent: string[][] = [];
for (let e = 0; e < EVENTS; e++) {
  const ev = await createEvent(world.db, {
    ownerId: 'demo-owner',
    now: new Date(),
    input: {
      name: `Load ${e}`,
      startsAt: '2026-12-24T19:00:00Z',
      timezone: 'Europe/Rome',
      defaultLocale: 'en',
    },
  });
  eventIds.push(ev.id);
  const ps = await world.db
    .insert(participants)
    .values(
      Array.from({ length: CLIENTS }, (_, i) => ({
        eventId: ev.id,
        displayName: `L${e}-${i}`,
        status: 'active' as const,
        source: 'import' as const,
        sessionTokenHash: hashToken(`load-${e}-${i}`),
      })),
    )
    .returning();
  const gs = await world.db
    .insert(gifts)
    .values(
      ps.map((p, i) => ({
        eventId: ev.id,
        giverId: p.id,
        aliasNo: i + 1,
        name: `Present ${i + 1}`,
        status: 'opened' as const,
      })),
    )
    .returning();
  giftIdsByEvent.push(gs.map((g) => g.id));
  categoryIdsByEvent.push(
    (await world.db.select().from(votingCategories).where(eq(votingCategories.eventId, ev.id))).map(
      (c) => c.id,
    ),
  );
  await world.db.update(events).set({ phase: 'voting' }).where(eq(events.id, ev.id));
  roster.push(
    ps.map((_, i) => ({
      socket: undefined as unknown as Socket,
      cookie: `sg_p=load-${e}-${i}`,
      eventIdx: e,
      index: i,
    })),
  );
}

/* ---------- helpers ---------- */
const sockets: Socket[] = [];
function open(cookie: string): { socket: Socket; ready: Promise<number> } {
  const t0 = performance.now();
  const socket = connectClient(base, {
    transports: ['websocket'],
    extraHeaders: { cookie },
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 30_000);
    let first = true;
    socket.once('connect', () => socket.emit('subscribe', {}));
    socket.on('snapshot', () => {
      if (!first) return;
      first = false;
      clearTimeout(timer);
      resolve(performance.now() - t0);
    });
    socket.once('connect_error', (err) => reject(err));
  });
  return { socket, ready };
}
const api = async (method: string, path: string, cookie: string, body?: unknown) => {
  const t0 = performance.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      'content-type': 'application/json',
      'idempotency-key': `ld-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await res.arrayBuffer();
  return { ms: performance.now() - t0, status: res.status };
};
const inBatches = async <T>(items: T[], size: number, fn: (x: T) => Promise<void>) => {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
};

const all = roster.flat();
const displays: Socket[] = [];

/* ---------- 1. connect + snapshot ---------- */
console.log(`connecting ${all.length} participants + ${EVENTS} displays...`);
const connectMs: number[] = [];
await inBatches(all, BATCH, async (c) => {
  const { socket, ready } = open(c.cookie);
  c.socket = socket;
  connectMs.push(await ready);
});
for (let e = 0; e < EVENTS; e++) {
  const token = `load-display-${e}`;
  await world.db
    .insert(eventAccess)
    .values({ eventId: eventIds[e]!, kind: 'display', tokenHash: hashToken(token) });
  const { socket, ready } = open(`sg_d=${token}`);
  await ready;
  displays.push(socket);
}

/* ---------- 2. REST: vote burst + reads ---------- */
console.log('vote burst + reads...');
const mutationMs: number[] = [];
const readMs: number[] = [];
let mutationErrors = 0;
await inBatches(all, BATCH, async (c) => {
  const gs = giftIdsByEvent[c.eventIdx]!;
  const cats = categoryIdsByEvent[c.eventIdx]!;
  for (const cat of cats.slice(0, 2)) {
    let g = gs[Math.floor(Math.random() * gs.length)]!;
    if (g === gs[c.index]) g = gs[(c.index + 1) % gs.length]!;
    const r = await api('POST', '/api/me/votes', c.cookie, { categoryId: cat, giftId: g });
    mutationMs.push(r.ms);
    if (r.status !== 200) mutationErrors++;
  }
  for (const path of ['/api/me/voting', '/api/me/votes', '/api/me']) {
    readMs.push((await api('GET', path, c.cookie)).ms);
  }
});

/* ---------- 3. push latency (all events concurrently) ---------- */
async function pushRound(label: string, trigger: (e: number) => Promise<void>, surface: string) {
  const arrivals: number[] = [];
  const expected = EVENTS * (CLIENTS + 1);
  let armedAt = 0;
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const timeout = setTimeout(finish, 10_000);
  const handlers: Array<[Socket, (m: { surface?: string }) => void]> = [];
  for (const s of [...all.map((c) => c.socket), ...displays]) {
    const h = (m: { surface?: string }) => {
      if (m.surface !== surface) return;
      arrivals.push(performance.now() - armedAt);
      s.off('delta', h);
      if (arrivals.length === expected) finish();
    };
    s.on('delta', h);
    handlers.push([s, h]);
  }
  armedAt = performance.now();
  await Promise.all(Array.from({ length: EVENTS }, (_, e) => trigger(e)));
  await done;
  clearTimeout(timeout);
  for (const [s, h] of handlers) s.off('delta', h);
  console.log(`  ${label}: delivered ${arrivals.length}/${expected}`);
  return { arrivals, expected };
}

console.log('push: board publish...');
const boardPush = await pushRound(
  'board',
  async (e) => {
    const r = await api('POST', `/api/events/${eventIds[e]}/boards/most_creative`, owner, {
      action: 'enable',
    });
    if (r.status !== 200) throw new Error(`board enable failed: ${r.status}`);
  },
  'leaderboards',
);
console.log('push: phase change (voting close)...');
const phasePush = await pushRound(
  'phase',
  async (e) => {
    const r = await api('POST', `/api/events/${eventIds[e]}/voting/close`, owner, {});
    if (r.status !== 200) throw new Error(`close failed: ${r.status}`);
  },
  'eventState',
);

/* ---------- 4. reconnect storm ---------- */
console.log(`reconnect storm (${Math.round(RECONNECT_RATIO * 100)}%)...`);
const storm = all.filter(() => Math.random() < RECONNECT_RATIO);
for (const c of storm) c.socket.disconnect();
const reconnectMs: number[] = [];
const stormStart = performance.now();
await Promise.all(
  storm.map(async (c) => {
    await new Promise((r) => setTimeout(r, Math.random() * 500)); // jittered backoff
    const { socket, ready } = open(c.cookie);
    c.socket = socket;
    reconnectMs.push(await ready);
  }),
);
const stormMs = performance.now() - stormStart;

/* ---------- report ---------- */
const mem = process.memoryUsage();
const cpu = process.cpuUsage();
const report = {
  scale: { events: EVENTS, clientsPerEvent: CLIENTS, sockets: all.length + EVENTS },
  restRead: stats(readMs),
  restMutation: {
    ...stats(mutationMs),
    errorRate: mutationErrors / Math.max(1, mutationMs.length),
  },
  connectSnapshot: stats(connectMs),
  boardPush: {
    ...stats(boardPush.arrivals),
    delivered: `${boardPush.arrivals.length}/${boardPush.expected}`,
  },
  phasePush: {
    ...stats(phasePush.arrivals),
    delivered: `${phasePush.arrivals.length}/${phasePush.expected}`,
  },
  reconnect: { ...stats(reconnectMs), clients: storm.length, totalMs: round(stormMs) },
  process: {
    rssMiB: Math.round(mem.rss / 1048576),
    heapMiB: Math.round(mem.heapUsed / 1048576),
    cpuUserS: round(cpu.user / 1e6),
    cpuSysS: round(cpu.system / 1e6),
  },
};

const t = TARGETS;
const checks: Array<[string, boolean, string]> = [
  [
    'REST read p95',
    report.restRead.p95 <= t.restReadP95,
    `${report.restRead.p95} <= ${t.restReadP95}`,
  ],
  [
    'REST mutation p95',
    report.restMutation.p95 <= t.restMutationP95,
    `${report.restMutation.p95} <= ${t.restMutationP95}`,
  ],
  [
    'mutation error rate',
    report.restMutation.errorRate <= t.mutationErrorRate,
    `${report.restMutation.errorRate} <= ${t.mutationErrorRate}`,
  ],
  [
    'connect+snapshot p95',
    report.connectSnapshot.p95 <= t.connectSnapshotP95,
    `${report.connectSnapshot.p95} <= ${t.connectSnapshotP95}`,
  ],
  ['board push p95', report.boardPush.p95 <= t.pushP95, `${report.boardPush.p95} <= ${t.pushP95}`],
  ['board push max', report.boardPush.max <= t.pushMax, `${report.boardPush.max} <= ${t.pushMax}`],
  [
    'board push delivery',
    boardPush.arrivals.length === boardPush.expected,
    report.boardPush.delivered,
  ],
  ['phase push p95', report.phasePush.p95 <= t.pushP95, `${report.phasePush.p95} <= ${t.pushP95}`],
  [
    'phase push delivery',
    phasePush.arrivals.length === phasePush.expected,
    report.phasePush.delivered,
  ],
  [
    'reconnect p95',
    report.reconnect.p95 <= t.reconnectP95,
    `${report.reconnect.p95} <= ${t.reconnectP95}`,
  ],
];
console.log(JSON.stringify(report, null, 2));
console.log('\nADR-0006 check:');
for (const [name, ok, detail] of checks)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);

for (const s of sockets) s.close();
await world.close();
process.exit(STRICT && checks.some((c) => !c[1]) ? 1 : 0);
