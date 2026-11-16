import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { gifts, media, participants, xpLedger } from '@santa/db';
import { scanForbidden } from '@santa/contracts';
import { createWorld, sleep, connected, collect, type World } from '../testing/world.js';
import { multipart } from '../testing/multipart.js';

let w: World;
let n = 0;
const OWNER = () => w.organizerCookie('demo-owner', 'sess-o');

beforeAll(async () => {
  w = await createWorld();
}, 60_000);
afterAll(async () => {
  await w.close();
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  o: { cookie?: string; body?: unknown; raw?: { payload: Buffer; contentType: string } } = {},
) =>
  w.app.inject({
    method,
    url,
    ...(o.raw
      ? { payload: o.raw.payload }
      : o.body === undefined
        ? {}
        : { payload: o.body as object }),
    headers: {
      'idempotency-key': `g-${++n}-xxxxxxxx`,
      ...(o.raw ? { 'content-type': o.raw.contentType } : {}),
      ...(o.cookie ? { cookie: o.cookie } : {}),
    },
  });
const ev = (s = '') => `/api/events/${w.eventId}${s}`;
const xpOf = async (i: number) =>
  (
    await w.db.select().from(xpLedger).where(eq(xpLedger.participantId, w.participantIds[i]!))
  ).reduce((a, r) => a + r.amount, 0);

const photoUpload = (content: Buffer | string, name = 'holiday-IMG_1234.jpg', field = 'photo') =>
  multipart({}, { name, content, field, type: 'image/jpeg' });
const exifJpeg = () =>
  sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#cc0000' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Copyright: 'SECRET-COPYRIGHT' } })
    .toBuffer();

describe('giver: own gift', () => {
  it('requires a participant session; validates input strictly', async () => {
    expect((await call('PUT', '/api/me/gift', { body: { name: 'x' } })).statusCode).toBe(401);
    const c = await w.guestCookie(0);
    expect((await call('PUT', '/api/me/gift', { cookie: c, body: { name: '' } })).statusCode).toBe(
      400,
    );
    expect(
      (await call('PUT', '/api/me/gift', { cookie: c, body: { name: 'ok', giverId: 'x' } }))
        .statusCode,
    ).toBe(400);
    const none = await call('GET', '/api/me/gift', { cookie: c });
    expect(none.json()).toEqual({ gift: null, editable: true });
  });

  it('first save registers (201, random alias, +20 XP once); edits keep alias; response has no recipient/giver ids', async () => {
    const c = await w.guestCookie(1);
    const before = await xpOf(1);
    const created = await call('PUT', '/api/me/gift', {
      cookie: c,
      body: { name: 'Hand-knitted scarf', description: 'warm' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.gift).toMatchObject({
      name: 'Hand-knitted scarf',
      status: 'registered',
      photoUrl: null,
    });
    expect(body.gift.alias).toMatch(/^Gift \d+$/);
    expect(
      scanForbidden(body, { keys: ['giverId', 'recipientId', 'recipient', 'openingOrder'] }),
    ).toEqual([]);
    expect(await xpOf(1)).toBe(before + 20);

    const edit = await call('PUT', '/api/me/gift', { cookie: c, body: { name: 'Scarf v2' } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().gift).toMatchObject({ name: 'Scarf v2', alias: body.gift.alias });
    expect(await xpOf(1)).toBe(before + 20);
    expect((await call('GET', '/api/me/gift', { cookie: c })).json().gift.name).toBe('Scarf v2');
  });

  it('counts only during registration: display/pub sees a number, never content', async () => {
    const display = w.client(await w.displayCookie());
    await connected(display);
    const snaps = collect(display, 'snapshot') as Array<{
      stream: string;
      data: Record<string, unknown>;
    }>;
    display.emit('subscribe', {});
    await sleep(300);
    const pub = snaps.find((s) => s.stream === 'pub')!;
    expect(pub.data['giftList']).toMatchObject({ mode: 'count_only', count: 1 });
    expect(pub.data['scene']).toMatchObject({ scene: 'lobby' });
    expect(JSON.stringify(pub.data)).not.toMatch(/Scarf|alias/i);
  });

  it('photo: EXIF stripped + oriented + resized, stored under a renamed key, served via signed URL only', async () => {
    const c = await w.guestCookie(2);
    await call('PUT', '/api/me/gift', { cookie: c, body: { name: 'With photo' } });
    const m = photoUpload(await exifJpeg());
    const res = await call('POST', '/api/me/gift/photo', {
      cookie: c,
      raw: { payload: m.payload, contentType: m.contentType },
    });
    expect(res.statusCode).toBe(200);
    const url = res.json().gift.photoUrl as string;
    expect(url).toMatch(
      new RegExp(`^/media/gifts/${w.eventId}/[0-9a-f-]{36}\\.jpg\\?exp=\\d+&sig=`),
    );
    expect(url).not.toContain('holiday');

    const [row] = await w.db.select().from(gifts).where(eq(gifts.giverId, w.participantIds[2]!));
    expect(row!.photoKey).toMatch(/^gifts\/.+\.jpg$/);
    expect(await w.db.select().from(media).where(eq(media.key, row!.photoKey!))).toMatchObject([
      { kind: 'gift_photo', mime: 'image/jpeg' },
    ]);

    const served = await w.app.inject({ method: 'GET', url });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(served.rawPayload).metadata();
    expect(meta.exif).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([1067, 1600]);
    expect(served.rawPayload.includes(Buffer.from('SECRET-COPYRIGHT'))).toBe(false);

    // tampered / unsigned URLs do not work
    expect(
      (await w.app.inject({ method: 'GET', url: url.replace(/sig=./, 'sig=X') })).statusCode,
    ).toBe(404);
    expect((await w.app.inject({ method: 'GET', url: url.split('?')[0]! })).statusCode).toBe(404);

    // replacing the photo deletes the old blob; removing deletes the current one
    const m2 = photoUpload(await exifJpeg());
    const res2 = await call('POST', '/api/me/gift/photo', {
      cookie: c,
      raw: { payload: m2.payload, contentType: m2.contentType },
    });
    expect((await w.app.inject({ method: 'GET', url })).statusCode).toBe(404); // old URL's blob is gone
    expect((await w.app.inject({ method: 'GET', url: res2.json().gift.photoUrl })).statusCode).toBe(
      200,
    );
    const del = await call('DELETE', '/api/me/gift/photo', { cookie: c });
    expect(del.json().gift.photoUrl).toBeNull();
    expect((await w.app.inject({ method: 'GET', url: res2.json().gift.photoUrl })).statusCode).toBe(
      404,
    );
  });

  it('photo validation: 5 MB cap, real image content only, needs a gift, wrong field name', async () => {
    const c = await w.guestCookie(3);
    const send = (m: { payload: Buffer; contentType: string }) =>
      call('POST', '/api/me/gift/photo', {
        cookie: c,
        raw: { payload: m.payload, contentType: m.contentType },
      });
    const m = photoUpload(await exifJpeg());
    expect((await send(m)).json().error.code).toBe('gift_locked'); // no gift yet
    await call('PUT', '/api/me/gift', { cookie: c, body: { name: 'G3' } });

    const big = await send(photoUpload(Buffer.alloc(5 * 1024 * 1024 + 10, 1)));
    expect(big.statusCode).toBe(413);
    const text = await send(photoUpload('definitely not an image', 'evil.jpg'));
    expect(text.statusCode).toBe(400);
    expect(text.json().error.code).toBe('invalid_image');
    expect((await send(photoUpload(await exifJpeg(), 'a.jpg', 'file'))).statusCode).toBe(400);
  });

  it('own recipient only with a verified claim', async () => {
    const c = await w.guestCookie(4);
    const denied = await call('GET', '/api/me/assignment', { cookie: c });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('verification_required');
    await w.db
      .update(participants)
      .set({ claimVerifiedAt: new Date() })
      .where(eq(participants.id, w.participantIds[4]!));
    const ok = await call('GET', '/api/me/assignment', { cookie: c });
    expect(ok.json().recipient).toMatchObject({
      participantId: w.participantIds[5],
      displayName: 'Paolo',
    });
    expect(Object.keys(ok.json().recipient).sort()).toEqual([
      'avatar',
      'displayName',
      'participantId',
    ]);
  });

  it('editing is locked once the registration phase is over', async () => {
    const c = await w.guestCookie(5);
    await call('PUT', '/api/me/gift', { cookie: c, body: { name: 'G5' } });
    expect(
      (await call('POST', ev('/phase'), { cookie: OWNER(), body: { to: 'gift_opening' } }))
        .statusCode,
    ).toBe(200);
    const late = await call('PUT', '/api/me/gift', { cookie: c, body: { name: 'G5 edited' } });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('gift_locked');
    expect((await call('GET', '/api/me/gift', { cookie: c })).json().editable).toBe(false);
    await call('POST', ev('/phase'), { cookie: OWNER(), body: { to: 'gift_registration' } }); // audited back-step for the next tests
  });
});

describe('organizer moderation', () => {
  it('lists gifts by alias without any giver/recipient/order data; non-members refused', async () => {
    const res = await call('GET', ev('/gifts'), { cookie: OWNER() });
    expect(res.statusCode).toBe(200);
    const list = res.json().gifts as Array<{ giftId: string; name: string; hidden: boolean }>;
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(
      scanForbidden(res.json(), {
        keys: ['giverId', 'recipientId', 'giver', 'openingOrder', 'createdAt'],
      }),
    ).toEqual([]);
    expect(
      (await call('GET', ev('/gifts'), { cookie: w.organizerCookie('stranger', 's') })).statusCode,
    ).toBe(403);
    expect((await call('GET', ev('/gifts'))).statusCode).toBe(401);
  });

  it('edit text, hide, and remove a photo (blob deleted); invalid patches rejected', async () => {
    const withPhoto = (
      await w.db
        .select()
        .from(gifts)
        .where(and(eq(gifts.eventId, w.eventId), eq(gifts.giverId, w.participantIds[2]!)))
    )[0]!;
    const c = await w.guestCookie(2);
    const m = photoUpload(await exifJpeg());
    const up = await call('POST', '/api/me/gift/photo', {
      cookie: c,
      raw: { payload: m.payload, contentType: m.contentType },
    });
    const url = up.json().gift.photoUrl as string;

    const patch = await call('PATCH', ev(`/gifts/${withPhoto.id}`), {
      cookie: OWNER(),
      body: { name: 'Moderated', removePhoto: true, hidden: true },
    });
    expect(patch.statusCode).toBe(200);
    expect((await w.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    const list = (await call('GET', ev('/gifts'), { cookie: OWNER() })).json().gifts as Array<{
      giftId: string;
      name: string;
      hidden: boolean;
      photoUrl: string | null;
    }>;
    expect(list.find((g) => g.giftId === withPhoto.id)).toMatchObject({
      name: 'Moderated',
      hidden: true,
      photoUrl: null,
    });
    expect(
      (
        await call('PATCH', ev(`/gifts/${withPhoto.id}`), {
          cookie: OWNER(),
          body: { giverId: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('PATCH', ev('/gifts/00000000-0000-0000-0000-000000000000'), {
          cookie: OWNER(),
          body: { hidden: true },
        })
      ).statusCode,
    ).toBe(404);
    // hidden gifts are excluded from the public count
    const display = w.client(await w.displayCookie());
    await connected(display);
    const snaps = collect(display, 'snapshot') as Array<{
      stream: string;
      data: Record<string, { count?: number }>;
    }>;
    display.emit('subscribe', {});
    await sleep(300);
    const visible = (
      await w.db
        .select()
        .from(gifts)
        .where(and(eq(gifts.eventId, w.eventId), eq(gifts.hidden, false)))
    ).length;
    expect(snaps.find((s) => s.stream === 'pub')!.data['giftList']!.count).toBe(visible);
  });
});
