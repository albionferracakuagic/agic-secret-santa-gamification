import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { awards, events, gifts, participants, user, votes, votingCategories } from '@santa/db';
import { scanForbidden } from '@santa/contracts';
import { connected, createWorld, sleep, type World } from '../testing/world.js';

const NAMES = ['Giulia', 'Marco', 'Sofia', 'Luca', 'Chiara', 'Paolo', 'Elena', 'Davide'];
type Msg = { stream: string; surface?: string; payload?: unknown; data?: Record<string, unknown> };

describe('boards, ceremony, moderation and privacy controls (end to end)', () => {
  let w: World;
  let n = 0;
  let giftIds: string[];
  const OWNER = () => w.organizerCookie('demo-owner', 'sess-o');
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    o: { cookie?: string; body?: unknown } = {},
  ) =>
    w.app.inject({
      method,
      url: url.startsWith('/api/') ? url : `/api/events/${w.eventId}${url}`,
      ...(o.body === undefined ? {} : { payload: o.body as object }),
      headers: { 'idempotency-key': `s-${++n}-xxxxxxxx`, cookie: o.cookie ?? OWNER() },
    });
  let display: ReturnType<World['client']>;
  const seen: Msg[] = [];

  beforeAll(async () => {
    w = await createWorld();
    await w.db.update(events).set({ phase: 'voting' }).where(eq(events.id, w.eventId));
    giftIds = (
      await w.db
        .insert(gifts)
        .values(
          w.participantIds.map((giverId, i) => ({
            eventId: w.eventId,
            giverId,
            aliasNo: i + 1,
            name: `Present ${i + 1}`,
            status: 'opened' as const,
            photoKey: `gifts/${w.eventId}/p${i}.jpg`,
          })),
        )
        .returning()
    ).map((g) => g.id);
    const cats = await w.db
      .select()
      .from(votingCategories)
      .where(eq(votingCategories.eventId, w.eventId));
    const spread = [0, 0, 0, 1, 1, 2, 3, 4];
    for (const key of ['funniest', 'best_overall']) {
      const cat = cats.find((c) => c.key === key)!;
      await w.db.insert(votes).values(
        w.participantIds.map((voterId, i) => ({
          categoryId: cat.id,
          voterId,
          eventId: w.eventId,
          giftId: giftIds[spread[i]! + (spread[i] === i ? 5 : 0)]!,
        })),
      );
    }
    display = w.client(await w.displayCookie());
    await connected(display);
    display.on('snapshot', (m: Msg) => seen.push(m));
    display.on('delta', (m: Msg) => seen.push(m));
    display.emit('subscribe', {});
    await sleep(300);
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  const latest = (surface: string) =>
    [...seen].reverse().find((m) => m.surface === surface)?.payload as
      Record<string, unknown> | undefined;

  it('boards: small cohort needs acknowledgement; public board has aliases only; organizer list is masked', async () => {
    const r1 = await call('POST', '/boards/funniest', { body: { action: 'enable' } });
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.code).toBe('small_cohort_ack_required');
    const r2 = await call('POST', '/boards/funniest', {
      body: { action: 'enable', acknowledgeSmallCohort: true },
    });
    expect(r2.json()).toEqual({ boardKey: 'funniest', state: 'live' });
    await sleep(300);
    const boards = latest('leaderboards') as {
      boards: Array<{ boardKey: string; entries: unknown[]; message: string | null }>;
    };
    const b = boards.boards.find((x) => x.boardKey === 'funniest')!;
    expect(b.entries.length).toBeGreaterThan(0);
    expect(b.entries.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(boards)).not.toMatch(/score|total|voter|giver/);
    for (const nm of NAMES) expect(JSON.stringify(boards)).not.toContain(nm);

    const list = (await call('GET', '/boards')).json();
    expect(list.boards.find((x: { boardKey: string }) => x.boardKey === 'funniest')).toMatchObject({
      state: 'live',
      forced: true,
    });
    expect(JSON.stringify(list)).not.toMatch(/entries|entryId/);

    expect(
      (await call('POST', '/boards/funniest', { body: { action: 'hide' } })).json().state,
    ).toBe('hidden');
    await sleep(200);
    expect((latest('leaderboards') as { boards: unknown[] }).boards).toEqual([]);
    const stranger = await call('GET', '/boards', { cookie: w.organizerCookie('stranger', 's2') });
    expect(stranger.statusCode).toBe(403);
  });

  it('ceremony: closing voting locks awards; show reveals givers and unlocks achievements only at their steps', async () => {
    await call('POST', '/boards/best_overall', {
      body: { action: 'enable', acknowledgeSmallCohort: true },
    });
    expect((await call('POST', '/voting/close')).statusCode).toBe(200);
    expect(
      (await call('GET', '/boards'))
        .json()
        .boards.find((x: { boardKey: string }) => x.boardKey === 'best_overall').state,
    ).toBe('paused'); // frozen at close
    const locked = await w.db.select().from(awards).where(eq(awards.eventId, w.eventId));
    expect(locked.every((a) => a.lockedAt !== null)).toBe(true);

    expect((await call('GET', '/ceremony')).json()).toMatchObject({ canStart: false });
    expect((await call('POST', '/ceremony/start')).json().error.code).toBe('not_in_awards_phase');
    await w.db
      .update(events)
      .set({ phase: 'awards', revealStartedAt: new Date() })
      .where(eq(events.id, w.eventId));

    const state = (await call('GET', '/ceremony')).json();
    expect(state).toMatchObject({ canStart: true, status: 'idle' });
    expect(JSON.stringify(state)).not.toMatch(/Giulia|Marco|winner/);

    const before = seen.length;
    expect((await call('POST', '/ceremony/start')).json()).toMatchObject({
      status: 'running',
      index: 0,
    });
    expect((await call('POST', '/ceremony/next', { body: { fromIndex: 5 } })).statusCode).toBe(409);

    let idx = 0;
    let winnerGiverSeen = false;
    for (let guard = 0; guard < 40; guard++) {
      const view = (latest('scene') as { scene: string; ceremony: { step: { type: string } } })
        .ceremony;
      if (view.step.type === 'winner') winnerGiverSeen = true;
      const r = await call('POST', '/ceremony/next', { body: { fromIndex: idx } });
      expect(r.statusCode).toBe(200);
      await sleep(40);
      if (r.json().status === 'done') break;
      idx++;
    }
    expect(winnerGiverSeen).toBe(true);
    const ceremonyMsgs = seen.slice(before);
    expect(ceremonyMsgs.some((m) => m.surface === 'announcement')).toBe(true);
    expect(
      scanForbidden(ceremonyMsgs, {
        keys: ['voterId', 'score', 'openingOrder', 'recipientId', 'giverId'],
      }),
    ).toEqual([]);
    // only winners' givers were revealed: not every giver name appears on the public stream
    const text = JSON.stringify(ceremonyMsgs);
    expect(NAMES.filter((nm) => text.includes(nm)).length).toBeLessThan(NAMES.length);

    const mine = await w.guestCookie(0);
    const ach = (await call('GET', '/api/me/achievements', { cookie: mine })).json();
    expect(Array.isArray(ach.achievements)).toBe(true);
  });

  it('admin: stats are masked counts; vote integrity details need an unmask grant', async () => {
    const stats = (await call('GET', '/stats')).json();
    expect(stats).toMatchObject({ phase: 'awards', ceremony: 'done' });
    expect(JSON.stringify(stats)).not.toMatch(/Giulia|@example/);
    // own-gift vote (the API blocks it; the review still has to catch anything that slips in)
    await w.db
      .update(votes)
      .set({ giftId: giftIds[2]! })
      .where(eq(votes.voterId, w.participantIds[2]!));
    const rep = (await call('GET', '/integrity')).json();
    expect(rep.clean).toBe(false);
    expect(JSON.stringify(rep)).not.toContain(w.participantIds[0]!);
    expect((await call('GET', '/integrity/details')).statusCode).toBe(403);
    const grant = await w.grant();
    const d = await w.app.inject({
      method: 'GET',
      url: `/api/events/${w.eventId}/integrity/details`,
      headers: { cookie: OWNER(), 'x-unmask-grant': grant },
    });
    expect(d.statusCode).toBe(200);
    expect(d.json().items.length).toBeGreaterThan(0);
  });

  it('remove participant drops their session; delete-my-data anonymises; takedown needs a platform admin', async () => {
    const cookie6 = await w.guestCookie(6);
    const sock = w.client(cookie6);
    await connected(sock);
    const dropped = new Promise((resolve) => sock.once('disconnect', resolve));
    const rm = await call('POST', `/participants/${w.participantIds[6]!}/remove`, {
      body: { reason: 'left the party' },
    });
    expect(rm.json()).toMatchObject({ status: 'removed' });
    await dropped;
    expect((await call('GET', '/api/me', { cookie: cookie6 })).statusCode).toBe(401);

    const cookie7 = await w.guestCookie(7);
    const del = await call('DELETE', '/api/me', { cookie: cookie7 });
    expect(del.json()).toMatchObject({ anonymized: true });
    const [p7] = await w.db
      .select()
      .from(participants)
      .where(eq(participants.id, w.participantIds[7]!));
    expect(p7).toMatchObject({ displayName: 'Ex partecipante', email: null });
    expect((await call('GET', '/api/me', { cookie: cookie7 })).statusCode).toBe(401);

    const body = { reason: 'abuse report 42' };
    const notAdmin = await call('POST', `/api/admin/events/${w.eventId}/takedown`, { body });
    expect(notAdmin.statusCode).toBe(403);
    await w.db.update(user).set({ isPlatformAdmin: true }).where(eq(user.id, 'stranger'));
    const adminCookie = w.organizerCookie('stranger', 'adm');
    const g1 = await w.guestCookie(1);
    expect((await call('GET', '/api/me', { cookie: g1 })).statusCode).toBe(200);
    expect(
      (
        await call('POST', `/api/admin/events/${w.eventId}/takedown`, { body, cookie: adminCookie })
      ).json(),
    ).toEqual({ eventId: w.eventId, suspended: true });
    expect((await call('GET', '/api/me', { cookie: g1 })).statusCode).toBe(401);
    expect(
      (
        await call('POST', `/api/admin/events/${w.eventId}/restore`, {
          body: { reason: 'resolved ok' },
          cookie: adminCookie,
        })
      ).json().suspended,
    ).toBe(false);
    expect((await call('GET', '/api/me', { cookie: g1 })).statusCode).toBe(200);
  });
});
