import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
} from '@playwright/test';

const ORG_COOKIE = { name: 'sg_o', value: 'e2e-organizer:e2e-session' };
const NAMES = ['Giulia', 'Marco', 'Sofia', 'Luca', 'Chiara', 'Paolo'] as const;

const axeViolations = async (page: Page, selector?: string) => {
  const builder = new AxeBuilder({ page });
  if (selector) builder.include(selector);
  return (await builder.analyze()).violations.map(
    (violation) => `${violation.id}: ${violation.nodes[0]?.target}`,
  );
};

async function ok<T = unknown>(response: APIResponse, label: string): Promise<T> {
  if (!response.ok()) throw new Error(`${label} -> ${response.status()}: ${await response.text()}`);
  return (await response.json()) as T;
}

const initPage = async (page: Page) =>
  page.addInitScript(() => {
    localStorage.setItem('sg.cookieNotice', 'ack');
    localStorage.setItem('sg.locale', 'en');
  });

test('autopilot show keeps giver private until display and personal reveal, then recap', async ({
  browser,
  page: organizer,
  baseURL,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBeTruthy();
  await organizer.context().addCookies([{ ...ORG_COOKIE, url: baseURL! }]);
  await initPage(organizer);

  let requestNo = 0;
  const headers = () => ({ 'idempotency-key': `show-e2e-${Date.now()}-${++requestNo}` });
  const post = (ctx: APIRequestContext, path: string, data: object = {}) =>
    ctx.post(path, { data, headers: headers() });
  const eventApi = (eventId: string, path = '') => `/api/events/${eventId}${path}`;

  const created = await ok<{ id: string }>(
    await post(organizer.context().request, '/api/events', {
      name: 'Autopilot Reveal Party',
      startsAt: '2026-12-24T19:00:00Z',
      timezone: 'Europe/Rome',
      defaultLocale: 'en',
      settings: {
        openingCountdownSeconds: 0,
        ceremonyCountdownSeconds: 3,
        features: {
          miniGames: false,
          guessSanta: true,
          history: true,
        },
        autopilot: {
          preset: 'quick',
          includeExtras: false,
          openingGiftSeconds: 5,
          votingMinutes: 1,
          revealGiftSeconds: 5,
          interludeSeconds: 0,
        },
      },
    }),
    'create event',
  );
  const eventId = created.id;

  const csv = [
    'Giver,Recipient',
    ...NAMES.map((giver, index) => `${giver},${NAMES[(index + 1) % NAMES.length]}`),
  ].join('\n');
  const imported = await ok<{ status: string }>(
    await organizer.context().request.post(eventApi(eventId, '/pairing-imports'), {
      headers: headers(),
      multipart: {
        file: {
          name: 'draw.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(csv),
        },
      },
    }),
    'pairing import',
  );
  expect(imported.status).toBe('ready');

  for (const phase of ['registration', 'gift_registration'] as const)
    await ok(
      await post(organizer.context().request, eventApi(eventId, '/phase'), { to: phase }),
      `phase ${phase}`,
    );

  const join = await ok<{ token: string }>(
    await post(organizer.context().request, eventApi(eventId, '/access'), {
      kind: 'join',
      expiresInHours: 24,
    }),
    'join access',
  );
  const display = await ok<{ token: string }>(
    await post(organizer.context().request, eventApi(eventId, '/access'), {
      kind: 'display',
      expiresInHours: 24,
    }),
    'display access',
  );
  const { codes } = await ok<{
    codes: Array<{ participantId: string; displayName: string; code: string }>;
  }>(await post(organizer.context().request, eventApi(eventId, '/claims/codes')), 'claim codes');

  const guestContexts: BrowserContext[] = [];
  const guests: Array<{
    context: BrowserContext;
    participantId: string;
    name: string;
    giftId: string;
  }> = [];
  try {
    for (const code of codes) {
      const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
      guestContexts.push(context);
      const claimed = await ok<{ status: string; verified: boolean }>(
        await context.request.post('/api/join/claim', {
          data: {
            method: 'personal_code',
            target: { joinToken: join.token },
            code: code.code,
          },
          headers: headers(),
        }),
        `claim ${code.displayName}`,
      );
      expect(claimed).toMatchObject({ status: 'active', verified: true });
      const registered = await ok<{ gift: { giftId: string } }>(
        await context.request.put('/api/me/gift', {
          data: {
            name: `Parcel ${NAMES.indexOf(code.displayName as (typeof NAMES)[number]) + 1}`,
            description: null,
          },
          headers: headers(),
        }),
        `gift ${code.displayName}`,
      );
      guests.push({
        context,
        participantId: code.participantId,
        name: code.displayName,
        giftId: registered.gift.giftId,
      });
    }

    const openingOrder = NAMES.map((name) => guests.find((guest) => guest.name === name)!.giftId);
    await ok(
      await post(organizer.context().request, eventApi(eventId, '/opening/order'), {
        mode: 'manual',
        order: openingOrder,
      }),
      'opening order',
    );
    await ok(
      await post(organizer.context().request, eventApi(eventId, '/phase'), {
        to: 'gift_opening',
      }),
      'phase gift_opening',
    );

    const displayContext = await browser.newContext({
      baseURL,
      reducedMotion: 'reduce',
      viewport: { width: 1920, height: 1080 },
    });
    guestContexts.push(displayContext);
    const displayPage = await displayContext.newPage();
    await initPage(displayPage);

    const marco = guests.find((guest) => guest.name === 'Marco')!;
    const participant = await marco.context.newPage();
    await initPage(participant);

    await Promise.all([
      displayPage.goto(`/d/${display.token}`),
      participant.goto('/e'),
      organizer.goto(`/o/events/${eventId}?tab=live`),
    ]);
    await expect(displayPage.getByTestId('display-stage')).toBeVisible();
    await expect(participant.getByText('Marco')).toBeVisible();
    await expect(organizer.getByTestId('live-cockpit')).toBeVisible();
    await expect(
      organizer
        .getByTestId('autopilot-readiness')
        .getByText('Display connected')
        .locator('..'),
    ).toContainText('Ready', { timeout: 10_000 });
    const start = organizer.getByRole('button', { name: 'Start Show' });
    await expect
      .poll(
        async () => {
          await ok(
            await organizer.context().request.patch(eventApi(eventId), {
              data: { name: 'Autopilot Reveal Party' },
              headers: headers(),
            }),
            'refresh live event state',
          );
          return start.isEnabled();
        },
        {
          message: 'autopilot live display readiness',
          intervals: [100, 250, 500],
          timeout: 10_000,
        },
      )
      .toBe(true);
    expect(await axeViolations(organizer)).toEqual([]);

    await start.click();
    await expect(organizer.getByRole('button', { name: 'Hold' })).toBeVisible();
    await ok(
      await organizer.context().request.post('/__e2e/jobs/advance', { data: { ms: 0 } }),
      'start tick',
    );
    await expect(displayPage.getByRole('heading', { name: /Parcel 1$/ })).toBeVisible();
    await expect(displayPage.getByText(/Giulia/)).toHaveCount(0);
    await expect(participant.getByText(/Giulia/)).toHaveCount(0);

    await organizer.getByRole('button', { name: 'Hold' }).click();
    await expect(organizer.getByRole('button', { name: 'Resume' })).toBeVisible();
    await ok(
      await organizer.context().request.post('/__e2e/jobs/advance', { data: { ms: 30_000 } }),
      'held advance',
    );
    const held = await ok<{ state: { status: string; step: string | null } }>(
      await organizer.context().request.get(eventApi(eventId, '/autopilot')),
      'held state',
    );
    expect(held.state).toMatchObject({ status: 'held', step: 'opening' });
    await expect(displayPage.getByText('1 of 6 gifts opened')).toBeVisible();

    await organizer.getByRole('button', { name: 'Resume' }).click();
    await expect(organizer.getByRole('button', { name: 'Hold' })).toBeVisible();
    for (let i = 0; i < 7; i++) {
      await ok(
        await organizer.context().request.post('/__e2e/jobs/advance', { data: { ms: 5_000 } }),
        `opening advance ${i}`,
      );
      const state = await ok<{ state: { step: string | null } }>(
        await organizer.context().request.get(eventApi(eventId, '/autopilot')),
        `autopilot state ${i}`,
      );
      if (state.state.step === 'voting') break;
    }
    await expect(participant.getByRole('group', { name: 'Most Thoughtful' })).toBeVisible();

    const targetGift = guests.find((guest) => guest.name === 'Giulia')!.giftId;
    for (const guest of guests) {
      const voting = await ok<{ categories: Array<{ id: string }> }>(
        await guest.context.request.get('/api/me/voting'),
        `voting ${guest.name}`,
      );
      const giftId = guest.giftId === targetGift ? openingOrder[1]! : targetGift;
      await ok(
        await guest.context.request.post('/api/me/votes', {
          data: { categoryId: voting.categories[0]!.id, giftId },
          headers: headers(),
        }),
        `vote ${guest.name}`,
      );
    }

    await organizer.getByRole('button', { name: 'Skip current step' }).click();
    await organizer.getByRole('button', { name: 'Skip now' }).click();
    await ok(
      await organizer.context().request.post('/__e2e/jobs/advance', { data: { ms: 0 } }),
      'skip to reveal',
    );
    await expect(displayPage.getByTestId('reveal-drumroll')).toBeVisible();
    await expect(participant.getByTestId('my-drumroll')).toBeVisible();
    await expect(displayPage.getByText(/Giulia/)).toHaveCount(0);
    await expect(participant.getByText(/Giulia/)).toHaveCount(0);
    expect(await axeViolations(displayPage)).toEqual([]);

    await ok(
      await organizer.context().request.post('/__e2e/jobs/advance', { data: { ms: 3_000 } }),
      'unveil first gift',
    );
    await expect(displayPage.getByTestId('reveal-giver')).toContainText('Giulia');
    await expect(participant.getByTestId('reveal-overlay-giver')).toContainText('Giulia');
    expect(await axeViolations(participant, '[data-testid="reveal-overlay"]')).toEqual([]);
    await participant.getByRole('button', { name: 'Continue' }).click();

    for (let i = 1; i < NAMES.length; i++) {
      await ok(
        await organizer.context().request.post('/__e2e/jobs/advance', { data: { ms: 2_000 } }),
        `stage reveal ${i}`,
      );
      await ok(
        await organizer.context().request.post('/__e2e/jobs/advance', { data: { ms: 3_000 } }),
        `unveil reveal ${i}`,
      );
    }
    const revealDone = await ok<{ done: boolean }>(
      await post(organizer.context().request, eventApi(eventId, '/reveal/next')),
      'reveal finale',
    );
    expect(revealDone.done).toBe(true);
    await expect(displayPage.getByTestId('reveal-finale-grid')).toBeVisible();
    await participant.getByTestId('reveal-recap-link').click();
    await expect(participant).toHaveURL(/\/e\/recap$/);
    await expect(participant.getByTestId('recap-locked')).toBeVisible();
    await ok(
      await post(organizer.context().request, eventApi(eventId, '/phase'), { to: 'awards' }),
      'organizer enters awards',
    );
    const recapParcel = participant
      .getByTestId('recap-gallery')
      .getByRole('listitem')
      .filter({ hasText: 'Parcel 1' });
    await expect(recapParcel).toContainText('Giulia');
    expect(await axeViolations(participant)).toEqual([]);

    await organizer.goto(`/o/events/${eventId}?tab=show`);
    const presentationRequest = organizer.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === `/api/events/${eventId}/presentations`,
    );
    await organizer
      .getByRole('button', { name: 'Show on display: Santa Detective' })
      .click();
    expect((await presentationRequest).postDataJSON()).toEqual({ kind: 'santa_detective' });
    await expect(displayPage.getByTestId('spotlight-scene')).toBeVisible({ timeout: 10_000 });
    expect(new URL(displayPage.url()).pathname).toBe(`/d/${display.token}`);
  } finally {
    for (const context of guestContexts.reverse()) await context.close();
  }
});
