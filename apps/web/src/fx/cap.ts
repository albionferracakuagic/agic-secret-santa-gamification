import { create } from 'zustand';
import { lowerIntensity, type Intensity } from '../prefs/store';

/** Auto-degrade ceiling: effective intensity = min(user pref, cap). */
export const useFxCap = create<{ cap: Intensity; degrade: () => void }>((set) => ({
  cap: 'high',
  degrade: () => set((s) => ({ cap: lowerIntensity(s.cap) })),
}));
