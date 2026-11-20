import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAIRING_FIELDS, PAIRING_ISSUE_CODES, REACTION_KINDS } from '@santa/contracts';
import i18n from './i18n';
import { en } from './i18n/en';
import { it as itLocale } from './i18n/it';
import { App } from './App';
import { OrganizerApiProvider, type OrganizerApi, type PairingImportResult } from './api/organizer';
import { ParticipantApiProvider, type ParticipantApi } from './api/participant';
import { RealtimeProvider } from './realtime/react';
import { createRealtimeStore } from './realtime/store';

const baseResult: PairingImportResult = {
  importId: null,
  status: 'needs_mapping',
  detected: { format: 'csv', delimiter: ',', encoding: 'utf-8' },
  sheets: ['Draw', 'Other'],
  sheet: 'Draw',
  columns: ['Chi regala', 'Chi riceve', 'Notes'],
  suggestedMapping: { giverName: 'Chi regala', recipientName: 'Chi riceve' },
  mapping: null,
  summary: null,
  issues: [],
  issuesTruncated: false,
};

function fakeApi(over: Partial<OrganizerApi> = {}): OrganizerApi {
  return {
    uploadPairing: vi.fn(async () => baseResult),
    latestPairing: async () => ({ import: null, reimportAllowed: true }),
    createAccess: vi.fn(),
    claimCodes: vi.fn(async () => ({
      codes: [{ participantId: 'p2', displayName: 'Bruno', code: 'ABCD2345EF' }],
    })),
    sendEmailLinks: vi.fn(async () => ({ sent: 3 })),
    listRoster: async () => ({
      participants: [
        { participantId: 'p1', displayName: 'Anna', status: 'pending', reactionsMuted: false },
        { participantId: 'p3', displayName: 'Carla', status: 'active', reactionsMuted: false },
      ],
    }),
    approve: vi.fn(async () => undefined),
    setReactionsEnabled: vi.fn(async () => undefined),
    muteParticipant: vi.fn(async () => undefined),
    openingState: vi.fn(async () => ({
      mode: 'random' as const,
      openedCount: 0,
      total: 3,
      currentGiftId: null,
      countdownSeconds: 3,
      countdownEndsAt: null,
      allOpened: false,
    })),
    openingNext: vi.fn(async () => ({
      mode: 'random' as const,
      openedCount: 1,
      total: 3,
      currentGiftId: 'g1',
      countdownSeconds: 3,
      countdownEndsAt: null,
      allOpened: false,
    })),
    openingOrder: vi.fn(async () => ({
      mode: 'manual' as const,
      openedCount: 0,
      total: 3,
      currentGiftId: null,
      countdownSeconds: 3,
      countdownEndsAt: null,
      allOpened: false,
    })),
    listGifts: async () => [
      {
        giftId: 'g1',
        alias: 'Gift 1',
        name: 'Scarf',
        description: null,
        photoUrl: null,
        status: 'registered' as const,
        hidden: false,
      },
      {
        giftId: 'g2',
        alias: 'Gift 2',
        name: 'Mug',
        description: null,
        photoUrl: null,
        status: 'registered' as const,
        hidden: false,
      },
    ],
    openVoting: vi.fn(async () => ({
      status: 'open' as const,
      endsAt: null,
      votedCount: null,
      categories: [],
    })),
    closeVoting: vi.fn(async () => ({ categoriesLocked: 2, categoriesPublishable: 1 })),
    revealGift: vi.fn(async () => undefined),
    revealAll: vi.fn(async () => ({ revealed: 2 })),
    ...over,
  };
}

function mount(org: OrganizerApi, phase = 'registration', tab = 'setup') {
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
                phase,
                paused: false,
                counts: { participants: 3, giftsRegistered: 0 },
                organizer: {
                  roster: { unclaimed: 1, pending: 1, active: 1, removed: 0 },
                  warnings: [],
                },
              },
            };
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  const rt = createRealtimeStore();
  const noop = {} as ParticipantApi;
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ParticipantApiProvider value={noop}>
        <RealtimeProvider factory={() => rt}>
          <OrganizerApiProvider value={org}>
            <MemoryRouter initialEntries={[`/o/events/e1?tab=${tab}`]}>
              <App />
            </MemoryRouter>
          </OrganizerApiProvider>
        </RealtimeProvider>
      </ParticipantApiProvider>
    </QueryClientProvider>,
  );
}

const csv = () => new File(['a,b\n1,2'], 'draw.csv', { type: 'text/csv' });

beforeEach(() => i18n.changeLanguage('en'));
afterEach(() => vi.unstubAllGlobals());

