import { createStore } from 'zustand/vanilla';

/** Minimal socket surface the store needs (socket.io-client satisfies it). */
export interface SocketLike {
  on(event: string, cb: (...args: never[]) => void): unknown;
  emit(event: string, payload?: unknown): unknown;
  close(): unknown;
}

interface DeltaMsg {
  stream: string;
  cursor: number;
  surface: string;
  payload: unknown;
}
interface SnapshotMsg {
  stream: string;
  cursor: number;
  data: Record<string, unknown>;
}

export interface RealtimeState {
  status: 'idle' | 'connecting' | 'live' | 'reconnecting';
  /** stream -> last applied cursor (per-projection, never compared across streams) */
  cursors: Record<string, number>;
  /** stream -> surface -> latest projected payload */
  surfaces: Record<string, Record<string, unknown>>;
  /** Scene snapshot generations, including recovery; newer snapshots never replay scene FX. */
  sceneSnapshots: Record<string, number>;
  revokedGrants: string[];
  /** serverNow = Date.now() + clockOffsetMs */
  clockOffsetMs: number;
  /** Aggregated bursts from the server; seq is monotonic so consumers can tell what is new. */
  reactions: Array<{ kind: string; count: number; at: number; seq: number }>;
}

/**
 * Subscribe-then-snapshot recovery (ADR-0002): deltas that arrive before a stream's snapshot are buffered;
 * on snapshot we drop buffered deltas <= snapshot cursor and replay the rest. A cursor gap => resubscribe.
 */
export function createRealtimeStore(opts: { eventId?: string; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const store = createStore<RealtimeState>(() => ({
    status: 'idle',
    cursors: {},
    surfaces: {},
    sceneSnapshots: {},
    revokedGrants: [],
    clockOffsetMs: 0,
    reactions: [],
  }));
  const buffers = new Map<string, DeltaMsg[]>();
  let socket: SocketLike | undefined;
  let pingSentAt = 0;

  const apply = (d: DeltaMsg) =>
    store.setState((s) => ({
      cursors: { ...s.cursors, [d.stream]: d.cursor },
      surfaces: { ...s.surfaces, [d.stream]: { ...s.surfaces[d.stream], [d.surface]: d.payload } },
    }));

  const subscribe = () => {
    buffers.clear();
    store.setState({ cursors: {}, surfaces: {} });
    socket?.emit('subscribe', opts.eventId ? { eventId: opts.eventId } : {});
    pingSentAt = now();
    socket?.emit('time.ping', { clientTime: pingSentAt });
  };

  const onSnapshot = (m: SnapshotMsg) => {
    store.setState((s) => ({
      status: 'live',
      cursors: { ...s.cursors, [m.stream]: m.cursor },
      surfaces: { ...s.surfaces, [m.stream]: { ...m.data } },
      sceneSnapshots:
        'scene' in m.data
          ? { ...s.sceneSnapshots, [m.stream]: (s.sceneSnapshots[m.stream] ?? 0) + 1 }
          : s.sceneSnapshots,
    }));
    const pending = (buffers.get(m.stream) ?? [])
      .filter((d) => d.cursor > m.cursor)
      .sort((a, b) => a.cursor - b.cursor);
    buffers.delete(m.stream);
    for (const d of pending) onDelta(d);
  };

  function onDelta(d: DeltaMsg) {
    const cur = store.getState().cursors[d.stream];
    if (cur === undefined) {
      buffers.set(d.stream, [...(buffers.get(d.stream) ?? []), d]); // snapshot not here yet
      return;
    }
    if (d.cursor <= cur) return; // duplicate / already in snapshot
    if (d.cursor !== cur + 1) return subscribe(); // gap => full resnapshot
    apply(d);
  }

  return {
    store,
    connect(s: SocketLike) {
      socket = s;
      store.setState({ status: 'connecting' });
      s.on('connect', () => subscribe());
      s.on('disconnect', () => store.setState({ status: 'reconnecting' }));
      s.on('snapshot', onSnapshot as never);
      s.on('delta', onDelta as never);
      s.on('grant.revoked', ((m: { grantId: string }) =>
        store.setState((st) => {
          const { [`grant:${m.grantId}`]: _gone, ...rest } = st.surfaces;
          void _gone;
          return { surfaces: rest, revokedGrants: [...st.revokedGrants, m.grantId] };
        })) as never);
      s.on('reaction', ((m: { kind: string; count?: number }) =>
        store.setState((st) => ({
          reactions: [
            ...st.reactions.slice(-19),
            {
              kind: m.kind,
              count: m.count ?? 1,
              at: now(),
              seq: (st.reactions.at(-1)?.seq ?? 0) + 1,
            },
          ],
        }))) as never);
      s.on('time.sync', ((m: { serverTime: number }) => {
        const rtt = now() - pingSentAt;
        store.setState({ clockOffsetMs: m.serverTime - (pingSentAt + rtt / 2) });
      }) as never);
    },
    subscribeGrant(grantId: string) {
      socket?.emit('grant.subscribe', { grantId });
    },
    sendReaction(kind: string) {
      socket?.emit('reaction.send', { kind });
    },
    serverNow: () => now() + store.getState().clockOffsetMs,
    disconnect() {
      socket?.close();
      store.setState({ status: 'idle' });
    },
  };
}

export type RealtimeClient = ReturnType<typeof createRealtimeStore>;
