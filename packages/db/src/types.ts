import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema.js';

/** Any Drizzle Postgres database or transaction (node-postgres, PGlite). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
