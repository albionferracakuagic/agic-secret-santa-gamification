import type { JobRunner } from '../jobs/runner.js';
import type { RealtimeHub } from './hub.js';

export const GRANT_EXPIRE_JOB = 'grant.expire';

/** Durable counterpart of the in-hub send-time check: forces disconnect at grant expiry. */
export function registerRealtimeJobs(runner: JobRunner, hub: RealtimeHub) {
  runner.register(GRANT_EXPIRE_JOB, async (job) => {
    const { grantId } = job.payload as { grantId: string };
    hub.revokeGrant(grantId, 'expired');
  });
}
