import { fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuctionViewSchema, ParticipantAnnouncementSchema, SceneSchema } from '@santa/contracts';
import i18n from './i18n';
import { usePrefs } from './prefs/store';
import type { Phase3Api } from './api/phase3';
import { ME, mountConsole, setup } from './test-utils';

const es = (phase: string, role: 'participant' | 'display' = 'participant') => ({
  role,
  eventId: 'e1',
  name: 'Office Party',
  description: null,
  theme: 'xmas',
  startsAt: '2026-12-20T18:00:00Z',
  timezone: 'UTC',
  phase,
  paused: false,
  votingEndsAt: null,
  counts: { participants: 7, giftsRegistered: 4 },
  ...(role === 'participant' ? { me: ME } : {}),
});
const person = (id: string, name: string) => ({
  participantId: id,
  displayName: name,
  avatar: 'elf',
});
const later = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const AT = '2026-12-20T18:30:00Z';

const view = (over: Record<string, unknown> = {}) =>
  AuctionViewSchema.parse({
    prizeId: 'z1',
    title: { en: 'Mystery Box 1', it: 'Scatola Misteriosa 1' },
    status: 'open',
    endsAt: later(60),
    currentBid: 12,
    minNextBid: 13,
    winner: null,
    reveal: null,
    ...over,
  });
const myAuction = (prize: unknown, over: Record<string, unknown> = {}) =>
  ({ enabled: true, balance: 30, prize, you: { leading: false, myBid: null }, ...over }) as never;

beforeEach(async () => {
  await i18n.changeLanguage('en');
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' });
});

describe('coins (self only)', () => {
  it('shows my balance and ledger, and nothing like a leaderboard; hidden when off', async () => {
    const t = setup(
      '/e',
      {},
      {},
      {},
      {
        myCoins: async () => ({
          enabled: true,
          balance: 42,
          held: 5,
          entries: [{ reason: 'game_win' as const, amount: 10, at: AT }],
        }),
      },
    );
    t.snapshot('p:p1', { eventState: es('games') });
    expect((await screen.findByTestId('coin-balance')).textContent).toBe('Your coins: 42');
    expect(screen.getByText('On hold in your leading bid: 5')).toBeTruthy();
    expect(screen.getByText(/Won a game: \+10/)).toBeTruthy();
    expect(screen.queryByText(/leaderboard|ranking/i)).toBeNull();
  });

  it('flag off: no coins UI', async () => {
    const t = setup('/e');
    t.snapshot('p:p1', { eventState: es('games') });
    await screen.findByText('Office Party');
    expect(screen.queryByTestId('coins-panel')).toBeNull();
  });
});

describe('auction (participant)', () => {
  it('validates the bid, places it and shows leading + anti-snipe extension', async () => {
    const placeBid = vi.fn<Phase3Api['placeBid']>(async (amount) => ({
      prizeId: 'z1',
      amount,
      leading: true as const,
      endsAt: later(75),
      extended: true,
    }));
    const t = setup('/e', {}, {}, {}, { myAuction: async () => myAuction(view()), placeBid });
    t.snapshot('p:p1', { eventState: es('games') });
    t.snapshot('pub', {
      eventState: es('games', 'display'),
      scene: SceneSchema.parse({ scene: 'auction', auction: view() }),
    });
    expect((await screen.findByTestId('auction-price')).textContent).toBe('Current price: 12');
    const input = screen.getByLabelText('Your bid (coins)');
    const bid = screen.getByRole('button', { name: 'Place bid' }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: '5' } });
    expect(screen.getByText('Bid at least 13 coins.')).toBeTruthy();
    expect(bid.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '99' } });
    expect(screen.getByText('You can bid up to 30 coins.')).toBeTruthy();
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(screen.getByText('Use a whole number of coins.')).toBeTruthy();
    fireEvent.change(input, { target: { value: '15' } });
    expect(bid.disabled).toBe(false);
    fireEvent.click(bid);
    await waitFor(() => expect(placeBid).toHaveBeenCalledWith(15));
    expect(await screen.findByText(/Time extended/)).toBeTruthy();
    expect(screen.getAllByRole('timer').length).toBeGreaterThan(0);
  });

  it('"you are leading" is the only bidder info; leading disables a new bid', async () => {
    const t = setup(
      '/e',
      {},
      {},
      {},
      {
        myAuction: async () => myAuction(view(), { you: { leading: true, myBid: 12 } }),
      },
    );
    t.snapshot('p:p1', { eventState: es('games') });
    expect(await screen.findByText('You are leading! 🎉')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Place bid' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it('closed auction names the winner; after the reveal the box content appears', async () => {
    const t = setup(
      '/e',
      {},
      {},
      {},
      {
        myAuction: async () =>
          myAuction(
            view({ status: 'revealed', winner: person('p2', 'Bruno'), reveal: { en: 'A scarf' } }),
          ),
      },
    );
    t.snapshot('p:p1', { eventState: es('games') });
    expect(await screen.findByText('Winner: Bruno')).toBeTruthy();
    expect(screen.getByTestId('mystery-reveal').textContent).toContain('A scarf');
  });

  it('errors use the friendly translated code', async () => {
    const { ApiError } = await import('./api/client');
    const t = setup(
      '/e',
      {},
      {},
      {},
      {
        myAuction: async () => myAuction(view()),
        placeBid: async () => {
          throw new ApiError(409, 'bid_too_low');
        },
      },
    );
    t.snapshot('p:p1', { eventState: es('games') });
    fireEvent.change(await screen.findByLabelText('Your bid (coins)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place bid' }));
    expect(
      await screen.findByText('Your bid is too low. Check the minimum next bid.'),
    ).toBeTruthy();
  });

  it('auction_won / mystery_reveal announcements on the participant stream', async () => {
    const t = setup('/e', {}, {}, {}, { myAuction: async () => myAuction(view()) });
    t.snapshot('p:p1', { eventState: es('games') });
    await screen.findByTestId('auction-panel');
    t.snapshot('p:p1', {
      eventState: es('games'),
      announcement: ParticipantAnnouncementSchema.parse({
        type: 'mystery_reveal',
        prizeId: 'z1',
        title: { en: 'Mystery Box 1' },
        reveal: { en: 'A scarf' },
        winner: person('p2', 'Bruno'),
        cue: 'box_open',
        at: AT,
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId('achievement-unlock').textContent).toContain(
        'Mystery Box 1 opens: A scarf',
      ),
    );
  });
});

