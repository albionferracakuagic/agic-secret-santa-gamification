import type { Page, WebSocketRoute } from '@playwright/test';
import { json } from './fixtures';

type Snap = { stream: string; data: Record<string, unknown> };

/**
 * Minimal Socket.IO v4 server double over Playwright's routeWebSocket: handshake, then on `subscribe`
 * it pushes the current snapshots. `delta` / `reaction` push later updates; `drop` simulates a network
 * loss (the client reconnects and receives `snapshots` again, which tests may swap with `setSnapshots`).
 */
export async function mockRealtime(page: Page, initial: Snap[]) {
  let snapshots = initial;
  const sockets: WebSocketRoute[] = [];
  const cursors = new Map<string, number>();
  let connections = 0;
  // The participant page now bootstraps over HTTP before consuming realtime state.
  if (initial.some((s) => s.stream.startsWith('p:') && s.data.eventState)) {
    await page.route('**/api/me/state', (route) => {
      const state = snapshots.find((s) => s.stream.startsWith('p:') && s.data.eventState);
      return state
        ? route.fulfill(json(state.data.eventState))
        : route.fulfill(json({ error: { code: 'unauthenticated' } }, 401));
    });
  }
  await page.routeWebSocket(/socket\.io/, (ws) => {
    sockets.push(ws);
    connections++;
    ws.send(
      '0' +
        JSON.stringify({
          sid: 'e2e',
          upgrades: [],
          pingInterval: 600000,
          pingTimeout: 600000,
          maxPayload: 1000000,
        }),
    );
    ws.onMessage((raw) => {
      const m = String(raw);
      if (m.startsWith('40')) ws.send('40' + JSON.stringify({ sid: 'ns' }));
      if (m.startsWith('42')) {
        const [event] = JSON.parse(m.slice(2)) as [string];
        if (event === 'subscribe')
          for (const s of snapshots) {
            cursors.set(s.stream, 1);
            ws.send(
              '42' + JSON.stringify(['snapshot', { stream: s.stream, cursor: 1, data: s.data }]),
            );
          }
        if (event === 'time.ping')
          ws.send('42' + JSON.stringify(['time.sync', { clientTime: 0, serverTime: Date.now() }]));
      }
    });
  });
  const live = () => sockets.filter((s) => !closed.has(s));
  const closed = new Set<WebSocketRoute>();
  return {
    connections: () => connections,
    setSnapshots(next: Snap[]) {
      snapshots = next;
    },
    delta(stream: string, surface: string, payload: unknown) {
      const cursor = (cursors.get(stream) ?? 1) + 1;
      cursors.set(stream, cursor);
      for (const ws of live())
        ws.send('42' + JSON.stringify(['delta', { stream, cursor, surface, payload }]));
    },
    reaction(kind: string, count = 1) {
      for (const ws of live()) ws.send('42' + JSON.stringify(['reaction', { kind, count }]));
    },
    drop() {
      for (const ws of live()) {
        closed.add(ws);
        void ws.close();
      }
    },
  };
}

export type Realtime = Awaited<ReturnType<typeof mockRealtime>>;
