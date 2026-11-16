import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import type { EventStateOutput } from '@santa/contracts';
import { App } from './App';
import { ParticipantApiProvider, type MeResponse, type ParticipantApi } from './api/participant';
import { PlayApiProvider, type PlayApi } from './api/play';
import { RealtimeProvider } from './realtime/react';
import { createRealtimeStore, type SocketLike } from './realtime/store';

/** Play endpoints reject by default: tests opt in to the ones they exercise. */
const unimplementedPlay: PlayApi = {
  getGift: async () => ({ gift: null, editable: false }),
  saveGift: vi.fn(),
  uploadPhoto: vi.fn(),
  removePhoto: vi.fn(),
  assignment: async () => {
    throw new Error('no assignment');
  },
  voting: async () => ({ status: 'not_open', endsAt: null, votedCount: null, categories: [] }),
  ownVotes: async () => ({ votes: [] }),
  castVote: vi.fn(),
};
export type Handler = (...a: never[]) => void;
export function fakeSocket() {
  const h = new Map<string, Handler>();
  const sent: Array<[string, unknown]> = [];
  const s: SocketLike = {
    on: (e, cb) => void h.set(e, cb),
    emit: (e, p) => void sent.push([e, p]),
    close: () => undefined,
  };
  return {
    s,
    sent,
    fire: (e: string, p?: unknown) => (h.get(e) as ((p: unknown) => void) | undefined)?.(p),
  };
}

export type PMe = Extract<EventStateOutput, { role: 'participant' }>['me'];
export const ME: PMe = {
  participantId: 'p1',
  displayName: 'Anna',
  avatar: 'santa',
  status: 'active',
  xp: { xp: 10, level: 1 },
  votes: [{ categoryId: 'c1', giftId: 'g1' }],
};
export const MY: MeResponse = {
  participantId: 'p1',
  eventId: 'e1',
  displayName: 'Anna',
  avatar: 'santa',
  status: 'active',
  verified: false,
  locale: 'en',
};

export function setup(
  path: string,
  api: Partial<ParticipantApi> = {},
  play: Partial<PlayApi> = {},
) {
  const sock = fakeSocket();
  const rt = createRealtimeStore();
  rt.connect(sock.s);
  const fullApi: ParticipantApi = {
    resolve: async () => ({
      event: {
        name: 'Office Party',
        startsAt: '2026-12-20T18:00:00Z',
        defaultLocale: 'en',
        joinOpen: true,
      },
      unclaimed: [
        { participantId: 'p1', displayName: 'Anna' },
        { participantId: 'p2', displayName: 'Bruno' },
      ],
    }),
    claim: async () => ({ status: 'pending', participantId: 'p1', verified: false }),
    me: async () => ({ ...MY, status: 'pending' }),
    updateProfile: async (p) => ({
      ...MY,
      displayName: p.displayName ?? MY.displayName,
      avatar: p.avatar ?? MY.avatar,
    }),
    exchangeDisplayToken: async () => undefined,
    ...api,
  };
  const Where = () => (
    <p hidden data-testid="where">
      {useLocation().pathname}
    </p>
  );
  const view = render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PlayApiProvider value={{ ...unimplementedPlay, ...play }}>
        <ParticipantApiProvider value={fullApi}>
          <RealtimeProvider factory={() => rt}>
            <MemoryRouter initialEntries={[path]}>
              <App />
              <Routes>
                <Route path="*" element={<Where />} />
              </Routes>
            </MemoryRouter>
          </RealtimeProvider>
        </ParticipantApiProvider>
      </PlayApiProvider>
    </QueryClientProvider>,
  );
  let connected = false;
  const snapshot = (stream: string, data: Record<string, unknown>) =>
    act(() => {
      if (!connected) sock.fire('connect');
      connected = true;
      sock.fire('snapshot', { stream, cursor: 1, data });
    });
  return { ...view, sock, rt, snapshot, fullApi };
}
