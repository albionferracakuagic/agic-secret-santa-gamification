import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from './index.js';

describe('contracts', () => {
  it('health schema is strict', () => {
    expect(HealthResponseSchema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(HealthResponseSchema.safeParse({ status: 'ok', extra: 1 }).success).toBe(false);
  });
});
