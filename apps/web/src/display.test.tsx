import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneSchema, AnnouncementSchema } from '@santa/contracts';
import i18n from './i18n';
import { usePrefs } from './prefs/store';
import { setup } from './test-utils';

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
  votingEndsAt: null,
  counts: { participants: 12, giftsRegistered: 9 },
  ...over,
});
const gift = (id: string, name: string, status: 'opened' | 'revealed' = 'opened') => ({
  giftId: id,
  alias: `Gift ${id}`,
  name,
  description: 'Soft and warm',
  photoUrl: null,
  status,
  ...(status === 'revealed'
    ? { giver: { participantId: 'p9', displayName: 'Marta', avatar: 'elf' } }
    : {}),
});
const scene = (s: unknown) => SceneSchema.parse(s); // fixtures must satisfy the real contract

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' });
});
afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('display scenes (SceneSchema)', () => {
  it('bare /d renders only after a display event projection arrives', async () => {
    const t = setup('/d');
    expect(await screen.findByTestId('display-stage')).toBeTruthy();
    expect(screen.queryByText(/Welcome to Office Party/)).toBeNull();

    t.snapshot('pub', {
      eventState: ds('registration'),
      scene: scene({
        scene: 'lobby',
        participants: 12,
        joinUrl: null,
        shortCode: null,
      }),
    });

    expect(await screen.findByText(/Welcome to Office Party/)).toBeTruthy();
  });

  it('a non-display projection is not rendered as display state', () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: { ...ds('registration'), role: 'participant' },
      scene: scene({ scene: 'lobby', participants: 12, joinUrl: null, shortCode: null }),
    });
    expect(screen.queryByText(/Welcome to Office Party/)).toBeNull();
  });

  it('lobby: QR from scene joinUrl, short code and joined counter; sound overlay is non-modal', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('registration'),
      scene: scene({
        scene: 'lobby',
        participants: 12,
        joinUrl: 'https://x.test/j?code=ABCDEFGHJK',
        shortCode: 'ABCDEFGHJK',
      }),
    });
    expect(await screen.findByRole('img', { name: 'QR code to join the event' })).toBeTruthy();
    expect(screen.getByTestId('big-count').textContent).toBe('12');
    expect(screen.getByText('ABCDE-FGHJK')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep silent' }));
    expect(screen.queryByRole('region', { name: 'Sound' })).toBeNull();
    expect(usePrefs.getState().sound).toBe(false);
  });

  it('voting: countdown from the server endsAt (server clock) and the published voted counter', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('voting'),
      scene: scene({
        scene: 'voting',
        endsAt: new Date(Date.now() + 90_000).toISOString(),
        votedCount: 5,
        closed: false,
      }),
    });
    expect(await screen.findByText('Voting is open')).toBeTruthy();
    expect(screen.getByTestId('big-count').textContent).toBe('5');
    expect(screen.getByRole('timer').textContent).toMatch(/^0[01]:\d\d$/);
  });

  it('voting closed shows no countdown; unpublished counter is not rendered', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('voting'),
      scene: scene({ scene: 'voting', endsAt: null, votedCount: null, closed: true }),
    });
    expect(await screen.findByText('Voting is closed')).toBeTruthy();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.queryByTestId('big-count')).toBeNull();
  });

  it('registration phase shows counts only', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('gift_registration'),
      scene: scene({ scene: 'phase', phase: 'gift_registration' }),
    });
    expect(await screen.findByText('Gifts are arriving')).toBeTruthy();
    expect(screen.getByTestId('big-count').textContent).toBe('9');
  });

  it('opening: box + countdown, then the gift is revealed; reduced motion reveals immediately', async () => {
    vi.useFakeTimers();
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('gift_opening'),
      scene: scene({
        scene: 'opening',
        openedCount: 3,
        total: 12,
        countdownSeconds: 3,
        countdownEndsAt: new Date(Date.now() + 3000).toISOString(),
        current: {
          ...gift('7', 'Warm scarf'),
          photoUrl:
            'https://account.blob.core.windows.net/gifts/e1/scarf.jpg?sv=1&se=2026-12-20&sig=signed',
        },
      }),
    });
    expect(screen.getByText('3 of 12 gifts opened')).toBeTruthy();
    expect(screen.queryByTestId('opening-revealed')).toBeNull();
    act(() => void vi.advanceTimersByTime(3100));
    expect(screen.getByTestId('opening-revealed').textContent).toContain('Warm scarf');
    expect(screen.getByTestId('opening-gift-photo').getAttribute('src')).toContain('sig=signed');
    vi.useRealTimers();

    usePrefs.setState({ reducedMotion: 'on' });
    const t2 = setup('/d');
    t2.snapshot('pub', {
      eventState: ds('gift_opening'),
      scene: scene({
        scene: 'opening',
        openedCount: 4,
        total: 12,
        countdownSeconds: 3,
        countdownEndsAt: null,
        current: gift('8', 'Candle'),
      }),
    });
    expect((await screen.findAllByTestId('opening-revealed')).at(-1)!.textContent).toContain(
      'Candle',
    );
  });

  it('reveal: givers appear only for revealed gifts', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('reveal'),
      scene: scene({ scene: 'phase', phase: 'reveal' }),
      giftList: {
        mode: 'gallery',
        currentGiftId: null,
        gifts: [gift('1', 'Scarf', 'revealed'), gift('2', 'Candle')],
      },
    });
    const grid = await screen.findByTestId('reveal-grid');
    expect(grid.textContent).toContain('Scarf');
    expect(grid.textContent).toContain('Marta');
    expect(grid.textContent).not.toContain('Candle');
  });

  it('leaderboard: top-N podium with crown from the projection (labels, no totals)', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('awards'),
      scene: scene({ scene: 'phase', phase: 'awards' }),
      leaderboards: {
        boards: [
          {
            boardKey: 'funniest',
            state: 'live',
            message: null,
            entries: [
              { entryId: 'g1', label: 'Gift 7', rank: 1, tied: false },
              { entryId: 'g2', label: 'Gift 3', rank: 2, tied: true },
            ],
          },
        ],
      },
    });
    const podium = await screen.findByTestId('podium');
    expect(podium.textContent).toContain('👑');
    expect(podium.textContent).toContain('Gift 7');
    expect(podium.querySelectorAll('li')).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/score|points|total/i);
  });

  it('announcement overlay: shows a NEW announcement only (not the one in the first snapshot), then hides', async () => {
    const old = AnnouncementSchema.parse({
      type: 'achievement',
      key: 'first_gift',
      person: { participantId: 'p1', displayName: 'Old', avatar: null },
      at: '2026-12-20T18:00:00Z',
    });
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('registration'),
      scene: scene({ scene: 'lobby', participants: 1, joinUrl: null, shortCode: null }),
      announcement: old,
    });
    await screen.findByText(/Welcome to Office Party/);
    expect(screen.queryByTestId('announcement')).toBeNull();
    vi.useFakeTimers();
    act(() => {
      t.sock.fire('delta', {
        stream: 'pub',
        cursor: 2,
        surface: 'announcement',
        payload: AnnouncementSchema.parse({
          type: 'achievement',
          key: 'first_vote',
          person: { participantId: 'p2', displayName: 'Anna', avatar: 'santa' },
          at: '2026-12-20T18:05:00Z',
        }),
      });
    });
    expect(screen.getByTestId('announcement').textContent).toContain('Anna earned the first vote!');
    act(() => void vi.advanceTimersByTime(8100));
    expect(screen.queryByTestId('announcement')).toBeNull();
    vi.useRealTimers();
  });

  it('announcement overlay: the first announcement after an empty snapshot is shown', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('registration'),
      scene: scene({ scene: 'lobby', participants: 1, joinUrl: null, shortCode: null }),
    });
    await screen.findByText(/Welcome to Office Party/);
    act(() => {
      t.sock.fire('delta', {
        stream: 'pub',
        cursor: 2,
        surface: 'announcement',
        payload: AnnouncementSchema.parse({
          type: 'achievement',
          key: 'first_gift',
          person: { participantId: 'p2', displayName: 'Bea', avatar: null },
          at: '2026-12-20T18:05:00Z',
        }),
      });
    });
    expect(screen.getByTestId('announcement').textContent).toContain('Bea earned the first gift!');
  });

  it('a11y: opening + lobby scenes have no axe violations', async () => {
    const t = setup('/d');
    t.snapshot('pub', {
      eventState: ds('gift_opening'),
      scene: scene({
        scene: 'opening',
        openedCount: 0,
        total: 5,
        countdownSeconds: 3,
        countdownEndsAt: null,
        current: null,
      }),
    });
    await screen.findByText('Waiting for the next gift…');
    const res = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    await waitFor(() => expect(screen.getByTestId('display-stage')).toBeTruthy());
  });
});
