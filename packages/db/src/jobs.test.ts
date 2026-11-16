import { describe } from 'vitest';
import { createTestDb, type TestDb } from './testing.js';
import { seedDemoEvent } from './seed.js';
import { jobsSuite } from './jobs.suite.js';

describe('scheduled jobs (PGlite)', () => {
  let shared: { db: TestDb; eventId: string } | undefined;
  jobsSuite(async () => {
    if (!shared) {
      const db = await createTestDb();
      shared = { db, eventId: (await seedDemoEvent(db)).eventId };
    }
    return shared;
  });
});
