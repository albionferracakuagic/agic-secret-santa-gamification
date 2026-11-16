import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  ClientEvents,
  SURFACES,
  guardOutput,
  type GuardEnv,
  type PrivacyViolationError,
  type Role,
  type Surface,
} from '@santa/contracts';
import type { Principal, PrincipalStore } from '../principal.js';
import { ReactionService, type ReactionPolicy } from './reactions.js';

export interface SnapshotProvider {
  /** Returns projected payloads keyed by surface; the hub guards every value before sending. */
  snapshot(p: Principal, eventId: string, stream: string): Promise<Record<string, unknown>>;
}

export interface HubOptions {
  principals: PrincipalStore;
  snapshots: SnapshotProvider;
  guardEnv: GuardEnv;
  alert?: (v: PrivacyViolationError) => void;
  clock?: () => Date;
  /** Per-socket message budget and per-PARTICIPANT reaction budget (events/second). */
  rate?: { messagesPerSec: number; reactionsPerSec: number };
  /** Decides whether a participant's reaction counts right now (event switch, mute, phase). Default: allow. */
  reactionPolicy?: ReactionPolicy;
  /** Aggregation window for reaction bursts (ms). */
  reactionWindowMs?: number;
}

export type RevokeReason = 'expired' | 'revoked' | 'membership' | 'session';

interface SocketData {
  principal: Principal;
  eventId?: string;
  grants: Set<string>;
  buckets: { msg: Bucket };
}

class Bucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly perSec: number) {
    this.tokens = perSec;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.perSec, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

type Sock = Socket & { data: SocketData };

const roomFor = (eventId: string, stream: string) =>
  stream.startsWith('grant:') ? stream : `e:${eventId}:${stream}`;

function roleFor(p: Principal, grant = false): Role {
  if (p.kind === 'guest') return 'participant';
  if (p.kind === 'display') return 'display';
  return grant ? 'organizer_unmasked' : 'organizer_masked';
}

/**
 * Realtime hub (ADR-0002): role-scoped rooms, per-stream cursors, subscribe-then-snapshot,
 * grant-scoped unmask channel with authz re-check before every send.
 */
export class RealtimeHub {
  io!: Server;
  private readonly cursors = new Map<string, number>();
  private readonly clock: () => Date;
  private readonly rate: { messagesPerSec: number; reactionsPerSec: number };
  readonly reactions: ReactionService;

  constructor(private readonly o: HubOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.rate = o.rate ?? { messagesPerSec: 20, reactionsPerSec: 5 };
    this.reactions = new ReactionService({
      perParticipantPerSec: this.rate.reactionsPerSec,
      windowMs: o.reactionWindowMs ?? 300,
      policy: o.reactionPolicy ?? (async () => true),
      emit: (eventId, burst) => this.io.to(roomFor(eventId, 'pub')).emit('reaction', burst),
    });
  }

  attach(httpServer: HttpServer): Server {
    this.io = new Server(httpServer, { serveClient: false, cors: { origin: false } });
    this.io.use((socket, next) => {
      this.o.principals
        .resolve(socket.handshake.headers.cookie)
        .then((principal) => {
          if (!principal) return next(new Error('unauthorized'));
          (socket as Sock).data = {
            principal,
            grants: new Set(),
            buckets: { msg: new Bucket(this.rate.messagesPerSec) },
          };
          next();
        })
        .catch(() => next(new Error('unauthorized')));
    });
    this.io.on('connection', (socket) => this.onConnection(socket as Sock));
    return this.io;
  }

