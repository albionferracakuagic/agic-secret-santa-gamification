import { describe, expect, it } from 'vitest';
import { isSafeZip, ZIP_LIMITS } from './zip.js';
import { parseUpload, ParseError } from './parse.js';

/** Minimal archive: only the central directory matters to the guard, so entry data is omitted. */
function craftZip(entries: Array<{ name?: string; compressed: number; uncompressed: number }>) {
  const cds = entries.map((e) => {
    const name = Buffer.from(e.name ?? 'xl/worksheets/sheet1.xml');
    const h = Buffer.alloc(46 + name.length);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt32LE(e.compressed >>> 0, 20);
    h.writeUInt32LE(e.uncompressed >>> 0, 24);
    h.writeUInt16LE(name.length, 28);
    name.copy(h, 46);
    return h;
  });
  const cd = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([cd, eocd]);
}

describe('isSafeZip', () => {
  it('accepts a normal small archive', () => {
    expect(isSafeZip(craftZip([{ compressed: 800, uncompressed: 4000 }]))).toBe(true);
  });

  it('rejects a high-ratio bomb, an oversized total and too many entries', () => {
    expect(isSafeZip(craftZip([{ compressed: 1000, uncompressed: 40 * 1024 * 1024 }]))).toBe(false);
    const big = ZIP_LIMITS.maxTotalUncompressed / 4 + 1;
    expect(
      isSafeZip(
        craftZip(Array.from({ length: 5 }, () => ({ compressed: big / 2, uncompressed: big }))),
      ),
    ).toBe(false);
    expect(
      isSafeZip(
        craftZip(
          Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, () => ({
            compressed: 10,
            uncompressed: 10,
          })),
        ),
      ),
    ).toBe(false);
  });

  it('rejects zip64 markers, truncated and non-zip data', () => {
    expect(isSafeZip(craftZip([{ compressed: 10, uncompressed: 0xffffffff }]))).toBe(false);
    expect(isSafeZip(craftZip([{ compressed: 10, uncompressed: 10 }]).subarray(0, 30))).toBe(false);
    expect(isSafeZip(Buffer.from('hello world'))).toBe(false);
  });

  it('parseUpload refuses a bomb with a generic invalid_file error before any inflation', async () => {
    const bomb = craftZip([{ compressed: 1000, uncompressed: 40 * 1024 * 1024 }]);
    await expect(parseUpload(bomb, 'roster.xlsx')).rejects.toMatchObject({ code: 'invalid_file' });
    await expect(parseUpload(bomb, 'roster.xlsx')).rejects.toBeInstanceOf(ParseError);
  });
});
