/**
 * Boots the real server for full-stack e2e: PGlite in memory, the BUILT web app served from apps/web/dist,
 * a fake organizer session (cookie `sg_o=e2e-organizer:e2e-session`) instead of a real sign-in, local-FS media.
 *   npx tsx e2e/fullstack/boot.ts   (PORT defaults to 4180)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { user } from '@santa/db';
import { createTestDb } from '@santa/db/testing';
import { buildApp } from '../../apps/server/src/app.ts';
import { JobRunner } from '../../apps/server/src/jobs/runner.ts';
import { registerAutopilotJobs } from '../../apps/server/src/realtime/autopilot.ts';
import { registerCeremonyJobs } from '../../apps/server/src/realtime/ceremonyEvents.ts';
import { registerRealtimeJobs } from '../../apps/server/src/realtime/jobs.ts';
import { registerAuctionJobs } from '../../apps/server/src/realtime/phase3.ts';
import { registerRevealJobs } from '../../apps/server/src/realtime/reveal.ts';
import { registerVotingJobs } from '../../apps/server/src/realtime/votingJobs.ts';
import { LocalFsStorage } from '../../apps/server/src/storage/local.ts';
import { FakeOrganizerSessions } from '../../apps/server/src/testing/world.ts';

const port = Number(process.env['PORT'] ?? 4180);
const db = await createTestDb();
let now = Date.now();
const clock = () => new Date(now);
await db
  .insert(user)
  .values({ id: 'e2e-organizer', name: 'E2E Organizer', email: 'e2e@example.test' });

const organizerSessions = new FakeOrganizerSessions();
const app = buildApp({
  db,
  organizerSessions,
  guardEnv: 'test',
  baseUrl: `http://localhost:${port}`,
  webDist: resolve(import.meta.dirname, '../../apps/web/dist'),
  storage: new LocalFsStorage(mkdtempSync(join(tmpdir(), 'santa-e2e-')), 'e2e-media-secret'),
  rateLimitMax: 100_000,
  // Specs share one server/IP; per-route join limits (10 claims/min) would starve later specs.
  joinRateLimits: { resolve: 100_000, claim: 100_000 },
  clock,
});

const jobErrors: string[] = [];
const runner = new JobRunner(db, {
  clock,
  onError: (job, error) =>
    jobErrors.push(`${job.kind}: ${error instanceof Error ? error.message : String(error)}`),
});
registerRealtimeJobs(runner, app.hub!, db);
registerVotingJobs(runner, app.hub!, db, clock);
registerCeremonyJobs(runner, app.hub!, db, clock);
registerAuctionJobs(runner, app.hub!, db, clock);
registerRevealJobs(runner, app.hub!, db, clock);
registerAutopilotJobs(runner, app.hub!, db, clock);

app.get('/api/organizer/me', async (req, reply) => {
  const session = await organizerSessions.fromCookieHeader(req.headers.cookie);
  if (!session) return reply.status(401).send({ error: { code: 'unauthenticated' } });
  return {
    userId: session.userId,
    email: 'e2e@example.test',
    isPlatformAdmin: false,
  };
});

/** Test-only deterministic clock/job advancement; production never exposes this route. */
app.post('/__e2e/jobs/advance', async (req, reply) => {
  const ms = (req.body as { ms?: unknown } | null)?.ms;
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0)
    return reply.status(400).send({ error: 'invalid_ms' });

  now += ms;
  const errorsBefore = jobErrors.length;
  let processed = 0;
  for (let i = 0; i < 200; i++) {
    const batch = await runner.tick();
    processed += batch;
    if (batch === 0) break;
  }
  const errors = jobErrors.slice(errorsBefore);
  if (errors.length) return reply.status(500).send({ error: 'job_failed', errors });
  return { now: clock().toISOString(), processed };
});

await app.listen({ port, host: '127.0.0.1' });
console.log(`e2e server on http://localhost:${port}`);