describe('display auction scene', () => {
  it('shows only the price (never bidders), the winner after close and the content after reveal', async () => {
    const t = setup('/d');
    const snap = (a: unknown) =>
      t.snapshot('pub', {
        eventState: es('games', 'display'),
        scene: SceneSchema.parse({ scene: 'auction', auction: a }),
      });
    snap(view());
    expect((await screen.findByTestId('auction-price')).textContent).toContain('12');
    expect(screen.getByTestId('auction-scene').textContent).not.toMatch(/bid(s|der)/i);
    expect(screen.getAllByRole('timer').length).toBeGreaterThan(0);
    snap(view({ status: 'closed', winner: person('p2', 'Bruno'), endsAt: null }));
    expect(await screen.findByText('Winner: Bruno')).toBeTruthy();
    snap(
      view({
        status: 'revealed',
        winner: person('p2', 'Bruno'),
        reveal: { en: 'A scarf' },
        endsAt: null,
      }),
    );
    expect((await screen.findByTestId('mystery-reveal')).textContent).toContain('A scarf');
  });
});

describe('feature flags panel (organizer)', () => {
  it('flips a switch with PATCH and shows locked states', async () => {
    const updateFeatures = vi.fn<Phase3Api['updateFeatures']>(async () => ({}) as never);
    mountConsole({ phase: 'gift_opening', p3: { updateFeatures } });
    const sw = await screen.findByRole('switch', { name: 'Guess your Secret Santa' });
    fireEvent.click(sw);
    await waitFor(() => expect(updateFeatures).toHaveBeenCalledWith('e1', { guessSanta: true }));
    // auction needs coins
    expect(
      (screen.getByRole('switch', { name: 'Mystery auction' }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Needs Santa Coins/)).toBeTruthy();
  });

  it('awards phase: nothing new can be switched on (history still can); completed: all locked', async () => {
    mountConsole({ phase: 'awards', features: { miniGames: false } });
    expect(
      ((await screen.findByRole('switch', { name: 'Mini-games' })) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.getAllByText(/nothing new can be switched on/i).length).toBeGreaterThan(0);
    expect(
      (screen.getByRole('switch', { name: 'History & Hall of Fame' }) as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it('completed: every switch is locked', async () => {
    mountConsole({ phase: 'completed' });
    const sw = await screen.findAllByRole('switch');
    expect(sw.length).toBe(6);
    expect(sw.every((s) => (s as HTMLInputElement).disabled)).toBe(true);
  });

  it('saves rules via the same endpoint', async () => {
    const updateFeatures = vi.fn<Phase3Api['updateFeatures']>(async () => ({}) as never);
    mountConsole({ phase: 'gift_opening', p3: { updateFeatures } });
    fireEvent.change(await screen.findByLabelText('Coins for winning a game'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(updateFeatures).toHaveBeenCalled());
    const patch = updateFeatures.mock.calls[0]![1];
    expect(patch.phase3?.coinRules?.game_win).toBe(20);
  });

  it('console panels follow the flags: clue queue, missions and coins appear only when enabled', async () => {
    mountConsole({
      phase: 'gift_opening',
      features: { guessSanta: false, missions: false, miniGames: false },
    });
    await screen.findByTestId('features-panel');
    expect(screen.queryByTestId('clue-queue')).toBeNull();
    expect(screen.queryByTestId('games-console')).toBeNull();
    expect(screen.queryByTestId('missions-console')).toBeNull();
    expect(screen.queryByTestId('coins-console')).toBeNull();
  });

  it('games console is hidden when the API says disabled and create is hidden when canCreate is false', async () => {
    mountConsole({
      phase: 'gift_opening',
      p2: {
        organizerGames: async () => ({
          enabled: true,
          canCreate: false,
          games: [],
          catalog: { triviaQuestions: 1, bingoSquares: 1 },
        }),
      },
    });
    await screen.findByTestId('games-console');
    expect(screen.queryByRole('button', { name: 'Create game' })).toBeNull();
  });
});

describe('auction + coins consoles (organizer)', () => {
  it('prize CRUD and stage controls; coin grant', async () => {
    const createPrize = vi.fn<Phase3Api['createPrize']>(async () => undefined);
    const prizeAction = vi.fn<Phase3Api['prizeAction']>(async () => undefined);
    const grantCoins = vi.fn<Phase3Api['grantCoins']>(async () => ({ granted: 7 }));
    mountConsole({
      phase: 'games',
      features: { coins: true, auction: true },
      p3: {
        prizes: async () => ({
          enabled: true,
          prizes: [
            {
              prizeId: 'z1',
              title: { en: 'Mystery Box 1' },
              reveal: { en: 'A scarf' },
              status: 'draft' as const,
              onStage: false,
              minBid: 1,
              endsAt: null,
              currentBid: null,
              winner: null,
            },
          ],
        }),
        organizerCoins: async () => ({
          enabled: true,
          rules: {
            game_play: 2,
            game_win: 10,
            mission_completed: 10,
            guess_correct: 5,
            achievement_unlock: 10,
          },
          issued: 80,
        }),
        createPrize,
        prizeAction,
        grantCoins,
      },
    });
    fireEvent.change(await screen.findByLabelText(/Public label/), { target: { value: 'Box 2' } });
    fireEvent.change(screen.getByLabelText(/What is inside/), { target: { value: 'Mug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add prize' }));
    await waitFor(() =>
      expect(createPrize).toHaveBeenCalledWith('e1', {
        title: { en: 'Box 2' },
        reveal: { en: 'Mug' },
        minBid: 1,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start auction: Mystery Box 1' }));
    await waitFor(() => expect(prizeAction).toHaveBeenCalledWith('e1', 'z1', 'open', 60));
    expect(screen.getByText('Coins issued so far: 80')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Grant name (used once)'), {
      target: { value: 'bonus-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Give coins to everyone' }));
    await waitFor(() =>
      expect(grantCoins).toHaveBeenCalledWith('e1', { key: 'bonus-1', amount: 5 }),
    );
    expect(await screen.findByText('Coins given to 7 people.')).toBeTruthy();
  });
});

const archive = {
  eventId: 'e1',
  name: 'Office Party',
  year: 2026,
  completedAt: AT,
  participants: [person('p1', 'Anna')],
  winners: [
    {
      boardKey: 'best_overall',
      name: { en: 'Best Overall' },
      grand: true,
      giftLabel: 'Gift 1',
      giftName: 'Warm scarf',
      photoUrl: null,
      giver: person('p2', 'Bruno'),
    },
  ],
  achievements: [{ key: 'game_night', person: person('p1', 'Anna') }],
  games: [],
  champion: person('p3', 'Carla'),
  expiresAt: '2028-12-20T18:00:00Z',
};

describe('history, Hall of Fame, lifetime, account link', () => {
  it('shows my event archive, the Hall of Fame and lifetime titles (positive only)', async () => {
    const t = setup(
      '/e',
      {},
      {},
      {},
      {
        myHistory: async () => ({ enabled: true, archive }),
        myHallOfFame: async () => ({
          enabled: true,
          years: [
            {
              year: 2026,
              events: [
                {
                  name: 'Office Party',
                  champions: [
                    {
                      kind: 'grand_champion' as const,
                      title: { en: 'Best Overall' },
                      person: person('p2', 'Bruno'),
                    },
                  ],
                },
              ],
            },
          ],
          seasons: [],
        }),
        myLifetime: async () => ({
          linked: true,
          profile: {
            displayName: 'Anna',
            events: 2,
            participationYears: [2025, 2026],
            titles: [
              {
                key: 'grand',
                title: { en: 'Grand Champion' },
                eventName: 'Office Party',
                year: 2026,
                trophy: true,
              },
            ],
            totalAchievements: 3,
          },
        }),
      },
    );
    t.snapshot('p:p1', { eventState: es('completed') });
    expect(await screen.findByTestId('archive')).toBeTruthy();
    expect(screen.getByText(/Warm scarf/)).toBeTruthy();
    expect(screen.getByTestId('hall-of-fame').textContent).toContain(
      'Grand Champion · Best Overall: Bruno',
    );
    expect(screen.getByTestId('lifetime').textContent).toContain('Events joined: 2');
    expect(screen.getByTestId('lifetime').textContent).toContain('Seasons: 2025, 2026');
  });

  it('account link: email -> sent; verification error is shown as a friendly message', async () => {
    const { ApiError } = await import('./api/client');
    const startAccountLink = vi
      .fn<Phase3Api['startAccountLink']>()
      .mockRejectedValueOnce(new ApiError(403, 'verification_required_for_link'))
      .mockResolvedValueOnce(undefined);
    const t = setup(
      '/e',
      {},
      {},
      {},
      {
        myHistory: async () => ({ enabled: true, archive: null }),
        startAccountLink,
      },
    );
    t.snapshot('p:p1', { eventState: es('completed') });
    fireEvent.change(await screen.findByLabelText('Your email'), {
      target: { value: 'a@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }));
    expect(
      await screen.findByText('Your access must be verified before you can link an account.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }));
    expect(await screen.findByText(/we sent you a link/)).toBeTruthy();
    expect(startAccountLink).toHaveBeenLastCalledWith('a@example.test');
  });

  it('/link?token confirms the account link once; bad tokens show one generic message', async () => {
    const { ApiError } = await import('./api/client');
    const ok = vi.fn<Phase3Api['confirmAccountLink']>(async () => undefined);
    setup('/link?token=abcdefghijklmnopqrstuv', {}, {}, {}, { confirmAccountLink: ok });
    expect(await screen.findByText('Done! Your profile is linked.')).toBeTruthy();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledWith('abcdefghijklmnopqrstuv');
    void ApiError;
  });

  it('/link with a rejected token', async () => {
    const { ApiError } = await import('./api/client');
    setup(
      '/link?token=abcdefghijklmnopqrstuv',
      {},
      {},
      {},
      {
        confirmAccountLink: async () => {
          throw new ApiError(401, 'invalid_link');
        },
      },
    );
    expect(await screen.findByText('This link is not valid or has expired.')).toBeTruthy();
  });

  it('organizer archive console shows the archive and Hall of Fame when history is on', async () => {
    mountConsole({
      phase: 'completed',
      features: { history: true },
      p3: {
        archive: async () => ({ enabled: true, archive }),
        hallOfFame: async () => ({ enabled: true, years: [], seasons: [] }),
      },
    });
    expect(await screen.findByTestId('archive-console')).toBeTruthy();
    expect(screen.getByText(/Warm scarf/)).toBeTruthy();
  });
});

describe('custom categories / achievements editor', () => {
  it('creates a category before voting and freezes the editor afterwards', async () => {
    const createCategory = vi.fn<Phase3Api['createCategory']>(async () => ({
      categories: [],
      editable: true,
    }));
    mountConsole({
      phase: 'gift_opening',
      p3: { categories: async () => ({ categories: [], editable: true }), createCategory },
    });
    await screen.findByRole('button', { name: 'Add category' });
    fireEvent.change(screen.getAllByLabelText('Key (c_ + letters, numbers, _)')[0]!, {
      target: { value: 'c_cosy' },
    });
    fireEvent.change(screen.getAllByLabelText('Name (English)')[0]!, {
      target: { value: 'Most Cosy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    await waitFor(() =>
      expect(createCategory).toHaveBeenCalledWith('e1', {
        key: 'c_cosy',
        name: { en: 'Most Cosy' },
      }),
    );
  });

  it('frozen editor shows the note and no add form', async () => {
    mountConsole({ phase: 'voting' });
    expect(await screen.findByText('Categories are locked once voting has opened.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add category' })).toBeNull();
  });
});
