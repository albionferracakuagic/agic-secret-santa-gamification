import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { App } from './App';
import { usePrefs } from './prefs/store';

type Route = (url: string, init?: RequestInit) => { status?: number; body?: unknown } | undefined;
let calls: Array<{ url: string; init?: RequestInit }> = [];

function mockApi(routes: Route) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      const r = routes(url, init) ?? { status: 404, body: { error: { code: 'not_found' } } };
      const status = r.status ?? 200;
      return { ok: status < 400, status, json: async () => r.body } as Response;
    }),
  );
}

const renderAt = (path: string) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const ME = { userId: 'u1', email: 'o@example.test', isPlatformAdmin: false };
const autopilotState = (
  status: 'idle' | 'running' | 'held' | 'done',
  stepEndsAt: string | null = null,
) => ({
  status,
  step: status === 'idle' || status === 'done' ? null : 'opening',
  seq: status === 'idle' ? 0 : 1,
  stepEndsAt,
  startedAt: status === 'idle' ? null : '2026-12-20T17:00:00.000Z',
  heldAt: status === 'held' ? '2026-12-20T17:01:00.000Z' : null,
  remainingMsAtHold: status === 'held' ? 10_000 : null,
  timeline: stepEndsAt
    ? [{ step: 'opening', plannedSeconds: 60, eta: stepEndsAt, status: 'active' }]
    : [],
  log: [],
});
const autopilotResponse = (state: ReturnType<typeof autopilotState>) => ({
  settings: { preset: 'standard', includeExtras: true },
  timings: {
    openingGiftSeconds: 40,
    votingMinutes: 5,
    gamesMinutes: 10,
    revealGiftSeconds: 20,
    interludeSeconds: 10,
  },
  state,
});
const state = (over: Record<string, unknown> = {}, warnings: string[] = []) => ({
  role: 'organizer_masked',
  eventState: {
    name: 'Office Party',
    phase: 'registration',
    paused: false,
    counts: { participants: 3, giftsRegistered: 0 },
    organizer: { roster: { unclaimed: 1, pending: 0, active: 3, removed: 0 }, warnings },
    ...over,
  },
});

beforeEach(async () => {
  await i18n.changeLanguage('en');
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' });
});
afterEach(() => vi.unstubAllGlobals());

