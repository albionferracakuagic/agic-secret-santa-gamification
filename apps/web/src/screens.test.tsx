import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REACTION_KINDS } from '@santa/contracts';
import { ME, MY, setup } from './test-utils';
import i18n from './i18n';
import { en } from './i18n/en';
import { it as itLocale } from './i18n/it';
import { usePrefs } from './prefs/store';
import { httpParticipantApi, type MeResponse } from './api/participant';
import { createReactionThrottle } from './components/reactionThrottle';

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' });
});
afterEach(() => vi.unstubAllGlobals());

describe('join flow /j', () => {
  it('short code -> roster name -> pending -> approved goes to /e', async () => {
    const claim = vi.fn(async () => ({
      status: 'pending' as const,
      participantId: 'p1',
      verified: false,
    }));
    let status: MeResponse['status'] = 'pending';
    const resolve = vi.fn(async () => ({
      event: {
        name: 'Office Party',
        startsAt: '2026-12-20T18:00:00Z',
        defaultLocale: 'en' as const,
        joinOpen: true,
      },
      unclaimed: [{ participantId: 'p1', displayName: 'Anna' }],
    }));
    setup('/j', { claim, resolve, me: async () => ({ ...MY, status }) });
    fireEvent.change(await screen.findByLabelText('Event code'), {
      target: { value: 'abcde-fghjk' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Welcome to Office Party!')).toBeTruthy();
    expect(resolve).toHaveBeenCalledWith({ shortCode: 'ABCDEFGHJK' });
    fireEvent.click(screen.getByRole('button', { name: /Anna/ }));
    expect(await screen.findByText(/organizer will confirm/)).toBeTruthy();
    expect(claim).toHaveBeenCalledWith({
      method: 'pick_name',
      target: { shortCode: 'ABCDEFGHJK' },
      participantId: 'p1',
    });
    status = 'active';
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/e'), {
      timeout: 5000,
    });
  }, 10_000);

  it('10-character short codes: Continue stays disabled until the code is valid (case, spaces and hyphens ignored)', async () => {
    setup('/j');
    const input = await screen.findByLabelText('Event code');
    const go = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: 'ABC234' } });
    expect(go.disabled).toBe(true);
    fireEvent.change(input, { target: { value: ' abcde fghjk ' } });
    expect(go.disabled).toBe(false);
  });

  it('QR landing token skips the code step; personal code claim uses the join target', async () => {
    const token = 'a'.repeat(22);
    const claim = vi.fn(async () => ({
      status: 'pending' as const,
      participantId: 'p1',
      verified: false,
    }));
    const resolve = vi.fn(async () => ({
      event: {
        name: 'Gala',
        startsAt: '2026-12-20T18:00:00Z',
        defaultLocale: 'en' as const,
        joinOpen: true,
      },
      unclaimed: [{ participantId: 'p1', displayName: 'Anna' }],
    }));
    setup('/j/' + token, { resolve, claim });
    fireEvent.click(await screen.findByRole('button', { name: /Anna/ }));
    expect(resolve).toHaveBeenCalledWith({ joinToken: token });
    fireEvent.change(await screen.findByLabelText('Personal code'), {
      target: { value: 'abcdef23' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(claim).toHaveBeenLastCalledWith({
        method: 'personal_code',
        target: { joinToken: token },
        code: 'ABCDEF23',
      }),
    );
  });

  it('Join navigation clears a QR landing instead of keeping its roster on the code route', async () => {
    setup(`/j/${'a'.repeat(22)}`);
    expect(await screen.findByText('Welcome to Office Party!')).toBeTruthy();
    const join = screen.getByRole('link', { name: 'Join event' });
    expect(join.getAttribute('aria-current')).toBe('page');
    fireEvent.click(join);
    expect(await screen.findByLabelText('Event code')).toBeTruthy();
    expect(screen.queryByText('Welcome to Office Party!')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/j');
  });

  it('email claim link claims straight away and lands on /e', async () => {
    const claim = vi.fn(async () => ({
      status: 'active' as const,
      participantId: 'p1',
      verified: true,
    }));
    setup('/j/claim?token=' + 'b'.repeat(24), { claim });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/e'));
    expect(claim).toHaveBeenCalledWith({ method: 'email_link', token: 'b'.repeat(24) });
  });

  it('shows a localized error for an unknown code', async () => {
    const { ApiError } = await import('./api/client');
    setup('/j', {
      resolve: async () => {
        throw new ApiError(404, 'invalid_claim');
      },
    });
    fireEvent.change(await screen.findByLabelText('Event code'), {
      target: { value: 'ZZZZZZZZZZ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not verify that code/);
  });
});
const PUB_BOARD = {
  eventState: undefined,
  leaderboard: {
    boardKey: 'b',
    state: 'live',
    entries: [{ entryId: 'g9', label: 'Gift 9', rank: 1, tied: false }],
  },
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
    votingEndsAt: null,
    paused: false,
    counts: { participants: 7, giftsRegistered: 7 },
    me: ME,
    ...over,
  });

  it('renders own selections only, neutral non-top message with no rank/total, and sends reactions', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: eventState({ phase: 'awards' }) });
    t.snapshot('pub', { leaderboards: { boards: [PUB_BOARD.leaderboard] } });
    expect(await screen.findByText('Your picks')).toBeTruthy();
    expect(screen.getByText('Your pick')).toBeTruthy();
    expect(screen.getByText(/Thanks for playing/)).toBeTruthy();
    expect(screen.getByTestId('podium').textContent).toContain('Gift 9');
    expect(document.body.textContent).not.toMatch(/rank|total|points|score/i);
    fireEvent.click(screen.getByRole('button', { name: 'Applause' }));
    expect(t.sock.sent).toContainEqual(['reaction.send', { kind: 'applause' }]);
  });

  it('redirects to join when a reload has no participant session', async () => {
    const { ApiError } = await import('./api/client');
    setup('/e', {
      state: async () => {
        throw new ApiError(401, 'unauthenticated');
      },
    });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/j'));
  });

  it('profile edit calls the API with trimmed name and avatar', async () => {
    const updateProfile = vi.fn(async (p: { displayName?: string; avatar?: string | null }) => ({
      ...MY,
      ...p,
      avatar: p.avatar ?? null,
    }));
    const t = setup('/e', { updateProfile });
    t.snapshot('p:p1', { eventState: eventState() });
    fireEvent.change(await screen.findByLabelText('Display name'), {
      target: { value: ' Anna B ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith({ displayName: 'Anna B', avatar: 'tree' }),
    );
    expect(await screen.findByText('Saved!')).toBeTruthy();
  });

  it('reaction bar throttles with a neutral message (no error role) and never blocks', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: eventState() });
    const heart = await screen.findByRole('button', { name: 'Love' });
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

describe('display token + reaction bursts', () => {
  it('joins from a direct token URL without replacing it and consumes the display projection', async () => {
    const token = 'c'.repeat(24);
    let finishExchange: (() => void) | undefined;
    const fetchRequest = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishExchange = () => resolve(new Response(null, { status: 204 }));
        }),
    );
    vi.stubGlobal('fetch', fetchRequest);
    const t = setup(`/d/${token}`, {
      exchangeDisplayToken: httpParticipantApi.exchangeDisplayToken,
    });

    await waitFor(() =>
      expect(fetchRequest).toHaveBeenCalledWith(
        '/api/join/display',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify({ token }),
        }),
      ),
    );
    expect(screen.getByTestId('where').textContent).toBe(`/d/${token}`);
    expect(t.sock.sent).toEqual([]);

    act(() => finishExchange?.());
    expect(await screen.findByTestId('display-stage')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe(`/d/${token}`);

    act(() => t.sock.fire('connect'));
    expect(t.sock.sent).toContainEqual(['subscribe', {}]);
    t.snapshot('pub', {
      eventState: {
        role: 'display',
        eventId: 'display-event',
        name: 'Direct Display Event',
        description: null,
        theme: 'xmas',
        startsAt: '2026-12-20T18:00:00Z',
        timezone: 'UTC',
        phase: 'registration',
        paused: false,
        votingEndsAt: null,
        counts: { participants: 3, giftsRegistered: 0 },
      },
      scene: {
        scene: 'lobby',
        phase: 'registration',
        participants: 3,
        joinUrl: null,
        shortCode: null,
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Welcome to Direct Display Event' }),
    ).toBeTruthy();
  });

  it('keeps a failed token URL without subscribing or advertising readiness', async () => {
    const token = 'x'.repeat(24);
    const t = setup(`/d/${token}`, {
      exchangeDisplayToken: async () => {
        throw new Error('invalid display token');
      },
    });

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe(`/d/${token}`);
    expect(t.sock.sent).toEqual([]);
  });

  it('bare /d uses its existing session without exchanging an inferred token', async () => {
    const exchange = vi.fn(async () => undefined);
    const t = setup('/d', { exchangeDisplayToken: exchange });
    expect(await screen.findByTestId('display-stage')).toBeTruthy();
    expect(exchange).not.toHaveBeenCalled();
    act(() => t.sock.fire('connect'));
    expect(t.sock.sent).toContainEqual(['subscribe', {}]);
  });

  it('stores aggregated reaction bursts with a monotonic sequence', () => {
    const t = setup('/d');
    act(() => {
      t.sock.fire('connect');
      t.sock.fire('reaction', { kind: 'wow', count: 3 });
      t.sock.fire('reaction', { kind: 'love', count: 1 });
    });
    expect(t.rt.store.getState().reactions.map((r) => [r.kind, r.count, r.seq])).toEqual([
      ['wow', 3, 1],
      ['love', 1, 2],
    ]);
  });
});
