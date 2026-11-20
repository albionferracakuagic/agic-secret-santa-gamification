/**
 * Acceptance-criteria walkthrough (AC1-AC14, doc/implementation-plan.md) at the UI level.
 * Backend behaviour is covered by the server tests; here the API and the Socket.IO stream are doubles
 * (page.route + routeWebSocket), so every screen is driven exactly as the server would drive it.
 *
 *  AC1 invites               -> "AC1" test (organizer creates join link, short code, QR, display link)
 *  AC2 mobile join           -> "AC2" test (375px: code -> pick name -> pending -> approved)
 *  AC3 giver anonymity       -> lifecycle steps (no giver anywhere until the reveal)
 *  AC4/AC5 voting rules      -> lifecycle (own gift disabled, one pick per category, editable while open)
 *  AC6 live top-N            -> lifecycle (podium for the top, neutral message for everyone else)
 *  AC7/AC13 privacy contract -> "AC7/13" test (no data beyond the projection, no API caching, no private storage)
 *  AC8 FX cues + text        -> lifecycle (cues have ARIA-live text equivalents)
 *  AC9 display sync          -> lifecycle (display and phones show the same scene at the same time)
 *  AC10 achievements         -> lifecycle (announcement overlay + unlock on the phone)
 *  AC11 phase control        -> "AC11" test (organizer console drives the phase and pause)
 *  AC12 ceremony             -> lifecycle (intro -> winner -> Grand Champion fireworks)
 *  AC14 reduced motion/sound -> "AC14" tests
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { mockRealtime, type Realtime } from './support/mockRealtime';
import {
  displayState,
  gift,
  json,
  meOf,
  newPage,
  participantState,
  person,
} from './support/fixtures';

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .analyze()
    .then((r) => r.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`));

const NAME = { en: 'Funniest gift', it: 'Regalo più divertente' };
const CATEGORIES = [{ id: 'c1', key: 'funniest', name: NAME, description: null }];

interface Phone {
  page: Page;
  rt: Realtime;
  votes: Array<{ categoryId: string; giftId: string }>;
  own: ReturnType<typeof gift> | null;
}

async function phone(
  browser: Browser,
  id: string,
  name: string,
  opts: { locale?: 'en' | 'it'; ownGift?: ReturnType<typeof gift> | null } = {},
): Promise<Phone> {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await newPage(ctx, opts.locale ? { locale: opts.locale } : {});
  const me = meOf(id, name);
  const rt = await mockRealtime(page, [
    { stream: `p:${id}`, data: { eventState: participantState('registration', me) } },
    {
      stream: 'pub',
      data: { scene: { scene: 'lobby', participants: 3, joinUrl: null, shortCode: null } },
    },
  ]);
  const p: Phone = { page, rt, votes: [], own: opts.ownGift ?? null };
  await page.route('**/api/me/gift', (r) => r.fulfill(json({ gift: p.own, editable: false })));
  await page.route('**/api/me/assignment', (r) =>
    r.fulfill(json({ recipient: person('p9', 'Zoe') })),
  );
  await page.route('**/api/me/voting', (r) =>
    r.fulfill(
      json({
        status: 'open',
        endsAt: new Date(Date.now() + 600_000).toISOString(),
        votedCount: null,
        categories: CATEGORIES,
      }),
    ),
  );
  await page.route('**/api/me/votes', async (route) => {
    if (route.request().method() === 'POST') {
      const b = route.request().postDataJSON() as { categoryId: string; giftId: string };
      p.votes = [...p.votes.filter((v) => v.categoryId !== b.categoryId), b];
      return route.fulfill(json({ ...b, xpAwarded: p.votes.length === 1 }));
    }
    return route.fulfill(json({ votes: p.votes }));
  });
  await page.route('**/api/me/achievements', (r) => r.fulfill(json({ achievements: [] })));
  await page.goto('/e');
  return p;
}

