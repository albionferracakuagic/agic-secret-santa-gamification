import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ERROR_CODES, ApiErrorBodySchema } from '@santa/contracts';
import { STATUS } from './routes/guards.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === 'dist' ? [] : sources(p);
    return /\.ts$/.test(n) && !/\.(test|suite)\.ts$/.test(n) ? [p] : [];
  });

const PATTERNS = [
  /new EventError\(\s*'([a-z_]+)'/g,
  /fail\(\s*\w+,\s*\d+,\s*'([a-z_]+)'/g,
  /error: \{ code: '([a-z_]+)'/g,
  /err\('([a-z_]+)'/g,
];

describe('shared API error code enum', () => {
  it('every code used by server or db source is declared in @santa/contracts', () => {
    const used = new Set<string>();
    for (const dir of ['apps/server/src', 'packages/db/src'])
      for (const f of sources(join(root, dir))) {
        const text = readFileSync(f, 'utf8');
        for (const re of PATTERNS) for (const m of text.matchAll(re)) used.add(m[1]!);
      }
    expect(used.size).toBeGreaterThan(30); // the scan really found codes
    const declared = new Set<string>(API_ERROR_CODES);
    expect([...used].filter((c) => !declared.has(c))).toEqual([]);
  });

  it('every status-mapped code is in the enum, and the participant-facing ones are present', () => {
    const declared = new Set<string>(API_ERROR_CODES);
    expect(Object.keys(STATUS).filter((c) => !declared.has(c))).toEqual([]);
    for (const c of ['verification_required', 'own_gift', 'gift_locked'])
      expect(declared.has(c)).toBe(true);
  });

  it('error bodies are strict and reject unknown codes', () => {
    expect(
      ApiErrorBodySchema.safeParse({ error: { code: 'own_gift', message: 'x' } }).success,
    ).toBe(true);
    expect(ApiErrorBodySchema.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(
      false,
    );
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });
});
