import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processGiftPhoto, ImageError } from '../images/process.js';
import { AzureBlobStorage, type BlobServiceLike } from './azure.js';
import { LocalFsStorage } from './local.js';
import { isValidKey, newGiftPhotoKey } from './adapter.js';

describe('storage keys', () => {
  it('generates opaque renamed keys and rejects anything outside the namespace', () => {
    const k = newGiftPhotoKey('0b8d2f4a-1111-4222-8333-444455556666');
    expect(k).toMatch(/^gifts\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/);
    expect(isValidKey(k)).toBe(true);
    for (const bad of [
      '../etc/passwd',
      'gifts/../x.jpg',
      '/abs.jpg',
      'gifts/A.JPG',
      'x',
      'gifts/a/b.jpg?x=1',
    ]) {
      expect(isValidKey(bad), bad).toBe(false);
    }
  });
});

describe('LocalFsStorage signed URLs', () => {
  let dir: string;
  let now = 1_800_000_000_000;
  let st: LocalFsStorage;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'santa-media-'));
    st = new LocalFsStorage(dir, 'secret-secret', () => now);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const parts = (url: string) => {
    const u = new URL(url, 'http://x');
    return {
      key: u.pathname.replace('/media/', ''),
      exp: Number(u.searchParams.get('exp')),
      sig: u.searchParams.get('sig')!,
    };
  };

  it('serves bytes only with a valid, unexpired signature; tampering/expiry/traversal fail', async () => {
    const key = 'gifts/e1/abc.jpg';
    await st.put(key, Buffer.from('JPEGDATA'));
    const { exp, sig } = parts(await st.readUrl(key, 600));
    expect((await st.readSigned(key, exp, sig))?.toString()).toBe('JPEGDATA');
    expect(await st.readSigned(key, exp, sig.slice(0, -2) + 'AA')).toBeNull();
    expect(await st.readSigned('gifts/e1/other.jpg', exp, sig)).toBeNull();
    expect(await st.readSigned(key, exp + 1, sig)).toBeNull();
    expect(await st.readSigned('../../etc/passwd', exp, sig)).toBeNull();
    now += 601_000;
    expect(await st.readSigned(key, exp, sig)).toBeNull(); // expired
    await st.delete(key);
    now -= 601_000;
    expect(await st.readSigned(key, exp, sig)).toBeNull(); // deleted
    await expect(st.put('../evil.jpg', Buffer.from('x'))).rejects.toThrow('invalid storage key');
  });
});

describe('AzureBlobStorage (fake client: no network)', () => {
  const calls: string[] = [];
  let keyFetches = 0;
  const client: BlobServiceLike = {
    async getUserDelegationKey(start, expiry) {
      keyFetches++;
      return {
        signedObjectId: 'oid',
        signedTenantId: 'tid',
        signedStartsOn: start,
        signedExpiresOn: expiry,
        signedService: 'b',
        signedVersion: '2023-11-03',
        value: Buffer.from('k'.repeat(32)).toString('base64'),
      };
    },
    getContainerClient: (c) => ({
      getBlockBlobClient: (blob) => ({
        url: `https://acct.blob.core.windows.net/${c}/${blob}`,
        uploadData: async (_d, o) =>
          void calls.push(`put:${blob}:${o.blobHTTPHeaders.blobContentType}`),
        deleteIfExists: async () => void calls.push(`del:${blob}`),
      }),
    }),
  };
  let now = Date.parse('2026-12-24T20:00:00Z');
  const st = new AzureBlobStorage({
    accountName: 'acct',
    container: 'media',
    client,
    now: () => now,
  });

  it('mints read-only, https-only, short-lived user-delegation SAS URLs and caches the delegation key', async () => {
    const url = new URL(await st.readUrl('gifts/e1/a.jpg', 600));
    expect(url.origin + url.pathname).toBe(
      'https://acct.blob.core.windows.net/media/gifts/e1/a.jpg',
    );
    expect(url.searchParams.get('sp')).toBe('r');
    expect(url.searchParams.get('spr')).toBe('https');
    expect(url.searchParams.get('sig')).toBeTruthy();
    expect(Date.parse(url.searchParams.get('se')!)).toBe(now + 600_000);
    await st.readUrl('gifts/e1/b.jpg', 600);
    expect(keyFetches).toBe(1); // cached
    now += 56 * 60_000; // inside the 5-minute refresh margin of the 60-minute key
    await st.readUrl('gifts/e1/c.jpg', 600);
    expect(keyFetches).toBe(2);
  });

  it('uploads with content type, deletes, and refuses keys outside the namespace', async () => {
    await st.put('gifts/e1/a.jpg', Buffer.from('x'), 'image/jpeg');
    await st.delete('gifts/e1/a.jpg');
    expect(calls).toEqual(['put:gifts/e1/a.jpg:image/jpeg', 'del:gifts/e1/a.jpg']);
    await expect(st.put('../x.jpg', Buffer.from('x'), 'image/jpeg')).rejects.toThrow(
      'invalid storage key',
    );
    await expect(st.readUrl('nope', 60)).rejects.toThrow('invalid storage key');
  });
});

describe('processGiftPhoto', () => {
  const jpegWithExif = () =>
    sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#cc0000' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Copyright: 'SECRET-COPYRIGHT', ImageDescription: 'GPS-HOME-ADDRESS' } })
      .toBuffer();

  it('strips EXIF (incl. GPS-like tags), applies orientation, resizes to <=1600 and re-encodes as JPEG', async () => {
    const input = await jpegWithExif();
    const inMeta = await sharp(input).metadata();
    expect(inMeta.exif).toBeDefined(); // sanity: the fixture really carries EXIF
    expect(input.includes(Buffer.from('SECRET-COPYRIGHT'))).toBe(true);

    const out = await processGiftPhoto(input);
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(out.data.includes(Buffer.from('SECRET-COPYRIGHT'))).toBe(false);
    expect(out.data.includes(Buffer.from('GPS-HOME-ADDRESS'))).toBe(false);
    // 3000x2000 with orientation 6 displays as 2000x3000 -> fit inside 1600
    expect([out.width, out.height]).toEqual([1067, 1600]);
  });

  it('never upscales small images; accepts PNG/WebP; rejects non-images, other formats and oversized pixel counts', async () => {
    const small = await sharp({
      create: { width: 200, height: 100, channels: 4, background: '#00ff0080' },
    })
      .png()
      .toBuffer();
    expect(await processGiftPhoto(small)).toMatchObject({
      width: 200,
      height: 100,
      mime: 'image/jpeg',
    });
    const webp = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } })
      .webp()
      .toBuffer();
    expect((await processGiftPhoto(webp)).width).toBe(50);

    await expect(
      processGiftPhoto(
        Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
      ),
    ).rejects.toBeInstanceOf(ImageError);
    await expect(processGiftPhoto(Buffer.from('just text'))).rejects.toBeInstanceOf(ImageError);
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } })
      .gif()
      .toBuffer();
    await expect(processGiftPhoto(gif)).rejects.toBeInstanceOf(ImageError);
    const huge = await sharp({
      create: { width: 7000, height: 7000, channels: 3, background: '#fff' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(processGiftPhoto(huge)).rejects.toBeInstanceOf(ImageError); // 49 MP > 40 MP guard
  }, 30_000);
});
