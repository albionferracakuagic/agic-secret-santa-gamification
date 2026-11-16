import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type PgDb = NodePgDatabase<typeof schema> & { $client: Pool };

export function createPgDb(connectionString: string, max = 10): PgDb {
  const pool = new Pool({ connectionString, max });
  return drizzle(pool, { schema }) as PgDb;
}
