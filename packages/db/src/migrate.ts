import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPgDb } from './connect.js';
import { MIGRATIONS_FOLDER } from './paths.js';

/** Session-level advisory lock key serialising concurrent migration runs. */
export const MIGRATE_LOCK_KEY = 7_340_002;

export interface LockedMigration {
  /** Acquires the lock (blocking) and resolves to its release function. */
  lock: () => Promise<() => Promise<void>>;
  run: () => Promise<void>;
}

export async function runLockedMigration({ lock, run }: LockedMigration): Promise<void> {
  const release = await lock();
  try {
    await run();
  } finally {
    await release();
  }
}

async function migratePostgres(databaseUrl: string): Promise<void> {
  const db = createPgDb(databaseUrl, 2);
  // the lock lives on a dedicated connection; the migrator uses another one from the pool
  const lockClient = await db.$client.connect();
  try {
    await runLockedMigration({
      lock: async () => {
        await lockClient.query('select pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
        return async () => {
          await lockClient.query('select pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]);
        };
      },
      run: () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    });
  } finally {
    lockClient.release();
    await db.$client.end();
  }
}

export interface MigrateCliDeps {
  log?: (msg: string) => void;
  migrate?: (databaseUrl: string) => Promise<void>;
}

/** Returns the process exit code. Never logs the connection string or raw driver errors. */
export async function migrateCliMain(
  env: NodeJS.ProcessEnv,
  { log = console.log, migrate: doMigrate = migratePostgres }: MigrateCliDeps = {},
): Promise<number> {
  const url = env['DATABASE_URL'];
  if (!url) {
    log('migrate: DATABASE_URL is required');
    return 1;
  }
  try {
    log('migrate: applying migrations');
    await doMigrate(url);
    log('migrate: done');
    return 0;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    log(
      `migrate: failed (${err instanceof Error ? err.name : 'error'}${code ? ` ${String(code)}` : ''})`,
    );
    return 1;
  }
}
