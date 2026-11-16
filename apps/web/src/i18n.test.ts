import { describe, expect, it } from 'vitest';
import { en } from './i18n/en';
import { it as itLocale } from './i18n/it';
import { FX_CATALOG } from './fx/catalog';

const keys = (o: unknown, p = ''): string[] =>
  Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`],
  );

describe('i18n', () => {
  it('EN and IT have exactly the same keys, none empty', () => {
    expect(keys(itLocale).sort()).toEqual(keys(en).sort());
    const flat = (o: unknown): string[] => JSON.stringify(o).match(/:""/g) ?? [];
    expect(flat(en)).toEqual([]);
    expect(flat(itLocale)).toEqual([]);
  });

  it('every FX cue has a text equivalent in both languages', () => {
    for (const id of Object.keys(FX_CATALOG)) {
      expect(en.fx).toHaveProperty(id);
      expect(itLocale.fx).toHaveProperty(id);
    }
  });
});
