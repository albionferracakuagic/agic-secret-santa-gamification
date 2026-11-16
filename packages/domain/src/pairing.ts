import type { PairingField } from '@santa/contracts';

export interface RosterEntry {
  id: string;
  displayName: string;
  email?: string | null | undefined;
}

export interface RawRow {
  /** 1-based spreadsheet row number (header = row 1). */
  row: number;
  giverName?: string | undefined;
  giverEmail?: string | undefined;
  recipientName?: string | undefined;
  recipientEmail?: string | undefined;
}

export type PersonRef = { kind: 'existing'; id: string } | { kind: 'new'; key: string };

export interface ResolvedPair {
  row: number;
  giver: PersonRef;
  recipient: PersonRef;
}

export interface NewEntry {
  key: string;
  displayName: string;
  email: string | null;
}

export type PairIssueCode =
  | 'missing_giver'
  | 'missing_recipient'
  | 'self_pair'
  | 'duplicate_row'
  | 'ambiguous_name'
  | 'giver_multiple_recipients'
  | 'over_capacity'
  | 'recipient_none'
  | 'recipient_multiple'
  | 'roster_without_pairing';

export interface PairIssue {
  row: number | null;
  severity: 'error' | 'warning';
  code: PairIssueCode;
  count?: number;
}

export interface PairingValidation {
  pairs: ResolvedPair[];
  newEntries: NewEntry[];
  issues: PairIssue[];
  summary: {
    rows: number;
    matchedRoster: number;
    newRosterEntries: number;
    errors: number;
    warnings: number;
  };
}

/** NFKD, strip diacritics, lowercase, punctuation -> space, collapse spaces. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const norm = normalizeName;
const clean = (s: string | undefined) => (s ?? '').trim();
const lowerEmail = (s: string | undefined) => clean(s).toLowerCase();

/* ---------- header auto-mapping (EN/IT synonyms) ---------- */

const GIVER_WORDS = [
  'giver',
  'santa',
  'secret santa',
  'from',
  'sender',
  'donatore',
  'donatrice',
  'regalante',
  'chi regala',
  'da',
  'mittente',
];
const RECIPIENT_WORDS = [
  'recipient',
  'receiver',
  'to',
  'gifted',
  'destinatario',
  'destinataria',
  'riceve',
  'chi riceve',
  'per',
  'beneficiario',
  'beneficiaria',
  'regalato a',
];
const EMAIL_RE = /e mail|email|mail|posta/;

function matchesWords(header: string, words: string[]): boolean {
  const tokens = header.split(' ');
  return words.some((w) =>
    w.includes(' ') ? ` ${header} `.includes(` ${w} `) : tokens.includes(w),
  );
}

/** Suggests a column mapping from EN/IT header synonyms; email-looking value columns become email fields. */
export function suggestMapping(
  headers: readonly string[],
  sampleRows: ReadonlyArray<Record<string, string>>,
): Partial<Record<PairingField, string>> {
  const out: Partial<Record<PairingField, string>> = {};
  const looksLikeEmail = (h: string) => {
    const vals = sampleRows.map((r) => clean(r[h])).filter(Boolean);
    return vals.length > 0 && vals.filter((v) => v.includes('@')).length / vals.length >= 0.8;
  };
  for (const h of headers) {
    const n = norm(h);
    const role = matchesWords(n, GIVER_WORDS)
      ? 'giver'
      : matchesWords(n, RECIPIENT_WORDS)
        ? 'recipient'
        : null;
    if (!role) continue;
    const isEmail = EMAIL_RE.test(n) || looksLikeEmail(h);
    const field = `${role}${isEmail ? 'Email' : 'Name'}` as PairingField;
    out[field] ??= h;
  }
  return out;
}

/* ---------- matching + validation ---------- */

type Side = 'missing' | 'ambiguous' | PersonRef;

