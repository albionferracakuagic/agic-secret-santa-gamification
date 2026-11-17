import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './testing.js';
import { createEvent } from './events.js';
import { eventStats, integrityDetails, integrityReport, removeParticipant } from './admin.js';
import {
  anonymizeParticipant,
  ensureRetentionJob,
  setEventSuspended,
  sweepRetention,
  takedownGift,
} from './privacy.js';
import { findParticipantBySession, resolveJoinTarget } from './join.js';
import { closeVoting } from './voting.js';
import * as s from './schema.js';

let db: TestDb;
let eventId: string;
let ids: string[];
let giftIds: string[];
const NOW = new Date('2026-12-20T18:00:00Z');
const DAY = 86_400_000;

async function setup() {
  db = await createTestDb();
  await db.insert(s.user).values({ id: 'owner', name: 'O', email: 'o@example.test' });
  const e = await createEvent(db, {
    ownerId: 'owner',
    now: NOW,
    input: {
      name: 'P',
      startsAt: '2026-12-24T19:00:00Z',
      timezone: 'Europe/Rome',
      defaultLocale: 'en',
    },
  });
  eventId = e.id;
  await db.update(s.events).set({ phase: 'voting' }).where(eq(s.events.id, eventId));
  const ps = await db
    .insert(s.participants)
    .values(
      Array.from({ length: 6 }, (_, i) => ({
        eventId,
        displayName: `P${i}`,
        email: `p${i}@example.test`,
        status: 'active' as const,
        source: 'import' as const,
        sessionTokenHash: `hash${i}`,
      })),
    )
    .returning();
  ids = ps.map((p) => p.id);
  giftIds = (
    await db
      .insert(s.gifts)
      .values(
        ids.map((giverId, i) => ({
          eventId,
          giverId,
          aliasNo: i + 1,
          name: `G${i}`,
          photoKey: `gifts/${eventId}/photo-${i}.jpg`,
          status: 'opened' as const,
        })),
      )
      .returning()
  ).map((g) => g.id);
  const [cat] = await db
    .select()
    .from(s.votingCategories)
    .where(and(eq(s.votingCategories.eventId, eventId), eq(s.votingCategories.key, 'funniest')));
  await db.insert(s.votes).values(
    ids.map((voterId, i) => ({
      categoryId: cat!.id,
      voterId,
      eventId,
      giftId: giftIds[(i + 1) % 6]!,
    })),
  );
}

describe('admin moderation', () => {
  beforeEach(setup, 60_000);

  it('removing a participant during voting drops session, votes and hides their gift', async () => {
    const r = await removeParticipant(db, {
      eventId,
      actor: 'owner',
      participantId: ids[0]!,
      now: NOW,
    });
    expect(r.votesRemoved).toBe(1);
    expect(await findParticipantBySession(db, 'hash0')).toBeNull();
    const [g] = await db.select().from(s.gifts).where(eq(s.gifts.id, giftIds[0]!));
    expect(g!.hidden).toBe(true);
    const stats = await eventStats(db, eventId, NOW);
    expect(stats.participants).toMatchObject({ active: 5, removed: 1 });
    expect(stats.gifts.hidden).toBe(1);
  });

  it('after voting closed, votes stay (locked awards are not rewritten)', async () => {
    await closeVoting(db, { eventId, actor: 'owner', now: NOW });
    const r = await removeParticipant(db, {
      eventId,
      actor: 'owner',
      participantId: ids[1]!,
      now: NOW,
    });
    expect(r.votesRemoved).toBe(0);
    expect(await db.select().from(s.votes)).toHaveLength(6);
    const report = await integrityReport(db, eventId);
    expect(report.anomalies.vote_from_inactive_participant).toBe(1);
    expect(report.clean).toBe(false);
  });

  it('integrity report is aggregate-only; details are audited', async () => {
    await db.update(s.votes).set({ giftId: giftIds[2]! }).where(eq(s.votes.voterId, ids[2]!)); // own gift
    const rep = await integrityReport(db, eventId);
    expect(rep.anomalies.vote_for_own_gift).toBe(1);
    expect(JSON.stringify(rep)).not.toContain(ids[2]!);
    const funniest = rep.categories.find((c) => c.boardKey === 'funniest');
    expect(funniest).toMatchObject({ voters: 6, belowPrivacyFloor: false });
    const d = await integrityDetails(db, { eventId, actor: 'owner', now: NOW });
    expect(d.items).toHaveLength(1);
    const audit = await db
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.action, 'integrity.details'));
    expect(audit).toHaveLength(1);
  });

  it('stats contain counts only', async () => {
    const stats = await eventStats(db, eventId, NOW);
    expect(JSON.stringify(stats)).not.toMatch(/P0|@example/);
    expect(stats.voting).toMatchObject({ status: 'open', round: 1 });
  });
});

