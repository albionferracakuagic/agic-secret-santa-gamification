// k6 socket scenario against a DEPLOYED environment (ADR-0006). NOT verified in CI: k6 is not installed in
// this repo's toolchain; run it manually once a staging environment exists.
//
//   k6 run -e BASE_URL=https://staging.example -e CLIENTS_FILE=clients.json e2e/load/k6-socket.js
//
// clients.json: [{ "cookie": "sg_p=<token>", "eventId": "<uuid>" }, ...]  (guest sessions of a seeded staging
// event set: 5 events x 100). Profile: ramp to 500 sockets, hold, vote burst, hold for pushes, 30 % reconnect.
//
// Protocol: raw Engine.IO v4 over WebSocket (k6 has no socket.io client).
//   server '0{...}' open -> client '40' (connect default namespace) -> server '40{...}'
//   client '42["subscribe",{}]' -> server '42["snapshot",{...}]' / '42["delta",{...}]'
//   server '2' ping -> client '3' pong
/* global open, __ENV, __VU */
import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const clients = JSON.parse(open(__ENV.CLIENTS_FILE || 'clients.json'));
const BASE = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';

const snapshotMs = new Trend('socket_snapshot_ms', true);
const deltaGapMs = new Trend('socket_delta_gap_ms', true);
const restReadMs = new Trend('rest_read_ms', true);

export const options = {
  scenarios: {
    sockets: {
      executor: 'ramping-vus',
      stages: [
        { duration: '60s', target: clients.length },
        { duration: '120s', target: clients.length },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // ADR-0006
    socket_snapshot_ms: ['p(95)<1500'],
    rest_read_ms: ['p(95)<300', 'p(99)<800'],
  },
};

export default function () {
  const c = clients[(__VU - 1) % clients.length];
  const headers = { Cookie: c.cookie, 'Content-Type': 'application/json' };
  const start = Date.now();
  let lastDelta = 0;

  const res = ws.connect(WS, { headers: { Cookie: c.cookie } }, (socket) => {
    socket.on('message', (msg) => {
      if (msg === '2') return socket.send('3'); // ping -> pong
      if (msg.startsWith('0')) return socket.send('40');
      if (msg.startsWith('40')) return socket.send('42["subscribe",{}]');
      if (msg.startsWith('42["snapshot"')) {
        snapshotMs.add(Date.now() - start);
      } else if (msg.startsWith('42["delta"')) {
        const now = Date.now();
        if (lastDelta) deltaGapMs.add(now - lastDelta);
        lastDelta = now;
      }
    });

    // state reads ~60 s after ramp (every VU, jittered). Vote mutations need gift ids from the staging seed:
    // extend clients.json with {categoryId, giftId} pairs and POST /api/me/votes here (see harness.ts for the shape).
    socket.setTimeout(
      () => {
        const state = http.get(`${BASE}/api/me/voting`, { headers });
        restReadMs.add(state.timings.duration);
      },
      60000 + Math.random() * 5000,
    );

    // 30 % of VUs drop and reconnect once (reconnect storm)
    if (Math.random() < 0.3) socket.setTimeout(() => socket.close(), 150000 + Math.random() * 3000);
    socket.setTimeout(() => socket.close(), 170000);
  });

  check(res, { 'ws upgraded (101)': (r) => r && r.status === 101 });
  sleep(1);
}
