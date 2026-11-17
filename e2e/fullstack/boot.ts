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
import { LocalFsStorage } from '../../apps/server/src/storage/local.ts';
import { FakeOrganizerSessions } from '../../apps/server/src/testing/world.ts';

const port = Number(process.env['PORT'] ?? 4180);
const db = await createTestDb();
await db
  .insert(user)
  .values({ id: 'e2e-organizer', name: 'E2E Organizer', email: 'e2e@example.test' });

const app = buildApp({
  db,
  organizerSessions: new FakeOrganizerSessions(),
  guardEnv: 'test',
  baseUrl: `http://localhost:${port}`,
  webDist: resolve(import.meta.dirname, '../../apps/web/dist'),
  storage: new LocalFsStorage(mkdtempSync(join(tmpdir(), 'santa-e2e-')), 'e2e-media-secret'),
  rateLimitMax: 100_000,
});
await app.listen({ port, host: '127.0.0.1' });
console.log(`e2e server on http://localhost:${port}`);
