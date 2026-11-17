import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import type { EventStateOutput } from '@santa/contracts';
import { App } from './App';
import { ParticipantApiProvider, type MeResponse, type ParticipantApi } from './api/participant';
import { PlayApiProvider, type PlayApi } from './api/play';
import { OrganizerApiProvider, type OrganizerApi } from './api/organizer';
import { AdminApiProvider, type AdminApi } from './api/admin';
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
  myAchievements: async () => ({ achievements: [] }),
  profile: vi.fn(),
  deleteMe: vi.fn(),
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

const reject = (name: string) => async () => {
  throw new Error(`unexpected call: ${name}`);
};

/** Organizer API double: read endpoints return empty data, everything else must be provided by the test. */
export function fakeOrganizerApi(over: Partial<OrganizerApi> = {}): OrganizerApi {
  return {
    uploadPairing: reject('uploadPairing'),
    latestPairing: async () => ({ import: null, reimportAllowed: false }),
    createAccess: reject('createAccess'),
    claimCodes: reject('claimCodes'),
    sendEmailLinks: reject('sendEmailLinks'),
    listRoster: async () => ({ participants: [] }),
    approve: reject('approve'),
    setReactionsEnabled: reject('setReactionsEnabled'),
    muteParticipant: reject('muteParticipant'),
    openingState: reject('openingState'),
    openingNext: reject('openingNext'),
    openingOrder: reject('openingOrder'),
    listGifts: async () => [],
    openVoting: reject('openVoting'),
    closeVoting: reject('closeVoting'),
    revealGift: reject('revealGift'),
    revealAll: reject('revealAll'),
    ...over,
  };
}

export function fakeAdminApi(over: Partial<AdminApi> = {}): AdminApi {
  return {
    ceremony: async () => ({
      status: 'idle',
      index: 0,
      total: 0,
      canStart: false,
      blockers: [],
      outline: [],
      pendingDecisions: [],
    }),
    ceremonyAct: reject('ceremonyAct'),
    ceremonyNext: reject('ceremonyNext'),
    decideAward: reject('decideAward'),
    boards: async () => ({ boards: [], cadenceSeconds: 10 }),
    boardAction: reject('boardAction'),
    stats: reject('stats'),
    integrity: reject('integrity'),
    integrityDetails: reject('integrityDetails'),
    unmask: reject('unmask'),
    revokeUnmask: reject('revokeUnmask'),
    removeParticipant: reject('removeParticipant'),
    moderateGift: reject('moderateGift'),
    audit: async () => [],
    ...over,
  };
}

/** Organizer console at /o/events/e1 with doubles for the organizer + admin APIs. */
export function mountConsole(opts: {
  phase?: string;
  org?: Partial<OrganizerApi>;
  admin?: Partial<AdminApi>;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body =
        url === '/api/organizer/me'
          ? { userId: 'u1', email: 'o@example.test', isPlatformAdmin: false }
          : {
              role: 'organizer_masked',
              eventState: {
                name: 'Office Party',
                phase: opts.phase ?? 'registration',
                paused: false,
                counts: { participants: 3, giftsRegistered: 0 },
                organizer: {
                  roster: { unclaimed: 0, pending: 0, active: 3, removed: 0 },
                  warnings: [],
                  reactionsEnabled: true,
                },
              },
            };
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  const rt = createRealtimeStore();
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RealtimeProvider factory={() => rt}>
        <OrganizerApiProvider value={fakeOrganizerApi(opts.org)}>
          <AdminApiProvider value={fakeAdminApi(opts.admin)}>
            <MemoryRouter initialEntries={['/o/events/e1']}>
              <App />
            </MemoryRouter>
          </AdminApiProvider>
        </OrganizerApiProvider>
      </RealtimeProvider>
    </QueryClientProvider>,
  );
}