test.describe('AC1 invites', () => {
  test('organizer creates a join link, short code, QR and a display link', async ({ page }) => {
    await page.route('**/api/organizer/me', (r) =>
      r.fulfill(json({ userId: 'u1', email: 'o@example.test', isPlatformAdmin: false })),
    );
    await page.route('**/api/events/e1/organizer-state', (r) =>
      r.fulfill(
        json({
          role: 'organizer_masked',
          eventState: {
            ...displayState('registration'),
            organizer: {
              roster: { unclaimed: 3, pending: 0, active: 0, removed: 0 },
              warnings: [],
              reactionsEnabled: true,
            },
          },
        }),
      ),
    );
    await page.route('**/api/events/e1/access', (r) => {
      const kind = (r.request().postDataJSON() as { kind: string }).kind;
      return r.fulfill(
        json(
          {
            accessId: 'a1',
            kind,
            token: 'x'.repeat(24),
            shortCode: kind === 'join' ? 'ABCDEFGHJK' : null,
            path: `/${kind === 'join' ? 'j' : 'd'}/${'x'.repeat(24)}`,
            expiresAt: '2026-12-23T18:00:00Z',
          },
          201,
        ),
      );
    });
    await page.goto('/o/events/e1?tab=people');
    await page.getByRole('button', { name: 'Create join link and QR' }).click();
    const join = page.getByTestId('join-link');
    await expect(join).toContainText('ABCDE-FGHJK');
    await expect(join.getByRole('img', { name: 'QR code to join the event' })).toBeVisible();
    await page.getByRole('button', { name: 'Create display link' }).click();
    await expect(page.getByTestId('display-link')).toContainText('/d/');
  });
});

test.describe('AC2 mobile join', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('code -> pick name -> pending -> approved lands on the participant app (IT)', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
    const page = await newPage(ctx, { locale: 'it' });
    let approved = false;
    await mockRealtime(page, [
      {
        stream: 'p:p1',
        data: { eventState: participantState('registration', meOf('p1', 'Anna')) },
      },
    ]);
    await page.route('**/api/join/resolve', (r) =>
      r.fulfill(
        json({
          event: {
            name: 'Festa',
            startsAt: '2026-12-20T18:00:00Z',
            defaultLocale: 'it',
            joinOpen: true,
          },
          unclaimed: [{ participantId: 'p1', displayName: 'Anna' }],
        }),
      ),
    );
    await page.route('**/api/join/claim', (r) =>
      r.fulfill(json({ status: 'pending', participantId: 'p1', verified: false })),
    );
    await page.route('**/api/me', (r) =>
      r.fulfill(
        json({
          participantId: 'p1',
          eventId: 'e1',
          displayName: 'Anna',
          avatar: null,
          status: approved ? 'active' : 'pending',
          verified: false,
          locale: 'it',
        }),
      ),
    );
    await page.goto('/j');
    await page.getByLabel('Codice evento').fill('abcde-fghjk');
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'Continua' }).click();
    await page.getByRole('button', { name: /Anna/ }).click();
    await expect(page.getByText(/confermerà a breve/)).toBeVisible();
    approved = true;
    await expect(page).toHaveURL(/\/e$/, { timeout: 8000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
    await ctx.close();
  });
});

