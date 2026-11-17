import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { App } from './App';
import { Markdown, splitLegal } from './components/Markdown';
import { ME, mountConsole, setup } from './test-utils';

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
});

const grant = () => ({
  grantId: 'gr1',
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  banner: true as const,
});

describe('organizer admin', () => {
  it('stats: counts only', async () => {
    mountConsole({
      phase: 'voting',
      admin: {
        stats: async () => ({
          phase: 'voting',
          paused: false,
          participants: { unclaimed: 1, pending: 0, active: 9, removed: 0 },
          gifts: { registered: 9, opened: 9, revealed: 0, hidden: 1 },
          voting: { status: 'open', votedCount: 4, round: 1 },
          ceremony: 'idle',
          reactionsEnabled: true,
        }),
      },
    });
    const stats = await screen.findByTestId('stats');
    expect(stats.textContent).toContain('active 9');
    expect(stats.textContent).toContain('9 registered · 9 opened · 0 revealed · 1 hidden');
    expect(stats.textContent).toContain('4 people have voted');
  });

  it('unmask: needs a reason (8+) and confirmation, shows the persistent banner, integrity details only while unmasked, then ends', async () => {
    const unmask = vi.fn(async () => grant());
    const revokeUnmask = vi.fn(async () => undefined);
    const integrityDetails = vi.fn(async () => ({
      items: [
        {
          anomaly: 'vote_for_own_gift' as const,
          boardKey: 'funniest',
          voterId: 'p3',
          giftId: 'g9',
          at: '2026-12-20T20:00:00Z',
        },
      ],
    }));
    mountConsole({
      phase: 'voting',
      admin: {
        unmask,
        revokeUnmask,
        integrityDetails,
        integrity: async () => ({
          round: 1,
          categories: [{ boardKey: 'funniest', voters: 4, belowPrivacyFloor: true }],
          anomalies: {
            vote_from_inactive_participant: 0,
            vote_for_own_gift: 1,
            vote_for_hidden_gift: 0,
            vote_for_unopened_gift: 0,
          },
          clean: false,
        }),
      },
    });
    expect(await screen.findByText('Some anomalies need review.')).toBeTruthy();
    expect(screen.getByText('Vote for own gift: 1')).toBeTruthy();
    const details = screen.getByRole('button', {
      name: 'Show details (needs unmask)',
    }) as HTMLButtonElement;
    expect(details.disabled).toBe(true);

    const start = screen.getByRole('button', {
      name: 'Start 10-minute unmask session',
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason (at least 8 characters)'), {
      target: { value: 'fix typo' },
    });
    expect(start.disabled).toBe(true); // not confirmed yet
    fireEvent.click(screen.getByLabelText(/this is audited/));
    fireEvent.click(start);
    await waitFor(() => expect(unmask).toHaveBeenCalledWith('e1', 'fix typo'));

    const banner = await screen.findByTestId('unmask-banner');
    expect(banner.textContent).toMatch(/UNMASKED.*(09|10):\d\d/);
    await waitFor(() => expect((details as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(details);
    await waitFor(() => expect(integrityDetails).toHaveBeenCalledWith('e1', 'gr1'));
    expect((await screen.findByTestId('integrity-details')).textContent).toContain('p3 → g9');

    fireEvent.click(within(banner).getByRole('button', { name: 'End session now' }));
    await waitFor(() => expect(revokeUnmask).toHaveBeenCalledWith('e1', 'gr1'));
    await waitFor(() => expect(screen.queryByTestId('unmask-banner')).toBeNull());
  });

  it('remove participant needs a second confirmation', async () => {
    const removeParticipant = vi.fn(async () => ({ votesRemoved: 0 }));
    mountConsole({
      phase: 'voting',
      org: {
        listRoster: async () => ({
          participants: [
            { participantId: 'p3', displayName: 'Carla', status: 'active', reactionsMuted: false },
          ],
        }),
      },
      admin: { removeParticipant },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Carla' }));
    expect(removeParticipant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: remove Carla' }));
    await waitFor(() => expect(removeParticipant).toHaveBeenCalledWith('e1', 'p3'));
  });

  it('gift moderation by alias: hide and remove photo; no giver shown', async () => {
    const moderateGift = vi.fn(async () => undefined);
    mountConsole({
      phase: 'voting',
      org: {
        listGifts: async () => [
          {
            giftId: 'g1',
            alias: 'Gift 1',
            name: 'Scarf',
            description: null,
            photoUrl: 'https://cdn/x.jpg',
            status: 'opened',
            hidden: false,
          },
        ],
      },
      admin: { moderateGift },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Hide Gift 1' }));
    await waitFor(() => expect(moderateGift).toHaveBeenCalledWith('e1', 'g1', { hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo Gift 1' }));
    await waitFor(() =>
      expect(moderateGift).toHaveBeenCalledWith('e1', 'g1', { removePhoto: true }),
    );
  });

  it('audit viewer lists entries', async () => {
    mountConsole({
      admin: {
        audit: async () => [
          {
            id: 'a1',
            actor: 'org@x.test',
            action: 'unmask.start',
            target: null,
            reason: 'fix typo',
            at: '2026-12-20T20:00:00Z',
          },
        ],
      },
    });
    const table = await screen.findByTestId('audit');
    expect(table.textContent).toContain('unmask.start');
    expect(table.textContent).toContain('fix typo');
  });
});

describe('invitations', () => {
  it('creates a join link with short code and QR, and a display link', async () => {
    const createAccess = vi.fn(async (_e: string, kind: 'join' | 'display') => ({
      accessId: 'a1',
      kind,
      token: 't'.repeat(24),
      shortCode: kind === 'join' ? 'ABCDEFGHJK' : null,
      path: `/${kind === 'join' ? 'j' : 'd'}/${'t'.repeat(24)}`,
      expiresAt: '2026-12-23T18:00:00Z',
    }));
    mountConsole({ org: { createAccess } });
    fireEvent.click(await screen.findByRole('button', { name: 'Create join link and QR' }));
    const join = await screen.findByTestId('join-link');
    expect(join.textContent).toContain('ABCDE-FGHJK');
    expect(within(join).getByRole('img', { name: 'QR code to join the event' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create display link' }));
    expect((await screen.findByTestId('display-link')).textContent).toContain('/d/');
    expect(createAccess).toHaveBeenCalledWith('e1', 'display');
  });
});

describe('privacy', () => {
  it('delete-my-data: two-step confirmation then the erased summary', async () => {
    const deleteMe = vi.fn(async () => ({
      anonymized: true as const,
      erased: ['name', 'gift_photo'] as ('name' | 'gift_photo')[],
    }));
    const t = setup('/e', {}, { deleteMe, getGift: async () => ({ gift: null, editable: false }) });
    t.snapshot('p:p1', {
      eventState: {
        role: 'participant',
        eventId: 'e1',
        name: 'P',
        description: null,
        theme: 'x',
        startsAt: '2026-12-20T18:00:00Z',
        timezone: 'UTC',
        phase: 'voting',
        paused: false,
        votingEndsAt: null,
        counts: { participants: 1, giftsRegistered: 1 },
        me: ME,
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my data' }));
    expect(deleteMe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete my data' }));
    await waitFor(() => expect(deleteMe).toHaveBeenCalled());
    expect((await screen.findByTestId('erased')).textContent).toBe('NameGift photo');
  });
});

describe('credits', () => {
  it('lists attribution entries and the OFL/Apache notices, in EN and IT, from bundled text', async () => {
    render(
      <MemoryRouter initialEntries={['/credits']}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: 'Credits and licenses', level: 1 }),
    ).toBeTruthy();
    const list = screen.getByTestId('credits-list');
    expect(list.textContent).toContain('Nunito');
    expect(list.textContent).toContain('Mountains of Christmas');
    expect(screen.getByText(/SIL OPEN FONT LICENSE Version 1.1/i)).toBeTruthy();
    expect(screen.getByTestId('lottie-notice').textContent).toMatch(/No Lottie/);
    await i18n.changeLanguage('it');
    expect(
      await screen.findByRole('heading', { name: 'Crediti e licenze', level: 1 }),
    ).toBeTruthy();
  });

  it('is linked from the footer and from the settings panel', async () => {
    render(
      <MemoryRouter initialEntries={['/j']}>
        <App />
      </MemoryRouter>,
    );
    const nav = await screen.findByRole('navigation', { name: 'Legal documents' });
    expect(within(nav).getByRole('link', { name: 'Credits' }).getAttribute('href')).toBe(
      '/credits',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));
    expect(screen.getAllByRole('link', { name: 'Credits' })).toHaveLength(2);
  });
});

describe('legal pages and cookie notice', () => {
  it('renders doc/legal markdown in EN and IT as static pages with a draft banner in dev', async () => {
    render(
      <MemoryRouter initialEntries={['/legal/privacy']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Privacy notice', level: 1 })).toBeTruthy();
    expect(screen.getByText(/Who we are/)).toBeTruthy();
    expect(screen.getByTestId('legal-draft-banner').textContent).toMatch(/DRAFT/);
    expect(document.querySelector('mark[data-placeholder]')).not.toBeNull(); // placeholders flagged in dev
    await i18n.changeLanguage('it');
    expect(await screen.findByText(/Chi siamo/)).toBeTruthy();
  });

  it('cookies page lists the essential cookies table', async () => {
    render(
      <MemoryRouter initialEntries={['/legal/cookies']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText('sg_p')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Purpose' })).toBeTruthy();
  });

  it('production rendering hides the draft banner and shows placeholders as plain text', () => {
    const { preamble, en } = splitLegal(
      '# T\n\n> **DRAFT**\n\n## English\n\nSent by **[Acme Ltd]** within [90] days.\n\n## Italiano\n\nCiao',
    );
    expect(preamble).toContain('DRAFT');
    const { container } = render(<Markdown source={en} dev={false} />);
    expect(container.querySelector('mark')).toBeNull();
    expect(container.textContent).toBe('Sent by Acme Ltd within 90 days.');
  });

  it('cookie notice: essential only, dismissible and remembered', async () => {
    render(
      <MemoryRouter initialEntries={['/j']}>
        <App />
      </MemoryRouter>,
    );
    const notice = await screen.findByTestId('cookie-notice');
    expect(notice.textContent).toMatch(/only use essential cookies/);
    expect(notice.querySelector('input[type=checkbox]')).toBeNull(); // no consent toggles: nothing optional exists
    fireEvent.click(within(notice).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('cookie-notice')).toBeNull();
    expect(localStorage.getItem('sg.cookieNotice')).toBe('ack');
  });

  it('footer links to the legal pages and credits; the display has no chrome', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/j']}>
        <App />
      </MemoryRouter>,
    );
    const nav = await screen.findByRole('navigation', { name: 'Legal documents' });
    expect(within(nav).getAllByRole('link')).toHaveLength(4); // privacy, terms, cookies, credits
    unmount();
    setup('/d');
    expect(screen.queryByRole('navigation', { name: 'Legal documents' })).toBeNull();
  });
});
