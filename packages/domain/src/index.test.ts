import { describe, expect, it } from 'vitest';
import { PHASES } from './index.js';

describe('domain', () => {
  it('phases start at preparation and end at completed', () => {
    expect(PHASES[0]).toBe('preparation');
    expect(PHASES.at(-1)).toBe('completed');
  });
});
