import { RETENTION_JOB, enqueueJob, ensureRetentionJob, sweepRetention, type Db } from '@santa/db';
import type { JobRunner } from '../jobs/runner.js';
import type { StorageAdapter } from '../storage/adapter.js';

const DAY_MS = 86_400_000;

/**
 * Daily retention sweep (photos / roster emails after the event). Idempotent: a blob is forgotten only after
 * its deletion succeeded; if the sweep throws, the job runner retries and the next daily job is still queued.
 */
export function registerRetentionJob(
  runner: JobRunner,
  db: Db,
  storage: StorageAdapter | undefined,
  clock: () => Date = () => new Date(),
) {
  runner.register(RETENTION_JOB, async () => {
    const now = clock();
    // schedule tomorrow first so a failing sweep can never stop the daily cadence
    await enqueueJob(db, { kind: RETENTION_JOB, runAt: new Date(now.getTime() + DAY_MS) });
    await sweepRetention(db, {
      now,
      deleteBlob: async (key) => {
        await storage?.delete(key);
      },
    });
  });
}

export const ensureDailyRetention = (db: Db, now = new Date()) => ensureRetentionJob(db, now);
