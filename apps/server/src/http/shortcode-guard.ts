/**
 * Brute-force protection for short join codes, independent of client IP (IPs are cheap to rotate):
 *  - per code: more than `perCodeMax` lookups in a window locks THAT code for `lockMs` (stops hammering one code);
 *  - global: more than `globalFailMax` failed lookups in a window locks ALL short-code lookups for `lockMs`
 *    (a guessing campaign across many codes). QR join tokens are unaffected, so a lockout never stops joining.
 * In-memory (single replica, ADR-0005); entries expire so memory stays bounded.
 */
export interface ShortCodeGuardOptions {
  perCodeMax?: number;
  globalFailMax?: number;
  windowMs?: number;
  lockMs?: number;
}

export class ShortCodeGuard {
  private readonly perCodeMax: number;
  private readonly globalFailMax: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly codes = new Map<string, { hits: number[]; lockedUntil: number }>();
  private fails: number[] = [];
  private globalLockedUntil = 0;

  constructor(o: ShortCodeGuardOptions = {}) {
    this.perCodeMax = o.perCodeMax ?? 30;
    this.globalFailMax = o.globalFailMax ?? 100;
    this.windowMs = o.windowMs ?? 60_000;
    this.lockMs = o.lockMs ?? 60_000;
  }

  /** Call before looking a code up. Returns false while the code or the whole mechanism is locked. */
  allow(code: string, now: number): boolean {
    if (now < this.globalLockedUntil) return false;
    this.prune(now);
    const e = this.codes.get(code) ?? { hits: [], lockedUntil: 0 };
    if (now < e.lockedUntil) return false;
    e.hits = e.hits.filter((t) => now - t < this.windowMs);
    e.hits.push(now);
    if (e.hits.length > this.perCodeMax) {
      e.lockedUntil = now + this.lockMs;
      e.hits = [];
      this.codes.set(code, e);
      return false;
    }
    this.codes.set(code, e);
    return true;
  }

  /** Call when a lookup found nothing. */
  fail(now: number): void {
    this.fails = this.fails.filter((t) => now - t < this.windowMs);
    this.fails.push(now);
    if (this.fails.length > this.globalFailMax) {
      this.globalLockedUntil = now + this.lockMs;
      this.fails = [];
    }
  }

  private prune(now: number) {
    if (this.codes.size < 5000) return;
    for (const [k, v] of this.codes)
      if (now >= v.lockedUntil && v.hits.every((t) => now - t >= this.windowMs))
        this.codes.delete(k);
  }
}
