import { describe, expect, it } from 'vitest';
import { createRealtimeStore, type SocketLike } from './store';

function fakeSocket() {
  const handlers = new Map<string, (m: never) => void>();
  const sent: Array<[string, unknown]> = [];
  const s: SocketLike & { fire: (e: string, m?: unknown) => void; sent: typeof sent } = {
    on: (e, cb) => void handlers.set(e, cb),
    emit: (e, p) => void sent.push([e, p]),
    close: () => undefined,
    fire: (e, m) => handlers.get(e)?.(m as never),
    sent,
  };
  return s;
}

const snap = (stream: string, cursor: number, data: Record<string, unknown> = {}) => ({
  stream,
  cursor,
  data,
});
const delta = (stream: string, cursor: number, payload: unknown, surface = 'giftList') => ({
  stream,
  cursor,
  surface,
  payload,
});

describe('realtime store', () => {
  it('subscribes on connect and applies snapshot then contiguous deltas', () => {
    const c = createRealtimeStore({ eventId: 'e1' });
    const s = fakeSocket();
    c.connect(s);
    s.fire('connect');
    expect(s.sent[0]).toEqual(['subscribe', { eventId: 'e1' }]);
    s.fire('snapshot', snap('pub', 2, { giftList: 'A' }));
    s.fire('delta', delta('pub', 3, 'B'));
    s.fire('delta', delta('pub', 3, 'B')); // duplicate ignored
    expect(c.store.getState()).toMatchObject({
      status: 'live',
      cursors: { pub: 3 },
      surfaces: { pub: { giftList: 'B' } },
    });
  });

  it('buffers deltas that race ahead of the snapshot and drops those already covered', () => {
    const c = createRealtimeStore();
    const s = fakeSocket();
    c.connect(s);
    s.fire('connect');
    s.fire('delta', delta('pub', 4, 'D4'));
    s.fire('delta', delta('pub', 5, 'D5'));
    s.fire('snapshot', snap('pub', 4, { giftList: 'S4' }));
    expect(c.store.getState().surfaces['pub']).toEqual({ giftList: 'D5' });
    expect(c.store.getState().cursors['pub']).toBe(5);
  });

  it('cursor gap triggers a resubscribe (full resnapshot)', () => {
    const c = createRealtimeStore();
    const s = fakeSocket();
    c.connect(s);
    s.fire('connect');
    s.fire('snapshot', snap('pub', 1));
    s.sent.length = 0;
    s.fire('delta', delta('pub', 5, 'X'));
    expect(s.sent.map(([e]) => e)).toContain('subscribe');
    expect(c.store.getState().cursors).toEqual({});
  });

  it('streams have independent cursors', () => {
    const c = createRealtimeStore();
    const s = fakeSocket();
    c.connect(s);
    s.fire('snapshot', snap('pub', 10));
    s.fire('snapshot', snap('p:abc', 0));
    s.fire('delta', delta('p:abc', 1, 'mine', 'eventState'));
    expect(c.store.getState().cursors).toEqual({ pub: 10, 'p:abc': 1 });
  });

  it('grant revoked drops the unmasked surfaces; disconnect marks reconnecting; clock offset from time.sync', () => {
    let t = 1_000;
    const c = createRealtimeStore({ now: () => t });
    const s = fakeSocket();
    c.connect(s);
    s.fire('connect');
    s.fire('snapshot', snap('grant:g1', 0, { giftList: 'secret' }));
    s.fire('grant.revoked', { grantId: 'g1' });
    expect(c.store.getState().surfaces['grant:g1']).toBeUndefined();
    expect(c.store.getState().revokedGrants).toEqual(['g1']);
    t = 1_100; // 100 ms rtt -> server time at midpoint
    s.fire('time.sync', { clientTime: 1_000, serverTime: 5_050 });
    expect(c.store.getState().clockOffsetMs).toBe(4_000);
    s.fire('disconnect');
    expect(c.store.getState().status).toBe('reconnecting');
  });
});
