import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  ACHIEVEMENT_CATALOG,
  CertificateQuerySchema,
  MyCertificatesResponseSchema,
} from '@santa/contracts';
import { events, myAchievements, participantAchievements, participants, type Db } from '@santa/db';
import { fail, makeParticipantGuard } from '../routes/guards.js';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { renderCertificate } from './render.js';

export interface CertificateRouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  clock: () => Date;
  /** Override the font directory (tests); defaults to the web app's licensed fonts. */
  fontsDir?: string;
}

const MAX_CACHED = 100;

/**
 * FR-041: PNG award cards. One per achievement the caller has actually unlocked (vote-derived ones only exist
 * after canPublish() and the ceremony step). Nobody can fetch another person's certificate.
 */
export function registerCertificateRoutes(app: FastifyInstance, d: CertificateRouteDeps) {
  const mine = makeParticipantGuard(d.db);
  // small in-memory LRU: a card is a pure function of (participant, achievement, locale, event name)
  const cache = new Map<string, Buffer>();

  app.get('/api/me/certificates', { preHandler: mine }, async (req) => {
    const unlocked = await myAchievements(d.db, req.me!.participantId);
    return MyCertificatesResponseSchema.parse({
      certificates: unlocked.flatMap((a) => {
        const def = ACHIEVEMENT_CATALOG.find((x) => x.key === a.key);
        return def
          ? [
              {
                key: def.key,
                title: { ...def.name },
                url: `/api/me/achievements/${def.key}/certificate.png`,
              },
            ]
          : [];
      }),
    });
  });

  app.get(
    '/api/me/achievements/:key/certificate.png',
    // rendering is CPU-heavy: tight per-client limit on top of the global one
    { preHandler: mine, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { key } = req.params as { key: string };
      const q = CertificateQuerySchema.safeParse(req.query ?? {});
      if (!q.success) return fail(reply, 400, 'bad_request');
      const def = ACHIEVEMENT_CATALOG.find((x) => x.key === key);
      const [owned] = def
        ? await d.db
            .select({ id: participantAchievements.id })
            .from(participantAchievements)
            .where(
              and(
                eq(participantAchievements.participantId, req.me!.participantId),
                eq(participantAchievements.key, key),
              ),
            )
        : [];
      // same answer for "unknown" and "not yours": no probing of other people's achievements
      if (!def || !owned) return fail(reply, 404, 'not_found');
      const [row] = await d.db
        .select({
          name: participants.displayName,
          eventName: events.name,
          startsAt: events.startsAt,
          timezone: events.timezone,
          locale: events.defaultLocale,
        })
        .from(participants)
        .innerJoin(events, eq(events.id, participants.eventId))
        .where(eq(participants.id, req.me!.participantId));
      if (!row) return fail(reply, 404, 'not_found');
      const locale = q.data.locale ?? (row.locale === 'it' ? 'it' : 'en');
      const year = Number(
        new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: row.timezone }).format(
          row.startsAt,
        ),
      );
      const cacheKey = [req.me!.participantId, key, locale, row.name, row.eventName].join('|');
      let png = cache.get(cacheKey);
      if (png) {
        cache.delete(cacheKey);
      } else {
        png = await renderCertificate(
          {
            locale,
            name: row.name,
            title: def.name[locale],
            description: def.description[locale],
            eventName: row.eventName,
            year,
            seed: `${req.me!.participantId}:${key}`,
          },
          d.fontsDir,
        );
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
      }
      cache.set(cacheKey, png);
      return reply
        .type('image/png')
        .header('Cache-Control', 'no-store')
        .header('Content-Disposition', `inline; filename="certificate-${key}.png"`)
        .send(png);
    },
  );
}
