import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { HealthResponseSchema, type GuardEnv, type PrivacyViolationError } from '@santa/contracts';
import type { Db } from '@santa/db';
import { registerIdempotency } from './http/idempotency.js';
import { DbPrincipalStore, type OrganizerSessions } from './principal.js';
import { RealtimeHub, type HubOptions, type SnapshotProvider } from './realtime/hub.js';
import { DbSnapshotProvider } from './realtime/snapshots.js';
import { registerAuthRoutes, type AuthModule } from './auth/routes.js';
import { registerOrganizerRoutes } from './routes/organizer.js';

declare module 'fastify' {
  interface FastifyInstance {
    hub?: RealtimeHub;
  }
}

export interface AppOptions {
  db?: Db;
  auth?: AuthModule;
  /** Used for the websocket handshake when `auth` is absent (tests). */
  organizerSessions?: OrganizerSessions;
  snapshots?: SnapshotProvider;
  guardEnv?: GuardEnv;
  alert?: (v: PrivacyViolationError) => void;
  rate?: HubOptions['rate'];
  clock?: () => Date;
  rateLimitMax?: number;
}

const NO_ORGANIZERS: OrganizerSessions = {
  fromCookieHeader: async () => null,
  isCurrent: async () => false,
};

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: true });
  const guardEnv: GuardEnv =
    opts.guardEnv ?? (process.env['NODE_ENV'] === 'production' ? 'production' : 'development');

  void app.register(helmet, {
    contentSecurityPolicy: {
      directives: { 'connect-src': ["'self'", 'ws:', 'wss:'] },
    },
  });
  void app.register(cookie);
  void app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax ?? 300,
    timeWindow: '1 minute',
  });

  // State APIs must never be cached by browsers, proxies or the service worker.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/health')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
  registerIdempotency(app);

  app.get('/health', async () => HealthResponseSchema.parse({ status: 'ok' }));

  // Client clock-offset estimation (countdowns use server timestamps).
  app.get('/api/time', async () => ({
    serverTime: (opts.clock ?? (() => new Date()))().getTime(),
  }));

  if (opts.auth) registerAuthRoutes(app, opts.auth);

  if (opts.db) {
    const principals = new DbPrincipalStore(
      opts.db,
      opts.auth?.organizerSessions ?? opts.organizerSessions ?? NO_ORGANIZERS,
      opts.clock,
    );
    const hub = new RealtimeHub({
      principals,
      snapshots: opts.snapshots ?? new DbSnapshotProvider(opts.db),
      guardEnv,
      ...(opts.alert ? { alert: opts.alert } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.rate ? { rate: opts.rate } : {}),
    });
    hub.attach(app.server);
    app.decorate('hub', hub);
    const sessions = opts.auth?.organizerSessions ?? opts.organizerSessions;
    if (sessions) {
      registerOrganizerRoutes(app, {
        db: opts.db,
        sessions,
        principals,
        hub,
        guardEnv,
        clock: opts.clock ?? (() => new Date()),
      });
    }
    app.addHook('preClose', async () => {
      hub.io.local.disconnectSockets(true);
    });
    app.addHook('onClose', async () => {
      hub.io.close();
    });
  }

  return app;
}
