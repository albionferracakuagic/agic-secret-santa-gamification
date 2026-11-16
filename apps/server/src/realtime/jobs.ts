import { GRANT_EXPIRE_JOB, writeAudit, type Db } from '@santa/db';
import type { JobRunner } from '../jobs/runner.js';
import type { RealtimeHub } from './hub.js';

export { GRANT_EXPIRE_JOB };

/** Durable counterpart of the in-hub send-time check: forces disconnect at grant expiry (idempotent). */
export function registerRealtimeJobs(runner: JobRunner, hub: RealtimeHub, db: Db) {
  runner.register(GRANT_EXPIRE_JOB, async (job) => {
    const { grantId } = job.payload as { grantId: string };
    hub.revokeGrant(grantId, 'expired');
    await writeAudit(db, {
      eventId: job.eventId,
      actor: 'system',
      action: 'unmask.expire',
      target: grantId,
    });
  });
}
