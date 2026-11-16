import { describe, expect, it } from 'vitest';
import {
  normalizeName,
  suggestMapping,
  validatePairings,
  type RawRow,
  type RosterEntry,
} from './pairing.js';

const roster = (...names: Array<string | [string, string]>): RosterEntry[] =>
  names.map((n, i) => ({
    id: `r${i}`,
    displayName: Array.isArray(n) ? n[0] : n,
    email: Array.isArray(n) ? n[1] : null,
  }));
const row = (n: number, g: string, r: string, over: Partial<RawRow> = {}): RawRow => ({
  row: n,
  giverName: g,
  recipientName: r,
  ...over,
});
const codes = (r: ReturnType<typeof validatePairings>) => r.issues.map((i) => `${i.row}:${i.code}`);

describe('normalizeName', () => {
  it('ignores case, accents, punctuation and extra spaces', () => {
    expect(normalizeName('  Élodie   D\u2019Arco ')).toBe('elodie d arco');
    expect(normalizeName('NICCOLÒ  Rossi')).toBe(normalizeName('niccolo rossi'));
  });
});

describe('header synonyms (EN/IT)', () => {
  it.each([
    [['Giver', 'Recipient'], { giverName: 'Giver', recipientName: 'Recipient' }],
    [['Santa', 'To'], { giverName: 'Santa', recipientName: 'To' }],
    [['Donatore', 'Destinatario'], { giverName: 'Donatore', recipientName: 'Destinatario' }],
    [['Chi regala', 'Chi riceve'], { giverName: 'Chi regala', recipientName: 'Chi riceve' }],
    [
      ['Email donatore', 'Email destinatario'],
      { giverEmail: 'Email donatore', recipientEmail: 'Email destinatario' },
    ],
    [
      ['From email', 'To name', 'To email'],
      { giverEmail: 'From email', recipientName: 'To name', recipientEmail: 'To email' },
    ],
  ])('%j', (headers, expected) => {
    expect(suggestMapping(headers, [])).toEqual(expected);
  });

  it('a single "name" column holding emails is treated as email', () => {
    const rows = [
      { Giver: 'a@x.it', Recipient: 'b@x.it' },
      { Giver: 'c@x.it', Recipient: 'd@x.it' },
    ];
    expect(suggestMapping(['Giver', 'Recipient'], rows)).toEqual({
      giverEmail: 'Giver',
      recipientEmail: 'Recipient',
    });
  });

  it('unknown headers yield an empty suggestion (mapping step needed)', () => {
    expect(suggestMapping(['Col A', 'Col B'], [])).toEqual({});
  });
});

describe('validatePairings', () => {
  it('matches roster by email first, then normalized name; unmatched become new unclaimed entries', () => {
    const r = validatePairings(
      [
        row(2, 'Anna Bianchi', 'luca@x.it', {
          recipientName: undefined,
          recipientEmail: 'LUCA@x.it',
        }),
        row(3, 'luca rossi', 'Zoe New'),
        row(4, 'Zoe New', 'Anna  Bianchi'),
      ],
      roster('Anna Bianchi', ['Luca Rossi', 'luca@x.it']),
    );
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.newEntries.map((e) => e.displayName)).toEqual(['Zoe New']);
    expect(r.pairs).toHaveLength(3);
    expect(r.pairs[0]).toMatchObject({
      giver: { kind: 'existing', id: 'r0' },
      recipient: { kind: 'existing', id: 'r1' },
    });
    expect(r.summary).toMatchObject({ rows: 3, matchedRoster: 2, newRosterEntries: 1, errors: 0 });
  });

  it('errors: self pair, duplicate row, missing sides, giver with several recipients', () => {
    const r = validatePairings(
      [
        row(2, 'A', 'A'),
        row(3, 'B', 'C'),
        row(4, 'B', 'C'),
        row(5, 'D', 'E'),
        row(6, 'D', 'F'),
        row(7, '', 'G'),
        row(8, 'H', ''),
      ],
      [],
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        '2:self_pair',
        '4:duplicate_row',
        '5:giver_multiple_recipients',
        '6:giver_multiple_recipients',
        '7:missing_giver',
        '8:missing_recipient',
      ]),
    );
    expect(r.summary.errors).toBeGreaterThanOrEqual(6);
  });

  it('ambiguous name (two roster entries normalize equal) is an error until resolved by email', () => {
    const ros = roster(['Mario Rossi', 'm1@x.it'], ['mario  rossi', 'm2@x.it']);
    const bad = validatePairings([row(2, 'Mario Rossi', 'X')], ros);
    expect(codes(bad)).toContain('2:ambiguous_name');
    const ok = validatePairings([{ row: 2, giverEmail: 'm2@x.it', recipientName: 'X' }], ros);
    expect(ok.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(ok.pairs[0]!.giver).toEqual({ kind: 'existing', id: 'r1' });
  });

  it('warnings (non-blocking): recipient with none/several gifts, roster entries not giving', () => {
    const r = validatePairings(
      [row(2, 'A', 'B'), row(3, 'C', 'B'), row(4, 'B', 'A')],
      roster('A', 'B', 'C', 'Lurker'),
    );
    const w = r.issues.filter((i) => i.severity === 'warning');
    expect(w).toContainEqual({ row: null, severity: 'warning', code: 'recipient_none', count: 2 }); // C and Lurker receive nothing
    expect(w).toContainEqual({
      row: null,
      severity: 'warning',
      code: 'recipient_multiple',
      count: 1,
    }); // B receives two
    expect(w).toContainEqual({
      row: null,
      severity: 'warning',
      code: 'roster_without_pairing',
      count: 1,
    }); // Lurker
    expect(r.summary).toMatchObject({ errors: 0, warnings: 3 });
  });

  it('over capacity: new entries beyond maxParticipants is an error', () => {
    const r = validatePairings([row(2, 'A', 'B'), row(3, 'B', 'C')], roster('Z'), {
      maxParticipants: 3,
    });
    expect(r.issues).toContainEqual({ row: null, severity: 'error', code: 'over_capacity' });
  });

  it('issues never contain names, emails or ids', () => {
    const r = validatePairings(
      [row(2, 'Secret Giver', 'Secret Giver'), row(3, '', 'Hidden Person')],
      [],
    );
    const json = JSON.stringify(r.issues) + JSON.stringify(r.summary);
    expect(json).not.toMatch(/Secret|Hidden/);
  });
});
