import { beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  cancelJobs,
  claimDueJobs,
  completeJob,
  enqueueJob,
  failJob,
  requeueRunningJobs,
} from './jobs.js';
import * as s from './schema.js';
import type { Db } from './types.js';

const T0 = new Date('2026-12-24T20:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const claim = (db: Db, workerId: string, now: Date, leaseMs = 60_000) =>
  claimDueJobs(db, { workerId, now, limit: 10, leaseMs });
const status = async (db: Db, id: string) =>
  (await db.select().from(s.scheduledJobs).where(eq(s.scheduledJobs.id, id)))[0]!;

/** Shared behaviour suite: run on PGlite always and on real Postgres in CI (jobs.pg.test.ts). */
export function jobsSuite(makeDb: () => Promise<{ db: Db; eventId: string }>) {
  let db: Db;
  let eventId: string;
  beforeEach(async () => {
    ({ db, eventId } = await makeDb());
    await db.delete(s.scheduledJobs);
  });

  it('claims only due jobs and marks them running', async () => {
    const due = await enqueueJob(db, { kind: 'a', runAt: at(-1000) });
    const later = await enqueueJob(db, { kind: 'b', runAt: at(60_000) });
    const got = await claim(db, 'w1', T0);
    expect(got.map((j) => j.id)).toEqual([due]);
    expect((await status(db, due)).status).toBe('running');
    expect((await status(db, later)).status).toBe('pending');
  });

  it('two pollers racing never claim the same job', async () => {
    for (let i = 0; i < 6; i++) await enqueueJob(db, { kind: 'k', runAt: at(-1) });
    const [a, b] = await Promise.all([claim(db, 'w1', T0), claim(db, 'w2', T0)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });

  it('crash recovery: a running job whose lease expired is re-claimed by another worker', async () => {
    const id = await enqueueJob(db, { kind: 'a', runAt: at(-1) });
    await claim(db, 'crashed-worker', T0); // never completes
    expect(await claim(db, 'w2', at(30_000))).toHaveLength(0); // lease still valid
    const recovered = await claim(db, 'w2', at(61_000));
    expect(recovered.map((j) => [j.id, j.attempts])).toEqual([[id, 2]]);
  });

  it('startup recovery (single replica) requeues running jobs immediately', async () => {
    const id = await enqueueJob(db, { kind: 'a', runAt: at(-1) });
    await claim(db, 'old-process', T0);
    expect(await requeueRunningJobs(db)).toBe(1);
    expect((await claim(db, 'new-process', at(1))).map((j) => j.id)).toEqual([id]);
  });

  it('retries with backoff then dead-letters; complete is fenced by lock owner', async () => {
    const id = await enqueueJob(db, { kind: 'a', runAt: at(-1) });
    const opts = { now: T0, error: 'x', maxAttempts: 2, backoffMs: 1000 };
    const [j1] = await claim(db, 'w1', T0);
    await failJob(db, j1!, { workerId: 'w1', ...opts });
    expect(await claim(db, 'w1', T0)).toHaveLength(0); // backing off
    const [j2] = await claim(db, 'w1', at(5000));
    expect(j2!.attempts).toBe(2);
    await completeJob(db, id, 'someone-else');
    expect((await status(db, id)).status).toBe('running');
    await failJob(db, j2!, { workerId: 'w1', ...opts, now: at(5000) });
    expect(await status(db, id)).toMatchObject({ status: 'failed', lastError: 'x' });
  });

  it('cancelJobs cancels only pending jobs of the event/kinds', async () => {
    const a = await enqueueJob(db, { eventId, kind: 'voting.autoclose', runAt: at(1000) });
    const b = await enqueueJob(db, { eventId, kind: 'board.publish', runAt: at(1000) });
    await cancelJobs(db, eventId, ['voting.autoclose']);
    expect((await status(db, a)).status).toBe('cancelled');
    expect((await status(db, b)).status).toBe('pending');
  });
}
