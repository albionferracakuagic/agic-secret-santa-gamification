import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTestDb } from './testing.js';
import { seedDemoEvent } from './seed.js';

const dataDir = process.argv[2] ?? '.data/dev-pglite';
mkdirSync(dirname(dataDir), { recursive: true });
const db = await createTestDb(dataDir);
const { eventId, participantIds } = await seedDemoEvent(db);
console.log(`seeded demo event ${eventId} (${participantIds.length} participants) into ${dataDir}`);
await db.$client.close();
