import { mkdirSync } from 'node:fs';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPgDb, MIGRATIONS_FOLDER, type Db } from '@santa/db';
import { buildApp } from './app.js';
import { createAuth } from './auth/auth.js';
import { loadEnv, socialFromEnv } from './auth/config.js';
import { ConsoleEmailTransport } from './auth/email.js';
import { createAuthModule } from './auth/routes.js';
import { JobRunner } from './jobs/runner.js';
import { registerRealtimeJobs } from './realtime/jobs.js';

const env = loadEnv();

async function connect(): Promise<Db> {
  if (env.DATABASE_URL) {
    // Prod migrations run as a deploy step (ADR-0005); auto-migrate only for local Postgres.
    const db = createPgDb(env.DATABASE_URL);
    if (env.NODE_ENV !== 'production') await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
  }
  if (env.NODE_ENV === 'production') throw new Error('DATABASE_URL required');
  const { createTestDb } = await import('@santa/db/testing');
  mkdirSync('.data', { recursive: true });
  return createTestDb('.data/dev-pglite');
}

const db = await connect();
const auth = createAuth({
  db,
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET ?? 'dev-only-secret-dev-only-secret-0000',
  email: new ConsoleEmailTransport(),
  ...socialFromEnv(env),
});
const app = buildApp({ db, auth: createAuthModule(auth, db) });

const runner = new JobRunner(db, {
  onError: (job, err) => console.error('job failed', job.kind, err),
});
registerRealtimeJobs(runner, app.hub!);

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  await runner.start();
  console.log(`server listening on :${env.PORT}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    void runner
      .stop()
      .then(() => app.close())
      .then(() => process.exit(0));
  });
}
