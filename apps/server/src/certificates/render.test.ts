import { describe, expect, it } from 'vitest';
import { CERT_HEIGHT, CERT_WIDTH, certificateArt, latinSafe, renderCertificate } from './render.js';

const input = {
  locale: 'en' as const,
  name: 'Anna Rossi',
  title: 'Santa Detective',
  description: 'Unmasked the most secret Santas',
  eventName: 'Secret Santa',
  year: 2026,
  seed: 'p:detective',
};

describe('certificate rendering (FR-041)', () => {
  it('folds text the bundled font subsets cannot draw', () => {
    expect(latinSafe('Łukasz Müller-Ñoño', 40)).toBe('Lukasz Müller-Ñoño');
    expect(latinSafe('Zoë  ✨ 太郎', 40)).toBe('Zoë ? ??');
    expect(latinSafe('x'.repeat(60), 10)).toHaveLength(10);
  });

  it('art is procedural: deterministic per seed, built from plain shapes only', () => {
    const a = certificateArt('seed-1');
    expect(a).toBe(certificateArt('seed-1'));
    expect(a).not.toBe(certificateArt('seed-2'));
    expect(a).not.toMatch(/<image|<use|href|<text|<script|<foreignObject/i);
  });

  it('renders a 1200x850 PNG for EN and IT from the licensed web fonts', async () => {
    const en = await renderCertificate(input);
    const it = await renderCertificate({
      ...input,
      locale: 'it',
      title: 'Detective di Babbo Natale',
    });
    for (const png of [en, it]) {
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(png.readUInt32BE(16)).toBe(CERT_WIDTH);
      expect(png.readUInt32BE(20)).toBe(CERT_HEIGHT);
    }
    expect(en.equals(it)).toBe(false);
    // same input = same picture
    expect((await renderCertificate(input)).equals(en)).toBe(true);
  }, 30_000);
});
