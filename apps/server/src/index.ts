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
import { registerVotingJobs } from './realtime/votingJobs.js';
import { AzureBlobStorage } from './storage/azure.js';

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
const social = socialFromEnv(env);
const email = new ConsoleEmailTransport();
const auth = createAuth({
  db,
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET ?? 'dev-only-secret-dev-only-secret-0000',
  email,
  ...social,
});
const app = buildApp({
  db,
  baseUrl: env.BETTER_AUTH_URL,
  email,
  ...(env.STORAGE_ACCOUNT_NAME
    ? {
        storage: new AzureBlobStorage({
          accountName: env.STORAGE_ACCOUNT_NAME,
          container: env.STORAGE_CONTAINER,
        }),
      }
    : {}),
  auth: createAuthModule(auth, db, undefined, {
    google: !!social.google,
    microsoft: !!social.microsoft,
  }),
});

const runner = new JobRunner(db, {
  onError: (job, err) => console.error('job failed', job.kind, err),
});
registerRealtimeJobs(runner, app.hub!, db);
registerVotingJobs(runner, app.hub!, db);

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
