import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import writeXlsxFile from 'write-excel-file/node';
import {
  gifts,
  events,
  pairingImports,
  pairings,
  participants,
  votes,
  votingCategories,
} from '@santa/db';
import { createWorld, type World } from '../testing/world.js';
import { multipart } from '../testing/multipart.js';
import { decodeText, parseUpload, ParseError } from './parse.js';

describe('parse: encoding + delimiter sniffing', () => {
  it('UTF-8 BOM, UTF-16LE BOM, BOM-less UTF-16LE, Windows-1252 and plain UTF-8', () => {
    const s = 'Donatore;Destinatario\nNiccolò;Zoë\n';
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s)]))).toEqual({
      text: s,
      encoding: 'utf-8',
    });
    expect(
      decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])),
    ).toEqual({ text: s, encoding: 'utf-16le' });
    expect(decodeText(Buffer.from(s, 'utf16le'))).toEqual({ text: s, encoding: 'utf-16le' });
    expect(decodeText(Buffer.from(s, 'latin1'))).toEqual({ text: s, encoding: 'windows-1252' });
    expect(decodeText(Buffer.from(s, 'utf8'))).toEqual({ text: s, encoding: 'utf-8' });
  });

  it.each([
    [';', 'Donatore;Destinatario\nA;B\n'],
    [',', 'Giver,Recipient\nA,B\n'],
    ['\t', 'Giver\tRecipient\nA\tB\n'],
  ])('detects delimiter %j', async (delimiter, csv) => {
    const t = await parseUpload(Buffer.from(csv), 'x.csv');
    expect(t.delimiter).toBe(delimiter);
    expect(t.rows).toEqual([{ row: 2, cells: expect.any(Object) }]);
  });

  it('keeps spreadsheet row numbers across blank lines; rejects legacy .xls and empty files', async () => {
    const t = await parseUpload(Buffer.from('Giver,Recipient\n\nA,B\n,\nC,D\n'), 'x.csv');
    expect(t.rows.map((r) => r.row)).toEqual([3, 5]);
    await expect(parseUpload(Buffer.from('x'), 'old.xls')).rejects.toBeInstanceOf(ParseError);
    await expect(parseUpload(Buffer.alloc(0), 'x.csv')).rejects.toMatchObject({
      code: 'empty_file',
    });
  });
});

