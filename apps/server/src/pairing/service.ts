import { and, eq, ne } from 'drizzle-orm';
import {
  PairingMappingSchema,
  type PairingImportResult,
  type PairingMapping,
} from '@santa/contracts';
import {
  EventError,
  events,
  latestPairingImport,
  participants,
  recordPairingImport,
  type Db,
} from '@santa/db';
import { suggestMapping, validatePairings, type RawRow } from '@santa/domain';
import { parseUpload } from './parse.js';

export class InvalidMappingError extends Error {}

const ISSUE_CAP = 200;

/**
 * Parse -> (mapping step) -> match + validate -> store/apply. The raw buffer lives only in this call.
 * Returns a masked result: counts + row-numbered issue codes, never pairs, names or emails.
 */
export async function processPairingUpload(
  db: Db,
  p: {
    eventId: string;
    actor: string;
    now: Date;
    fileName: string;
    buf: Buffer;
    sheet?: string | undefined;
    mapping?: PairingMapping | undefined;
  },
): Promise<{ result: PairingImportResult; applied: boolean }> {
  const { reimportAllowed } = await latestPairingImport(db, p.eventId);
  if (!reimportAllowed) throw new EventError('import_locked'); // fail fast, before any parsing
  const table = await parseUpload(p.buf, p.fileName, { sheet: p.sheet });
  const sample = table.rows.slice(0, 50).map((r) => r.cells);
  const suggested = suggestMapping(table.columns, sample);
  const auto = PairingMappingSchema.safeParse(suggested);
  const mapping = p.mapping ?? (auto.success ? auto.data : null);

  const base = {
    detected: { format: table.format, delimiter: table.delimiter, encoding: table.encoding },
    sheets: table.sheets,
    sheet: table.sheet,
    columns: table.columns,
    suggestedMapping: suggested,
  };

  if (!mapping) {
    return {
      applied: false,
      result: {
        ...base,
        importId: null,
        status: 'needs_mapping',
        mapping: null,
        summary: null,
        issues: [],
        issuesTruncated: false,
      },
    };
  }
  for (const col of Object.values(mapping)) {
    if (col && !table.columns.includes(col)) throw new InvalidMappingError(col);
  }

  const raws: RawRow[] = table.rows.map((r) => ({
    row: r.row,
    giverName: mapping.giverName ? r.cells[mapping.giverName] : undefined,
    giverEmail: mapping.giverEmail ? r.cells[mapping.giverEmail] : undefined,
    recipientName: mapping.recipientName ? r.cells[mapping.recipientName] : undefined,
    recipientEmail: mapping.recipientEmail ? r.cells[mapping.recipientEmail] : undefined,
  }));

  const [event] = await db
    .select({ max: events.maxParticipants })
    .from(events)
    .where(eq(events.id, p.eventId));
  const roster = await db
    .select({
      id: participants.id,
      displayName: participants.displayName,
      email: participants.email,
    })
    .from(participants)
    .where(and(eq(participants.eventId, p.eventId), ne(participants.status, 'removed')));

  const validation = validatePairings(raws, roster, { maxParticipants: event?.max ?? 100 });
  const rec = await recordPairingImport(db, {
    eventId: p.eventId,
    actor: p.actor,
    now: p.now,
    fileName: p.fileName.slice(0, 200),
    fileSize: p.buf.length,
    mapping: mapping as Record<string, string>,
    validation,
  });

  return {
    applied: rec.status === 'ready',
    result: {
      ...base,
      importId: rec.importId,
      status: rec.status,
      mapping,
      summary: validation.summary,
      issues: validation.issues.slice(0, ISSUE_CAP),
      issuesTruncated: validation.issues.length > ISSUE_CAP,
    },
  };
}
