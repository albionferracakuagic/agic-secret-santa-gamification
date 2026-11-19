import { mkdirSync } from 'node:fs';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPgDb, MIGRATIONS_FOLDER, type Db } from '@santa/db';
import { buildApp } from './app.js';
import { createAuth } from './auth/auth.js';
import { loadEnv, socialFromEnv } from './auth/config.js';
import { createEmailTransport } from './auth/email-factory.js';
import { createAuthModule } from './auth/routes.js';
import { JobRunner } from './jobs/runner.js';
import { registerRealtimeJobs } from './realtime/jobs.js';
import { registerVotingJobs } from './realtime/votingJobs.js';
import { registerCeremonyJobs } from './realtime/ceremonyEvents.js';
import { registerPhase2Jobs } from './realtime/phase2.js';
import { registerAuctionJobs } from './realtime/phase3.js';
import { ensureDailyRetention, registerRetentionJob } from './realtime/retentionJob.js';
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
// fails startup in production unless ACS is configured (console transport prints magic links)
const email = createEmailTransport(env);
const auth = createAuth({
  db,
  baseURL: env.BETTER_AUTH_URL,
  // dev: browser talks to the Vite origin (proxying /api), which differs from the server port
  ...(env.NODE_ENV === 'production'
    ? {}
    : { trustedOrigins: [env.BETTER_AUTH_URL, 'http://localhost:5173'] }),
  secret: env.BETTER_AUTH_SECRET ?? 'dev-only-secret-dev-only-secret-0000',
  email,
  ...social,
});
const app = buildApp({
  db,
  baseUrl: env.BETTER_AUTH_URL,
  trustProxyHops: env.TRUST_PROXY_HOPS,
  platformAdminEmails: (env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean),
  ...(env.WEB_DIST ? { webDist: env.WEB_DIST } : {}),
  ...(env.STORAGE_ACCOUNT_NAME
    ? { cspImgSources: [`https://${env.STORAGE_ACCOUNT_NAME}.blob.core.windows.net`] }
    : {}),
  logging: true,
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
registerCeremonyJobs(runner, app.hub!, db);
registerPhase2Jobs(runner, app.hub!, db);
registerAuctionJobs(runner, app.hub!, db);
registerRetentionJob(runner, db, app.hub!.ctx.storage);
await ensureDailyRetention(db);

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  // several replicas: a 'running' job may belong to a live sibling, so no blanket requeue (leases recover crashes)
  await runner.start({ requeueAll: process.env['SCALE_OUT'] !== 'true' });
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
