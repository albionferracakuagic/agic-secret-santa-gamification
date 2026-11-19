import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  HealthResponseSchema,
  PAIRING_MAX_FILE_BYTES,
  type GuardEnv,
  type PrivacyViolationError,
} from '@santa/contracts';
import type { Db } from '@santa/db';
import { DbIdempotencyStore } from './http/idempotency-db.js';
import { registerIdempotency } from './http/idempotency.js';
import { DbPrincipalStore, type OrganizerSessions } from './principal.js';
import { RealtimeHub, type HubOptions, type SnapshotProvider } from './realtime/hub.js';
import { DbSnapshotProvider } from './realtime/snapshots.js';
import { registerAuthRoutes, type AuthModule } from './auth/routes.js';
import { registerOrganizerRoutes } from './routes/organizer.js';
import { registerPairingRoutes } from './routes/pairing.js';
import { registerJoinRoutes } from './routes/join.js';
import { registerGiftRoutes } from './routes/gifts.js';
import { registerVotingRoutes } from './routes/voting.js';
import { registerShowRoutes } from './routes/show.js';
import { registerAutopilotRoutes } from './routes/autopilot.js';
import { registerPhase2Routes } from './routes/phase2.js';
import { registerPhase3Routes } from './routes/phase3.js';
import type { FanoutBus } from './scale/bus.js';
import { registerCertificateRoutes } from './certificates/routes.js';
import { registerAdminRoutes } from './routes/admin.js';
import { API_PREFIX, cspDirectives, registerWeb } from './http/web.js';
import type { ShortCodeGuardOptions } from './http/shortcode-guard.js';
import { loggerOptions, type LogSink } from './logging.js';
import { LocalFsStorage, registerMediaRoute } from './storage/local.js';
import type { StorageAdapter } from './storage/adapter.js';
import { randomBytes } from 'node:crypto';
import { dbReactionPolicy } from './realtime/reactions.js';
import { MemoryEmailTransport, type EmailTransport } from './auth/email.js';

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
  /** Claim-link emails (default: in-memory). */
  email?: EmailTransport;
  /** Public base URL used in emailed claim links. */
  baseUrl?: string;
  /** Blob storage (default: local FS under MEDIA_DIR with signed URLs; Azure Blob in production). */
  storage?: StorageAdapter;
  reactionWindowMs?: number;
  /** Public join endpoints: per-IP requests/minute (defaults: resolve/display 20, claim 10). */
  joinRateLimits?: { resolve: number; claim: number };
  rateLimitMax?: number;
  /** Global short-code brute-force limits (see ShortCodeGuard). */
  shortCodeLimits?: ShortCodeGuardOptions;
  /** Directory of the built SPA to serve (history fallback); unset = API only. */
  webDist?: string;
  /** Extra CSP image origins (private blob storage host). */
  cspImgSources?: string[];
  /** Extra browser origins allowed to open sockets (default: only aseUrl; localhost in dev/test). */
  allowedOrigins?: string[];
  /** Verified emails that count as platform admins (bootstrap; env PLATFORM_ADMIN_EMAILS). */
  platformAdminEmails?: string[];
  /** Trusted reverse-proxy hops (default 1; 0 = none). */
  trustProxyHops?: number;
  /** Scale-out: relay realtime deltas to other instances (default: none = single replica). */
  bus?: FanoutBus;
  /** Directory with the certificate fonts (default: the web app's licensed fonts). */
  certificateFontsDir?: string;
  /** Structured request logging (off by default; tests pass a sink to verify redaction). */
  logging?: boolean | { sink: LogSink };
}

const NO_ORGANIZERS: OrganizerSessions = {
  fromCookieHeader: async () => null,
  isCurrent: async () => false,
};