test.describe('AC11 phase control', () => {
  test('organizer moves the phase forward and pauses; errors are localized', async ({ page }) => {
    let phase = 'gift_registration';
    const posted: unknown[] = [];
    await page.route('**/api/organizer/me', (r) =>
      r.fulfill(json({ userId: 'u1', email: 'o@example.test', isPlatformAdmin: false })),
    );
    await page.route('**/api/events/e1/organizer-state', (r) =>
      r.fulfill(
        json({
          role: 'organizer_masked',
          eventState: {
            ...displayState(phase),
            organizer: {
              roster: { unclaimed: 0, pending: 0, active: 3, removed: 0 },
              warnings: [],
              reactionsEnabled: true,
            },
          },
        }),
      ),
    );
    await page.route('**/api/events/e1/phase', (r) => {
      const b = r.request().postDataJSON() as { to: string };
      posted.push(b);
      phase = b.to;
      return r.fulfill(json({ phase }));
    });
    await page.route('**/api/events/e1/pause', (r) => {
      posted.push(r.request().postDataJSON());
      return r.fulfill(json({ paused: true }));
    });
    await page.goto('/o/events/e1');
    await expect(page.getByText('Gift registration', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Next: Gift opening' }).click();
    await expect.poll(() => posted[0]).toEqual({ to: 'gift_opening' });
    await page.getByRole('button', { name: 'Pause event' }).click();
    await expect.poll(() => posted[1]).toEqual({ paused: true });
  });
});

test.describe('AC7/AC13 privacy: nothing beyond the projection, nothing cached', () => {
  test('API and event data are never cached by the service worker or stored locally', async ({
    page,
    request,
  }) => {
    const sw = await request.get('/sw.js');
    const body = await sw.text();
    expect(body).not.toMatch(/NetworkFirst|StaleWhileRevalidate|CacheFirst\(/);
    await mockRealtime(page, [
      { stream: 'p:p1', data: { eventState: participantState('voting', meOf('p1', 'Anna')) } },
    ]);
    await page.route('**/api/me/**', (r) =>
      new URL(r.request().url()).pathname === '/api/me/state'
        ? r.fallback()
        : r.fulfill(json({ gift: null, editable: false })),
    );
    await page.goto('/e');
    await expect(page.getByText('Office Party')).toBeVisible();
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.filter((k) => !k.startsWith('sg.'))).toEqual([]);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(stored).not.toMatch(/Office Party|Anna/);
  });
});

test.describe('AC14 reduced motion and sound off', () => {
  test('reduced motion: opening reveals at once, ceremony keeps its text, sound is off until opted in', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      reducedMotion: 'reduce',
      viewport: { width: 1920, height: 1080 },
    });
    const page = await newPage(ctx);
    const rt = await mockRealtime(page, [
      {
        stream: 'pub',
        data: {
          eventState: displayState('gift_opening'),
          scene: {
            scene: 'opening',
            openedCount: 1,
            total: 4,
            countdownSeconds: 3,
            countdownEndsAt: new Date(Date.now() + 3000).toISOString(),
            current: gift('g1', 'Warm scarf'),
          },
        },
      },
    ]);
    await page.goto('/d');
    await expect(page.getByTestId('opening-revealed')).toContainText('Warm scarf', {
      timeout: 1500,
    });
    rt.delta('pub', 'scene', {
      scene: 'ceremony',
      ceremony: {
        status: 'running',
        index: 1,
        total: 5,
        endsAt: null,
        step: { type: 'champion', person: person('p9', 'Elena') },
      },
    });
    await expect(page.getByText('Christmas Champion')).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('sg.prefs') ?? '{"state":{"sound":false}}').state.sound,
      ),
    ).toBe(false);
    await expect(page.getByRole('region', { name: 'Sound' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    const pe = await page
      .getByTestId('fx-root')
      .evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(pe).toBe('none');
    await ctx.close();
  });
});

