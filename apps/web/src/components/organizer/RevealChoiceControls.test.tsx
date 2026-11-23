import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { RevealChoiceControls } from './RevealChoiceControls';

afterEach(() => vi.unstubAllGlobals());

it('waits for host state, sends one start request, and cancels without a winner', async () => {
  await i18n.changeLanguage('en');
  const endsAt = new Date(Date.now() + 10_000).toISOString();
  let state: unknown = { lights: 8, choice: null, effect: null };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.endsWith('/choice')) {
      state = {
        lights: 8,
        choice: { status: 'open', round: 1, endsAt, result: null },
        effect: null,
      };
    } else if (init?.method === 'POST' && url.endsWith('/choice/cancel')) {
      state = {
        lights: 8,
        choice: { status: 'closed', round: 1, endsAt, result: 'none' },
        effect: null,
      };
    }
    return new Response(JSON.stringify(state));
  });
  vi.stubGlobal('fetch', fetch);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RevealChoiceControls eventId="e1" paused={false} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('button')).toBeNull();
  const start = await screen.findByRole('button', { name: 'Start effect vote' });
  fireEvent.click(start);
  fireEvent.click(start);
  const cancel = await screen.findByRole('button', { name: 'Cancel effect vote' });
  await waitFor(() => expect(cancel.getAttribute('aria-disabled')).toBe('false'));
  fireEvent.click(cancel);
  expect(await screen.findByText('No effect selected.')).toBeTruthy();
  const actions = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(actions.map(([url]) => url)).toEqual([
    '/api/events/e1/reveal/choice',
    '/api/events/e1/reveal/choice/cancel',
  ]);
  expect(
    actions.every(([, init]) => !!(init?.headers as Record<string, string>)['idempotency-key']),
  ).toBe(true);
});
