import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockRealtime } from './support/mockRealtime';

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .analyze()
    .then((r) => r.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`));

const base = {
  eventId: 'e1',
  name: 'Office Party',
  description: null,
  theme: 'xmas',
  startsAt: '2026-12-20T18:00:00Z',
  timezone: 'UTC',
  paused: false,
  votingEndsAt: null,
  counts: { participants: 7, giftsRegistered: 4 },
};
const me = {
  participantId: 'p1',
  displayName: 'Anna',
  avatar: 'santa',
  status: 'active',
  xp: { xp: 10, level: 1 },
  votes: [],
};
const pubGift = (id: string, name: string) => ({
  giftId: id,
  alias: `Gift ${id}`,
  name,
  description: null,
  photoUrl: null,
  status: 'opened',
});
const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

test.describe('participant gameplay (mocked API + realtime)', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('register a gift with a photo preview, axe clean on mobile', async ({ page }) => {
    await mockRealtime(page, [
      {
        stream: 'p:p1',
        data: { eventState: { ...base, role: 'participant', phase: 'gift_registration', me } },
      },
    ]);
    let saved: unknown;
    await page.route('**/api/me/gift', async (route) => {
      if (route.request().method() === 'PUT') {
        saved = route.request().postDataJSON();
        return route.fulfill(
          json({
            gift: {
              giftId: 'g1',
              alias: 'Gift 1',
              name: 'Warm scarf',
              description: null,
              photoUrl: null,
              status: 'registered',
            },
            editable: true,
          }),
        );
      }
      return route.fulfill(json({ gift: null, editable: true }));
    });
    await page.route('**/api/me/assignment', (r) =>
      r.fulfill(json({ error: { code: 'verification_required', message: '' } }, 403)),
    );
    await page.goto('/e');
    await expect(page.getByText('4 gifts registered so far')).toBeVisible();
    await page.getByLabel('Gift name').fill('Warm scarf');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    await page
      .getByLabel('Photo (optional)')
      .setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByTestId('gift-photo-preview')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'Register gift' }).click();
    await expect.poll(() => saved).toEqual({ name: 'Warm scarf', description: null });
  });

  test('voting: own gift disabled, vote sent, own picks listed, no horizontal scroll', async ({
    page,
  }) => {
    await mockRealtime(page, [
      {
        stream: 'p:p1',
        data: { eventState: { ...base, role: 'participant', phase: 'voting', votedCount: 3, me } },
      },
      {
        stream: 'pub',
        data: {
          giftList: {
            mode: 'gallery',
            currentGiftId: null,
            gifts: [pubGift('g-mine', 'Mug'), pubGift('g2', 'Scarf')],
          },
        },
      },
    ]);
    await page.route('**/api/me/gift', (r) =>
      r.fulfill(
        json({
          gift: {
            giftId: 'g-mine',
            alias: 'Gift 1',
            name: 'Mug',
            description: null,
            photoUrl: null,
            status: 'registered',
          },
          editable: false,
        }),
      ),
    );
    await page.route('**/api/me/assignment', (r) =>
      r.fulfill(json({ error: { code: 'verification_required', message: '' } }, 403)),
    );
    await page.route('**/api/me/voting', (r) =>
      r.fulfill(
        json({
          status: 'open',
          endsAt: new Date(Date.now() + 300_000).toISOString(),
          votedCount: 3,
          categories: [{ id: 'c1', key: 'funny', name: { en: 'Funniest' }, description: null }],
        }),
      ),
    );
    const votes: unknown[] = [];
    await page.route('**/api/me/votes', async (route) => {
      if (route.request().method() === 'POST') {
        const b = route.request().postDataJSON() as { categoryId: string; giftId: string };
        votes.push(b);
        return route.fulfill(json({ ...b, xpAwarded: true }));
      }
      return route.fulfill(json({ votes: votes }));
    });
    await page.goto('/e');
    const group = page.getByRole('group', { name: 'Funniest' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('radio').first()).toBeDisabled();
    await expect(page.getByTestId('voted-count')).toHaveText('3 people have voted');
    await group.getByRole('radio').nth(1).check();
    await expect.poll(() => votes).toEqual([{ categoryId: 'c1', giftId: 'g2' }]);
    await expect(page.getByTestId('own-picks')).toContainText('Funniest: Scarf');
    expect(await axe(page)).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
  });
});

test.describe('public display scenes (mocked realtime)', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('opening scene counts down then reveals; leaderboard podium; announcement overlay', async ({
    page,
  }) => {
    const rt = await mockRealtime(page, [
      {
        stream: 'pub',
        data: {
          eventState: { ...base, role: 'display', phase: 'gift_opening' },
          scene: {
            scene: 'opening',
            openedCount: 1,
            total: 5,
            countdownSeconds: 3,
            countdownEndsAt: new Date(Date.now() + 3000).toISOString(),
            current: { ...pubGift('7', 'Warm scarf') },
          },
        },
      },
    ]);
    await page.goto('/d');
    await expect(page.getByText('1 of 5 gifts opened')).toBeVisible();
    await expect(page.getByTestId('opening-revealed')).toBeVisible({ timeout: 6000 });
    await expect(page.getByTestId('opening-revealed')).toContainText('Warm scarf');
    expect(await axe(page)).toEqual([]);

    rt.delta('pub', 'announcement', {
      type: 'achievement',
      key: 'first_vote',
      person: { participantId: 'p2', displayName: 'Anna', avatar: 'santa' },
      at: new Date().toISOString(),
    });
    await expect(page.getByTestId('announcement')).toContainText('Anna earned the first vote!');

    rt.delta('pub', 'eventState', { ...base, role: 'display', phase: 'awards' });
    rt.delta('pub', 'scene', { scene: 'phase', phase: 'awards' });
    rt.delta('pub', 'leaderboards', {
      boards: [
        {
          boardKey: 'funniest',
          state: 'live',
          message: null,
          entries: [{ entryId: 'g1', label: 'Gift 7', rank: 1, tied: false }],
        },
      ],
    });
    await expect(page.getByTestId('podium')).toContainText('Gift 7');
  });

  test('reduced motion: opening reveals immediately with no countdown', async ({ browser }) => {
    const ctx = await browser.newContext({
      reducedMotion: 'reduce',
      viewport: { width: 1920, height: 1080 },
    });
    const page = await ctx.newPage();
    await mockRealtime(page, [
      {
        stream: 'pub',
        data: {
          eventState: { ...base, role: 'display', phase: 'gift_opening' },
          scene: {
            scene: 'opening',
            openedCount: 2,
            total: 5,
            countdownSeconds: 3,
            countdownEndsAt: new Date(Date.now() + 3000).toISOString(),
            current: pubGift('8', 'Candle'),
          },
        },
      },
    ]);
    await page.goto('/d');
    await expect(page.getByTestId('opening-revealed')).toContainText('Candle', { timeout: 1500 });
    await ctx.close();
  });

  test('lobby: QR + short code from the scene; sound stays off until opted in', async ({
    page,
  }) => {
    await mockRealtime(page, [
      {
        stream: 'pub',
        data: {
          eventState: { ...base, role: 'display', phase: 'registration' },
          scene: {
            scene: 'lobby',
            participants: 7,
            joinUrl: 'http://localhost:4173/j?code=ABCDEFGHJK',
            shortCode: 'ABCDEFGHJK',
          },
        },
      },
    ]);
    await page.goto('/d');
    await expect(page.getByRole('img', { name: 'QR code to join the event' })).toBeVisible();
    await expect(page.getByText('ABCDE-FGHJK')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Sound' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('organizer console game controls (mocked API)', () => {
  test('opening: next gift control posts and progress is shown', async ({ page }) => {
    await page.route('**/api/organizer/me', (r) =>
      r.fulfill(json({ userId: 'u1', email: 'o@example.test', isPlatformAdmin: false })),
    );
    await page.route('**/api/events/e1/organizer-state', (r) =>
      r.fulfill(
        json({
          role: 'organizer_masked',
          eventState: {
            ...base,
            role: 'organizer_masked',
            phase: 'gift_opening',
            organizer: {
              roster: { unclaimed: 0, pending: 0, active: 7, removed: 0 },
              warnings: [],
              reactionsEnabled: true,
            },
          },
        }),
      ),
    );
    await page.route('**/api/events/e1/pairing-imports/latest', (r) =>
      r.fulfill(json({ import: null, reimportAllowed: false })),
    );
    await page.route('**/api/events/e1/participants', (r) => r.fulfill(json({ participants: [] })));
    await page.route('**/api/events/e1/gifts', (r) => r.fulfill(json({ gifts: [] })));
    await page.route('**/api/events/e1/opening', (r) =>
      r.fulfill(
        json({
          mode: 'random',
          openedCount: 1,
          total: 5,
          currentGiftId: null,
          countdownSeconds: 3,
          countdownEndsAt: null,
          allOpened: false,
        }),
      ),
    );
    let next = 0;
    await page.route('**/api/events/e1/opening/next', (r) => {
      next++;
      return r.fulfill(
        json({
          mode: 'random',
          openedCount: 2,
          total: 5,
          currentGiftId: 'g1',
          countdownSeconds: 3,
          countdownEndsAt: null,
          allOpened: false,
        }),
      );
    });
    await page.goto('/o/events/e1');
    await expect(page.getByText('1 of 5 gifts opened')).toBeVisible();
    await page.getByRole('button', { name: 'Open next gift' }).click();
    await expect.poll(() => next).toBe(1);
    expect(await axe(page)).toEqual([]);
  });
});
