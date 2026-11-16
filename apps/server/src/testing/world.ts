import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { io as connectClient, type Socket } from 'socket.io-client';
import {
  eventAccess,
  eventOrganizers,
  events,
  participants,
  unmaskGrants,
  user,
  type Db,
} from '@santa/db';
import { createTestDb, type TestDb } from '@santa/db/testing';
import { seedDemoEvent } from '@santa/db/seed';
import { buildApp, type AppOptions } from '../app.js';
import { DISPLAY_COOKIE, GUEST_COOKIE, type OrganizerSessions } from '../principal.js';
import { hashToken } from '../tokens.js';
import type { FastifyInstance } from 'fastify';

/** Test organizer sessions: cookie `sg_o=<userId>:<sessionId>`, revocable via `revoked`. */
export class FakeOrganizerSessions implements OrganizerSessions {
  readonly revoked = new Set<string>();
  async fromCookieHeader(header: string | undefined) {
    const m = /(?:^|;\s*)sg_o=([^:;]+):([^;]+)/.exec(header ?? '');
    return m && !this.revoked.has(m[2]!) ? { userId: m[1]!, sessionId: m[2]! } : null;
  }
  async isCurrent(sessionId: string) {
    return !this.revoked.has(sessionId);
  }
}

export interface World {
  db: TestDb;
  app: FastifyInstance;
  port: number;
  eventId: string;
  participantIds: string[];
  organizers: FakeOrganizerSessions;
  guestCookie(i: number, token?: string): Promise<string>;
  displayCookie(): Promise<string>;
  organizerCookie(userId?: string, sessionId?: string): string;
  grant(opts?: { expiresInMs?: number; userId?: string }): Promise<string>;
  client(cookie: string): Socket;
  close(): Promise<void>;
}

export async function createWorld(opts: AppOptions = {}): Promise<World> {
  const db = await createTestDb();
  const { eventId, participantIds } = await seedDemoEvent(db);
  await db
    .insert(user)
    .values({ id: 'stranger', name: 'Stranger', email: 'stranger@example.test' });
  const organizers = new FakeOrganizerSessions();
  const app = buildApp({ db, organizerSessions: organizers, guardEnv: 'test', ...opts });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const clients: Socket[] = [];

  return {
    db,
    app,
    port,
    eventId,
    participantIds,
    organizers,
    async guestCookie(i, token = `guest-token-${i}`) {
      await db
        .update(participants)
        .set({ sessionTokenHash: hashToken(token) })
        .where(eq(participants.id, participantIds[i]!));
      return `${GUEST_COOKIE}=${token}`;
    },
    async displayCookie() {
      await db
        .insert(eventAccess)
        .values({ eventId, kind: 'display', tokenHash: hashToken('display-token') });
      return `${DISPLAY_COOKIE}=display-token`;
    },
    organizerCookie: (userId = 'demo-owner', sessionId = 'sess-1') => `sg_o=${userId}:${sessionId}`,
    async grant({ expiresInMs = 600_000, userId = 'demo-owner' } = {}) {
      const [g] = await db
        .insert(unmaskGrants)
        .values({
          eventId,
          userId,
          reason: 'fix assignment',
          expiresAt: new Date(Date.now() + expiresInMs),
        })
        .returning({ id: unmaskGrants.id });
      return g!.id;
    },
    client(cookie) {
      const c = connectClient(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        extraHeaders: { cookie },
        reconnection: false,
        forceNew: true,
      });
      clients.push(c);
      return c;
    },
    async close() {
      for (const c of clients) c.close();
      await app.close();
    },
  };
}

export const waitFor = <T = unknown>(s: Socket, event: string, ms = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    s.once(event, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });

export const connected = (s: Socket) =>
  new Promise<void>((resolve, reject) => {
    s.once('connect', () => resolve());
    s.once('connect_error', (e) => reject(e));
  });

export const collect = (s: Socket, event: string) => {
  const got: unknown[] = [];
  s.on(event, (v) => got.push(v));
  return got;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function addOrganizer(db: Db, eventId: string, userId: string) {
  await db.insert(eventOrganizers).values({ eventId, userId, role: 'co' });
}

export async function insertSecondEvent(db: Db) {
  const [e] = await db
    .insert(events)
    .values({
      ownerId: 'stranger',
      name: 'Other',
      startsAt: new Date(),
      timezone: 'UTC',
      settings: (await db.select().from(events).limit(1))[0]!.settings,
    })
    .returning();
  const [p] = await db
    .insert(participants)
    .values({
      eventId: e!.id,
      displayName: 'Outsider',
      status: 'active',
      source: 'join',
      sessionTokenHash: hashToken('outsider'),
    })
    .returning();
  return { eventId: e!.id, participantId: p!.id, cookie: `${GUEST_COOKIE}=outsider` };
}
