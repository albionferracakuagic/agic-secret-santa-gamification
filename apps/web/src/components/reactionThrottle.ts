/** Client-side reaction pacing: soft burst cap so the UI cools down gently before the server would rate-limit. */
export function createReactionThrottle(opts: {
  burst?: number;
  windowMs?: number;
  now?: () => number;
}) {
  const burst = opts.burst ?? 4;
  const windowMs = opts.windowMs ?? 3000;
  const now = opts.now ?? Date.now;
  let stamps: number[] = [];
  const prune = () => {
    const t = now();
    stamps = stamps.filter((s) => t - s < windowMs);
  };
  return {
    /** true => may send now (and records it). */
    tryAcquire(): boolean {
      prune();
      if (stamps.length >= burst) return false;
      stamps.push(now());
      return true;
    },
    /** ms until a slot frees up (0 when available). */
    waitMs(): number {
      prune();
      return stamps.length < burst ? 0 : windowMs - (now() - stamps[0]!);
    },
  };
}
