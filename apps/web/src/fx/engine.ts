import { effectiveIntensity, type Intensity, type PrefsState } from '../prefs/store';
import { EVENT_TO_CUE, FX_CATALOG, type FxEvent, type SfxId } from './catalog';

export interface FxHost {
  emoji(glyph: string, count: number, durationMs: number): void;
  confetti(count: number): void;
  fireworks(bursts: number): void;
  snow(on: boolean, density: number): void;
  lights(on: boolean): void;
  /** ARIA-live (and visible caption in reduced-motion). Always called, whatever the intensity. */
  announce(text: string): void;
  play(sfx: SfxId): void;
}

export interface FxEngineDeps {
  host: FxHost;
  getPrefs: () => Pick<PrefsState, 'sound' | 'intensity' | 'reducedMotion'>;
  /** Auto-degrade ceiling (perf monitor). */
  getCap: () => Intensity;
  translate: (key: string) => string;
  systemReduce?: () => boolean;
  now?: () => number;
  /** Same cue within this window is dropped (reaction spam protection). */
  minGapMs?: number;
}

export const INTENSITY_FACTOR: Record<Intensity, number> = {
  off: 0,
  low: 0.4,
  normal: 1,
  high: 1.6,
};

export function createFxEngine(d: FxEngineDeps) {
  const now = d.now ?? Date.now;
  const gap = d.minGapMs ?? 150;
  const lastAt = new Map<string, number>();

  const level = () => effectiveIntensity(d.getPrefs(), d.getCap(), d.systemReduce?.());

  return {
    emit(event: FxEvent, opts: { glyph?: string } = {}) {
      const cue = FX_CATALOG[EVENT_TO_CUE[event]];
      const t = now();
      if (t - (lastAt.get(cue.id) ?? -Infinity) < gap) return;
      lastAt.set(cue.id, t);

      d.host.announce(d.translate(`fx.${cue.id}`)); // text equivalent for every cue

      const lv = level();
      if (lv === 'off') return; // reduced motion / user off: no visuals, no motion
      const f = INTENSITY_FACTOR[lv];
      if (d.getPrefs().sound && 'sfx' in cue) d.host.play(cue.sfx);
      const v = cue.visual;
      if (v.kind === 'emoji')
        d.host.emoji(opts.glyph ?? v.glyph, Math.max(1, Math.round(v.count * f)), v.durationMs);
      else if (v.kind === 'confetti') d.host.confetti(Math.max(10, Math.round(v.count * f)));
      else d.host.fireworks(Math.max(1, Math.round(v.bursts * f)));
    },

    setAmbient(on: boolean) {
      const lv = level();
      const active = on && lv !== 'off';
      d.host.snow(active, INTENSITY_FACTOR[lv]);
      d.host.lights(active && lv !== 'low');
      if (on) d.host.announce(d.translate('fx.snowfall'));
    },
  };
}

export type FxEngine = ReturnType<typeof createFxEngine>;
