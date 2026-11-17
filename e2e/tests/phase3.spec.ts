import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockRealtime } from './support/mockRealtime';
import { displayState, json, meOf, participantState, person } from './support/fixtures';

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .analyze()
    .then((r) => r.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`));

const me = meOf('p1', 'Anna');
const later = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const AT = '2026-12-20T18:30:00Z';

const prize = (over: Record<string, unknown> = {}) => ({
  prizeId: 'z1',
  title: { en: 'Mystery Box 1' },
  status: 'open',
  endsAt: later(60),
  currentBid: 12,
  minNextBid: 13,
  winner: null,
  reveal: null,
  ...over,
});

test.describe('phase 3 participant (mocked API + realtime)', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('auction: bid with validation, leading state, then the box-open reveal', async ({
    page,
  }) => {
    const rt = await mockRealtime(page, [
      { stream: 'p:p1', data: { eventState: participantState('games', me) } },
      {
        stream: 'pub',
        data: { eventState: displayState('games'), scene: { scene: 'auction', auction: prize() } },
      },
    ]);
    let leading = false;
    let bidBody: unknown;
    let current = prize();
    await page.route('**/api/me/auction', (r) =>
      r.fulfill(
        json({
          enabled: true,
          balance: 30,
          prize: current,
          you: { leading, myBid: leading ? 15 : null },
        }),
      ),
    );
    await page.route('**/api/me/coins', (r) =>
      r.fulfill(
        json({
          enabled: true,
          balance: leading ? 15 : 30,
          held: leading ? 15 : 0,
          entries: [{ reason: 'game_win', amount: 10, at: AT }],
        }),
      ),
    );
    await page.route('**/api/me/auction/bids', (r) => {
      bidBody = r.request().postDataJSON();
      leading = true;
      current = prize({ currentBid: 15, minNextBid: 16 });
      return r.fulfill(
        json({ prizeId: 'z1', amount: 15, leading: true, endsAt: later(75), extended: true }),
      );
    });
    await page.goto('/e');
    await expect(page.getByTestId('auction-price')).toHaveText('Current price: 12');
    await expect(page.getByTestId('coin-balance')).toHaveText('Your coins: 30');
    await expect(page.getByText(/leaderboard/i)).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    const input = page.getByLabel('Your bid (coins)');
    await input.fill('5');
    await expect(page.getByText('Bid at least 13 coins.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Place bid' })).toBeDisabled();
    await input.fill('15');
    await page.getByRole('button', { name: 'Place bid' }).click();
    await expect.poll(() => bidBody).toEqual({ amount: 15 });
    await expect(page.getByText('You are leading! 🎉')).toBeVisible();
    await expect(page.getByText(/Time extended/)).toBeVisible();
    await expect(page.getByTestId('coin-balance')).toHaveText('Your coins: 15');

    current = prize({
      status: 'revealed',
      endsAt: null,
      winner: person('p1', 'Anna'),
      reveal: { en: 'A cosy scarf' },
    });
    rt.delta('pub', 'scene', { scene: 'auction', auction: current });
    rt.delta('p:p1', 'announcement', {
      type: 'mystery_reveal',
      prizeId: 'z1',
      title: { en: 'Mystery Box 1' },
      reveal: { en: 'A cosy scarf' },
      winner: person('p1', 'Anna'),
      cue: 'box_open',
      at: later(0),
    });
    await expect(page.getByTestId('mystery-reveal')).toContainText('A cosy scarf');
    await expect(page.getByTestId('achievement-unlock')).toContainText('Mystery Box 1 opens');
  });

  test('history: Hall of Fame and lifetime titles for a completed event', async ({ page }) => {
    await mockRealtime(page, [
      { stream: 'p:p1', data: { eventState: participantState('completed', me) } },
    ]);
    await page.route('**/api/me/history', (r) => r.fulfill(json({ enabled: true, archive: null })));
    await page.route('**/api/me/hall-of-fame', (r) =>
      r.fulfill(
        json({
          enabled: true,
          years: [
            {
              year: 2026,
              events: [
                {
                  name: 'Office Party',
                  champions: [
                    {
                      kind: 'grand_champion',
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
      ),
    );
    await page.route('**/api/me/lifetime', (r) =>
      r.fulfill(json({ linked: false, profile: null })),
    );
    await page.goto('/e');
    await expect(page.getByTestId('hall-of-fame')).toContainText(
      'Grand Champion · Best Overall: Bruno',
    );
    await expect(page.getByLabel('Your email')).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('phase 3 display (1080p)', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('auction scene shows the price only, then the winner and the revealed content', async ({
    page,
  }) => {
    const rt = await mockRealtime(page, [
      {
        stream: 'pub',
        data: { eventState: displayState('games'), scene: { scene: 'auction', auction: prize() } },
      },
    ]);
    await page.goto('/d');
    await expect(page.getByTestId('auction-price')).toContainText('12');
    await expect(page.getByTestId('auction-scene')).not.toContainText(/bidder/i);
    rt.delta('pub', 'scene', {
      scene: 'auction',
      auction: prize({
        status: 'revealed',
        endsAt: null,
        winner: person('p2', 'Bruno'),
        reveal: { en: 'A cosy scarf' },
      }),
    });
    await expect(page.getByText('Winner: Bruno')).toBeVisible();
    await expect(page.getByTestId('mystery-reveal')).toContainText('A cosy scarf');
  });
});

test.describe('feature flags panel (organizer)', () => {
  test('switch on guess, auction locked until coins, PATCH sent', async ({ page }) => {
    await page.route('**/api/organizer/me', (r) =>
      r.fulfill(json({ userId: 'u1', email: 'o@example.test', isPlatformAdmin: false })),
    );
    await page.route('**/api/events/e1/organizer-state', (r) =>
      r.fulfill(
        json({
          role: 'organizer_masked',
          eventState: {
            ...displayState('gift_opening'),
            organizer: {
              roster: { unclaimed: 0, pending: 0, active: 3, removed: 0 },
              warnings: [],
              reactionsEnabled: true,
              features: {
                xpBoard: false,
                guessSanta: false,
                missions: false,
                miniGames: true,
                coins: false,
                auction: false,
                history: false,
              },
            },
          },
        }),
      ),
    );
    let patch: unknown;
    await page.route('**/api/events/e1/features', (r) => {
      patch = r.request().postDataJSON();
      return r.fulfill(json({ features: {}, phase2: {}, phase3: {} }));
    });
    await page.goto('/o/events/e1');
    await expect(page.getByTestId('features-panel')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Mystery auction' })).toBeDisabled();
    await expect(page.getByText(/Needs Santa Coins/)).toBeVisible();
    await page.getByRole('switch', { name: 'Guess your Secret Santa' }).click();
    await expect.poll(() => patch).toEqual({ guessSanta: true });
  });
});