describe('privacy controls', () => {
  beforeEach(setup, 60_000);

  it('delete-my-data anonymises the person and their gift but keeps anonymous ballots', async () => {
    const r = await anonymizeParticipant(db, { participantId: ids[0]!, now: NOW });
    expect(r.erased).toEqual(
      expect.arrayContaining(['name', 'email', 'session', 'gift_photo', 'gift_text']),
    );
    expect(r.photoKeys).toHaveLength(1);
    const [p] = await db.select().from(s.participants).where(eq(s.participants.id, ids[0]!));
    expect(p).toMatchObject({
      displayName: 'Former player',
      email: null,
      avatar: null,
      sessionTokenHash: null,
    });
    expect(p!.anonymizedAt).not.toBeNull();
    const [g] = await db.select().from(s.gifts).where(eq(s.gifts.id, giftIds[0]!));
    expect(g).toMatchObject({ name: 'Gift', description: null, photoKey: null });
    expect(await db.select().from(s.votes).where(eq(s.votes.voterId, ids[0]!))).toHaveLength(1);
    expect(await findParticipantBySession(db, 'hash0')).toBeNull();
  });

  it('takedown suspends participant and join access; restore reverses it; both audited with reason', async () => {
    await db
      .insert(s.eventAccess)
      .values({ eventId, kind: 'join', tokenHash: 'jt', shortCode: 'ABC2345678' });
    expect(await resolveJoinTarget(db, { shortCode: 'ABC2345678' }, NOW)).toBe(eventId);
    await setEventSuspended(db, {
      eventId,
      actor: 'owner',
      suspended: true,
      reason: 'abuse report #1',
      now: NOW,
    });
    expect(await findParticipantBySession(db, 'hash1')).toBeNull();
    expect(await resolveJoinTarget(db, { shortCode: 'ABC2345678' }, NOW)).toBeNull();
    await setEventSuspended(db, {
      eventId,
      actor: 'owner',
      suspended: false,
      reason: 'resolved',
      now: NOW,
    });
    expect(await findParticipantBySession(db, 'hash1')).not.toBeNull();
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.eventId, eventId));
    expect(audit.filter((a) => a.action.startsWith('platform.')).map((a) => a.reason)).toEqual(
      expect.arrayContaining(['abuse report #1', 'resolved']),
    );
  });

  it('gift takedown removes text and photo reference', async () => {
    const r = await takedownGift(db, { giftId: giftIds[3]!, actor: 'owner', now: NOW });
    expect(r.photoKey).toBe(`gifts/${eventId}/photo-3.jpg`);
    const [g] = await db.select().from(s.gifts).where(eq(s.gifts.id, giftIds[3]!));
    expect(g).toMatchObject({ photoKey: null, hidden: true, description: null });
  });

  it('retention: nothing before the window, then photos + emails once; a failed delete retries', async () => {
    const done = new Date(NOW.getTime());
    await db.update(s.events).set({ completedAt: done }).where(eq(s.events.id, eventId));
    const deleted: string[] = [];
    const del = async (k: string) => void deleted.push(k);
    expect(
      await sweepRetention(db, { now: new Date(done.getTime() + DAY), deleteBlob: del }),
    ).toEqual({
      photosDeleted: 0,
      emailsErased: 0,
    });

    const r1 = await sweepRetention(db, {
      now: new Date(done.getTime() + 31 * DAY),
      deleteBlob: del,
    });
    expect(r1).toEqual({ photosDeleted: 0, emailsErased: 6 });

    let calls = 0;
    const flaky = async (k: string) => {
      if (++calls === 2) throw new Error('storage down');
      deleted.push(k);
    };
    const at = new Date(done.getTime() + 91 * DAY);
    await expect(sweepRetention(db, { now: at, deleteBlob: flaky })).rejects.toThrow(
      'storage down',
    );
    expect(deleted).toHaveLength(1);
    const r2 = await sweepRetention(db, { now: at, deleteBlob: del });
    expect(r2.photosDeleted).toBe(5);
    expect(new Set(deleted).size).toBe(6);
    expect(await sweepRetention(db, { now: at, deleteBlob: del })).toEqual({
      photosDeleted: 0,
      emailsErased: 0,
    });
  });

  it('keeps exactly one daily retention job', async () => {
    expect(await ensureRetentionJob(db, NOW)).toBe(true);
    expect(await ensureRetentionJob(db, NOW)).toBe(false);
  });
});
