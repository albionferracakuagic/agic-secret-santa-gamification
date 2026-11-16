import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './testing.js';
import {
  addCoOrganizer,
  changePhase,
  createEvent,
  EventError,
  listEventsForUser,
  removeCoOrganizer,
  reopenVoting,
  setPaused,
  updateEvent,
} from './events.js';
import { listAudit, redactAuditData, writeAudit } from './audit.js';
import {
  createUnmaskGrant,
  revokeUnmaskGrant,
  loadPairingsUnmasked,
  UNMASK_TTL_MS,
} from './unmask.js';
import { enqueueJob } from './jobs.js';
import * as s from './schema.js';

let db: TestDb;
const NOW = new Date('2026-12-01T10:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

async function newEvent(over: Record<string, unknown> = {}) {
  await db
    .insert(s.user)
    .values({ id: 'owner', name: 'O', email: 'o@example.test' })
    .onConflictDoNothing();
  return createEvent(db, {
    ownerId: 'owner',
    now: NOW,
    input: {
      name: 'Party',
      startsAt: '2026-12-24T19:00:00Z',
      timezone: 'Europe/Rome',
      defaultLocale: 'it',
      ...over,
    },
  });
}

beforeEach(async () => {
  db = await createTestDb();
});

describe('event setup', () => {
  it('creates event with owner, EN/IT default categories, valid default settings, audit row', async () => {
    const e = await newEvent();
    const cats = await db
      .select()
      .from(s.votingCategories)
      .where(eq(s.votingCategories.eventId, e.id));
    expect(cats).toHaveLength(6);
    expect(cats.every((c) => c.name['en'] && c.name['it'])).toBe(true);
    expect(e.maxParticipants).toBe(100);
    expect(e.settings).toMatchObject({ minVoters: 5, hiddenMin: 2, cadenceSeconds: 10 });
    expect((await listEventsForUser(db, 'owner')).map((x) => x.id)).toEqual([e.id]);
    expect((await listAudit(db, e.id)).map((a) => a.action)).toEqual(['event.create']);
  });

  it('settings cannot lower privacy floors or carry unknown keys; stricter values are fine', async () => {
    await expect(newEvent({ settings: { minVoters: 3 } })).rejects.toMatchObject({
      code: 'invalid_settings',
    });
    await expect(newEvent({ settings: { hiddenMin: 1 } })).rejects.toBeInstanceOf(EventError);
    await expect(newEvent({ settings: { bogus: true } })).rejects.toBeInstanceOf(EventError);
    const e = await newEvent({ settings: { minVoters: 8, xpValues: { voted: 25 } } });
    expect(e.settings).toMatchObject({ minVoters: 8, xpValues: { joined: 10, voted: 25 } });
  });

  it('update merges settings (deep) and refuses maxParticipants below the roster', async () => {
    const e = await newEvent();
    await db
      .insert(s.participants)
      .values(
        Array.from({ length: 6 }, (_, i) => ({
          eventId: e.id,
          displayName: `P${i}`,
          source: 'import' as const,
        })),
      );
    const u = await updateEvent(db, {
      eventId: e.id,
      actor: 'owner',
      now: NOW,
      patch: { settings: { features: { xpBoard: true } } },
    });
    expect(u.settings.features.xpBoard).toBe(true);
    expect(u.settings.xpValues.joined).toBe(10);
    await expect(
      updateEvent(db, { eventId: e.id, actor: 'owner', now: NOW, patch: { maxParticipants: 5 } }),
    ).rejects.toMatchObject({ code: 'max_below_roster' });
    await expect(
      updateEvent(db, {
        eventId: e.id,
        actor: 'owner',
        now: NOW,
        patch: { settings: { minVoters: 2 } },
      }),
    ).rejects.toBeInstanceOf(EventError);
  });

  it('co-organizers: add by existing account email, owner cannot be removed', async () => {
    const e = await newEvent();
    await db.insert(s.user).values({ id: 'co1', name: 'Co', email: 'co@example.test' });
    await addCoOrganizer(db, { eventId: e.id, actor: 'owner', email: 'CO@example.test', now: NOW });
    await expect(
      addCoOrganizer(db, { eventId: e.id, actor: 'owner', email: 'x@example.test', now: NOW }),
    ).rejects.toMatchObject({ code: 'user_not_found' });
    await removeCoOrganizer(db, { eventId: e.id, actor: 'owner', userId: 'co1', now: NOW });
    await expect(
      removeCoOrganizer(db, { eventId: e.id, actor: 'owner', userId: 'owner', now: NOW }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('phase changes', () => {
  const step = (eventId: string, to: Parameters<typeof changePhase>[1]['to'], t = NOW) =>
    changePhase(db, { eventId, actor: 'owner', to, now: t });

  it('walks the machine, blocks import-less gift registration, audits back-steps, freezes after reveal', async () => {
    const e = await newEvent();
    await step(e.id, 'registration');
    await expect(step(e.id, 'gift_registration')).rejects.toMatchObject({
      code: 'pairing_not_ready',
    });
    await db.insert(s.pairingImports).values({ eventId: e.id, status: 'ready' });
    await step(e.id, 'gift_registration');
    await step(e.id, 'gift_opening', later(1000));
    const [row] = await db.select().from(s.events).where(eq(s.events.id, e.id));
    expect(row!.giftOpeningStartedAt).toEqual(later(1000));
    await step(e.id, 'gift_registration'); // back-step
    expect((await listAudit(db, e.id)).map((a) => a.action)).toContain('phase.back');
    await step(e.id, 'gift_opening');
    await step(e.id, 'voting');
    await step(e.id, 'reveal', later(5000));
    await expect(step(e.id, 'voting')).rejects.toMatchObject({ code: 'backstep_after_reveal' });
  });

  it('pause blocks phase changes and is audited', async () => {
    const e = await newEvent();
    await setPaused(db, { eventId: e.id, actor: 'owner', paused: true, now: NOW });
    await expect(step(e.id, 'registration')).rejects.toMatchObject({ code: 'paused' });
    await setPaused(db, { eventId: e.id, actor: 'owner', paused: false, now: NOW });
    await step(e.id, 'registration');
    expect((await listAudit(db, e.id)).map((a) => a.action)).toEqual(
      expect.arrayContaining(['event.pause', 'event.resume']),
    );
  });

  it('reopen voting: invalidates awards, bumps round, cancels pending jobs, audits; blocked after reveal', async () => {
    const e = await newEvent();
    await db
      .update(s.events)
      .set({ phase: 'games', votingClosedAt: NOW })
      .where(eq(s.events.id, e.id));
    await db
      .insert(s.awards)
      .values({
        eventId: e.id,
        boardKey: 'best_gift',
        votingRound: 1,
        winners: ['g1'],
        publishable: true,
        lockedAt: NOW,
      });
    const job = await enqueueJob(db, {
      eventId: e.id,
      kind: 'ceremony.step',
      runAt: later(60_000),
    });
    const keep = await enqueueJob(db, {
      eventId: e.id,
      kind: 'grant.expire',
      runAt: later(60_000),
    });

    await expect(
      reopenVoting(db, { eventId: e.id, actor: 'owner', reason: 'short', now: NOW }),
    ).resolves.toEqual({ votingRound: 2 });
    const [ev] = await db.select().from(s.events).where(eq(s.events.id, e.id));
    expect(ev).toMatchObject({ phase: 'voting', votingRound: 2, votingClosedAt: null });
    const [aw] = await db.select().from(s.awards).where(eq(s.awards.eventId, e.id));
    expect(aw!.invalidatedAt).not.toBeNull();
    expect(aw!.publishable).toBe(false);
    const status = async (id: string) =>
      (await db.select().from(s.scheduledJobs).where(eq(s.scheduledJobs.id, id)))[0]!.status;
    expect(await status(job)).toBe('cancelled');
    expect(await status(keep)).toBe('pending');
    expect((await listAudit(db, e.id)).map((a) => a.action)).toContain('voting.reopen');

    await expect(
      reopenVoting(db, { eventId: e.id, actor: 'owner', reason: 'again', now: NOW }),
    ).rejects.toMatchObject({ code: 'voting_not_closed' });
    await db
      .update(s.events)
      .set({ phase: 'awards', revealStartedAt: NOW })
      .where(eq(s.events.id, e.id));
    await expect(
      reopenVoting(db, { eventId: e.id, actor: 'owner', reason: 'too late', now: NOW }),
    ).rejects.toMatchObject({ code: 'backstep_after_reveal' });
  });
});

describe('audit + unmask grants', () => {
  it('audit redacts votes/pairings/tokens', async () => {
    const e = await newEvent();
    await writeAudit(db, {
      eventId: e.id,
      actor: 'owner',
      action: 'x',
      data: { votes: [1], nested: { pairings: [2], ok: 1 }, token: 'abc' },
    });
    const [row] = await db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.eventId, e.id), eq(s.auditLog.action, 'x')));
    expect(row!.data).toEqual({
      votes: '[redacted]',
      nested: { pairings: '[redacted]', ok: 1 },
      token: '[redacted]',
    });
    expect(redactAuditData({ recipientId: 'r' })).toEqual({ recipientId: '[redacted]' });
  });

  it('grant: exactly 10 minutes, schedules expiry job, audited; revoke only while active', async () => {
    const e = await newEvent();
    const g = await createUnmaskGrant(db, {
      eventId: e.id,
      userId: 'owner',
      reason: 'fix assignment',
      now: NOW,
    });
    expect(g.expiresAt.getTime() - NOW.getTime()).toBe(UNMASK_TTL_MS);
    const jobs = await db.select().from(s.scheduledJobs).where(eq(s.scheduledJobs.eventId, e.id));
    expect(jobs).toMatchObject([
      { kind: 'grant.expire', runAt: g.expiresAt, payload: { grantId: g.grantId } },
    ]);
    expect((await listAudit(db, e.id)).find((a) => a.action === 'unmask.grant')).toMatchObject({
      reason: 'fix assignment',
      target: g.grantId,
    });

    expect(
      await revokeUnmaskGrant(db, {
        eventId: e.id,
        grantId: g.grantId,
        userId: 'owner',
        now: later(1000),
      }),
    ).toBe(true);
    expect(
      await revokeUnmaskGrant(db, {
        eventId: e.id,
        grantId: g.grantId,
        userId: 'owner',
        now: later(2000),
      }),
    ).toBe(false);
  });

  it('reading pairings is audited without leaking ids into the log', async () => {
    const e = await newEvent();
    await loadPairingsUnmasked(db, e.id, 'owner', 'grant-1');
    const log = await db
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.action, 'unmask.read_pairings'));
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0]!.data)).toBe('{"count":0}');
  });
});