  private onConnection(socket: Sock) {
    const { principal } = socket.data;
    // A newer session for the same roster entry replaces older ones.
    if (principal.kind === 'guest') {
      this.disconnectWhere(
        (s) =>
          s.id !== socket.id &&
          s.data.principal.kind === 'guest' &&
          s.data.principal.participantId === principal.participantId &&
          s.data.principal.sessionId !== principal.sessionId,
        'session',
      );
    }

    const guarded =
      <T>(fn: (payload: T) => Promise<void> | void) =>
      (payload: T) => {
        if (!socket.data.buckets.msg.take()) {
          socket.emit('error', { code: 'rate_limited' });
          return;
        }
        Promise.resolve(fn(payload)).catch(() => socket.emit('error', { code: 'bad_request' }));
      };

    socket.on(
      'subscribe',
      guarded((raw: unknown) => this.onSubscribe(socket, raw)),
    );
    socket.on(
      'grant.subscribe',
      guarded((raw: unknown) => this.onGrantSubscribe(socket, raw)),
    );
    socket.on(
      'time.ping',
      guarded((raw: unknown) => {
        const m = ClientEvents['time.ping'].safeParse(raw);
        if (m.success)
          socket.emit('time.sync', {
            clientTime: m.data.clientTime,
            serverTime: this.clock().getTime(),
          });
      }),
    );
    socket.on(
      'reaction.send',
      guarded(async (raw: unknown) => {
        const m = ClientEvents['reaction.send'].safeParse(raw);
        const eventId = socket.data.eventId;
        if (!m.success || !eventId || principal.kind !== 'guest') return;
        // Per-participant bucket + policy + aggregation; no identity, no per-gift counters.
        await this.reactions.submit(eventId, principal.participantId, m.data.kind);
      }),
    );
  }

  private async onSubscribe(socket: Sock, raw: unknown) {
    const m = ClientEvents.subscribe.safeParse(raw ?? {});
    if (!m.success) return void socket.emit('error', { code: 'bad_request' });
    const { principal } = socket.data;
    let eventId: string;
    let streams: string[];
    if (principal.kind === 'organizer') {
      if (
        !m.data.eventId ||
        !(await this.o.principals.isOrganizerOf(principal.userId, m.data.eventId))
      ) {
        return void socket.emit('error', { code: 'forbidden' });
      }
      eventId = m.data.eventId;
      streams = ['pub', 'org'];
    } else {
      eventId = principal.eventId;
      streams = principal.kind === 'guest' ? ['pub', `p:${principal.participantId}`] : ['pub'];
    }
    socket.data.eventId = eventId;
    // Join rooms first so no delta is missed; snapshot carries the cursor to dedupe against.
    for (const stream of streams) await socket.join(roomFor(eventId, stream));
    for (const stream of streams)
      await this.sendSnapshot(socket, eventId, stream, roleFor(principal));
  }

  private async onGrantSubscribe(socket: Sock, raw: unknown) {
    const m = ClientEvents['grant.subscribe'].safeParse(raw);
    const { principal, eventId } = socket.data;
    if (!m.success || principal.kind !== 'organizer' || !eventId) {
      return void socket.emit('error', { code: m.success ? 'forbidden' : 'bad_request' });
    }
    if (!(await this.grantOk(principal, eventId, m.data.grantId))) {
      return void socket.emit('error', { code: 'forbidden' });
    }
    const stream = `grant:${m.data.grantId}`;
    await socket.join(stream);
    socket.data.grants.add(m.data.grantId);
    await this.sendSnapshot(socket, eventId, stream, 'organizer_unmasked');
  }

  private async grantOk(p: Principal, eventId: string, grantId: string): Promise<boolean> {
    if (p.kind !== 'organizer') return false;
    const { principals } = this.o;
    return (
      (await principals.isCurrent(p)) &&
      (await principals.isOrganizerOf(p.userId, eventId)) &&
      (await principals.grantActive(p.userId, eventId, grantId, this.clock()))
    );
  }

  private cursorKey = (eventId: string, stream: string) =>
    stream.startsWith('grant:') ? stream : `${eventId}|${stream}`;
  currentCursor = (eventId: string, stream: string) =>
    this.cursors.get(this.cursorKey(eventId, stream)) ?? 0;

