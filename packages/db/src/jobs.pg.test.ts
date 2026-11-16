import { describe } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPgDb } from './connect.js';
import { MIGRATIONS_FOLDER } from './paths.js';
import { seedDemoEvent } from './seed.js';
import { jobsSuite } from './jobs.suite.js';

const url = process.env['TEST_DATABASE_URL'];

// Real Postgres: exercises advisory locks + SKIP LOCKED with multiple pooled connections (CI service).
describe.skipIf(!url)('scheduled jobs (real Postgres)', () => {
  let shared: Awaited<ReturnType<typeof init>> | undefined;
  async function init() {
    const db = createPgDb(url!);
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`create schema public`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return { db, eventId: (await seedDemoEvent(db)).eventId };
  }
  jobsSuite(async () => (shared ??= await init()));
});
