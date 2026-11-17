import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * One real lifecycle against the real server (PGlite) serving the built SPA:
 * organizer creates an event and imports pairings -> guests join with personal codes -> register gifts ->
 * organizer opens gifts -> guests vote -> organizer closes voting. REST drives the lifecycle; the browser
 * checks the SPA is actually served (history fallback) with a CSP that blocks nothing the app needs.
 */
const NAMES = ['Giulia', 'Marco', 'Sofia', 'Luca', 'Chiara', 'Paolo'];
const ORG = { cookie: 'sg_o=e2e-organizer:e2e-session' };

let n = 0;
const key = () => ({ 'idempotency-key': `e2e-${++n}-${Date.now()}-xxxxxxxx` });

async function ok<T = unknown>(
  res: { ok(): boolean; status(): number; json(): Promise<unknown>; text(): Promise<string> },
  label: string,
): Promise<T> {
  if (!res.ok()) throw new Error(`${label} -> ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

test('organizer create -> join -> gift -> open -> vote -> close', async ({
  playwright,
  request,
  page,
  baseURL,
}) => {
  const api = (path: string) => `/api/events${path}`;
  const post = (path: string, data?: object, ctx: APIRequestContext = request, headers = ORG) =>
    ctx.post(path, { data: data ?? {}, headers: { ...headers, ...key() } });

  // 1. organizer creates the event
  const event = await ok<{ eventId?: string; id?: string }>(
    await post('/api/events', {
      name: 'E2E Party',
      startsAt: '2026-12-24T19:00:00Z',
      timezone: 'Europe/Rome',
      defaultLocale: 'en',
    }),
    'create event',
  );
  const eventId = (event.eventId ?? event.id)!;
  expect(eventId).toBeTruthy();

  // 2. pairings: ring over six names, CSV upload (creates the unclaimed roster)
  const csv = [
    'Giver,Recipient',
    ...NAMES.map((g, i) => `${g},${NAMES[(i + 1) % NAMES.length]}`),
  ].join('\n');
  const imp = await ok<{ status: string }>(
    await request.post(api(`/${eventId}/pairing-imports`), {
      headers: { ...ORG, ...key() },
      multipart: { file: { name: 'draw.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } },
    }),
    'pairing import',
  );
  expect(imp.status).toBe('ready');

  for (const to of ['registration', 'gift_registration']) {
    await ok(await post(api(`/${eventId}/phase`), { to }), `phase ${to}`);
  }

  // 3. join: QR token + printed personal codes -> one cookie jar per guest
  const access = await ok<{ token: string; shortCode: string }>(
    await post(api(`/${eventId}/access`), { kind: 'join', expiresInHours: 24 }),
    'join access',
  );
  expect(access.shortCode).toMatch(/^[A-Z2-9]{10}$/);
  const { codes } = await ok<{
    codes: Array<{ participantId: string; displayName: string; code: string }>;
  }>(await post(api(`/${eventId}/claims/codes`)), 'claim codes');
  expect(codes).toHaveLength(NAMES.length);

  const guests: Array<{ ctx: APIRequestContext; participantId: string; name: string }> = [];
  for (const c of codes) {
    const ctx = await playwright.request.newContext({ baseURL });
    const claim = await ok<{ status: string; verified: boolean }>(
      await post(
        '/api/join/claim',
        { method: 'personal_code', target: { joinToken: access.token }, code: c.code },
        ctx,
        {} as typeof ORG,
      ),
      `claim ${c.displayName}`,
    );
    expect(claim).toMatchObject({ status: 'active', verified: true });
    guests.push({ ctx, participantId: c.participantId, name: c.displayName });
  }

  // 4. each guest registers a gift (+XP once); the organizer-masked list shows aliases only
  for (const g of guests) {
    await ok(
      await g.ctx.put('/api/me/gift', { data: { name: `Present from ${g.name}` }, headers: key() }),
      `gift ${g.name}`,
    );
  }

  // 5. opening, then voting
  await ok(await post(api(`/${eventId}/phase`), { to: 'gift_opening' }), 'phase gift_opening');
  for (let i = 0; i < NAMES.length; i++)
    await ok(await post(api(`/${eventId}/opening/next`)), `open ${i}`);
  await ok(await post(api(`/${eventId}/voting/open`), {}), 'open voting');

  const giftList = await ok<{ gifts?: Array<{ giftId: string }> }>(
    await request.get(api(`/${eventId}/gifts`), { headers: ORG }),
    'gifts',
  );
  const giftIds = (giftList.gifts ?? (giftList as unknown as Array<{ giftId: string }>)).map(
    (g) => g.giftId,
  );
  expect(giftIds).toHaveLength(NAMES.length);

  const mine = new Map<string, string>();
  for (const g of guests) {
    const own = await ok<{ gift: { giftId: string } }>(await g.ctx.get('/api/me/gift'), 'own gift');
    mine.set(g.participantId, own.gift.giftId);
  }
  let votesCast = 0;
  for (const g of guests) {
    const voting = await ok<{ status: string; categories: Array<{ id: string }> }>(
      await g.ctx.get('/api/me/voting'),
      'voting state',
    );
    expect(voting.status).toBe('open');
    const target = giftIds.find((id) => id !== mine.get(g.participantId))!;
    const cat = voting.categories[0]!;
    await ok(
      await g.ctx.post('/api/me/votes', {
        data: { categoryId: cat.id, giftId: target },
        headers: key(),
      }),
      'vote',
    );
    votesCast++;
    // own gift is refused with the shared error code
    const own = await g.ctx.post('/api/me/votes', {
      data: { categoryId: cat.id, giftId: mine.get(g.participantId) },
      headers: key(),
    });
    expect(own.status()).toBe(422);
    expect((await own.json()).error.code).toBe('own_gift');
  }
  expect(votesCast).toBe(NAMES.length);

  // 6. close: awards are locked, below the 5-voter floor categories stay neutral (only category 1 had 6 voters)
  const closed = await ok<{ categoriesLocked: number; categoriesPublishable: number }>(
    await post(api(`/${eventId}/voting/close`)),
    'close voting',
  );
  expect(closed.categoriesLocked).toBe(6);
  expect(closed.categoriesPublishable).toBeLessThanOrEqual(1);

  // 7. the real browser gets the SPA for client routes, and the CSP does not block its own assets
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  for (const path of ['/', '/o', `/j?code=${access.shortCode}`, '/d']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(page.locator('#root')).toBeAttached();
  }
  expect(violations).toEqual([]);
  expect((await request.get('/api/does-not-exist')).status()).toBe(404);

  for (const g of guests) await g.ctx.dispose();
});
