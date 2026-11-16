/**
 * Frame-time monitor for FX auto-degrade (ADR-0006): sustained average frame time above `slowMs`
 * (~<40 fps) over `windowMs` => caller lowers intensity one level. Client-local, never reported.
 */
export class FrameMonitor {
  private samples: Array<{ t: number; dt: number }> = [];
  constructor(
    private readonly o: { windowMs?: number; slowMs?: number; minSamples?: number } = {},
  ) {}

  push(dtMs: number, nowMs: number): boolean {
    const windowMs = this.o.windowMs ?? 1000;
    this.samples.push({ t: nowMs, dt: dtMs });
    while (this.samples.length && nowMs - this.samples[0]!.t > windowMs) this.samples.shift();
    const first = this.samples[0]!;
    const spanned = nowMs - first.t >= windowMs * 0.9;
    if (!spanned || this.samples.length < (this.o.minSamples ?? 15)) return false;
    const avg = this.samples.reduce((a, s) => a + s.dt, 0) / this.samples.length;
    if (avg > (this.o.slowMs ?? 25)) {
      this.samples = []; // give the lower level time to prove itself
      return true;
    }
    return false;
  }
}
