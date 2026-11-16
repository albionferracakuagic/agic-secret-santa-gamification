import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema.js';
import { MIGRATIONS_FOLDER } from './paths.js';

export type TestDb = PgliteDatabase<typeof schema> & { $client: PGlite };

/** Fresh in-memory Postgres (PGlite) with all migrations applied. `dataDir` persists it (dev). */
export async function createTestDb(dataDir?: string): Promise<TestDb> {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db as TestDb;
}