describe('organizer console: pairing wizard', () => {
  it('upload -> mapping with suggestions -> draft with masked, row-numbered issues (no pairs)', async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce(baseResult)
      .mockResolvedValueOnce({
        ...baseResult,
        importId: 'i1',
        status: 'draft',
        mapping: baseResult.suggestedMapping,
        summary: { rows: 4, matchedRoster: 3, newRosterEntries: 1, errors: 2, warnings: 1 },
        issues: [
          { row: 3, severity: 'error', code: 'self_pair' },
          { row: 5, severity: 'error', code: 'ambiguous_name' },
          { row: null, severity: 'warning', code: 'recipient_none', count: 2 },
        ],
      });
    mount(fakeApi({ uploadPairing: upload }));
    const input = await screen.findByLabelText('Upload CSV or Excel file');
    fireEvent.change(input, { target: { files: [csv()] } });
    expect(await screen.findByLabelText('Giver name')).toBeTruthy();
    expect((screen.getByLabelText('Giver name') as HTMLSelectElement).value).toBe('Chi regala');
    expect((screen.getByLabelText('Recipient name') as HTMLSelectElement).value).toBe('Chi riceve');
    fireEvent.click(screen.getByRole('button', { name: 'Use these columns' }));
    const status = await screen.findByTestId('pairing-status');
    expect(status.textContent).toContain('Draft');
    expect(status.textContent).toContain('Row 3: giver and recipient are the same person');
    expect(status.textContent).toContain('Row 5: name matches several people');
    expect(status.textContent).toContain('2 people receive no gift');
    expect(upload).toHaveBeenLastCalledWith('e1', expect.any(File), {
      sheet: 'Draw',
      mapping: { giverName: 'Chi regala', recipientName: 'Chi riceve' },
    });
  });

  it('shows ready status and locks re-import after gift opening', async () => {
    mount(
      fakeApi({
        latestPairing: async () => ({
          reimportAllowed: false,
          import: {
            importId: 'i1',
            status: 'ready',
            fileName: 'x.csv',
            createdAt: '2026-12-01T10:00:00Z',
            summary: { rows: 4, matchedRoster: 4, newRosterEntries: 0, errors: 0, warnings: 0 },
            issues: [],
          },
        }),
      }),
    );
    expect(await screen.findByText(/Ready: the pairing list is complete/)).toBeTruthy();
    expect(screen.getByText(/can no longer be replaced/)).toBeTruthy();
    expect(screen.queryByLabelText('Upload CSV or Excel file')).toBeNull();
  });
});

describe('organizer console: approvals and reactions', () => {
  it('approves pending, exports codes once and emails links', async () => {
    const org = fakeApi();
    mount(org, 'registration', 'people');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Anna' }));
    await waitFor(() => expect(org.approve).toHaveBeenCalledWith('e1', 'p1'));
    fireEvent.click(screen.getByRole('button', { name: 'Create claim codes' }));
    expect(await screen.findByText('ABCD2345EF')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Email claim links' }));
    expect(await screen.findByText('3 links sent')).toBeTruthy();
  });

  it('turns reactions off and mutes one participant', async () => {
    const org = fakeApi();
    mount(org);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn reactions off' }));
    expect(await screen.findByText('Reactions are off.')).toBeTruthy();
    expect(org.setReactionsEnabled).toHaveBeenCalledWith('e1', false);
    const row = (await screen.findAllByText('Carla', { selector: 'li > span' }))[0]!.closest('li')!;
    fireEvent.click(within(row).getByRole('button'));
    await waitFor(() => expect(org.muteParticipant).toHaveBeenCalledWith('e1', 'p3', true));
  });

  it('a11y: console with new panels has no axe violations', async () => {
    mount(fakeApi());
    await screen.findByLabelText('Upload CSV or Excel file');
    const res = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('organizer console: opening, voting, reveal', () => {
  it('opening: next gift, progress, manual order saved as a permutation of unopened gifts', async () => {
    const org = fakeApi();
    mount(org, 'gift_opening', 'show');
    expect(await screen.findByText('0 of 3 gifts opened')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open next gift' }));
    await waitFor(() => expect(org.openingNext).toHaveBeenCalledWith('e1'));
    fireEvent.click(screen.getByLabelText('Manual order'));
    fireEvent.click(await screen.findByRole('button', { name: 'Move down Gift 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    await waitFor(() =>
      expect(org.openingOrder).toHaveBeenCalledWith('e1', { mode: 'manual', order: ['g2', 'g1'] }),
    );
  });

  it('voting: opens with a timer from the opening phase', async () => {
    const org = fakeApi();
    mount(org, 'gift_opening', 'show');
    fireEvent.change(await screen.findByLabelText('Voting time (minutes)'), {
      target: { value: '15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open voting' }));
    await waitFor(() => expect(org.openVoting).toHaveBeenCalledWith('e1', 15));
  });

  it('voting: closes and reports locked/publishable categories', async () => {
    const org = fakeApi();
    mount(org, 'voting', 'show');
    fireEvent.click(await screen.findByRole('button', { name: 'Close voting' }));
    expect(await screen.findByText('2 categories locked, 1 can be published.')).toBeTruthy();
  });

  it('reveal: per gift and all at once, aliases only', async () => {
    const org = fakeApi();
    mount(org, 'reveal', 'show');
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal giver Gift 1' }));
    await waitFor(() => expect(org.revealGift).toHaveBeenCalledWith('e1', 'g1'));
    fireEvent.click(screen.getByRole('button', { name: 'Reveal all givers' }));
    expect(await screen.findByText('2 givers revealed.')).toBeTruthy();
  });
});

describe('EN/IT parity against contract enums', () => {
  it.each([
    ['en', en],
    ['it', itLocale],
  ] as const)('%s covers every pairing issue code, field and reaction kind', (_n, loc) => {
    for (const c of PAIRING_ISSUE_CODES) expect(loc.pairing.issue).toHaveProperty(c);
    for (const f of PAIRING_FIELDS) expect(loc.pairing.field).toHaveProperty(f);
    for (const k of REACTION_KINDS) expect(loc.reactions.kind).toHaveProperty(k);
    expect(Object.keys(loc.reactions.kind)).toHaveLength(6);
  });
});
