import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REACTION_KINDS } from '@santa/contracts';
import i18n from './i18n';
import { en } from './i18n/en';
import { it as itLocale } from './i18n/it';
import { App } from './App';
import { usePrefs } from './prefs/store';
import { ParticipantApiProvider, type ParticipantApi, type Me } from './api/participant';
import { RealtimeProvider } from './realtime/react';
import { createRealtimeStore, type SocketLike } from './realtime/store';
import { createReactionThrottle } from './components/reactionThrottle';

type Handler = (...a: never[]) => void;
function fakeSocket() {
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

const ME: Me = {
  participantId: 'p1',
  displayName: 'Anna',
  avatar: '🎅',
  status: 'active',
  xp: { xp: 10, level: 1 },
  votes: [{ categoryId: 'c1', giftId: 'g1' }],
};

function setup(path: string, api: Partial<ParticipantApi> = {}) {
  const sock = fakeSocket();
  const rt = createRealtimeStore();
  rt.connect(sock.s);
  const fullApi: ParticipantApi = {
    preview: async () => ({
      eventName: 'Office Party',
      roster: [
        { participantId: 'p1', displayName: 'Anna', avatar: null, available: true },
        { participantId: 'p2', displayName: 'Bruno', avatar: null, available: false },
      ],
    }),
    pickName: async () => ({ status: 'pending' }),
    claim: async () => ({ status: 'active' }),
    me: async () => ({ ...ME, status: 'pending' }),
    updateProfile: async (p) => ({ ...ME, ...p }),
    ...api,
  };
  const Where = () => (
    <p hidden data-testid="where">
      {useLocation().pathname}
    </p>
  );
  const view = render(
    <ParticipantApiProvider value={fullApi}>
      <RealtimeProvider factory={() => rt}>
        <MemoryRouter initialEntries={[path]}>
          <App />
          <Routes>
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </RealtimeProvider>
    </ParticipantApiProvider>,
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

beforeEach(async () => {
  await i18n.changeLanguage('en');
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' });
});

describe('join flow /j', () => {
  it('short code -> roster name -> pending -> approved goes to /e; taken names are disabled', async () => {
    const pickName = vi.fn(async () => ({ status: 'pending' as const }));
    let status: Me['status'] = 'pending';
    const { fullApi } = setup('/j', { pickName, me: async () => ({ ...ME, status }) });
    fireEvent.change(await screen.findByLabelText('Event code'), { target: { value: 'abc234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Welcome to Office Party!')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Bruno/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Anna' }));
    expect(await screen.findByText(/organizer will confirm/)).toBeTruthy();
    expect(pickName).toHaveBeenCalledWith('p1');
    expect(fullApi).toBeTruthy();
    status = 'active';
    // approval is detected by polling own status
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/e'), {
      timeout: 5000,
    });
  }, 10_000);

  it('QR landing token skips the code step; claim code is offered while pending', async () => {
    const claim = vi.fn(async () => ({ status: 'active' as const }));
    const preview = vi.fn(async () => ({
      eventName: 'Gala',
      roster: [{ participantId: 'p1', displayName: 'Anna', avatar: null, available: true }],
    }));
    setup('/j/' + 'a'.repeat(22), { preview, claim });
    fireEvent.click(await screen.findByRole('button', { name: 'Anna' }));
    expect(preview).toHaveBeenCalledWith({ token: 'a'.repeat(22) });
    fireEvent.change(await screen.findByLabelText('Personal code'), {
      target: { value: 'ABCDEF12' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(claim).toHaveBeenCalledWith({
        method: 'personal_code',
        participantId: 'p1',
        code: 'ABCDEF12',
      }),
    );
  });

  it('shows a localized error for an unknown code', async () => {
    const { ApiError } = await import('./api/client');
    setup('/j', {
      preview: async () => {
        throw new ApiError(404, 'not_found');
      },
    });
    fireEvent.change(await screen.findByLabelText('Event code'), { target: { value: 'ZZZZZZ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/could not find that event/);
  });
});

const PUB_BOARD = {
  eventState: undefined,
  leaderboard: { boardKey: 'b', state: 'live', entries: [{ entryId: 'g9', rank: 1, tied: false }] },
};

describe('participant /e', () => {
  const eventState = (over: Record<string, unknown> = {}) => ({
    role: 'participant',
    eventId: 'e1',
    name: 'Office Party',
    description: null,
    theme: 'xmas',
    startsAt: '2026-12-20T18:00:00Z',
    timezone: 'UTC',
    phase: 'voting',
    paused: false,
    counts: { participants: 7, giftsRegistered: 7 },
    me: ME,
    ...over,
  });

  it('renders own selections only, neutral non-top message with no rank/total, and sends reactions', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: eventState() });
    t.snapshot('pub', { leaderboard: PUB_BOARD.leaderboard });
    expect(await screen.findByText('Your picks')).toBeTruthy();
    expect(screen.getByText('Your pick')).toBeTruthy();
    expect(screen.getByText(/Thanks for playing/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/#1|rank|Rank/);
    fireEvent.click(screen.getByRole('button', { name: 'Clap' }));
    expect(t.sock.sent).toContainEqual(['reaction.send', { kind: 'clap' }]);
  });

  it('profile edit calls the API with trimmed name and avatar', async () => {
    const updateProfile = vi.fn(async (p) => ({ ...ME, ...p }));
    const t = setup('/e', { updateProfile });
    t.snapshot('p:p1', { eventState: eventState() });
    fireEvent.change(await screen.findByLabelText('Display name'), {
      target: { value: ' Anna B ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '🎄' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith({ displayName: 'Anna B', avatar: '🎄' }),
    );
    expect(await screen.findByText('Saved!')).toBeTruthy();
  });

  it('reaction bar throttles with a neutral message (no error role) and never blocks', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: eventState() });
    const heart = await screen.findByRole('button', { name: 'Heart' });
    for (let i = 0; i < 6; i++) fireEvent.click(heart);
    expect(t.sock.sent.filter(([e]) => e === 'reaction.send')).toHaveLength(4);
    expect(await screen.findByText('Lots of cheer! Give it a moment.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a11y: no axe violations (contrast excluded in jsdom)', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: eventState() });
    await screen.findByText('Your picks');
    const res = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('display /d', () => {
  const ds = (phase: string, over: Record<string, unknown> = {}) => ({
    role: 'display',
    eventId: 'e1',
    name: 'Office Party',
    description: null,
    theme: 'xmas',
    startsAt: '2026-12-20T18:00:00Z',
    timezone: 'UTC',
    phase,
    paused: false,
    counts: { participants: 12, giftsRegistered: 9 },
    ...over,
  });

  it('lobby: QR from the display link, joined counter, sound-unlock overlay is non-modal', async () => {
    const t = setup('/d?join=https%3A%2F%2Fx.test%2Fj%2Ftok&code=ABC234');
    t.snapshot('pub', { eventState: ds('registration') });
    expect(await screen.findByRole('img', { name: 'QR code to join the event' })).toBeTruthy();
    expect(screen.getByTestId('big-count').textContent).toBe('12');
    expect(screen.getByText('ABC234')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Sound' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep silent' }));
    expect(screen.queryByRole('region', { name: 'Sound' })).toBeNull();
    expect(usePrefs.getState().sound).toBe(false);
  });

  it('voting scene shows only the published voted counter; countdown only when the stream sends it', async () => {
    const t = setup('/d');
    t.snapshot('pub', { eventState: ds('voting', { votedCount: 5 }) });
    expect(await screen.findByText('Voting is open')).toBeTruthy();
    expect(screen.getByTestId('big-count').textContent).toBe('5');
    expect(screen.queryByRole('timer')).toBeNull();
    const t2 = setup('/d');
    t2.snapshot('pub', {
      eventState: ds('voting'),
      votingEndsAt: new Date(Date.now() + 90_000).toISOString(),
    });
    expect((await screen.findAllByRole('timer'))[0]!.textContent).toMatch(/^0[01]:\d\d$/);
  });

  it('leaderboard: top-N podium with crown, no data beyond the projection', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('awards'),
      leaderboard: {
        boardKey: 'b',
        state: 'live',
        entries: [
          { entryId: 'g1', rank: 1, tied: false },
          { entryId: 'g2', rank: 2, tied: true },
        ],
      },
      giftList: {
        mode: 'gallery',
        gifts: [
          {
            giftId: 'g1',
            alias: 'A',
            name: 'Scarf',
            description: null,
            photoUrl: null,
            status: 'opened',
          },
        ],
      },
    });
    const podium = await screen.findByTestId('podium');
    expect(podium.textContent).toContain('👑');
    expect(podium.textContent).toContain('Scarf');
    expect(podium.textContent).toContain('Gift #2');
    expect(podium.querySelectorAll('li')).toHaveLength(2);
  });

  it('achievement announcement scene; a11y clean', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('voting'),
      announcement: { displayName: 'Anna', avatar: '🎅', achievement: 'first_gift' },
    });
    expect(await screen.findByText('Anna earned first_gift!')).toBeTruthy();
    const res = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('reaction throttle', () => {
  it('allows a burst then frees slots as the window slides', () => {
    let now = 0;
    const th = createReactionThrottle({ burst: 2, windowMs: 1000, now: () => now });
    expect([th.tryAcquire(), th.tryAcquire(), th.tryAcquire()]).toEqual([true, true, false]);
    expect(th.waitMs()).toBe(1000);
    now = 1001;
    expect(th.tryAcquire()).toBe(true);
  });
});

describe('i18n parity for new screens', () => {
  it('reaction labels exist for every contract reaction kind in EN and IT', () => {
    for (const k of REACTION_KINDS) {
      expect(en.reactions.kind).toHaveProperty(k);
      expect(itLocale.reactions.kind).toHaveProperty(k);
    }
  });
  it('Italian renders the join screen', async () => {
    await i18n.changeLanguage('it');
    setup('/j');
    expect(await screen.findByLabelText('Codice evento')).toBeTruthy();
  });
});