  private guardSurfaces(role: Role, data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!(SURFACES as readonly string[]).includes(k)) throw new Error(`unknown surface ${k}`);
      out[k] = guardOutput(role, k as Surface, v, this.guardOpts);
    }
    return out;
  }

  private get guardOpts() {
    return { env: this.o.guardEnv, ...(this.o.alert ? { alert: this.o.alert } : {}) };
  }

  private async sendSnapshot(socket: Sock, eventId: string, stream: string, role: Role) {
    // cursor BEFORE snapshot: a delta racing the load is re-applied idempotently, never lost
    const cursor = this.currentCursor(eventId, stream);
    const data = this.guardSurfaces(
      role,
      await this.o.snapshots.snapshot(socket.data.principal, eventId, stream),
    );
    socket.emit('snapshot', { stream, cursor, data });
  }

  /** Public + per-participant + organizer-masked streams. Role derives from the stream. */
  publish(
    eventId: string,
    stream: 'pub' | 'org' | `p:${string}`,
    surface: Surface,
    payload: unknown,
  ): number {
    const role: Role =
      stream === 'pub' ? 'display' : stream === 'org' ? 'organizer_masked' : 'participant';
    const safe = guardOutput(role, surface, payload, this.guardOpts); // throws -> nothing is emitted
    const key = this.cursorKey(eventId, stream);
    const cursor = (this.cursors.get(key) ?? 0) + 1;
    this.cursors.set(key, cursor);
    this.io.to(roomFor(eventId, stream)).emit('delta', { stream, cursor, surface, payload: safe });
    return cursor;
  }

  /** Unmasked data: authz is re-checked per socket before EVERY send; failure => forced disconnect. */
  async publishToGrant(grantId: string, surface: Surface, payload: unknown): Promise<number> {
    const safe = guardOutput('organizer_unmasked', surface, payload, this.guardOpts);
    const stream = `grant:${grantId}`;
    const cursor = (this.cursors.get(stream) ?? 0) + 1;
    this.cursors.set(stream, cursor);
    for (const socket of this.socketsInRoom(stream)) {
      const eventId = socket.data.eventId;
      if (eventId && (await this.grantOk(socket.data.principal, eventId, grantId))) {
        socket.emit('delta', { stream, cursor, surface, payload: safe });
      } else {
        this.kick(socket, grantId, 'revoked');
      }
    }
    return cursor;
  }

  private socketsInRoom(room: string): Sock[] {
    return [...this.io.sockets.sockets.values()].filter((s) => s.rooms.has(room)) as Sock[];
  }

  private kick(socket: Sock, grantId: string | undefined, reason: RevokeReason) {
    if (grantId) socket.emit('grant.revoked', { grantId, reason });
    socket.disconnect(true);
  }

  /** Grant expiry/revocation (called by the durable `grant.expire` job or the revoke endpoint). */
  revokeGrant(grantId: string, reason: RevokeReason = 'revoked') {
    for (const s of this.socketsInRoom(`grant:${grantId}`)) this.kick(s, grantId, reason);
    this.cursors.delete(`grant:${grantId}`);
  }

  disconnectWhere(pred: (s: Sock) => boolean, reason: RevokeReason) {
    for (const s of this.io.sockets.sockets.values() as IterableIterator<Sock>) {
      if (!pred(s)) continue;
      for (const g of s.data.grants) s.emit('grant.revoked', { grantId: g, reason });
      s.disconnect(true);
    }
  }

  /** Organizer removed from event => drop all their sockets for that event. */
  dropOrganizer(eventId: string, userId: string) {
    this.disconnectWhere(
      (s) =>
        s.data.principal.kind === 'organizer' &&
        s.data.principal.userId === userId &&
        s.data.eventId === eventId,
      'membership',
    );
  }

  /** Participant removed / session replaced via REST. */
  dropParticipant(participantId: string, reason: RevokeReason = 'session') {
    this.disconnectWhere(
      (s) => s.data.principal.kind === 'guest' && s.data.principal.participantId === participantId,
      reason,
    );
  }

  /** Organizer logged in elsewhere / session revoked. */
  dropOrganizerSession(sessionId: string) {
    this.disconnectWhere(
      (s) => s.data.principal.kind === 'organizer' && s.data.principal.sessionId === sessionId,
      'session',
    );
  }

  /** Display token revoked => drop that event's display sockets. */
  dropDisplays(eventId: string) {
    this.disconnectWhere(
      (s) => s.data.principal.kind === 'display' && s.data.principal.eventId === eventId,
      'revoked',
    );
  }

  async close() {
    this.reactions.close();
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
  }
}