test.describe('lifecycle: organizer-driven party with display + 3 phones (AC3-AC10, AC12, reconnect, EN/IT)', () => {
  test('registration -> opening -> voting -> board -> reveal -> ceremony', async ({ browser }) => {
    test.setTimeout(90_000);
    const dctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const display = await newPage(dctx);
    const dRt = await mockRealtime(display, [
      {
        stream: 'pub',
        data: {
          eventState: displayState('registration'),
          scene: {
            scene: 'lobby',
            participants: 3,
            joinUrl: 'http://localhost:4173/j?code=ABCDEFGHJK',
            shortCode: 'ABCDEFGHJK',
          },
        },
      },
    ]);
    await display.goto('/d');

    const anna = await phone(browser, 'p1', 'Anna', {
      ownGift: gift('g1', 'Warm scarf', { status: 'registered' }),
    });
    const bruno = await phone(browser, 'p2', 'Bruno', {
      ownGift: gift('g2', 'Mug', { status: 'registered' }),
    });
    const carla = await phone(browser, 'p3', 'Carla', {
      locale: 'it',
      ownGift: gift('g3', 'Candela', { status: 'registered' }),
    });
    const phones = [anna, bruno, carla];
    const me = { p1: meOf('p1', 'Anna'), p2: meOf('p2', 'Bruno'), p3: meOf('p3', 'Carla') };
    const everyone = async (
      phase: string,
      scene: unknown,
      counts = { participants: 3, giftsRegistered: 3 },
      extra: Record<string, unknown> = {},
    ) => {
      dRt.delta('pub', 'eventState', displayState(phase, counts, extra));
      dRt.delta('pub', 'scene', scene);
      for (const [i, p] of phones.entries()) {
        const id = `p${i + 1}` as keyof typeof me;
        p.rt.delta(`p:${id}`, 'eventState', participantState(phase, me[id], counts, extra));
        p.rt.delta('pub', 'scene', scene);
      }
    };

    // AC9: display + phones are in sync from the very first screen; the phone is 'registration'
    await expect(display.getByRole('img', { name: 'QR code to join the event' })).toBeVisible();
    await expect(display.getByText('ABCDE-FGHJK')).toBeVisible();
    await expect(anna.page.getByText('Now: Registration')).toBeVisible();
    await expect(carla.page.getByText(/Ora: Registrazione/)).toBeVisible(); // EN/IT per device

    // AC8: a new joiner produces a cue with a text equivalent in the ARIA-live region (display)
    dRt.delta(
      'pub',
      'eventState',
      displayState('registration', { participants: 4, giftsRegistered: 0 }),
    );
    await expect(
      display.getByRole('status').filter({ hasText: 'Santa welcomes a new player!' }),
    ).toHaveCount(1);

    // AC3: gift registration shows counts only, never gift content or givers
    await everyone(
      'gift_registration',
      { scene: 'phase', phase: 'gift_registration' },
      { participants: 3, giftsRegistered: 3 },
    );
    await expect(display.getByTestId('big-count')).toHaveText('3');
    await expect(anna.page.getByText('3 gifts registered so far')).toBeVisible();
    for (const t of ['Warm scarf', 'Mug', 'Candela'])
      await expect(display.getByText(t)).toHaveCount(0);

    // gift opening: current gift is visible to everyone, the giver is not
    const opened = [gift('g1', 'Warm scarf')];
    await everyone('gift_opening', {
      scene: 'opening',
      openedCount: 1,
      total: 3,
      countdownSeconds: 3,
      countdownEndsAt: new Date(Date.now() + 3000).toISOString(),
      current: opened[0],
    });
    await expect(display.getByText('1 of 3 gifts opened')).toBeVisible();
    await expect(display.getByTestId('opening-revealed')).toContainText('Warm scarf', {
      timeout: 6000,
    });
    await expect(anna.page.getByTestId('opening-revealed')).toContainText('Warm scarf', {
      timeout: 6000,
    });
    expect(await display.locator('body').innerText()).not.toMatch(/Anna|Bruno|Carla/); // AC3

    // AC4/AC5 voting: gallery visible, own gift disabled, one pick per category, editable while open
    const gallery = {
      mode: 'gallery',
      currentGiftId: null,
      gifts: [gift('g1', 'Warm scarf'), gift('g2', 'Mug'), gift('g3', 'Candela')],
    };
    for (const p of phones) p.rt.delta('pub', 'giftList', gallery);
    const endsAt = new Date(Date.now() + 600_000).toISOString();
    await everyone(
      'voting',
      { scene: 'voting', endsAt, votedCount: null, closed: false },
      undefined,
      { votingEndsAt: endsAt },
    );
    await expect(display.getByText('Voting is open')).toBeVisible();
    await expect(display.getByRole('timer')).toBeVisible();
    const group = anna.page.getByRole('group', { name: 'Funniest gift' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('radio').first()).toBeDisabled(); // own gift (AC4)
    await group.getByRole('radio').nth(1).check();
    await expect.poll(() => anna.votes).toEqual([{ categoryId: 'c1', giftId: 'g2' }]);
    await group.getByRole('radio').nth(2).check(); // change while open (AC5)
    await expect.poll(() => anna.votes).toEqual([{ categoryId: 'c1', giftId: 'g3' }]);
    await expect(anna.page.getByTestId('own-picks')).toContainText('Funniest gift: Candela');
    await expect(bruno.page.getByTestId('own-picks')).toHaveCount(0); // nobody sees anyone else's picks
    await expect(carla.page.getByRole('group', { name: 'Regalo più divertente' })).toBeVisible(); // IT category name

    // published counter appears on the display (cadence), never per person
    dRt.delta('pub', 'scene', { scene: 'voting', endsAt, votedCount: 2, closed: false });
    await expect(display.getByTestId('big-count')).toHaveText('2');
    expect(await axe(anna.page)).toEqual([]);

    // reconnect: a dropped phone resubscribes and shows the fresh snapshot (no stale state)
    const before = bruno.rt.connections();
    bruno.rt.setSnapshots([
      {
        stream: 'p:p2',
        data: {
          eventState: participantState(
            'voting',
            me.p2,
            { participants: 5, giftsRegistered: 3 },
            { votingEndsAt: endsAt },
          ),
        },
      },
      {
        stream: 'pub',
        data: {
          giftList: gallery,
          scene: { scene: 'voting', endsAt, votedCount: 2, closed: false },
        },
      },
    ]);
    bruno.rt.drop();
    await expect(bruno.page.getByText('5 players joined')).toBeVisible({ timeout: 10_000 });
    expect(bruno.rt.connections()).toBeGreaterThan(before);

    // AC6 live top-N: the podium shows only the published top; everyone else gets the neutral message
    const boards = {
      boards: [
        {
          boardKey: 'funniest',
          state: 'live',
          message: null,
          entries: [
            { entryId: 'g1', label: 'Gift 1', rank: 1, tied: false },
            { entryId: 'g3', label: 'Gift 3', rank: 2, tied: false },
          ],
        },
        { boardKey: 'xp', state: 'hidden', message: null, entries: [] },
      ],
    };
    dRt.delta('pub', 'leaderboards', boards);
    for (const p of phones) p.rt.delta('pub', 'leaderboards', boards);
    await everyone('games', { scene: 'phase', phase: 'games' });
    await expect(display.getByTestId('podium')).toContainText('Gift 1');
    await expect(display.locator('[data-board=xp]')).toHaveCount(0);
    await expect(bruno.page.getByText(/Every gift made today brighter/)).toBeVisible(); // Bruno's gift (g2) is not on the board
    await expect(carla.page.getByText(/Il tuo regalo è in classifica/)).toBeVisible(); // Carla's g3 is

    // reveal: givers appear only now (AC3 after the reveal)
    const revealed = {
      mode: 'gallery',
      currentGiftId: null,
      gifts: [
        gift('g1', 'Warm scarf', { status: 'revealed', giver: person('p1', 'Anna') }),
        gift('g2', 'Mug'),
        gift('g3', 'Candela'),
      ],
    };
    dRt.delta('pub', 'giftList', revealed);
    for (const p of phones) p.rt.delta('pub', 'giftList', revealed);
    await everyone('reveal', { scene: 'phase', phase: 'reveal' });
    await expect(display.getByTestId('reveal-grid')).toContainText('Anna');
    await expect(display.getByTestId('reveal-grid')).not.toContainText('Mug');

    // AC12 ceremony: intro -> winner -> Grand Champion with golden fireworks, in sync on every screen
    const cere = (index: number, step: unknown) => ({
      scene: 'ceremony',
      ceremony: { status: 'running', index, total: 4, endsAt: null, step },
    });
    await everyone('awards', cere(0, { type: 'intro' }));
    await expect(display.getByText('The awards ceremony begins!')).toBeVisible();
    await expect(anna.page.getByTestId('ceremony-scene')).toContainText(
      'The awards ceremony begins!',
    );
    dRt.delta(
      'pub',
      'scene',
      cere(1, {
        type: 'winner',
        boardKey: 'funniest',
        name: NAME,
        grand: false,
        tied: false,
        winners: [{ entryId: 'g1', label: 'Gift 1', giver: person('p1', 'Anna') }],
      }),
    );
    await expect(display.getByTestId('ceremony-winners')).toContainText('Anna');
    await display.evaluate(() => {
      const w = window as unknown as { __live: string[] };
      w.__live = [];
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[role=status]'))
          if (el.textContent) w.__live.push(el.textContent);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    dRt.delta('pub', 'scene', cere(2, { type: 'champion', person: person('p1', 'Anna') }));
    await expect(display.getByText('Christmas Champion')).toBeVisible();
    // AC8: the grand-winner cue has a text equivalent for screen readers (recorded: the live region is replaced by later cues)
    await expect
      .poll(() =>
        display.evaluate(() => (window as unknown as { __live: string[] }).__live.join('|')),
      )
      .toContain('golden fireworks');

    // AC10 achievements: overlay on the display, unlock on the phone
    dRt.delta('pub', 'announcement', {
      type: 'achievement',
      key: 'comedy_santa',
      person: person('p1', 'Anna'),
      at: new Date().toISOString(),
    });
    await expect(display.getByTestId('announcement')).toContainText('Anna earned Comedy Santa!');
    anna.rt.delta('p:p1', 'announcement', {
      type: 'achievement',
      key: 'comedy_santa',
      person: person('p1', 'Anna'),
      at: new Date().toISOString(),
    });
    await expect(anna.page.getByTestId('achievement-unlock')).toContainText(
      'Achievement unlocked: Comedy Santa!',
    );
    expect(await axe(display)).toEqual([]);
  });
});
