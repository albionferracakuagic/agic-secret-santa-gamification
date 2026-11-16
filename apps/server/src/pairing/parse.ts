import Papa from 'papaparse';
import readXlsxFile from 'read-excel-file/node';

export class ParseError extends Error {
  constructor(readonly code: 'unsupported_file' | 'empty_file' | 'invalid_file' | 'too_many_rows') {
    super(code);
  }
}

export interface ParsedTable {
  format: 'csv' | 'xlsx';
  delimiter: string | null;
  encoding: string | null;
  sheets: string[];
  sheet: string | null;
  columns: string[];
  /** `row` = 1-based spreadsheet row (header = 1). Empty rows are skipped but keep their numbers. */
  rows: Array<{ row: number; cells: Record<string, string> }>;
}

export const MAX_ROWS = 5000;

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** BOM first; then BOM-less UTF-16 (NUL pattern); then strict UTF-8; else Windows-1252 (Excel on IT/EU Windows). */
export function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8' };
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }
  const sample = buf.subarray(0, Math.min(buf.length, 200));
  const odd = sample.filter((b, i) => i % 2 === 1 && b === 0).length;
  const even = sample.filter((b, i) => i % 2 === 0 && b === 0).length;
  if (sample.length >= 4 && odd > sample.length / 4 && even === 0) {
    return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'utf-16le' };
  }
  if (sample.length >= 4 && even > sample.length / 4 && odd === 0) {
    return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'utf-16be' };
  }
  try {
    return { text: utf8Strict.decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' };
  }
}

const isZip = (b: Buffer) => b[0] === 0x50 && b[1] === 0x4b;

const DELIMITERS = [',', ';', '\t', '|'] as const;

/** Picks the delimiter that splits the most leading lines into the same (>1) number of fields as the header. */
export function sniffDelimiter(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, 10);
  const fields = (line: string, d: string) => {
    let n = 1;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) n++;
    }
    return n;
  };
  let best = ',';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const header = fields(lines[0] ?? '', d);
    if (header < 2) continue;
    const score = lines.filter((l) => fields(l, d) === header).length * 100 + header;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function toTable(
  format: 'csv' | 'xlsx',
  grid: string[][],
  meta: Pick<ParsedTable, 'delimiter' | 'encoding' | 'sheets' | 'sheet'>,
): ParsedTable {
  const headerIdx = grid.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (headerIdx < 0) throw new ParseError('empty_file');
  const columns = grid[headerIdx]!.map((c) => c.trim());
  if (grid.length - headerIdx - 1 > MAX_ROWS) throw new ParseError('too_many_rows');
  const rows: ParsedTable['rows'] = [];
  grid.slice(headerIdx + 1).forEach((cells, i) => {
    if (cells.every((c) => c.trim() === '')) return;
    const rec: Record<string, string> = {};
    columns.forEach((h, ci) => {
      if (h) rec[h] = (cells[ci] ?? '').trim();
    });
    rows.push({ row: headerIdx + 2 + i, cells: rec });
  });
  return { format, columns: columns.filter(Boolean), rows, ...meta };
}

export async function parseUpload(
  buf: Buffer,
  fileName: string,
  opts: { sheet?: string | undefined } = {},
): Promise<ParsedTable> {
  const lower = fileName.toLowerCase();
  if (/\.xls$/.test(lower)) throw new ParseError('unsupported_file'); // legacy binary format
  if (buf.length === 0) throw new ParseError('empty_file');
  const xlsx = /\.(xlsx|xlsm)$/.test(lower) || (!/\.(csv|txt|tsv)$/.test(lower) && isZip(buf));

  if (xlsx) {
    let sheets: Array<{ sheet: string; data: unknown[][] }>;
    try {
      sheets = (await readXlsxFile(buf)) as Array<{ sheet: string; data: unknown[][] }>;
    } catch {
      throw new ParseError('invalid_file');
    }
    if (!sheets.length) throw new ParseError('empty_file');
    const picked = opts.sheet ? sheets.find((s) => s.sheet === opts.sheet) : sheets[0];
    if (!picked) throw new ParseError('invalid_file');
    const grid = picked.data.map((r) =>
      r.map((c) => (c === null || c === undefined ? '' : String(c))),
    );
    return toTable('xlsx', grid, {
      delimiter: null,
      encoding: null,
      sheets: sheets.map((s) => s.sheet),
      sheet: picked.sheet,
    });
  }

  if (isZip(buf)) throw new ParseError('unsupported_file');
  const { text, encoding } = decodeText(buf);
  const delimiter = sniffDelimiter(text);
  const res = Papa.parse<string[]>(text, { skipEmptyLines: false, delimiter });
  return toTable(
    'csv',
    res.data.map((r) => r.map((c) => String(c))),
    { delimiter, encoding, sheets: [], sheet: null },
  );
}