describe('pairing import endpoints', () => {
  let w: World;
  let n = 0;
  const OWNER = () => w.organizerCookie('demo-owner', 'sess-o');
  const names = ['Giulia', 'Marco', 'Sofia', 'Luca', 'Chiara', 'Paolo', 'Elena', 'Davide'];

  beforeAll(async () => {
    w = await createWorld();
  }, 60_000);
  afterAll(async () => {
    await w.close();
  });

  const upload = (
    file: { name: string; content: Buffer | string } | undefined,
    fields: Record<string, string> = {},
    cookie: string | null = OWNER(),
    eventId = w.eventId,
  ) => {
    const m = multipart(fields, file);
    return w.app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/pairing-imports`,
      payload: m.payload,
      headers: {
        'content-type': m.contentType,
        'idempotency-key': `up-${++n}-xxxxxxxx`,
        ...(cookie ? { cookie } : {}),
      },
    });
  };
  const ring = (offset: number, header = 'Donatore;Destinatario') =>
    `${header}\n${names.map((g, i) => `${g};${names[(i + offset) % names.length]}`).join('\n')}\n`;
  const pairCount = async () =>
    (await w.db.select().from(pairings).where(eq(pairings.eventId, w.eventId))).length;

  it('requires an organizer session and event membership', async () => {
    expect((await upload({ name: 'a.csv', content: ring(1) }, {}, null)).statusCode).toBe(401);
    expect(
      (await upload({ name: 'a.csv', content: ring(1) }, {}, w.organizerCookie('stranger', 's')))
        .statusCode,
    ).toBe(403);
  });

  it('IT CSV (; + BOM + accents): ready, replaces pairings, creates unclaimed roster entries, masked summary', async () => {
    const csv = `Donatore;Destinatario\n${names.map((g, i) => `${g};${i === 0 ? 'Niccolò Rossi' : names[i - 1]}`).join('\n')}\nNiccolò Rossi;Davide\n`;
    const res = await upload({
      name: 'draw.csv',
      content: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv)]),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'ready',
      detected: { format: 'csv', delimiter: ';', encoding: 'utf-8' },
      mapping: { giverName: 'Donatore', recipientName: 'Destinatario' },
      summary: { rows: 9, newRosterEntries: 1, errors: 0 },
    });
    // masked: counts + issue codes only, never names/pairs
    expect(JSON.stringify(body)).not.toMatch(/Giulia|Marco|Niccol|Davide/);
    const roster = await w.db
      .select()
      .from(participants)
      .where(eq(participants.displayName, 'Niccolò Rossi'));
    expect(roster).toMatchObject([{ status: 'unclaimed', source: 'import' }]);
    expect(await pairCount()).toBe(9);
    // raw file is not stored anywhere: only metadata + issue codes
    const [rec] = await w.db
      .select()
      .from(pairingImports)
      .where(eq(pairingImports.id, body.importId));
    expect(JSON.stringify(rec)).not.toMatch(/Giulia|Niccol/);
    expect(rec).toMatchObject({ status: 'ready', fileName: 'draw.csv' });
  });

  it('Windows-1252 and UTF-16LE files decode correctly', async () => {
    const cp1252 = await upload({
      name: 'x.csv',
      content: Buffer.from(ring(2).replace('Giulia;', 'Giulia;'), 'latin1'),
    });
    expect(cp1252.json()).toMatchObject({ status: 'ready', detected: { encoding: 'utf-8' } }); // ASCII-only names stay utf-8
    const withAccent = ring(3).replace('Elena', 'Elèna');
    const res = await upload({ name: 'x.csv', content: Buffer.from(withAccent, 'latin1') });
    expect(res.json()).toMatchObject({
      detected: { encoding: 'windows-1252' },
      summary: { newRosterEntries: 0 },
    }); // Elèna matches Elena (accent-insensitive)
    const u16 = await upload({
      name: 'x.csv',
      content: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ring(4), 'utf16le')]),
    });
    expect(u16.json()).toMatchObject({ status: 'ready', detected: { encoding: 'utf-16le' } });
  });

  it('XLSX: sheets listed, first sheet default, sheet picker works', async () => {
    const wb = await writeXlsxFile([
      {
        sheet: 'Notes',
        data: [
          ['Giver', 'Recipient'],
          ['Giulia', 'Giulia'],
        ],
      },
      {
        sheet: 'Draw',
        data: [['Santa', 'To'], ...names.map((g, i) => [g, names[(i + 1) % names.length]!])],
      },
    ]).toBuffer();
    const first = await upload({ name: 'draw.xlsx', content: wb });
    expect(first.json()).toMatchObject({
      detected: { format: 'xlsx' },
      sheets: ['Notes', 'Draw'],
      sheet: 'Notes',
      status: 'draft',
    });
    const second = await upload({ name: 'draw.xlsx', content: wb }, { sheet: 'Draw' });
    expect(second.json()).toMatchObject({
      status: 'ready',
      sheet: 'Draw',
      mapping: { giverName: 'Santa', recipientName: 'To' },
    });
  });

  it('mapping step: unknown headers -> needs_mapping (nothing stored); explicit mapping applies; bad mapping 400', async () => {
    const before = await pairCount();
    const csv = `Col A,Col B\n${names.map((g, i) => `${g},${names[(i + 5) % 8]}`).join('\n')}\n`;
    const need = await upload({ name: 'x.csv', content: csv });
    expect(need.json()).toMatchObject({
      status: 'needs_mapping',
      importId: null,
      columns: ['Col A', 'Col B'],
      summary: null,
    });
    expect(await pairCount()).toBe(before);

    const bad = await upload(
      { name: 'x.csv', content: csv },
      { mapping: JSON.stringify({ giverName: 'Nope', recipientName: 'Col B' }) },
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_mapping');
    const ok = await upload(
      { name: 'x.csv', content: csv },
      { mapping: JSON.stringify({ giverName: 'Col A', recipientName: 'Col B' }) },
    );
    expect(ok.json()).toMatchObject({ status: 'ready', summary: { errors: 0 } });
  });

  it('errors keep the import a draft: row-numbered codes, nothing applied, still masked', async () => {
    const before = await pairCount();
    const csv = 'Giver,Recipient\nGiulia,Giulia\nMarco,Sofia\nMarco,Luca\nSofia,Zeno Secret\n';
    const res = await upload({ name: 'bad.csv', content: csv });
    const body = res.json();
    expect(body.status).toBe('draft');
    expect(body.issues).toEqual(
      expect.arrayContaining([
        { row: 2, severity: 'error', code: 'self_pair' },
        { row: 3, severity: 'error', code: 'giver_multiple_recipients' },
        { row: 4, severity: 'error', code: 'giver_multiple_recipients' },
      ]),
    );
    expect(JSON.stringify(body)).not.toMatch(/Zeno|Secret/);
    expect(await pairCount()).toBe(before);
    expect(
      await w.db.select().from(participants).where(eq(participants.displayName, 'Zeno Secret')),
    ).toHaveLength(0);
    const latest = (
      await w.app.inject({
        method: 'GET',
        url: `/api/events/${w.eventId}/pairing-imports/latest`,
        headers: { cookie: OWNER() },
      })
    ).json();
    expect(latest).toMatchObject({
      import: { status: 'draft', summary: { errors: 3 } },
      reimportAllowed: true,
    });
  });

  it('size cap 2 MB, unsupported/empty files and non-multipart are rejected', async () => {
    const big = await upload({
      name: 'big.csv',
      content: Buffer.alloc(2 * 1024 * 1024 + 10, 0x41),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('file_too_large');
    expect((await upload({ name: 'old.xls', content: 'x' })).json().error.code).toBe(
      'unsupported_file',
    );
    expect((await upload({ name: 'e.csv', content: '' })).json().error.code).toBe('empty_file');
    expect((await upload(undefined)).statusCode).toBe(400);
    const plain = await w.app.inject({
      method: 'POST',
      url: `/api/events/${w.eventId}/pairing-imports`,
      payload: { a: 1 },
      headers: { cookie: OWNER(), 'idempotency-key': 'plain-xxxxxxxx' },
    });
    expect(plain.statusCode).toBe(400);
  });

  it('re-import is disabled once gift opening started; corrections need an unmask grant, are audited, drop invalid votes, and close with voting', async () => {
    const people = await w.db
      .select()
      .from(participants)
      .where(eq(participants.eventId, w.eventId));
    const [giulia, marco] = ['Giulia', 'Marco'].map((nm) =>
      people.find((p) => p.displayName === nm)!,
    );
    // a vote that becomes invalid: Marco voted for the gift Marco gave
    const [cat] = await w.db
      .select()
      .from(votingCategories)
      .where(eq(votingCategories.eventId, w.eventId))
      .limit(1);
    const [gift] = await w.db
      .insert(gifts)
      .values({ eventId: w.eventId, giverId: marco!.id, aliasNo: 77, name: 'G' })
      .returning();
    await w.db
      .insert(votes)
      .values({ categoryId: cat!.id, voterId: marco!.id, eventId: w.eventId, giftId: gift!.id });

    const correct = (
      grant?: string,
      body: object = { giverId: giulia!.id, recipientId: marco!.id },
    ) =>
      w.app.inject({
        method: 'POST',
        url: `/api/events/${w.eventId}/pairings/correct`,
        payload: body,
        headers: {
          cookie: OWNER(),
          'idempotency-key': `c-${++n}-xxxxxxxx`,
          ...(grant ? { 'x-unmask-grant': grant } : {}),
        },
      });
    expect((await correct()).statusCode).toBe(403);
    const grantId = await w.grant();
    const ok = await correct(grantId);
    expect(ok.json()).toEqual({ ok: true, invalidatedVotes: 1 });
    const [p] = await w.db.select().from(pairings).where(eq(pairings.giverId, giulia!.id));
    expect(p).toMatchObject({ recipientId: marco!.id, source: 'manual' });
    expect(await w.db.select().from(votes)).toHaveLength(0);
    expect(
      (await correct(grantId, { giverId: giulia!.id, recipientId: giulia!.id })).statusCode,
    ).toBe(400);

    const audit = (
      await w.app.inject({
        method: 'GET',
        url: `/api/events/${w.eventId}/audit`,
        headers: { cookie: OWNER() },
      })
    ).json();
    const actions = audit.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['pairing.import', 'pairing.correct']));

    await w.db
      .update(events)
      .set({ giftOpeningStartedAt: new Date() })
      .where(eq(events.id, w.eventId));
    const locked = await upload({ name: 'a.csv', content: ring(1) });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('import_locked');
    const latest = (
      await w.app.inject({
        method: 'GET',
        url: `/api/events/${w.eventId}/pairing-imports/latest`,
        headers: { cookie: OWNER() },
      })
    ).json();
    expect(latest.reimportAllowed).toBe(false);
    expect((await correct(grantId)).statusCode).toBe(200); // corrections still allowed until voting closes

    await w.db.update(events).set({ votingClosedAt: new Date() }).where(eq(events.id, w.eventId));
    const closed = await correct(grantId);
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('correction_closed');
  });
});
