import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDotenv } from './dotenv.js';
import { loadEnv } from './auth/config.js';

describe('loadDotenv', () => {
  let dir: string;
  let file: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dotenv-'));
    file = join(dir, '.env');
    delete process.env['DOTENV_TEST_A'];
    delete process.env['DOTENV_TEST_B'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  it('ignores a missing file', () => {
    expect(loadDotenv(join(dir, 'nope.env'))).toBe(false);
  });

  it('loads values but never overrides existing env', () => {
    writeFileSync(file, 'DOTENV_TEST_A=fromfile\nDOTENV_TEST_B=fromfile\n');
    process.env['DOTENV_TEST_B'] = 'real';
    expect(loadDotenv(file)).toBe(true);
    expect(process.env['DOTENV_TEST_A']).toBe('fromfile');
    expect(process.env['DOTENV_TEST_B']).toBe('real');
  });

  it('skips in production', () => {
    writeFileSync(file, 'DOTENV_TEST_A=fromfile\n');
    expect(loadDotenv(file, { NODE_ENV: 'production' })).toBe(false);
    expect(process.env['DOTENV_TEST_A']).toBeUndefined();
  });
});

describe('loadEnv empty values', () => {
  it('treats empty strings as unset', () => {
    const env = loadEnv({
      DATABASE_URL: '',
      WEB_DIST: '',
      GOOGLE_CLIENT_ID: '',
      BETTER_AUTH_URL: '',
      BETTER_AUTH_SECRET: '',
      PORT: '',
    });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.WEB_DIST).toBeUndefined();
    expect(env.BETTER_AUTH_URL).toBe('http://localhost:3000');
    expect(env.PORT).toBe(3000);
  });

  it('still requires non-empty secrets in production', () => {
    expect(() =>
      loadEnv({ NODE_ENV: 'production', BETTER_AUTH_SECRET: '', DATABASE_URL: '' }),
    ).toThrow(/required in production/);
  });
});
