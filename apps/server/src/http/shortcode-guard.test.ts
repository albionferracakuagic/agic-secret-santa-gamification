import { describe, expect, it } from 'vitest';
import { ShortCodeGuard } from './shortcode-guard.js';

describe('ShortCodeGuard', () => {
  it('locks one code after too many lookups, others stay usable, lock expires', () => {
    const g = new ShortCodeGuard({ perCodeMax: 3, lockMs: 1000, windowMs: 10_000 });
    expect([1, 2, 3].map(() => g.allow('AAAAAAAAAA', 0))).toEqual([true, true, true]);
    expect(g.allow('AAAAAAAAAA', 1)).toBe(false);
    expect(g.allow('AAAAAAAAAA', 500)).toBe(false);
    expect(g.allow('BBBBBBBBBB', 500)).toBe(true);
    expect(g.allow('AAAAAAAAAA', 1500)).toBe(true);
  });

  it('a global failure budget locks every short code regardless of which codes were tried', () => {
    const g = new ShortCodeGuard({ globalFailMax: 5, lockMs: 1000, windowMs: 10_000 });
    for (let i = 0; i < 6; i++) {
      expect(g.allow(`CODE${i}`, i)).toBe(true);
      g.fail(i);
    }
    expect(g.allow('ANOTHERCODE', 10)).toBe(false);
    expect(g.allow('ANOTHERCODE', 1100)).toBe(true);
  });

  it('failures outside the window do not accumulate', () => {
    const g = new ShortCodeGuard({ globalFailMax: 2, windowMs: 100, lockMs: 1000 });
    for (let i = 0; i < 10; i++) g.fail(i * 200);
    expect(g.allow('X', 5000)).toBe(true);
  });
});
