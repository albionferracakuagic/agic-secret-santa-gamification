import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import {
  AutopilotSettingsSchema,
  DEFAULT_EVENT_FEATURES,
  resolveAutopilotTimings,
  type AutopilotResponse,
  type AutopilotState,
} from '@santa/contracts';
import i18n from './i18n';
import { AutopilotApiProvider, type AutopilotApi } from './api/autopilot';
import { OrganizerApiProvider } from './api/organizer';
import { LiveTab, type PhaseActions } from './components/organizer/console/LiveTab';
import { AutopilotSettingsForm } from './components/organizer/console/tabs';
import type { OrganizerEventState } from './components/organizer/console/types';
import {
  isDisplayPresenceConnected,
  publishDisplayPresence,
} from './realtime/displayPresence';
import { RealtimeProvider } from './realtime/react';
import { createRealtimeStore } from './realtime/store';
import { fakeOrganizerApi, fakeSocket } from './test-utils';

beforeEach(() => {
  localStorage.clear();
  i18n.changeLanguage('en');
  document.title = 'Secret Santa Games';
  document.documentElement.lang = 'en';
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const NOW = '2026-12-20T18:00:00.000Z';
const idle = (over: Partial<AutopilotState> = {}): AutopilotState => ({
  status: 'idle',
  step: null,
  seq: 4,
  stepEndsAt: null,
  startedAt: null,
  heldAt: null,
  remainingMsAtHold: null,
  timeline: [],
  log: [],
  ...over,
});

const state = (
  autopilot: AutopilotState,
  over: { phase?: OrganizerEventState['phase']; paused?: boolean; gifts?: number } = {},
) =>
  ({
    name: 'Office Party',
    phase: over.phase ?? 'gift_opening',
    paused: over.paused ?? false,
    counts: { participants: 12, giftsRegistered: over.gifts ?? 12 },
    organizer: {
      roster: { active: 10, pending: 2, unclaimed: 0, removed: 0 },
      warnings: [],
      features: DEFAULT_EVENT_FEATURES,
      autopilot,
    },
  }) as OrganizerEventState;

const response = (ap: AutopilotState): AutopilotResponse => {
  const settings = AutopilotSettingsSchema.parse({});
  return {
    settings,
    timings: resolveAutopilotTimings(settings),
    state: ap,
  };
};

const actions: PhaseActions = {
  go: vi.fn(),
  togglePause: vi.fn(),
  pending: false,
  error: null,
};

function renderAutopilot(
  ap: AutopilotState,
  opts: {
    eventState?: OrganizerEventState | undefined;
    api?: Partial<AutopilotApi> | undefined;
    pairingReady?: boolean | undefined;
    displayConnected?: boolean | undefined;
    organizerPubSnapshot?: boolean | undefined;
    organizerSnapshot?: { displayConnected?: boolean } | undefined;
  } = {},
) {
  const socket = fakeSocket();
  const rt = createRealtimeStore({ eventId: 'e1' });
  rt.connect(socket.s);
  if (opts.organizerPubSnapshot || opts.organizerSnapshot) {
    socket.fire('connect');
    socket.fire(
      'snapshot',
      opts.organizerPubSnapshot
        ? {
            stream: 'pub',
            cursor: 1,
            data: { eventState: { role: 'display' } },
          }
        : {
            stream: 'org',
            cursor: 1,
            data: { eventState: { organizer: opts.organizerSnapshot } },
          },
    );
  }
  if (opts.displayConnected) publishDisplayPresence('e1', 'test-display');
  const api: AutopilotApi = {
    get: vi.fn(async () => response(ap)),
    command: vi.fn(async (_eventId, command) =>
      response(
        command.action === 'hold'
          ? idle({
              status: 'held',
              step: 'opening',
              seq: ap.seq + 1,
              remainingMsAtHold: 20_000,
              heldAt: NOW,
            })
          : command.action === 'resume'
            ? idle({
                status: 'running',
                step: 'opening',
                seq: ap.seq + 1,
                stepEndsAt: '2026-12-20T18:00:40.000Z',
              })
            : { ...ap, seq: ap.seq + 1 },
      ),
    ),
    patch: vi.fn(async () => response(ap)),
    ...opts.api,
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <AutopilotApiProvider value={api}>
        <OrganizerApiProvider
          value={{
            ...fakeOrganizerApi(),
            latestPairing: async () => ({
              import: opts.pairingReady
                ? {
                    importId: 'i1',
                    status: 'ready',
                    fileName: 'pairs.csv',
                    createdAt: NOW,
                    summary: {
                      rows: 12,
                      matchedRoster: 12,
                      newRosterEntries: 0,
                      errors: 0,
                      warnings: 0,
                    },
                    issues: [],
                  }
                : null,
              reimportAllowed: false,
            }),
          }}
        >
          <RealtimeProvider factory={() => rt}>
            <MemoryRouter initialEntries={['/o/events/e1?tab=live']}>
              <Routes>
                <Route
                  path="/o/events/:eventId"
                  element={<LiveTab state={opts.eventState ?? state(ap)} actions={actions} />}
                />
              </Routes>
            </MemoryRouter>
          </RealtimeProvider>
        </OrganizerApiProvider>
      </AutopilotApiProvider>
    </QueryClientProvider>,
  );
  return { ...view, api, socket, rt, qc };
}

describe('console live autopilot', () => {
  it('gates Start Show on pairing, gifts, display, features and phase readiness', async () => {
    const ap = idle();
    const mounted = renderAutopilot(ap, {
      pairingReady: true,
      displayConnected: true,
    });
    const start = (await screen.findByRole('button', { name: 'Start Show' })) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() =>
      expect(mounted.api.command).toHaveBeenCalledWith('e1', {
        action: 'start',
        fromSeq: 4,
      }),
    );
  });

  it('does not infer display readiness from the organizer pub subscription', async () => {
    const mounted = renderAutopilot(idle(), {
      pairingReady: true,
      organizerPubSnapshot: true,
    });
    const start = (await screen.findByRole('button', { name: 'Start Show' })) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(true));
    const readiness = within(screen.getByTestId('autopilot-readiness')).getByText(
      'Display connected',
    );
    expect(readiness.parentElement?.textContent).toContain('Not ready');

    act(() => publishDisplayPresence('e1', 'actual-display'));
    await waitFor(() => expect(start.disabled).toBe(false));
    mounted.unmount();
  });

  it('uses local presence only before the initial organizer snapshot', async () => {
    publishDisplayPresence('e1', 'same-browser-display');
    const mounted = renderAutopilot(idle(), { pairingReady: true });
    const start = (await screen.findByRole('button', { name: 'Start Show' })) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    mounted.unmount();
  });

  it('accepts cross-device display presence from the organizer snapshot', async () => {
    const mounted = renderAutopilot(idle(), {
      pairingReady: true,
      organizerSnapshot: { displayConnected: true },
    });
    const start = (await screen.findByRole('button', { name: 'Start Show' })) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(isDisplayPresenceConnected('e1')).toBe(false);
    mounted.unmount();
  });

  it('lets server false override same-browser display presence', async () => {
    publishDisplayPresence('e1', 'same-browser-display');
    const mounted = renderAutopilot(idle(), {
      pairingReady: true,
      organizerSnapshot: { displayConnected: false },
    });
    const start = (await screen.findByRole('button', { name: 'Start Show' })) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(true));
    mounted.unmount();
  });

  it('tracks authoritative display presence deltas in both directions', async () => {
    const mounted = renderAutopilot(idle(), {
      pairingReady: true,
      organizerSnapshot: { displayConnected: false },
    });
    const start = (await screen.findByRole('button', { name: 'Start Show' })) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(true));

    act(() =>
      mounted.socket.fire('delta', {
        stream: 'org',
        cursor: 2,
        surface: 'eventState',
        payload: { organizer: { displayConnected: true } },
      }),
    );
    await waitFor(() => expect(start.disabled).toBe(false));

    act(() =>
      mounted.socket.fire('delta', {
        stream: 'org',
        cursor: 3,
        surface: 'eventState',
        payload: { organizer: { displayConnected: false } },
      }),
    );
    await waitFor(() => expect(start.disabled).toBe(true));
    mounted.unmount();
  });

  it('uses state-keyed controls and confirms an irreversible skip', async () => {
    const ap = idle({
      status: 'running',
      step: 'voting',
      startedAt: NOW,
      stepEndsAt: '2026-12-20T18:05:00.000Z',
      timeline: [
        {
          step: 'voting',
          plannedSeconds: 300,
          eta: '2026-12-20T18:05:00.000Z',
          status: 'active',
        },
        { step: 'games', plannedSeconds: 600, eta: null, status: 'pending' },
      ],
      log: [{ at: NOW, code: 'step_started', params: { step: 'voting' } }],
    });
    const mounted = renderAutopilot(ap, { pairingReady: true, displayConnected: true });
    await screen.findByRole('button', { name: 'Hold' });
    expect(screen.getByRole('button', { name: 'Stop autopilot' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.getByText('Voting started')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Skip current step' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Skip this timed step?' });
    expect(dialog.textContent).toContain('closes voting');
    fireEvent.click(screen.getByRole('button', { name: 'Skip now' }));
    await waitFor(() =>
      expect(mounted.api.command).toHaveBeenCalledWith('e1', {
        action: 'skip',
        fromSeq: 4,
      }),
    );
  });

  it('shows held countdown frozen by an event pause and requires resume before input', async () => {
    const ap = idle({
      status: 'held',
      step: 'opening',
      startedAt: NOW,
      heldAt: NOW,
      remainingMsAtHold: 42_000,
      timeline: [
        {
          step: 'opening',
          plannedSeconds: 120,
          eta: null,
          status: 'active',
        },
      ],
      log: [{ at: NOW, code: 'frozen_held' }],
    });
    const { eventState } = { eventState: state(ap, { paused: true }) };
    renderAutopilot(ap, { eventState });
    expect(await screen.findByTestId('autopilot-frozen')).toBeTruthy();
    const resume = screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Skip current step' })).toBeNull();
    expect(screen.getByText('Autopilot held because the event was frozen')).toBeTruthy();
  });

  it('refetches autopilot when the org:eventState surface changes', async () => {
    const ap = idle();
    const get = vi.fn(async () => response(ap));
    const mounted = renderAutopilot(ap, { api: { get } });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    act(() => {
      mounted.socket.fire('snapshot', {
        stream: 'org',
        cursor: 1,
        data: { eventState: { organizer: { autopilot: ap } } },
      });
    });
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(1));
  });

  it('renders timeline, log and controls without axe violations', async () => {
    const ap = idle({
      status: 'running',
      step: 'reveal',
      startedAt: NOW,
      stepEndsAt: '2026-12-20T18:00:40.000Z',
      timeline: [
        { step: 'opening', plannedSeconds: 400, eta: null, status: 'done' },
        {
          step: 'reveal',
          plannedSeconds: 120,
          eta: '2026-12-20T18:00:40.000Z',
          status: 'active',
        },
      ],
      log: [{ at: NOW, code: 'manual_override_resync' }],
    });
    renderAutopilot(ap);
    await screen.findByTestId('autopilot-timeline');
    const result = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('autopilot setup', () => {
  it('patches a preset and nullable timing overrides', async () => {
    const ap = idle();
    const patch: AutopilotApi['patch'] = vi.fn(async () =>
      response({
        ...ap,
        log: [],
      }),
    );
    const api: AutopilotApi = {
      get: async () => response(ap),
      command: async () => response(ap),
      patch,
    };
    const rt = createRealtimeStore({ eventId: 'e1' });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AutopilotApiProvider value={api}>
          <RealtimeProvider factory={() => rt}>
            <MemoryRouter initialEntries={['/o/events/e1?tab=setup']}>
              <Routes>
                <Route
                  path="/o/events/:eventId"
                  element={<AutopilotSettingsForm eventId="e1" state={state(ap)} />}
                />
              </Routes>
            </MemoryRouter>
          </RealtimeProvider>
        </AutopilotApiProvider>
      </QueryClientProvider>,
    );
    const preset = (await screen.findByLabelText('Pace preset')) as HTMLSelectElement;
    await waitFor(() => expect(preset.disabled).toBe(false));
    fireEvent.change(preset, {
      target: { value: 'relaxed' },
    });
    fireEvent.change(screen.getByLabelText('Opening time per gift (seconds)'), {
      target: { value: '75' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save autopilot timing' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('e1', {
        preset: 'relaxed',
        includeExtras: true,
        openingGiftSeconds: 75,
        votingMinutes: null,
        gamesMinutes: null,
        revealGiftSeconds: null,
        interludeSeconds: null,
      }),
    );
  });

  it('has no axe violations', async () => {
    const ap = idle();
    const rt = createRealtimeStore({ eventId: 'e1' });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AutopilotApiProvider
          value={{
            get: async () => response(ap),
            command: async () => response(ap),
            patch: async () => response(ap),
          }}
        >
          <RealtimeProvider factory={() => rt}>
            <MemoryRouter initialEntries={['/o/events/e1?tab=setup']}>
              <Routes>
                <Route
                  path="/o/events/:eventId"
                  element={<AutopilotSettingsForm eventId="e1" state={state(ap)} />}
                />
              </Routes>
            </MemoryRouter>
          </RealtimeProvider>
        </AutopilotApiProvider>
      </QueryClientProvider>,
    );
    await screen.findByTestId('autopilot-settings');
    const result = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