/** Same-origin (plus configured extras); any localhost origin outside production for the Vite dev server. */
export function allowedOrigin(
  origin: string,
  baseUrl: string,
  extra: string[] = [],
  env: GuardEnv = 'development',
): boolean {
  if (origin === new URL(baseUrl).origin || extra.includes(origin)) return true;
  return env !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: !opts.logging
      ? false
      : loggerOptions(typeof opts.logging === 'object' ? opts.logging.sink : undefined),
    // exact hop count (Container Apps ingress = 1): a client cannot forge X-Forwarded-For beyond the trusted hops
    trustProxy: (_addr: string, hop: number) => hop < (opts.trustProxyHops ?? 1),
  });
  const guardEnv: GuardEnv =
    opts.guardEnv ?? (process.env['NODE_ENV'] === 'production' ? 'production' : 'development');

  void app.register(helmet, {
    contentSecurityPolicy: {
      directives: cspDirectives(
        opts.cspImgSources ? { imgSources: opts.cspImgSources } : {},
        guardEnv,
      ),
    },
  });
  void app.register(cookie);
  void app.register(multipart, {
    limits: { fileSize: PAIRING_MAX_FILE_BYTES, files: 1, fields: 5, parts: 8 },
  });
  void app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax ?? 300,
    timeWindow: '1 minute',
    allowList: (req) => req.method === 'GET' && !API_PREFIX.test(req.url.split('?')[0] ?? ''),
  });

  // State APIs must never be cached by browsers, proxies or the service worker.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/health')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
  // DB-backed when a database is present: keys survive restarts and work across replicas
  registerIdempotency(app, opts.db ? { store: new DbIdempotencyStore(opts.db) } : {});

  // Malformed ids (non-UUID path params / headers) reach Postgres as 22P02: that is a client error, not a 500.
  app.setErrorHandler((err, _req, reply) => {
    for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
      if ((e as { code?: string }).code === '22P02')
        return reply.status(400).send({ error: { code: 'bad_request', message: 'bad_request' } });
    }
    return reply.send(err);
  });

  // Default 404 handler logs the raw URL (may hold tokens); ours does not. With a built SPA, unknown GET paths
  // outside the API fall back to index.html (client-side routes like /o, /e, /d, /j).
  const spaFallback = opts.webDist ? registerWeb(app, opts.webDist) : undefined;
  app.setNotFoundHandler((req, reply) => {
    if (spaFallback && req.method === 'GET' && spaFallback(req.url))
      return reply.header('Cache-Control', 'no-cache').type('text/html').sendFile('index.html');
    return reply.status(404).send({ error: { code: 'not_found', message: 'not_found' } });
  });

  // Routes are registered in app.after(): @fastify/rate-limit (and other plugins) must finish loading
  // first, otherwise their onRoute hooks never see these routes and limits silently don't apply.
  const routes: Array<() => void> = [
    () => {
      app.get('/health', async () => HealthResponseSchema.parse({ status: 'ok' }));

      // Client clock-offset estimation (countdowns use server timestamps).
      app.get('/api/time', async () => ({
        serverTime: (opts.clock ?? (() => new Date()))().getTime(),
      }));

      if (opts.auth) registerAuthRoutes(app, opts.auth);
    },
  ];

  if (opts.db) {
    const principals = new DbPrincipalStore(
      opts.db,
      opts.auth?.organizerSessions ?? opts.organizerSessions ?? NO_ORGANIZERS,
      opts.clock,
    );
    const baseUrl = opts.baseUrl ?? 'http://localhost:3000';
    const storage: StorageAdapter =
      opts.storage ??
      new LocalFsStorage(
        process.env['MEDIA_DIR'] ?? '.data/media',
        process.env['MEDIA_SIGNING_SECRET'] ?? randomBytes(32).toString('hex'),
      );
    const realtimeCtx = { storage, baseUrl };
    const hub = new RealtimeHub({
      principals,
      snapshots: opts.snapshots ?? new DbSnapshotProvider(opts.db, realtimeCtx),
      guardEnv,
      ...(opts.alert ? { alert: opts.alert } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.rate ? { rate: opts.rate } : {}),
      ...(opts.bus ? { bus: opts.bus } : {}),
      reactionPolicy: dbReactionPolicy(opts.db),
      allowOrigin: (origin) => allowedOrigin(origin, baseUrl, opts.allowedOrigins, guardEnv),
      ...(opts.reactionWindowMs ? { reactionWindowMs: opts.reactionWindowMs } : {}),
    });
    hub.ctx = realtimeCtx;
    hub.attach(app.server);
    app.decorate('hub', hub);
    const sessions = opts.auth?.organizerSessions ?? opts.organizerSessions;
    const clock = opts.clock ?? (() => new Date());
    const db = opts.db;
    routes.push(() => {
      if (storage instanceof LocalFsStorage) registerMediaRoute(app, storage);
      registerJoinRoutes(app, {
        db,
        sessions: sessions ?? NO_ORGANIZERS,
        principals,
        hub,
        email: opts.email ?? new MemoryEmailTransport(),
        baseUrl,
        secureCookies: guardEnv === 'production',
        clock,
        ...(opts.joinRateLimits ? { limits: opts.joinRateLimits } : {}),
        ...(opts.shortCodeLimits ? { shortCodeLimits: opts.shortCodeLimits } : {}),
      });
      registerGiftRoutes(app, {
        db,
        sessions: sessions ?? NO_ORGANIZERS,
        principals,
        hub,
        storage,
        clock,
      });
      registerVotingRoutes(app, {
        db,
        sessions: sessions ?? NO_ORGANIZERS,
        principals,
        hub,
        clock,
      });
      registerShowRoutes(app, {
        db,
        sessions: sessions ?? NO_ORGANIZERS,
        principals,
        hub,
        clock,
      });
      registerAutopilotRoutes(app, {
        db,
        sessions: sessions ?? NO_ORGANIZERS,
        principals,
        hub,
        clock,
      });
      registerPhase2Routes(app, {
        db,
        sessions: sessions ?? NO_ORGANIZERS,
        principals,
        hub,
        clock,
      });
      registerPhase3Routes(app, {
        db,
        sessions: sessions ?? NO_ORGANIZERS,
        principals,
        hub,
        clock,
        email: opts.email ?? new MemoryEmailTransport(),
        baseUrl,
        storage,
      });
      registerCertificateRoutes(app, {
        db,
        sessions: sessions ?? NO_ORGANIZERS,
        principals,
        hub,
        clock,
        ...(opts.certificateFontsDir ? { fontsDir: opts.certificateFontsDir } : {}),
      });
      registerAdminRoutes(app, {
        db,
        sessions: sessions ?? NO_ORGANIZERS,
        principals,
        hub,
        storage,
        clock,
        ...(opts.platformAdminEmails ? { platformAdminEmails: opts.platformAdminEmails } : {}),
      });
      if (sessions) {
        registerOrganizerRoutes(app, { db, sessions, principals, hub, guardEnv, clock });
        registerPairingRoutes(app, { db, sessions, principals, hub, clock });
      }
    });
    app.addHook('preClose', async () => {
      hub.io.local.disconnectSockets(true);
    });
    app.addHook('onClose', async () => {
      hub.io.close();
    });
  }

  app.after(() => {
    for (const register of routes) register();
  });

  return app;
}