describe('routes', () => {
  it.each([
    ['/e', 'Participant app'],
    ['/d', 'Public display'],
    ['/j', 'Join event'],
    ['/unknown', 'Join event'],
  ])('renders %s', async (path, heading) => {
    mockApi(() => undefined);
    renderAt(path);
    // first render lazy-loads the page chunk (cold module transform in CI can exceed the 1s default)
    expect(await screen.findByRole('heading', { name: heading }, { timeout: 5000 })).toBeTruthy();
  });

  it('shell: skip link first in tab order, single main landmark, lang follows locale', async () => {
    mockApi(() => undefined);
    renderAt('/j');
    await screen.findByRole('heading', { name: 'Join event' });
    expect(document.querySelector('a')?.getAttribute('href')).toBe('#main');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(document.documentElement.lang).toBe('en');
    await act(() => i18n.changeLanguage('it'));
    expect(await screen.findByRole('heading', { name: "Unisciti all'evento" })).toBeTruthy();
    expect(document.documentElement.lang).toBe('it');
  });

  it('has no detectable a11y violations (axe, excluding jsdom-unsupported contrast)', async () => {
    mockApi(() => undefined);
    const { container } = renderAt('/j');
    await screen.findByRole('heading', { name: 'Join event' });
    const res = await axe.run(container.ownerDocument.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('organizer sign-in', () => {
  it('redirects signed-out organizers, sends a magic link, shows provider buttons only when enabled', async () => {
    mockApi((url) => {
      if (url === '/api/organizer/me')
        return { status: 401, body: { error: { code: 'unauthenticated' } } };
      if (url === '/api/config') return { body: { providers: { google: true, microsoft: false } } };
      if (url === '/api/auth/sign-in/magic-link') return { body: { status: true } };
    });
    renderAt('/o');
    expect(await screen.findByRole('heading', { name: 'Organizer sign-in' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Google' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Microsoft' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'o@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send me a sign-in link' }));
    expect(await screen.findByText(/sent you a sign-in link/)).toBeTruthy();
    const post = calls.find((c) => c.url === '/api/auth/sign-in/magic-link')!;
    expect(JSON.parse(post.init!.body as string)).toEqual({
      email: 'o@example.test',
      callbackURL: '/o',
    });
  });
});

describe('organizer dashboard + console', () => {
  it('dashboard renders embedded autopilot states, phase, and a live next-step ETA', async () => {
    const eta = new Date(Date.now() + 65_000).toISOString();
    mockApi((url) => {
      if (url === '/api/organizer/me') return { body: ME };
      if (url === '/api/events')
        return {
          body: {
            events: [
              {
                id: 'idle',
                name: 'Idle event',
                startsAt: eta,
                phase: 'preparation',
                autopilot: autopilotState('idle'),
              },
              {
                id: 'running',
                name: 'Running event',
                startsAt: eta,
                phase: 'gift_opening',
                autopilot: autopilotState('running', eta),
              },
              {
                id: 'held',
                name: 'Held event',
                startsAt: eta,
                phase: 'voting',
                autopilot: autopilotState('held'),
              },
              {
                id: 'done',
                name: 'Done event',
                startsAt: eta,
                phase: 'awards',
                autopilot: autopilotState('done'),
              },
            ],
          },
        };
    });
    renderAt('/o');
    expect(await screen.findByText('Idle')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Held')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Gift opening')).toBeTruthy();
    expect(screen.getByText(/Next step in 1m(?: 5s| 4s)/)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith('/autopilot'))).toHaveLength(0);
  });

  it('dashboard fetches autopilot only for show phases when list data is absent', async () => {
    mockApi((url) => {
      if (url === '/api/organizer/me') return { body: ME };
      if (url === '/api/events')
        return {
          body: {
            events: [
              { id: 'prep', name: 'Prep', startsAt: '2026-12-20', phase: 'preparation' },
              { id: 'registration', name: 'Registration', startsAt: '2026-12-20', phase: 'registration' },
              { id: 'gift', name: 'Gifts', startsAt: '2026-12-20', phase: 'gift_registration' },
              { id: 'show', name: 'Show', startsAt: '2026-12-20', phase: 'reveal' },
              { id: 'complete', name: 'Complete', startsAt: '2026-12-20', phase: 'completed' },
            ],
          },
        };
      if (url === '/api/events/show/autopilot')
        return { body: autopilotResponse(autopilotState('running')) };
    });
    renderAt('/o');
    expect(await screen.findByText('Running')).toBeTruthy();
    expect(screen.getAllByText('Manual')).toHaveLength(4);
    expect(calls.filter((c) => c.url.endsWith('/autopilot')).map((c) => c.url)).toEqual([
      '/api/events/show/autopilot',
    ]);
  });

  it('dashboard hides failed and unauthorized autopilot API details', async () => {
    mockApi((url) => {
      if (url === '/api/organizer/me') return { body: ME };
      if (url === '/api/events')
        return {
          body: {
            events: [
              { id: 'failed', name: 'Failed', startsAt: '2026-12-20', phase: 'gift_opening' },
              { id: 'invalid', name: 'Invalid', startsAt: '2026-12-20', phase: 'awards' },
            ],
          },
        };
      if (url === '/api/events/failed/autopilot')
        return { status: 500, body: { error: { code: 'secret_internal_failure' } } };
      if (url === '/api/events/invalid/autopilot')
        return {
          body: {
            ...autopilotResponse(autopilotState('running')),
            unauthorizedProjection: 'private giver identity',
          },
        };
    });
    renderAt('/o');
    await waitFor(() => expect(screen.getAllByText('Status unavailable')).toHaveLength(2));
    expect(screen.queryByText(/secret_internal_failure/)).toBeNull();
    expect(screen.queryByText(/private giver identity/)).toBeNull();
  });

  it('dashboard localizes autopilot status in Italian', async () => {
    await i18n.changeLanguage('it');
    mockApi((url) => {
      if (url === '/api/organizer/me') return { body: ME };
      if (url === '/api/events')
        return {
          body: {
            events: [
              {
                id: 'held',
                name: 'Festa',
                startsAt: '2026-12-20',
                phase: 'voting',
                autopilot: autopilotState('held'),
              },
            ],
          },
        };
    });
    renderAt('/o');
    expect(await screen.findByText('In pausa')).toBeTruthy();
    expect(screen.getByText('Votazioni')).toBeTruthy();
  });

  it('creates an event (cap 100, idempotency key, browser tz)', async () => {
    mockApi((url, init) => {
      if (url === '/api/organizer/me') return { body: ME };
      if (url === '/api/events' && init?.method === 'POST')
        return { status: 201, body: { id: 'e1' } };
      if (url === '/api/events') return { body: { events: [] } };
    });
    renderAt('/o');
    expect(await screen.findByText('No events yet. Create your first one!')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'Team Party' } });
    fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '2026-12-20T18:00' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create event' })[0]!);
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.init?.method === 'POST')!;
    const body = JSON.parse(post.init!.body as string);
    expect(body).toMatchObject({ name: 'Team Party', maxParticipants: 100 });
    expect((post.init!.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
  });

  it('console shows phase, roster warning, and drives next/back/pause; API errors are localized', async () => {
    let fail = false;
    mockApi((url, init) => {
      if (url === '/api/organizer/me') return { body: ME };
      if (url === '/api/events/e1/organizer-state')
        return { body: state({}, ['roster_below_voter_floor']) };
      if (url === '/api/events/e1/phase' && init?.method === 'POST') {
        return fail
          ? { status: 409, body: { error: { code: 'pairing_not_ready' } } }
          : { body: { phase: 'gift_registration' } };
      }
      if (url === '/api/events/e1/pause') return { body: { paused: true } };
    });
    renderAt('/o/events/e1');
    expect(await screen.findByRole('heading', { name: 'Office Party' })).toBeTruthy();
    expect(screen.getByText(/fewer than 5 participants/)).toBeTruthy();
    expect(screen.getByText(/3 joined/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to: Preparation' })).toBeTruthy();

    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Next: Gift registration' }));
    expect(await screen.findByText(/Upload and finish the pairing list/)).toBeTruthy();
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/phase'))!.init!.body as string)).toEqual({
      to: 'gift_registration',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pause event' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/pause'))).toBe(true));
  });

  it('voting phase offers skip-games straight to reveal', async () => {
    mockApi((url) => {
      if (url === '/api/organizer/me') return { body: ME };
      if (url === '/api/events/e1/organizer-state') return { body: state({ phase: 'voting' }) };
    });
    renderAt('/o/events/e1');
    expect(await screen.findByRole('button', { name: 'Skip games, go to reveal' })).toBeTruthy();
  });
});

describe('prefs panel', () => {
  it('persists sound/intensity prefs; sound and music default to off (opt-in)', async () => {
    mockApi(() => undefined);
    renderAt('/j');
    await screen.findByRole('heading', { name: 'Join event' });
    expect(usePrefs.getState()).toMatchObject({ sound: false, music: false });
    fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));
    fireEvent.change(screen.getByLabelText('Animation intensity'), { target: { value: 'low' } });
    expect(usePrefs.getState().intensity).toBe('low');
    expect(JSON.parse(localStorage.getItem('sg.prefs')!).state.intensity).toBe('low');
  });
});
