import { describe, expect, it } from 'vitest';
import { effectiveIntensity, isReducedMotion, lowerIntensity } from './store';

describe('prefs', () => {
  it('reduced motion (user or system) forces visuals off; user override beats system', () => {
    expect(effectiveIntensity({ intensity: 'high', reducedMotion: 'system' }, 'high', true)).toBe(
      'off',
    );
    expect(effectiveIntensity({ intensity: 'high', reducedMotion: 'off' }, 'high', true)).toBe(
      'high',
    );
    expect(effectiveIntensity({ intensity: 'normal', reducedMotion: 'on' }, 'high', false)).toBe(
      'off',
    );
    expect(isReducedMotion({ reducedMotion: 'system' }, false)).toBe(false);
  });

  it('auto-degrade cap lowers but never raises the effective level', () => {
    expect(effectiveIntensity({ intensity: 'high', reducedMotion: 'off' }, 'low', false)).toBe(
      'low',
    );
    expect(effectiveIntensity({ intensity: 'low', reducedMotion: 'off' }, 'high', false)).toBe(
      'low',
    );
    expect(lowerIntensity('off')).toBe('off');
    expect(lowerIntensity('high')).toBe('normal');
  });
});
