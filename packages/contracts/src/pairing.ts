import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';

/** Multipart upload cap for POST /api/events/:eventId/pairing-imports. */
export const PAIRING_MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Organizer-supplied giver->recipient list (CSV/XLSX from an external draw app).
 * Matching: email (case-insensitive) first, else normalized name. Masked by design:
 * no response in this file ever contains a pair, a name or an email.
 */
export const PAIRING_FIELDS = [
  'giverName',
  'giverEmail',
  'recipientName',
  'recipientEmail',
] as const;
export type PairingField = (typeof PAIRING_FIELDS)[number];

/** Column header (exact text from the file) for each field; at least one giver and one recipient column. */
export const PairingMappingSchema = z
  .strictObject({
    giverName: z.string().min(1).optional(),
    giverEmail: z.string().min(1).optional(),
    recipientName: z.string().min(1).optional(),
    recipientEmail: z.string().min(1).optional(),
  })
  .refine((m) => !!(m.giverName ?? m.giverEmail) && !!(m.recipientName ?? m.recipientEmail), {
    message: 'mapping needs a giver column and a recipient column',
  });
export type PairingMapping = z.infer<typeof PairingMappingSchema>;

/** Same shape without the "at least one per side" rule: auto-detection may find only part of it. */
export const SuggestedPairingMappingSchema = z.strictObject({
  giverName: z.string().optional(),
  giverEmail: z.string().optional(),
  recipientName: z.string().optional(),
  recipientEmail: z.string().optional(),
});

/** Multipart text fields next to the `file` part (all optional). */
export const PairingUploadFieldsSchema = z.strictObject({
  /** XLSX only: sheet name to read (default: first sheet). */
  sheet: z.string().min(1).max(100).optional(),
  /** JSON-encoded PairingMapping; omit to use auto-detected EN/IT header synonyms. */
  mapping: z.string().max(2000).optional(),
});

export const PAIRING_ISSUE_CODES = [
  'missing_giver', // error: row has no usable giver
  'missing_recipient', // error
  'self_pair', // error: giver == recipient
  'duplicate_row', // error: same giver->recipient twice
  'ambiguous_name', // error until resolved (use email, or make names unique)
  'giver_multiple_recipients', // error: one gift per giver
  'over_capacity', // error: new roster entries would exceed maxParticipants (row = null)
  'recipient_none', // warning: someone receives no gift (row = null, count = people)
  'recipient_multiple', // warning: someone receives several gifts (row = null, count = people)
  'roster_without_pairing', // warning: roster entries not giving in this file (row = null, count)
] as const;
export const PairingIssueCodeSchema = z.enum(PAIRING_ISSUE_CODES);

export const PairingIssueSchema = z.strictObject({
  /** 1-based spreadsheet row (header = row 1); null for roster-level issues. */
  row: z.number().int().min(1).nullable(),
  severity: z.enum(['error', 'warning']),
  code: PairingIssueCodeSchema,
  count: z.number().int().min(1).optional(),
});

export const PairingImportSummarySchema = z.strictObject({
  rows: z.number().int().min(0),
  matchedRoster: z.number().int().min(0),
  newRosterEntries: z.number().int().min(0),
  errors: z.number().int().min(0),
  warnings: z.number().int().min(0),
});

export const PAIRING_IMPORT_STATUSES = ['needs_mapping', 'draft', 'ready'] as const;
export const PairingImportStatusSchema = z.enum(PAIRING_IMPORT_STATUSES);

/**
 * Response of POST /api/events/:eventId/pairing-imports (multipart: file, sheet?, mapping?).
 * needs_mapping: nothing stored; re-upload the same file with `mapping` (and `sheet`).
 * draft: parsed, errors open, nothing applied (stored as an import record).
 * ready: consistent; roster entries + pairings applied (replacing earlier imported pairings).
 * The raw file is never stored.
 */
export const PairingImportResultSchema = z.strictObject({
  importId: IdSchema.nullable(),
  status: PairingImportStatusSchema,
  detected: z.strictObject({
    format: z.enum(['csv', 'xlsx']),
    delimiter: z.string().nullable(),
    encoding: z.string().nullable(),
  }),
  sheets: z.array(z.string()),
  sheet: z.string().nullable(),
  columns: z.array(z.string()),
  suggestedMapping: SuggestedPairingMappingSchema,
  mapping: PairingMappingSchema.nullable(),
  summary: PairingImportSummarySchema.nullable(),
  issues: z.array(PairingIssueSchema),
  issuesTruncated: z.boolean(),
});
export type PairingImportResult = z.infer<typeof PairingImportResultSchema>;

/** GET /api/events/:eventId/pairing-imports/latest */
export const PairingImportLatestResponseSchema = z.strictObject({
  import: z
    .strictObject({
      importId: IdSchema,
      status: z.enum(['draft', 'ready']),
      fileName: z.string().nullable(),
      createdAt: IsoDateSchema,
      summary: PairingImportSummarySchema,
      issues: z.array(PairingIssueSchema),
    })
    .nullable(),
  /** False once gift opening started: re-import is disabled forever (corrections need unmask). */
  reimportAllowed: z.boolean(),
});

/**
 * POST /api/events/:eventId/pairings/correct (requires x-unmask-grant; audited; until voting closes).
 * Also invalidates votes that became invalid (voter is the giver of the voted gift).
 */
export const PairingCorrectionRequestSchema = z.strictObject({
  giverId: IdSchema,
  recipientId: IdSchema,
});
export const PairingCorrectionResponseSchema = z.strictObject({
  ok: z.literal(true),
  invalidatedVotes: z.number().int().min(0),
});
