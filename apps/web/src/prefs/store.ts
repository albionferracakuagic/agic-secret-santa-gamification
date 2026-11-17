import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Intensity = 'off' | 'low' | 'normal' | 'high';
export type ReducedMotionPref = 'system' | 'on' | 'off';

export interface PrefsState {
  sound: boolean;
  music: boolean;
  intensity: Intensity;
  reducedMotion: ReducedMotionPref;
  set: (patch: Partial<Omit<PrefsState, 'set'>>) => void;
}

/** FR-038. Sound and music are opt-in (browsers also require a user gesture to play audio). */
export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      sound: false,
      music: false,
      intensity: 'normal',
      reducedMotion: 'system',
      set: (patch) => set(patch),
    }),
    {
      name: 'sg.prefs',
      partialize: ({ sound, music, intensity, reducedMotion }) => ({
        sound,
        music,
        intensity,
        reducedMotion,
      }),
    },
  ),
);

const ORDER: Intensity[] = ['off', 'low', 'normal', 'high'];
export const lowerIntensity = (i: Intensity): Intensity =>
  ORDER[Math.max(0, ORDER.indexOf(i) - 1)]!;

export function systemPrefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** User choice wins over system; reduced motion forces visuals off (text equivalents stay). */
export function isReducedMotion(
  p: Pick<PrefsState, 'reducedMotion'>,
  system = systemPrefersReducedMotion(),
) {
  return p.reducedMotion === 'on' || (p.reducedMotion === 'system' && system);
}

export function effectiveIntensity(
  p: Pick<PrefsState, 'intensity' | 'reducedMotion'>,
  cap: Intensity = 'high',
  system = systemPrefersReducedMotion(),
): Intensity {
  if (isReducedMotion(p, system)) return 'off';
  return ORDER[Math.min(ORDER.indexOf(p.intensity), ORDER.indexOf(cap))]!;
}
