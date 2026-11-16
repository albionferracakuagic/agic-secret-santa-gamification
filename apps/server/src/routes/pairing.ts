import type { FastifyInstance } from 'fastify';
import '@fastify/multipart';
import {
  PairingCorrectionRequestSchema,
  PairingCorrectionResponseSchema,
  PairingImportLatestResponseSchema,
  PairingImportResultSchema,
  PairingMappingSchema,
  PairingUploadFieldsSchema,
  UNMASK_GRANT_HEADER,
  type PairingMapping,
} from '@santa/contracts';
import { correctPairing, latestPairingImport, type Db } from '@santa/db';
import type { OrganizerSessions, PrincipalStore } from '../principal.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { broadcastEventState } from '../realtime/broadcast.js';
import { InvalidMappingError, processPairingUpload } from '../pairing/service.js';
import { ParseError } from '../pairing/parse.js';
import { fail, makeGuards } from './guards.js';

export interface PairingRouteDeps {
  db: Db;
  sessions: OrganizerSessions;
  principals: PrincipalStore;
  hub: RealtimeHub;
  clock: () => Date;
}

export function registerPairingRoutes(app: FastifyInstance, d: PairingRouteDeps) {
  const { pre, run, body, eventParams } = makeGuards(d);

  app.post('/api/events/:eventId/pairing-imports', { preHandler: pre }, async (req, reply) => {
    if (!req.isMultipart()) return fail(reply, 400, 'bad_request', 'multipart/form-data required');
    let file: { name: string; buf: Buffer } | undefined;
    const fields: Record<string, string> = {};
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer(); // throws when the 2 MB cap is exceeded
          if (part.fieldname === 'file') file = { name: part.filename, buf };
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') return fail(reply, 413, 'file_too_large');
      return fail(reply, 400, 'bad_request');
    }
    if (!file) return fail(reply, 400, 'bad_request', 'file part required');
    const parsedFields = body(reply, PairingUploadFieldsSchema, fields);
    if (!parsedFields) return;

    let mapping: PairingMapping | undefined;
    if (parsedFields.mapping) {
      try {
        const m = PairingMappingSchema.safeParse(JSON.parse(parsedFields.mapping));
        if (!m.success) return fail(reply, 400, 'invalid_mapping');
        mapping = m.data;
      } catch {
        return fail(reply, 400, 'invalid_mapping');
      }
    }

    return run(reply, async () => {
      try {
        const { result, applied } = await processPairingUpload(d.db, {
          eventId: eventParams(req),
          actor: req.org!.userId,
          now: d.clock(),
          fileName: file!.name,
          buf: file!.buf,
          sheet: parsedFields.sheet,
          mapping,
        });
        if (applied) await broadcastEventState(d.hub, d.db, eventParams(req));
        return PairingImportResultSchema.parse(result); // masked by schema: counts + issue codes only
      } catch (e) {
        if (e instanceof ParseError) return fail(reply, 400, e.code);
        if (e instanceof InvalidMappingError) return fail(reply, 400, 'invalid_mapping');
        throw e;
      }
    });
  });

  app.get('/api/events/:eventId/pairing-imports/latest', { preHandler: pre }, async (req) => {
    const { import: imp, reimportAllowed } = await latestPairingImport(d.db, eventParams(req));
    const stored = imp?.issueSummary as unknown as
      { summary: unknown; issues: unknown[] } | null | undefined;
    return PairingImportLatestResponseSchema.parse({
      import:
        imp && stored
          ? {
              importId: imp.id,
              status: imp.status,
              fileName: imp.fileName,
              createdAt: imp.createdAt.toISOString(),
              summary: stored.summary,
              issues: stored.issues,
            }
          : null,
      reimportAllowed,
    });
  });

  /** Assignment correction: needs an active unmask grant; audited; allowed until voting closes (FR-045). */
  app.post('/api/events/:eventId/pairings/correct', { preHandler: pre }, async (req, reply) => {
    const grant = req.headers[UNMASK_GRANT_HEADER];
    const active =
      typeof grant === 'string' &&
      (await d.principals.grantActive(req.org!.userId, eventParams(req), grant, d.clock()));
    if (!active) return fail(reply, 403, 'unmask_required', 'Active unmask grant required');
    const b = body(reply, PairingCorrectionRequestSchema, req.body);
    if (!b) return;
    return run(reply, async () => {
      const r = await correctPairing(d.db, {
        eventId: eventParams(req),
        actor: req.org!.userId,
        giverId: b.giverId,
        recipientId: b.recipientId,
        now: d.clock(),
      });
      return PairingCorrectionResponseSchema.parse({
        ok: true,
        invalidatedVotes: r.invalidatedVotes,
      });
    });
  });
}
