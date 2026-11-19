import type { FastifyInstance } from 'fastify';
import '@fastify/multipart';
import {
  GIFT_MAX_PHOTO_BYTES,
  GiftInputSchema,
  GiftModerationRequestSchema,
  MyAssignmentResponseSchema,
  OpeningOrderRequestSchema,
  OpeningStateSchema,
  OrganizerGiftListResponseSchema,
  OwnGiftResponseSchema,
  RevealAllResponseSchema,
  RevealGiftResponseSchema,
  RevealNextResponseSchema,
} from '@santa/contracts';
import {
  getAssignment,
  getOwnGift,
  listGiftsForModeration,
  moderateGift,
  openNextGift,
  openingState,
  revealAllGifts,
  revealGift,
  saveOwnGift,
  setOpeningOrder,
  setOwnGiftPhoto,
  type Db,
} from '@santa/db';
import { giftLabel } from '@santa/domain';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { broadcastEventState, broadcastGifts } from '../realtime/broadcast.js';
import { afterReveal } from '../realtime/phase2.js';
import { revealNextGift } from '../realtime/reveal.js';
import { ImageError, processGiftPhoto } from '../images/process.js';
import { PHOTO_URL_TTL_SECONDS, newGiftPhotoKey, type StorageAdapter } from '../storage/adapter.js';
import { fail, makeGuards, makeParticipantGuard } from './guards.js';

export interface GiftRouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  storage: StorageAdapter;
  clock: () => Date;
}

type GiftRow = {
  id: string;
  aliasNo: number;
  name: string;
  description: string | null;
  photoKey: string | null;
  status: 'registered' | 'opened' | 'revealed';
};

