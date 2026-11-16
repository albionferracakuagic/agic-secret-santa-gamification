import { describe, expect, it } from 'vitest';
import {
  ClientEvents,
  EventSettingsSchema,
  HealthResponseSchema,
  UnmaskRequestSchema,
  defaultEventSettings,
} from './index.js';

describe('contracts', () => {
  it('health schema is strict', () => {
    expect(HealthResponseSchema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(HealthResponseSchema.safeParse({ status: 'ok', extra: 1 }).success).toBe(false);
  });

  it('settings cannot lower privacy floors', () => {
    expect(defaultEventSettings()).toMatchObject({ minVoters: 5, hiddenMin: 2, showTotals: false });
    expect(EventSettingsSchema.safeParse({ minVoters: 4 }).success).toBe(false);
    expect(EventSettingsSchema.safeParse({ hiddenMin: 1 }).success).toBe(false);
  });

  it('unmask needs explicit confirm + reason; reactions are a fixed positive set', () => {
    expect(UnmaskRequestSchema.safeParse({ confirm: true, reason: 'fix assignment' }).success).toBe(
      true,
    );
    expect(UnmaskRequestSchema.safeParse({ confirm: true, reason: 'x' }).success).toBe(false);
    expect(ClientEvents['reaction.send'].safeParse({ kind: 'boo' }).success).toBe(false);
  });
});
