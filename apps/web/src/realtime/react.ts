import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { io } from 'socket.io-client';
import { createRealtimeStore, type RealtimeClient, type RealtimeState } from './store';

const Ctx = createContext<(() => RealtimeClient) | undefined>(undefined);

export const RealtimeProvider = ({
  factory,
  children,
}: {
  factory: () => RealtimeClient;
  children: ReactNode;
}) => createElement(Ctx.Provider, { value: factory }, children);

/** Production factory: same-origin Socket.IO with the guest/display session cookie. */
export const socketFactory = (): RealtimeClient => {
  const rt = createRealtimeStore();
  rt.connect(io({ withCredentials: true, transports: ['websocket', 'polling'] }));
  return rt;
};

const EMPTY: RealtimeState = {
  status: 'idle',
  cursors: {},
  surfaces: {},
  revokedGrants: [],
  clockOffsetMs: 0,
  reactions: [],
};

/** One realtime client per mounted page (StrictMode-safe: created and torn down in an effect). */
export function useRealtime(): { rt: RealtimeClient | undefined; state: RealtimeState } {
  const factory = useContext(Ctx) ?? socketFactory;
  const [rt, setRt] = useState<RealtimeClient>();
  const [state, setState] = useState<RealtimeState>(EMPTY);
  useEffect(() => {
    const client = factory();
    setRt(client);
    setState(client.store.getState());
    const off = client.store.subscribe(setState);
    return () => {
      off();
      client.disconnect();
      setRt(undefined);
    };
  }, [factory]);
  return { rt, state };
}

/** Latest payload of a surface from the first stream matching `pub` or the guest's `p:<id>` stream. */
export function surfaceOf<T = unknown>(
  s: RealtimeState,
  stream: 'pub' | 'participant',
  surface: 'eventState' | 'giftList' | 'leaderboard',
): T | undefined {
  const key = stream === 'pub' ? 'pub' : Object.keys(s.surfaces).find((k) => k.startsWith('p:'));
  return key ? (s.surfaces[key]?.[surface] as T | undefined) : undefined;
}