export function validatePairings(
  rows: readonly RawRow[],
  roster: readonly RosterEntry[],
  opts: { maxParticipants?: number } = {},
): PairingValidation {
  const byEmail = new Map<string, RosterEntry[]>();
  const byName = new Map<string, RosterEntry[]>();
  for (const r of roster) {
    if (r.email) byEmail.set(lowerEmail(r.email), [...(byEmail.get(lowerEmail(r.email)) ?? []), r]);
    byName.set(norm(r.displayName), [...(byName.get(norm(r.displayName)) ?? []), r]);
  }
  const newByEmail = new Map<string, NewEntry>();
  const newByName = new Map<string, NewEntry>();
  const newEntries: NewEntry[] = [];

  const makeNew = (name: string, email: string): PersonRef => {
    const found =
      (email && newByEmail.get(email)) || (name && newByName.get(norm(name))) || undefined;
    if (found) return { kind: 'new', key: found.key };
    const e: NewEntry = {
      key: `new:${newEntries.length}`,
      displayName: name || email.split('@')[0] || email,
      email: email || null,
    };
    newEntries.push(e);
    if (email) newByEmail.set(email, e);
    if (name) newByName.set(norm(name), e);
    return { kind: 'new', key: e.key };
  };

  const resolve = (nameRaw: string | undefined, emailRaw: string | undefined): Side => {
    const name = clean(nameRaw);
    const email = lowerEmail(emailRaw);
    if (!name && !email) return 'missing';
    if (email) {
      const hits = byEmail.get(email) ?? [];
      if (hits.length === 1) return { kind: 'existing', id: hits[0]!.id };
      if (hits.length > 1) return 'ambiguous';
    }
    if (name) {
      const hits = byName.get(norm(name)) ?? [];
      if (hits.length === 1 && !(email && hits[0]!.email && lowerEmail(hits[0]!.email) !== email)) {
        return { kind: 'existing', id: hits[0]!.id };
      }
      if (hits.length > 1) return 'ambiguous';
    }
    return makeNew(name, email);
  };

  const issues: PairIssue[] = [];
  const key = (p: PersonRef) => (p.kind === 'existing' ? `e:${p.id}` : p.key);
  const valid: ResolvedPair[] = [];
  const seenPair = new Set<string>();

  for (const r of rows) {
    const g = resolve(r.giverName, r.giverEmail);
    const t = resolve(r.recipientName, r.recipientEmail);
    let bad = false;
    for (const [side, miss] of [
      [g, 'missing_giver'],
      [t, 'missing_recipient'],
    ] as const) {
      if (side === 'missing') {
        issues.push({ row: r.row, severity: 'error', code: miss });
        bad = true;
      } else if (side === 'ambiguous') {
        issues.push({ row: r.row, severity: 'error', code: 'ambiguous_name' });
        bad = true;
      }
    }
    if (bad || typeof g === 'string' || typeof t === 'string') continue;
    if (key(g) === key(t)) {
      issues.push({ row: r.row, severity: 'error', code: 'self_pair' });
      continue;
    }
    const pk = `${key(g)}>${key(t)}`;
    if (seenPair.has(pk)) {
      issues.push({ row: r.row, severity: 'error', code: 'duplicate_row' });
      continue;
    }
    seenPair.add(pk);
    valid.push({ row: r.row, giver: g, recipient: t });
  }

  // one gift per giver: flag every row of a giver with different recipients
  const recipientsOfGiver = new Map<string, Set<string>>();
  for (const p of valid) {
    const set = recipientsOfGiver.get(key(p.giver)) ?? new Set<string>();
    set.add(key(p.recipient));
    recipientsOfGiver.set(key(p.giver), set);
  }
  for (const p of valid) {
    if ((recipientsOfGiver.get(key(p.giver))?.size ?? 0) > 1) {
      issues.push({ row: p.row, severity: 'error', code: 'giver_multiple_recipients' });
    }
  }

  const people = new Set<string>([
    ...roster.map((r) => `e:${r.id}`),
    ...newEntries.map((e) => e.key),
  ]);
  const incoming = new Map<string, number>();
  for (const p of valid) incoming.set(key(p.recipient), (incoming.get(key(p.recipient)) ?? 0) + 1);
  const givers = new Set(valid.map((p) => key(p.giver)));

  const none = [...people].filter((k) => !incoming.has(k)).length;
  const several = [...incoming.values()].filter((n) => n > 1).length;
  const idle = roster.filter((r) => !givers.has(`e:${r.id}`)).length;

  const warn = (code: PairIssueCode, count: number) =>
    count > 0 && issues.push({ row: null, severity: 'warning', code, count });
  warn('recipient_none', none);
  warn('recipient_multiple', several);
  warn('roster_without_pairing', idle);

  if (
    opts.maxParticipants !== undefined &&
    roster.length + newEntries.length > opts.maxParticipants
  ) {
    issues.push({ row: null, severity: 'error', code: 'over_capacity' });
  }

  issues.sort((a, b) => (a.row ?? Infinity) - (b.row ?? Infinity));
  const referencedExisting = new Set(
    valid
      .flatMap((p) => [p.giver, p.recipient])
      .flatMap((x) => (x.kind === 'existing' ? [x.id] : [])),
  );
  const errors = issues.filter((i) => i.severity === 'error').length;
  return {
    pairs: valid,
    newEntries,
    issues,
    summary: {
      rows: rows.length,
      matchedRoster: referencedExisting.size,
      newRosterEntries: newEntries.length,
      errors,
      warnings: issues.length - errors,
    },
  };
}
