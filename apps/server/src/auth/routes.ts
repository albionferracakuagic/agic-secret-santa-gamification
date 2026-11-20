import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { session as sessionTable, type Db } from '@santa/db';
import type { OrganizerSessions } from '../principal.js';
import { TRUSTED_IP_HEADER, type Auth } from './auth.js';

export interface OrganizerContext {
  userId: string;
  email: string;
  isPlatformAdmin: boolean;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    organizer?: OrganizerContext;
  }
}

export interface AuthModule {
  auth: Auth;
  organizerSessions: OrganizerSessions;
  /** Which social sign-in buttons the web app may show (derived from env credentials). */
  providers: { google: boolean; microsoft: boolean };
}

export function createAuthModule(
  auth: Auth,
  db: Db,
  clock: () => Date = () => new Date(),
  providers: AuthModule['providers'] = { google: false, microsoft: false },
): AuthModule {
  return {
    auth,
    providers,
    organizerSessions: {
      async fromCookieHeader(header) {
        if (!header) return null;
        const res = await auth.api.getSession({ headers: new Headers({ cookie: header }) });
        return res ? { userId: res.user.id, sessionId: res.session.id } : null;
      },
      async isCurrent(sessionId) {
        const [row] = await db
          .select({ id: sessionTable.id })
          .from(sessionTable)
          .where(and(eq(sessionTable.id, sessionId), gt(sessionTable.expiresAt, clock())));
        return !!row;
      },
    },
  };
}

export function toHeaders(req: FastifyRequest): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) h.append(k, x);
    else h.set(k, v);
  }
  // never let a client choose the IP Better Auth rate-limits on
  h.delete('x-forwarded-for');
  h.delete('x-real-ip');
  h.set(TRUSTED_IP_HEADER, req.ip);
  return h;
}

export function registerAuthRoutes(app: FastifyInstance, mod: AuthModule) {
  // Better Auth owns /api/auth/*: forward the Fastify request as a Web Request.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const url = new URL(req.url, `${req.protocol}://${req.headers.host ?? 'localhost'}`);
      const hasBody = req.method !== 'GET' && req.body !== undefined && req.body !== null;
      const response = await mod.auth.handler(
        new Request(url, {
          method: req.method,
          headers: toHeaders(req),
          ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers
        .getSetCookie()
        .map((cookie) =>
          req.protocol === 'https' && !/(?:^|;\s*)Secure(?:;|$)/i.test(cookie)
            ? `${cookie}; Secure`
            : cookie,
        );
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(response.body ? await response.text() : null);
    },
  });

  app.get('/api/config', async () => ({ providers: mod.providers }));

  app.get('/api/organizer/me', { preHandler: requireOrganizer(mod) }, async (req) => ({
    userId: req.organizer!.userId,
    email: req.organizer!.email,
    isPlatformAdmin: req.organizer!.isPlatformAdmin,
  }));

  app.get(
    '/api/admin/ping',
    { preHandler: [requireOrganizer(mod), requirePlatformAdmin()] },
    async () => ({ ok: true }),
  );
}

export function requireOrganizer(mod: AuthModule) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const res = await mod.auth.api.getSession({ headers: toHeaders(req) });
    if (!res) {
      return reply
        .status(401)
        .send({ error: { code: 'unauthenticated', message: 'Sign in required' } });
    }
    req.organizer = {
      userId: res.user.id,
      email: res.user.email,
      isPlatformAdmin: (res.user as { isPlatformAdmin?: boolean }).isPlatformAdmin === true,
      sessionId: res.session.id,
    };
  };
}

export function requirePlatformAdmin() {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.organizer?.isPlatformAdmin) {
      return reply
        .status(403)
        .send({ error: { code: 'forbidden', message: 'Platform admin only' } });
    }
  };
}