export function registerGiftRoutes(app: FastifyInstance, d: GiftRouteDeps) {
  const g = makeGuards(d);
  const mine = makeParticipantGuard(d.db);
  const url = (key: string | null) =>
    key ? d.storage.readUrl(key, PHOTO_URL_TTL_SECONDS) : Promise.resolve(null);

  const ownGift = async (row: GiftRow | null, editable: boolean) =>
    OwnGiftResponseSchema.parse({
      gift: row && {
        giftId: row.id,
        alias: giftLabel(row),
        name: row.name,
        description: row.description,
        photoUrl: await url(row.photoKey),
        status: row.status,
      },
      editable,
    });

  /* ================= giver ================= */

  app.get('/api/me/gift', { preHandler: mine }, async (req) => {
    const r = await getOwnGift(d.db, req.me!.participantId);
    return ownGift(r.gift, r.editable);
  });

  app.put('/api/me/gift', { preHandler: mine }, async (req, reply) => {
    const b = g.body(reply, GiftInputSchema, req.body);
    if (!b) return;
    return g.run(reply, async () => {
      const r = await saveOwnGift(d.db, {
        participantId: req.me!.participantId,
        name: b.name,
        description: b.description ?? null,
        now: d.clock(),
      });
      if (r.created) await broadcastEventState(d.hub, d.db, req.me!.eventId); // counts only
      const state = await getOwnGift(d.db, req.me!.participantId);
      return reply.status(r.created ? 201 : 200).send(await ownGift(state.gift, state.editable));
    });
  });

  app.post('/api/me/gift/photo', { preHandler: mine }, async (req, reply) => {
    if (!req.isMultipart()) return fail(reply, 400, 'bad_request');
    let buf: Buffer;
    try {
      const file = await req.file({ limits: { fileSize: GIFT_MAX_PHOTO_BYTES, files: 1 } });
      if (!file || file.fieldname !== 'photo') return fail(reply, 400, 'bad_request');
      buf = await file.toBuffer(); // throws past the 5 MB cap
    } catch (e) {
      if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
        return fail(reply, 413, 'file_too_large');
      return fail(reply, 400, 'bad_request');
    }
    return g.run(reply, async () => {
      // Fail before touching storage if the gift can't take a photo (no gift / locked).
      const before = await getOwnGift(d.db, req.me!.participantId);
      if (!before.gift || !before.editable) return fail(reply, 409, 'gift_locked');
      let processed;
      try {
        processed = await processGiftPhoto(buf);
      } catch (e) {
        if (e instanceof ImageError) return fail(reply, 400, 'invalid_image');
        throw e;
      }
      const key = newGiftPhotoKey(req.me!.eventId); // renamed blob: original filename is dropped
      await d.storage.put(key, processed.data, processed.mime);
      try {
        const { oldKey } = await setOwnGiftPhoto(d.db, {
          participantId: req.me!.participantId,
          photoKey: key,
          mime: processed.mime,
          size: processed.data.length,
        });
        if (oldKey) await d.storage.delete(oldKey);
      } catch (e) {
        await d.storage.delete(key); // don't leave an orphan blob
        throw e;
      }
      const state = await getOwnGift(d.db, req.me!.participantId);
      return ownGift(state.gift, state.editable);
    });
  });

  app.delete('/api/me/gift/photo', { preHandler: mine }, async (req, reply) =>
    g.run(reply, async () => {
      const { oldKey } = await setOwnGiftPhoto(d.db, {
        participantId: req.me!.participantId,
        photoKey: null,
      });
      if (oldKey) await d.storage.delete(oldKey);
      const state = await getOwnGift(d.db, req.me!.participantId);
      return ownGift(state.gift, state.editable);
    }),
  );

  /** Own recipient: released only after a verified claim (rule 16). */
  app.get('/api/me/assignment', { preHandler: mine }, async (req, reply) => {
    if (!req.me!.verified) return fail(reply, 403, 'verification_required');
    const a = await getAssignment(d.db, req.me!.participantId);
    if (!a.recipient) return fail(reply, 404, 'not_found');
    return MyAssignmentResponseSchema.parse({
      recipient: {
        participantId: a.recipient.id,
        displayName: a.recipient.displayName,
        avatar: a.recipient.avatar,
      },
    });
  });

  /* ================= organizer: moderation ================= */

  app.get('/api/events/:eventId/gifts', { preHandler: g.pre }, async (req) => {
    const rows = await listGiftsForModeration(d.db, g.eventParams(req));
    return OrganizerGiftListResponseSchema.parse({
      gifts: await Promise.all(
        rows.map(async (r) => ({
          giftId: r.id,
          alias: giftLabel(r),
          name: r.name,
          description: r.description,
          photoUrl: await url(r.photoKey),
          status: r.status,
          hidden: r.hidden,
        })),
      ),
    });
  });

  app.patch('/api/events/:eventId/gifts/:giftId', { preHandler: g.pre }, async (req, reply) => {
    const patch = g.body(reply, GiftModerationRequestSchema, req.body);
    if (!patch) return;
    const { giftId } = req.params as { giftId: string };
    return g.run(reply, async () => {
      const r = await moderateGift(d.db, {
        eventId: g.eventParams(req),
        giftId,
        actor: req.org!.userId,
        now: d.clock(),
        patch,
      });
      if (r.oldPhotoKey) await d.storage.delete(r.oldPhotoKey);
      await broadcastGifts(d.hub, d.db, g.eventParams(req));
      return { ok: true };
    });
  });

  /* ================= organizer: opening ================= */

  app.get('/api/events/:eventId/opening', { preHandler: g.pre }, async (req) =>
    OpeningStateSchema.parse(await openingState(d.db, g.eventParams(req))),
  );

  app.post('/api/events/:eventId/opening/order', { preHandler: g.pre }, async (req, reply) => {
    const b = g.body(reply, OpeningOrderRequestSchema, req.body);
    if (!b) return;
    return g.run(reply, async () =>
      OpeningStateSchema.parse(
        await setOpeningOrder(d.db, {
          eventId: g.eventParams(req),
          actor: req.org!.userId,
          now: d.clock(),
          mode: b.mode,
          ...(b.mode === 'manual' ? { order: b.order } : {}),
        }),
      ),
    );
  });

  app.post('/api/events/:eventId/opening/next', { preHandler: g.pre }, async (req, reply) =>
    g.run(reply, async () => {
      const st = await openNextGift(d.db, {
        eventId: g.eventParams(req),
        actor: req.org!.userId,
        now: d.clock(),
      });
      await broadcastGifts(d.hub, d.db, g.eventParams(req));
      return OpeningStateSchema.parse(st);
    }),
  );

  /* ================= organizer: giver reveal ================= */

  app.post(
    '/api/events/:eventId/reveal/gifts/:giftId',
    { preHandler: g.pre },
    async (req, reply) => {
      const { giftId } = req.params as { giftId: string };
      return g.run(reply, async () => {
        const r = await revealGift(d.db, {
          eventId: g.eventParams(req),
          giftId,
          actor: req.org!.userId,
          now: d.clock(),
        });
        if (r.changed) {
          await broadcastGifts(d.hub, d.db, g.eventParams(req));
          await afterReveal(d.hub, d.db, g.eventParams(req), d.clock()); // guesses on this gift settle
        }
        return RevealGiftResponseSchema.parse({
          giftId: r.giftId,
          status: 'revealed',
          revealedAt: r.revealedAt.toISOString(),
        });
      });
    },
  );

  /** Reveal show: next gift on stage with a drumroll; the giver is revealed by the durable `reveal.unveil` job. */
  app.post('/api/events/:eventId/reveal/next', { preHandler: g.pre }, async (req, reply) =>
    g.run(reply, async () => {
      const r = await revealNextGift(d.hub, d.db, {
        eventId: g.eventParams(req),
        actor: req.org!.userId,
        now: d.clock(),
      });
      return RevealNextResponseSchema.parse({
        ...r,
        countdownEndsAt: r.countdownEndsAt?.toISOString() ?? null,
      });
    }),
  );

  app.post('/api/events/:eventId/reveal/all', { preHandler: g.pre }, async (req, reply) =>
    g.run(reply, async () => {
      const r = await revealAllGifts(d.db, {
        eventId: g.eventParams(req),
        actor: req.org!.userId,
        now: d.clock(),
      });
      if (r.revealed > 0) {
        await broadcastGifts(d.hub, d.db, g.eventParams(req));
        await afterReveal(d.hub, d.db, g.eventParams(req), d.clock());
      }
      return RevealAllResponseSchema.parse(r);
    }),
  );
}
