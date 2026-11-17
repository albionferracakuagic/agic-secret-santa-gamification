import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MIGRATIONS_FOLDER } from './paths.js';
import { MIGRATE_LOCK_KEY, migrateCliMain, runLockedMigration } from './migrate.js';

describe('runLockedMigration', () => {
  it('takes the lock around the migration and always releases it', async () => {
    const calls: string[] = [];
    const lock = async () => {
      calls.push('lock');
      return async () => void calls.push('unlock');
    };
    await runLockedMigration({ lock, run: async () => void calls.push('run') });
    expect(calls).toEqual(['lock', 'run', 'unlock']);

    calls.length = 0;
    await expect(
      runLockedMigration({
        lock,
        run: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(calls).toEqual(['lock', 'unlock']);
  });

  it('is idempotent on a real (PGlite) database with the advisory lock', async () => {
    const client = new PGlite();
    const db = drizzle(client);
    const lock = async () => {
      await client.query('select pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
      return async () =>
        void (await client.query('select pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]));
    };
    const run = () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await runLockedMigration({ lock, run });
    await runLockedMigration({ lock, run });
    const r = await client.query<{ n: string }>(
      'select count(*)::text as n from pg_locks where locktype = $1',
      ['advisory'],
    );
    expect(r.rows[0]?.n).toBe('0');
    await client.close();
  });
});

describe('migrateCliMain', () => {
  it('exits 1 without DATABASE_URL and does not leak it on failure', async () => {
    const logs: string[] = [];
    const log = (m: string) => void logs.push(m);
    expect(await migrateCliMain({}, { log })).toBe(1);
    const url = 'postgres://u:s3cret@h/db';
    const code = await migrateCliMain(
      { DATABASE_URL: url },
      {
        log,
        migrate: async () => {
          throw new Error(`connect failed ${url}`);
        },
      },
    );
    expect(code).toBe(1);
    expect(logs.join('\n')).not.toContain('s3cret');
  });

  it('exits 0 on success', async () => {
    expect(
      await migrateCliMain(
        { DATABASE_URL: 'postgres://x/y' },
        { log: () => {}, migrate: async () => {} },
      ),
    ).toBe(0);
  });
});
