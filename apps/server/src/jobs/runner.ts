import { randomUUID } from 'node:crypto';
import {
  claimDueJobs,
  completeJob,
  failJob,
  requeueRunningJobs,
  type ClaimedJob,
  type Db,
} from '@santa/db';

export type JobHandler = (job: ClaimedJob) => Promise<void>;

export interface JobRunnerOptions {
  workerId?: string;
  leaseMs?: number;
  batch?: number;
  maxAttempts?: number;
  backoffMs?: number;
  clock?: () => Date;
  onError?: (job: ClaimedJob, err: unknown) => void;
}

/**
 * Durable scheduler: all timers live in `scheduled_jobs`; this process only polls.
 * Delivery is at-least-once, so handlers MUST be idempotent (unique keys / state checks).
 */
export class JobRunner {
  readonly workerId: string;
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();
  private readonly leaseMs: number;
  private readonly batch: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly clock: () => Date;
  private readonly onError: JobRunnerOptions['onError'];

  constructor(
    private readonly db: Db,
    opts: JobRunnerOptions = {},
  ) {
    this.workerId = opts.workerId ?? `worker-${randomUUID()}`;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.batch = opts.batch ?? 10;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffMs = opts.backoffMs ?? 5_000;
    this.clock = opts.clock ?? (() => new Date());
    this.onError = opts.onError;
  }

  register(kind: string, handler: JobHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  /** One poll: claim due/expired-lease jobs, run them, record outcome. Returns number processed. */
  async tick(): Promise<number> {
    const jobs = await claimDueJobs(this.db, {
      workerId: this.workerId,
      now: this.clock(),
      limit: this.batch,
      leaseMs: this.leaseMs,
    });
    for (const job of jobs) {
      const handler = this.handlers.get(job.kind);
      try {
        if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
        await handler(job);
        await completeJob(this.db, job.id, this.workerId);
      } catch (err) {
        this.onError?.(job, err);
        await failJob(this.db, job, {
          workerId: this.workerId,
          now: this.clock(),
          error: err instanceof Error ? err.message : String(err),
          maxAttempts: this.maxAttempts,
          backoffMs: this.backoffMs,
        });
      }
    }
    return jobs.length;
  }

  /** `requeueAll`: single-replica MVP — jobs still 'running' belong to a dead process. */
  async start(opts: { intervalMs?: number; requeueAll?: boolean } = {}): Promise<void> {
    if (opts.requeueAll ?? true) await requeueRunningJobs(this.db);
    await this.tick();
    this.timer = setInterval(() => {
      this.inFlight = this.inFlight.then(() => this.tick()).catch(() => undefined);
    }, opts.intervalMs ?? 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}
