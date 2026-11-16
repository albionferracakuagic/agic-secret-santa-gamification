#!/usr/bin/env node
/**
 * credits-report.mjs — Report dei crediti (premium requests) consumati dalle sessioni
 * GitHub Copilot CLI, per progetto / sessione / modello / agente / giorno.
 *
 * Parte del plugin Copilot CLI `agic-ai-team` (skill `credit-tracking`).
 * Scaffoldato nei repo cliente sotto `scripts/credits/` da `/init-slce-ai-team`.
 *
 * SORGENTE DATI
 * -------------
 * DB SQLite locale della Copilot CLI: `%USERPROFILE%/.copilot/session-store.db`
 *   - `assistant_usage_events` : una riga per richiesta al modello
 *   - `sessions`               : una riga per sessione (join su `sessions.id = session_id`)
 *
 * METRICHE
 * --------
 *   Crediti (premium requests) = SUM(request_multiplier)   <- METRICA PRINCIPALE (fatturata)
 *   AIU                        = SUM(total_nano_aiu) / 1e9 <- metrica secondaria di costo
 *
 * VINCOLI DI PROGETTO (non negoziabili)
 * -------------------------------------
 *   - Node.js >= 22, modulo NATIVO `node:sqlite`. ZERO dipendenze npm.
 *   - Il DB viene aperto SEMPRE in sola lettura: non ci si scrive MAI (è in uso dalla CLI).
 *   - Nessuno stacktrace in faccia all'utente: errori previsti = messaggio chiaro.
 *
 * @see skills/credit-tracking/SKILL.md
 */

// ---------------------------------------------------------------------------
// Soppressione dell'ExperimentalWarning di `node:sqlite`.
// Va installata PRIMA che il modulo venga caricato: gli `import` statici sono
// hoisted e valutati prima del codice top-level, quindi `node:sqlite` va
// importato dinamicamente (sotto) dopo aver patchato process.emit.
// Filtriamo SOLO l'ExperimentalWarning di sqlite: ogni altro warning passa.
// ---------------------------------------------------------------------------
const __emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (
    name === 'warning' &&
    data &&
    data.name === 'ExperimentalWarning' &&
    typeof data.message === 'string' &&
    /sqlite/i.test(data.message)
  ) {
    return false;
  }
  return __emit.call(process, name, data, ...rest);
};

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { DatabaseSync } = await import('node:sqlite');

// ---------------------------------------------------------------------------
// Costanti
// ---------------------------------------------------------------------------

const DEFAULT_DB = path.join(os.homedir(), '.copilot', 'session-store.db');
const BUDGET_FILE = '.ai-credits.json';
const LEDGER_FILE = path.join('doc', 'credits-ledger.md');
const GROUP_DIMS = ['project', 'session', 'model', 'agent', 'day'];
const NULL_AGENT_LABEL = '(main)';
const UNKNOWN_PROJECT_LABEL = '(sconosciuto)';

const LEDGER_HEADER = [
  '| Data | Sessione | Durata | Crediti | AIU | Modelli | Agenti | Attività |',
  '|---|---|---|---|---|---|---|---|',
];

const DEFAULT_BUDGET_CONFIG = {
  $schema: 'agic-ai-team/credits/v1',
  budget_credits: 0,
  warn_threshold: 0.8,
  expensive_models: [
    'claude-opus-5',
    'claude-opus-4.8',
    'claude-opus-4.7',
    'claude-opus-4.6',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.5',
  ],
  require_confirmation_over_budget: true,
  notes: 'budget_credits: 0 = nessun limite (default)',
};

const HELP = `
credits-report.mjs — crediti (premium requests) consumati dalle sessioni Copilot CLI

USO
  node credits-report.mjs [opzioni]

FILTRI
  --project <path>       Filtra per sessions.cwd (prefix match). Default: cartella corrente
  --all-projects         Aggrega su tutti i progetti (ignora --project)
  --session <id>         Dettaglio di una singola sessione (accetta anche solo il prefisso)
  --since <YYYY-MM-DD>   Considera solo gli eventi da questa data (inclusa)
  --days <n>             Ultimi n giorni solari, oggi incluso (--days 1 = solo oggi)

OUTPUT
  --group-by <dim>       project | session | model | agent | day   (default: model)
  --top <n>              Numero massimo di righe mostrate (default: 20, 0 = tutte)
  --json                 Output JSON invece delle tabelle testuali
  --agent-map <file>     JSON { "toolu_xxx": "gio" } per risolvere i nomi degli agenti

BUDGET (mai bloccante)
  --init-budget          Crea ${BUDGET_FILE} con i default nella root del progetto
  --budget-check         Stato del budget. Exit code SEMPRE 0. Silenzioso se budget = 0

LEDGER (sempre attivo: il ledger è un atto documentale, non un opt-in)
  --append-ledger        Upsert idempotente della riga di sessione su ${LEDGER_FILE.replace(/\\/g, '/')}:
                         crea il file se manca, appende se la sessione non c'è,
                         aggiorna in place la SOLA riga se la sessione c'è già
  --ledger-row           Stampa UNA riga markdown per il ledger (non scrive nulla)
  --init-ledger          Crea ${LEDGER_FILE.replace(/\\/g, '/')} vuoto (non serve prima di --append-ledger)

ALTRO
  --db <path>            Override del path del DB (default: ${DEFAULT_DB})
  -h, --help             Questo messaggio

METRICHE
  Crediti = SUM(request_multiplier) — è la metrica che GitHub fattura (opus-5 = 15x, sonnet-5 = 1x)
  AIU     = SUM(total_nano_aiu)/1e9 — metrica secondaria di costo

ESEMPI
  node credits-report.mjs --group-by model
  node credits-report.mjs --all-projects --group-by project --top 10
  node credits-report.mjs --days 7 --group-by day
  node credits-report.mjs --group-by agent --agent-map .ai-agents.json
  node credits-report.mjs --append-ledger
`;

// ---------------------------------------------------------------------------
// Errori "attesi": vengono resi come messaggio pulito, mai come stacktrace
// ---------------------------------------------------------------------------

class UserError extends Error {}

function fail(msg, hint) {
  throw new UserError(hint ? `${msg}\n   → ${hint}` : msg);
}

// ---------------------------------------------------------------------------
// Formattazione
// ---------------------------------------------------------------------------

// useGrouping: 'always' è necessario: in it-IT il default (minimumGroupingDigits: 2)
// NON raggruppa i numeri a 4 cifre — "5449,00" invece di "5.449,00".
const NF2 = new Intl.NumberFormat('it-IT', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: 'always',
});
const NF0 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0, useGrouping: 'always' });
const NF1 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const num2 = (n) => NF2.format(Number(n) || 0);
const num0 = (n) => NF0.format(Number(n) || 0);
const pctStr = (fraction) => `${NF1.format((Number(fraction) || 0) * 100)}%`;

/** Tronca con ellissi; keepTail preserva la coda (utile sui path). */
function clip(s, max, keepTail = false) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  if (keepTail && max > 4) return `…${str.slice(-(max - 1))}`;
  return `${str.slice(0, max - 1)}…`;
}

/**
 * Tabella testuale a colonne fisse.
 * columns: [{ header, align: 'l'|'r', max?: number, keepTail?: boolean }]
 */
function renderTable(columns, rows) {
  const widths = columns.map((c, i) => {
    const cells = rows.map((r) => String(r[i] ?? ''));
    const w = Math.max(c.header.length, ...cells.map((v) => v.length), 1);
    return c.max ? Math.min(w, c.max) : w;
  });

  const line = (cells) =>
    cells
      .map((cell, i) => {
        const v = clip(cell ?? '', widths[i], columns[i].keepTail);
        return columns[i].align === 'r' ? v.padStart(widths[i]) : v.padEnd(widths[i]);
      })
      .join('  ')
      .replace(/\s+$/, '');

  const out = [];
  out.push(line(columns.map((c) => c.header)));
  out.push(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) out.push(line(r.map((v) => String(v ?? ''))));
  return out.join('\n');
}

/** '2026-07-31T12:33:47.350Z' | '2026-07-31 12:33:47' -> Date (o null). */
function parseTs(value) {
  if (!value) return null;
  const s = String(value);
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  const min = Math.round(ms / 60000);
  if (min < 1) return '<1m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** claude-opus-5 -> opus-5 ; gpt-5.6-sol -> gpt-5.6-sol */
const shortModel = (m) => String(m ?? '?').replace(/^claude-/, '');

/** toolu_019NkXLPd3VKF712ptntXw5c -> 019NkX */
const shortAgent = (id) => String(id ?? '').replace(/^toolu_/, '').slice(0, 6);

// ---------------------------------------------------------------------------
// Path / filtri
// ---------------------------------------------------------------------------

/** Normalizza un path per il confronto con sessions.cwd (case-insensitive, separatori uniformi). */
function normPath(p) {
  return path
    .resolve(String(p))
    .replace(/[/\\]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

/** Escape dei metacaratteri LIKE. ESCAPE '!' perché '\' è il separatore di path su Windows. */
function likeEscape(s) {
  return String(s).replace(/[!%_]/g, (c) => `!${c}`);
}

/**
 * I "giorni" sono sempre quelli UTC, coerenti con `created_at` così come lo
 * scrive la CLI e con i bucket di `--group-by day`. L'aritmetica va fatta in UTC
 * end-to-end: mescolare getter locali e `toISOString()` produce un off-by-one
 * sulle macchine a fuso positivo nelle prime ore del mattino.
 */
const isoDay = (date) => date.toISOString().slice(0, 10);

/** --days n -> data di inizio (oggi incluso: --days 1 = solo oggi). */
function sinceFromDays(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (n - 1));
  return isoDay(d);
}

// ---------------------------------------------------------------------------
// Apertura del DB (sola lettura, con fallback su copia temporanea)
// ---------------------------------------------------------------------------

const tempArtifacts = [];

function openDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) {
    fail(
      `DB della Copilot CLI non trovato: ${dbPath}`,
      'Indica il path corretto con --db, oppure verifica che la Copilot CLI sia stata usata almeno una volta su questa macchina.',
    );
  }

  const openRO = (p) => {
    const db = new DatabaseSync(p, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 3000');
    } catch {
      /* pragma non critico */
    }
    return db;
  };

  try {
    return openRO(dbPath);
  } catch (err) {
    const msg = String(err && err.message);
    const recoverable = /busy|locked|readonly|unable to open|CANTOPEN|SQLITE_IOERR/i.test(msg);
    if (!recoverable) {
      fail(`Impossibile aprire il DB: ${dbPath}`, `SQLite ha risposto: ${msg}`);
    }
    // Fallback: DB in WAL e in uso dalla CLI. Si lavora su una COPIA temporanea
    // (main + -wal + -shm): il DB reale non viene mai toccato.
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agic-credits-'));
      tempArtifacts.push(tmpDir);
      const copy = path.join(tmpDir, 'session-store.db');
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, copy + suffix);
      }
      // La copia è usa-e-getta: si apre in scrittura per far recuperare il WAL a
      // SQLite, ma la si marca query_only per non modificarla per sbaglio.
      const db = new DatabaseSync(copy);
      db.exec('PRAGMA query_only = 1');
      return db;
    } catch (err2) {
      fail(
        'Il DB della Copilot CLI è occupato e non è stato possibile leggerne una copia.',
        `Chiudi le sessioni Copilot CLI in corso e riprova. Dettaglio: ${String(err2 && err2.message)}`,
      );
    }
  }
}

function cleanupTemp() {
  for (const dir of tempArtifacts) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  tempArtifacts.length = 0;
}

function assertSchema(db) {
  const found = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('assistant_usage_events','sessions')")
    .all()
    .map((r) => r.name);
  const missing = ['assistant_usage_events', 'sessions'].filter((t) => !found.includes(t));
  if (missing.length) {
    fail(
      `Nel DB mancano le tabelle: ${missing.join(', ')}`,
      'La versione della Copilot CLI installata non registra (ancora) il consumo in questo formato. Aggiorna la CLI e riprova.',
    );
  }
}

function query(db, sql, params) {
  try {
    return db.prepare(sql).all(params ?? {});
  } catch (err) {
    const msg = String(err && err.message);
    if (/database is locked|busy/i.test(msg)) {
      fail(
        'Il DB della Copilot CLI è momentaneamente bloccato da un altro processo.',
        'Riprova fra qualche secondo: la CLI lo tiene aperto mentre scrive gli eventi della sessione.',
      );
    }
    if (/no such column|no such table/i.test(msg)) {
      fail(`Lo schema del DB non corrisponde a quello atteso: ${msg}`, 'Probabile cambio di schema in una nuova versione della Copilot CLI.');
    }
    fail(`Errore nell'interrogazione del DB: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Costruzione del filtro WHERE
// ---------------------------------------------------------------------------

function buildFilter(opts) {
  const where = [];
  const params = {};

  if (!opts.allProjects && opts.projectPath) {
    const p = normPath(opts.projectPath);
    params.proj = p;
    params.projLike = `${likeEscape(p)}\\%`;
    where.push(
      "(REPLACE(LOWER(COALESCE(s.cwd,'')), '/', '\\') = $proj OR " +
        "REPLACE(LOWER(COALESCE(s.cwd,'')), '/', '\\') LIKE $projLike ESCAPE '!')",
    );
  }

  if (opts.session) {
    params.sid = opts.session;
    params.sidLike = `${likeEscape(opts.session)}%`;
    where.push("(u.session_id = $sid OR u.session_id LIKE $sidLike ESCAPE '!')");
  }

  if (opts.since) {
    params.since = opts.since;
    // created_at è TEXT e mescola 'YYYY-MM-DD HH:MM:SS' e ISO 'YYYY-MM-DDTHH:MM:SS.sssZ':
    // si confronta SEMPRE sul prefisso di 10 caratteri, mai con datetime().
    where.push('substr(u.created_at, 1, 10) >= $since');
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const AGG = `
  SUM(COALESCE(u.request_multiplier, 0))                        AS credits,
  SUM(CASE WHEN u.request_multiplier IS NULL THEN 1 ELSE 0 END) AS credits_unknown,
  SUM(COALESCE(u.total_nano_aiu, 0)) / 1e9                      AS aiu,
  COUNT(*)                                                      AS requests,
  COUNT(DISTINCT u.session_id)                                  AS sessions,
  MIN(substr(u.created_at, 1, 10))                              AS first_day,
  MAX(substr(u.created_at, 1, 10))                              AS last_day
`;

const GROUP_EXPR = {
  project: `COALESCE(NULLIF(s.cwd, ''), '${UNKNOWN_PROJECT_LABEL}')`,
  session: 'u.session_id',
  model: "COALESCE(u.model, '(?)')",
  agent: `COALESCE(u.agent_id, '${NULL_AGENT_LABEL}')`,
  day: 'substr(u.created_at, 1, 10)',
};

function normalizeAgg(r) {
  return {
    credits: Number(r.credits || 0),
    credits_unknown: Number(r.credits_unknown || 0),
    aiu: Number(r.aiu || 0),
    requests: Number(r.requests || 0),
    sessions: Number(r.sessions || 0),
    first_day: r.first_day || null,
    last_day: r.last_day || null,
  };
}

function fetchTotals(db, filter) {
  const rows = query(
    db,
    `SELECT ${AGG} FROM assistant_usage_events u LEFT JOIN sessions s ON s.id = u.session_id ${filter.sql}`,
    filter.params,
  );
  return normalizeAgg(rows[0] || {});
}

function fetchGrouped(db, filter, dim) {
  const extra = dim === 'session' ? ', MAX(s.summary) AS summary' : '';
  const sql = `
    SELECT ${GROUP_EXPR[dim]} AS k, ${AGG} ${extra}
    FROM assistant_usage_events u
    LEFT JOIN sessions s ON s.id = u.session_id
    ${filter.sql}
    GROUP BY k
    ORDER BY credits DESC, aiu DESC
  `;
  return query(db, sql, filter.params).map((r) => ({
    key: r.k,
    ...normalizeAgg(r),
    summary: r.summary ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Mappa agent_id -> nome del membro del team (opzionale)
// ---------------------------------------------------------------------------

/**
 * Legge e fa il parse di un JSON tollerando il BOM UTF-8: su Windows è la norma
 * (PowerShell `Set-Content -Encoding UTF8`, Blocco note, VS Code con BOM) e
 * `JSON.parse` fallirebbe su `\uFEFF` iniziale.
 */
function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function loadAgentMap(file) {
  if (!file) return {};
  if (!fs.existsSync(file)) fail(`File --agent-map non trovato: ${file}`);
  try {
    const raw = readJsonFile(file);
    const map = {};
    for (const [k, v] of Object.entries(raw)) map[k] = String(v).replace(/^agic-ai-team:/, '');
    return map;
  } catch (err) {
    fail(`Il file --agent-map non è un JSON valido: ${file}`, String(err && err.message));
  }
}

/**
 * Il nome del membro del team (Sol/Flo/Gio/...) NON è nel DB locale: la mappa
 * agent_id -> `agic-ai-team:<nome>` vive solo nel cloud session store (tabella
 * `tool_requests`, campo `arguments_json`). Qui si mostra `(main)` per l'agente
 * principale e l'id troncato per i sub-agent, salvo --agent-map.
 */
function agentLabel(key, agentMap) {
  if (key === NULL_AGENT_LABEL) return NULL_AGENT_LABEL;
  const mapped = agentMap[key];
  return mapped ? `${mapped} (${shortAgent(key)})` : shortAgent(key);
}

function labelFor(dim, row, agentMap) {
  switch (dim) {
    case 'agent':
      return agentLabel(row.key, agentMap);
    case 'session':
      return String(row.key ?? '').slice(0, 8);
    default:
      return String(row.key ?? '');
  }
}

// ---------------------------------------------------------------------------
// Config budget
// ---------------------------------------------------------------------------

function loadBudgetConfig(projectRoot) {
  const file = path.join(projectRoot, BUDGET_FILE);
  if (!fs.existsSync(file)) return { file, exists: false, config: { ...DEFAULT_BUDGET_CONFIG } };
  try {
    const config = { ...DEFAULT_BUDGET_CONFIG, ...readJsonFile(file) };
    return { file, exists: true, config };
  } catch (err) {
    fail(`${BUDGET_FILE} non è un JSON valido: ${file}`, String(err && err.message));
  }
}

/**
 * Semantica del budget — le 4 regole non negoziabili:
 *  1. budget_credits: 0 (default) = ILLIMITATO -> silenzio totale.
 *  2. budget > 0 e sotto warn_threshold -> nessun messaggio.
 *  3. Oltre budget -> MAI bloccante: al più una richiesta di conferma.
 *  4. L'utente può sempre forzare un modello costoso.
 * Lo script non blocca nulla: espone stato + `should_notify` e decide Olly.
 */
function evaluateBudget(consumed, config) {
  const budget = Number(config.budget_credits) || 0;
  const warnAt = Number.isFinite(Number(config.warn_threshold)) ? Number(config.warn_threshold) : 0.8;
  const common = {
    warn_threshold: warnAt,
    require_confirmation_over_budget: Boolean(config.require_confirmation_over_budget),
    expensive_models: config.expensive_models || [],
    consumed,
  };

  if (budget <= 0) {
    return { status: 'ok', unlimited: true, should_notify: false, budget: 0, pct: null, ...common };
  }

  const pct = consumed / budget;
  const status = pct >= 1 ? 'over' : pct >= warnAt ? 'warn' : 'ok';
  return { status, unlimited: false, should_notify: status !== 'ok', budget, pct, ...common };
}

// ---------------------------------------------------------------------------
// Modalità: report
// ---------------------------------------------------------------------------

function runReport(db, opts) {
  const filter = buildFilter(opts);
  const totals = fetchTotals(db, filter);
  const all = fetchGrouped(db, filter, opts.groupBy);
  const agentMap = opts.agentMap;

  const limit = opts.top > 0 ? opts.top : all.length;
  const shown = all.slice(0, limit);
  const rest = all.slice(limit);

  if (opts.json) {
    print(
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          db: opts.dbPath,
          scope: {
            project: opts.allProjects ? null : opts.projectPath,
            all_projects: opts.allProjects,
            session: opts.session || null,
            since: opts.since || null,
            days: opts.days || null,
          },
          group_by: opts.groupBy,
          totals,
          row_count: all.length,
          truncated: rest.length > 0,
          rows: shown.map((r) => ({
            key: r.key,
            label: labelFor(opts.groupBy, r, agentMap),
            credits: r.credits,
            credits_unknown: r.credits_unknown,
            aiu: r.aiu,
            requests: r.requests,
            sessions: r.sessions,
            first_day: r.first_day,
            last_day: r.last_day,
            share: totals.credits > 0 ? r.credits / totals.credits : 0,
            ...(opts.groupBy === 'session' ? { summary: r.summary } : {}),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  // ---- intestazione di riepilogo -----------------------------------------
  const title = ' AGIC AI Team — Crediti (premium requests) consumati';
  const bar = '═'.repeat(Math.max(title.length + 1, 66));
  const meta = [
    ['Progetto', opts.allProjects ? 'TUTTI i progetti' : opts.projectPath],
    opts.session ? ['Sessione', opts.session] : null,
    [
      'Periodo',
      totals.requests === 0
        ? '-'
        : `${totals.first_day} → ${totals.last_day}${opts.since ? ` (filtro: da ${opts.since})` : ''}`,
    ],
    ['Sessioni', num0(totals.sessions)],
    ['Richieste', num0(totals.requests)],
    ['Crediti', num2(totals.credits)],
    ['AIU', num2(totals.aiu)],
    ['DB', opts.dbPath],
  ].filter(Boolean);
  const w = Math.max(...meta.map(([k]) => k.length));
  print([bar, title, bar, ...meta.map(([k, v]) => ` ${k.padEnd(w)} : ${v}`)].join('\n'));

  if (totals.requests === 0) {
    print('\nNessun evento di utilizzo trovato con i filtri indicati.');
    if (!opts.allProjects) {
      print('Suggerimento: prova --all-projects, il consumo potrebbe essere registrato sotto un altro cwd.');
    }
    return;
  }

  // ---- tabella di breakdown ----------------------------------------------
  const dimTitle = { project: 'PROGETTO', session: 'SESSIONE', model: 'MODELLO', agent: 'AGENTE', day: 'GIORNO' }[
    opts.groupBy
  ];

  print(
    `\nBreakdown per ${dimTitle} — ${all.length} rig${all.length === 1 ? 'a' : 'he'}` +
      `${rest.length ? `, mostrate le prime ${shown.length}` : ''} (ordine: crediti desc)\n`,
  );

  const columns = [
    { header: dimTitle, align: 'l', max: 46, keepTail: opts.groupBy === 'project' },
    { header: 'CREDITI', align: 'r' },
    { header: 'QUOTA', align: 'r' },
    { header: 'AIU', align: 'r' },
    { header: 'RICH.', align: 'r' },
    { header: 'SESS.', align: 'r' },
  ];
  if (opts.groupBy === 'session') columns.push({ header: 'ATTIVITÀ', align: 'l', max: 40 });
  if (opts.groupBy === 'agent') columns.push({ header: 'AGENT ID', align: 'l', max: 30 });

  const pad = (row) => {
    while (row.length < columns.length) row.push('');
    return row;
  };

  const body = shown.map((r) => {
    const row = [
      labelFor(opts.groupBy, r, agentMap),
      num2(r.credits),
      totals.credits > 0 ? pctStr(r.credits / totals.credits) : '-',
      num2(r.aiu),
      num0(r.requests),
      num0(r.sessions),
    ];
    if (opts.groupBy === 'session') row.push(r.summary ? String(r.summary).replace(/\s+/g, ' ') : '-');
    if (opts.groupBy === 'agent') row.push(r.key === NULL_AGENT_LABEL ? '—' : r.key);
    return row;
  });

  if (rest.length) {
    const agg = rest.reduce(
      (a, r) => ({ credits: a.credits + r.credits, aiu: a.aiu + r.aiu, requests: a.requests + r.requests }),
      { credits: 0, aiu: 0, requests: 0 },
    );
    body.push(
      pad([
        `… altre ${rest.length}`,
        num2(agg.credits),
        totals.credits > 0 ? pctStr(agg.credits / totals.credits) : '-',
        num2(agg.aiu),
        num0(agg.requests),
        '',
      ]),
    );
  }

  body.push(
    pad([
      'TOTALE',
      num2(totals.credits),
      totals.credits > 0 ? pctStr(1) : '-',
      num2(totals.aiu),
      num0(totals.requests),
      num0(totals.sessions),
    ]),
  );

  print(renderTable(columns, body));

  // ---- note ---------------------------------------------------------------
  const notes = [];
  if (totals.credits_unknown > 0) {
    notes.push(
      `${num0(totals.credits_unknown)} richieste hanno request_multiplier NULL e contano 0 crediti: il totale ` +
        'crediti è quindi una stima per difetto (eventi scritti da versioni della CLI che non popolavano il campo).',
    );
  }
  if (opts.groupBy === 'agent') {
    notes.push(
      `"${NULL_AGENT_LABEL}" = agente principale (Olly); le altre righe sono sub-agent, identificati dal tool_call_id. ` +
        'Il nome del membro del team non è nel DB locale: usa --agent-map, o fai risolvere i nomi a Olly via cloud session store.',
    );
  }
  if (notes.length) {
    print('');
    for (const n of notes) print(`ℹ️  ${n}`);
  }
}

// ---------------------------------------------------------------------------
// Modalità: budget-check  (exit code SEMPRE 0)
// ---------------------------------------------------------------------------

function runBudgetCheck(db, opts) {
  const { file, exists, config } = loadBudgetConfig(opts.projectRoot);
  const totals = fetchTotals(db, buildFilter(opts));
  const b = evaluateBudget(totals.credits, config);

  if (opts.json) {
    print(
      JSON.stringify(
        {
          status: b.status,
          unlimited: b.unlimited,
          should_notify: b.should_notify,
          consumed: b.consumed,
          budget: b.budget,
          pct: b.pct,
          warn_threshold: b.warn_threshold,
          require_confirmation_over_budget: b.require_confirmation_over_budget,
          expensive_models: b.expensive_models,
          config_file: file,
          config_exists: exists,
          project: opts.allProjects ? null : opts.projectPath,
          since: opts.since || null,
          aiu: totals.aiu,
          requests: totals.requests,
          sessions: totals.sessions,
        },
        null,
        2,
      ),
    );
    return;
  }

  // REGOLA 1 — budget assente o 0: illimitato, silenzio totale.
  if (b.unlimited) return;

  const line = `${num2(b.consumed)} / ${num2(b.budget)} crediti (${pctStr(b.pct)})`;
  if (b.status === 'over') {
    print(`🔴 Budget crediti superato: ${line}.`);
    print(
      '   Nessun blocco: il budget è informativo. ' +
        (b.require_confirmation_over_budget
          ? 'Per i modelli costosi chiedi conferma all\'owner e procedi se conferma.'
          : 'Nessuna conferma richiesta.'),
    );
  } else if (b.status === 'warn') {
    print(`⚠️  Budget crediti: ${line} — oltre la soglia di avviso (${pctStr(b.warn_threshold)}).`);
  } else {
    print(`✅ Budget crediti: ${line} — sotto la soglia di avviso (${pctStr(b.warn_threshold)}).`);
  }
}

// ---------------------------------------------------------------------------
// Modalità: ledger-row
// ---------------------------------------------------------------------------

function resolveSessionId(db, opts) {
  if (opts.session) {
    const rows = query(
      db,
      "SELECT DISTINCT u.session_id AS id FROM assistant_usage_events u " +
        "WHERE u.session_id = $sid OR u.session_id LIKE $sidLike ESCAPE '!' LIMIT 5",
      { sid: opts.session, sidLike: `${likeEscape(opts.session)}%` },
    );
    if (!rows.length) fail(`Nessuna sessione trovata con id (o prefisso) "${opts.session}".`);
    if (rows.length > 1) {
      fail(`Il prefisso "${opts.session}" corrisponde a più sessioni.`, `Candidate: ${rows.map((r) => r.id).join(', ')}`);
    }
    return rows[0].id;
  }

  const filter = buildFilter({ ...opts, session: null });
  const rows = query(
    db,
    `SELECT u.session_id AS id, MAX(u.created_at) AS last
     FROM assistant_usage_events u LEFT JOIN sessions s ON s.id = u.session_id
     ${filter.sql}
     GROUP BY u.session_id ORDER BY last DESC LIMIT 1`,
    filter.params,
  );
  if (!rows.length) {
    fail(
      opts.allProjects
        ? 'Nessuna sessione con consumo registrato nel DB.'
        : `Nessuna sessione con consumo registrato per il progetto ${opts.projectPath}.`,
      'Indicane una con --session <id>, oppure allarga lo scope con --all-projects.',
    );
  }
  return rows[0].id;
}

function buildLedgerRow(db, opts) {
  const sessionId = resolveSessionId(db, opts);
  const p = { sid: sessionId };

  const t = query(
    db,
    `SELECT ${AGG}, MIN(u.created_at) AS ts_min, MAX(u.created_at) AS ts_max
     FROM assistant_usage_events u LEFT JOIN sessions s ON s.id = u.session_id
     WHERE u.session_id = $sid`,
    p,
  )[0];

  const models = query(
    db,
    "SELECT COALESCE(model, '(?)') AS k, COUNT(*) AS n FROM assistant_usage_events WHERE session_id = $sid GROUP BY k ORDER BY n DESC",
    p,
  );

  const agents = query(
    db,
    `SELECT COALESCE(agent_id, '${NULL_AGENT_LABEL}') AS k, COUNT(*) AS n
     FROM assistant_usage_events WHERE session_id = $sid GROUP BY k ORDER BY n DESC`,
    p,
  );

  const meta = query(db, 'SELECT summary, cwd, created_at, updated_at FROM sessions WHERE id = $sid', p)[0] || {};

  // Durata: span reale degli eventi di utilizzo. `sessions.updated_at` NON è
  // affidabile — resta indietro rispetto all'attività effettiva della sessione.
  const start = parseTs(t.ts_min) || parseTs(meta.created_at);
  const end = parseTs(t.ts_max) || parseTs(meta.updated_at);
  const durationMs = start && end ? end.getTime() - start.getTime() : NaN;

  const modelsStr = models.map((m) => `${shortModel(m.k)} x${m.n}`).join(', ') || '-';

  const TOP_AGENTS = 4;
  const agentsStr =
    agents
      .slice(0, TOP_AGENTS)
      .map((a) => `${a.k === NULL_AGENT_LABEL ? 'main' : agentLabel(a.k, opts.agentMap)} x${a.n}`)
      .join(', ') + (agents.length > TOP_AGENTS ? `, +${agents.length - TOP_AGENTS}` : '');

  const summary = meta.summary
    ? clip(String(meta.summary).replace(/\s+/g, ' ').replace(/\|/g, '\\|'), 80)
    : '-';

  const agg = normalizeAgg(t);
  const data = {
    session_id: sessionId,
    date: String(t.ts_min || meta.created_at || '').slice(0, 10) || '-',
    duration_ms: Number.isFinite(durationMs) ? durationMs : null,
    duration: humanDuration(durationMs),
    credits: agg.credits,
    aiu: agg.aiu,
    requests: agg.requests,
    models: models.map((m) => ({ model: m.k, requests: m.n })),
    agents: agents.map((a) => ({ agent_id: a.k === NULL_AGENT_LABEL ? null : a.k, requests: a.n })),
    project: meta.cwd || null,
    summary: meta.summary || null,
  };

  const markdown =
    `| ${data.date} | ${sessionId.slice(0, 8)} | ${data.duration} | ${num2(data.credits)} | ` +
    `${num2(data.aiu)} | ${modelsStr} | ${agentsStr || '-'} | ${summary} |`;

  return { data, markdown };
}

function runLedgerRow(db, opts) {
  const { data, markdown } = buildLedgerRow(db, opts);
  print(opts.json ? JSON.stringify({ ...data, markdown }, null, 2) : markdown);
}

// ---------------------------------------------------------------------------
// Modalità: init-budget
// ---------------------------------------------------------------------------

function runInitBudget(opts) {
  const file = path.join(opts.projectRoot, BUDGET_FILE);
  if (fs.existsSync(file)) {
    print(`ℹ️  ${BUDGET_FILE} esiste già, non lo sovrascrivo: ${file}`);
    return;
  }
  fs.writeFileSync(file, `${JSON.stringify(DEFAULT_BUDGET_CONFIG, null, 2)}\n`, 'utf8');
  print(`✅ Creato ${file}`);
  print('   budget_credits: 0 = nessun limite (default). Impostalo > 0 solo se vuoi warning e conferme.');
}

// ---------------------------------------------------------------------------
// Modalità: init-ledger / append-ledger
// ---------------------------------------------------------------------------

/**
 * Path dello script **così come è stato realmente invocato**, relativo alla root del
 * progetto a cui appartiene il ledger. Serve perché il comando scritto nell'intestazione
 * sia per costruzione eseguibile in *quel* repo: nei repo cliente lo script vive in
 * `scripts/credits/`, ma in questo repo plugin sta in `scripts-template/credits/`, e una
 * stringa fissa sarebbe corretta solo in uno dei due casi.
 */
function invokedScriptPath(projectRoot) {
  try {
    if (!process.argv[1]) return 'scripts/credits/credits-report.mjs';
    const abs = path.resolve(process.argv[1]);
    const rel = path.relative(projectRoot, abs);
    // Script fuori dalla root del progetto: un path relativo sarebbe fragile, meglio assoluto.
    if (!rel || rel.startsWith('..')) return abs;
    return rel.replace(/\\/g, '/');
  } catch {
    return 'scripts/credits/credits-report.mjs';
  }
}

/** Intestazione del ledger: unica fonte, condivisa da --init-ledger e --append-ledger. */
function ledgerTemplate(projectRoot, eol = '\n') {
  return [
    `# Credits ledger — ${path.basename(projectRoot)}`,
    '',
    'Registro versionato dei crediti (premium requests) consumati dalle sessioni Copilot CLI',
    'su questo progetto. Una riga per sessione, aggiunta a fine sessione con:',
    '',
    '```powershell',
    `node ${invokedScriptPath(projectRoot)} --append-ledger`,
    '```',
    '',
    '**Crediti** = `SUM(request_multiplier)`, la metrica fatturata da GitHub (opus-5 = 15x, sonnet-5 = 1x).  ',
    '**AIU** = `SUM(total_nano_aiu)/1e9`, metrica secondaria di costo.',
    '',
    '> **Consuntivo per difetto.** Le righe di consumo vengono scritte a fine turno, quindi',
    "> l'ultimo turno di ogni sessione — quello che esegue il comando qui sopra — non è mai",
    '> incluso nella riga che sta scrivendo. Lo scarto è di un turno per sessione ed è',
    '> strutturale, non correggibile: questi totali sono un **minimo certo**, non un valore',
    '> esatto. Dichiaralo se usi queste cifre per una rendicontazione.',
    '',
    ...LEDGER_HEADER,
    '',
  ].join(eol);
}

/**
 * Spezza il testo in righe conservando **offset e terminatore di ognuna**.
 * Serve per poter riscrivere UNA sola riga lasciando tutto il resto del file
 * byte-identico: uno `split`/`join` normalizzerebbe i fine-riga misti.
 */
function scanLines(text) {
  const lines = [];
  let pos = 0;
  while (pos <= text.length) {
    const rel = text.slice(pos).search(/\r\n|\n|\r/);
    if (rel === -1) {
      if (pos < text.length) lines.push({ text: text.slice(pos), start: pos, end: text.length, eol: '' });
      break;
    }
    const at = pos + rel;
    const eol = text.startsWith('\r\n', at) ? '\r\n' : text[at];
    lines.push({ text: text.slice(pos, at), start: pos, end: at, eol });
    pos = at + eol.length;
  }
  return lines;
}

const isTableRow = (line) => /^\s*\|/.test(String(line).replace(/^\uFEFF/, ''));

/** Estrae la 2ª cella (id sessione troncato) da una riga di tabella markdown. */
function rowSessionId(line) {
  const clean = String(line).replace(/^\uFEFF/, '').trim();
  if (!clean.startsWith('|')) return null;
  const cells = clean.split('|');
  return cells.length >= 4 ? cells[2].trim() : null;
}

/** Fine-riga dominante del file: preserva lo stile esistente invece di imporne uno. */
function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function runInitLedger(opts) {
  const file = path.join(opts.projectRoot, LEDGER_FILE);
  if (fs.existsSync(file)) {
    print(`ℹ️  ${LEDGER_FILE.replace(/\\/g, '/')} esiste già, non lo sovrascrivo: ${file}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ledgerTemplate(opts.projectRoot), 'utf8');
  print(`✅ Creato ${file}`);
  print(`   Le righe si aggiungono da sole a fine sessione: node ${invokedScriptPath(opts.projectRoot)} --append-ledger`);
}

/**
 * Append **idempotente** della riga di sessione sul ledger. Tre strade possibili:
 *   - file assente        -> crea (stessa intestazione di --init-ledger) e appende
 *   - sessione non presente -> appende in fondo alla tabella
 *   - sessione già presente -> **upsert della SOLA riga di quella sessione**
 *
 * L'upsert non è una riscrittura della storia: è lo stesso fatto misurato meglio
 * (i totali crescono se la sessione è proseguita). Nessun'altra riga viene
 * toccata, riordinata o riformattata, e i byte adiacenti restano identici —
 * per questo la riscrittura avviene per offset e non con split/join.
 */
/**
 * Guard cross-progetto: **avvisa, non blocca**.
 *
 * `--project` decide *dove* si scrive il ledger, non *cosa* contiene la riga: i totali
 * sono sempre quelli dell'intera sessione. Una sessione ha un solo `cwd` nel DB, quindi
 * non si spezza mai fra due progetti — il rischio è il simmetrico, e più insidioso: la
 * stessa riga finita in due ledger diversi vale due volte in rendicontazione, ed è
 * plausibile abbastanza da non farsi notare.
 *
 * Il percorso di default è sicuro (senza `--session` la sessione è già filtrata per
 * progetto): serve un gesto deliberato per arrivarci. Per questo si avvisa e si scrive,
 * come per il budget guard — lo strumento riporta, chi legge decide.
 *
 * Ritorna `null` quando tutto combacia: nel caso normale il silenzio è parte del requisito.
 */
function crossProjectWarning(data, projectRoot, file) {
  if (!data.project) return null; // cwd assente nel DB: non possiamo affermare che sia estranea
  if (normPath(data.project) === normPath(projectRoot)) return null;
  return {
    session_id: data.session_id,
    session_cwd: data.project,
    ledger_project: path.resolve(projectRoot),
    ledger_file: file,
    message:
      `La sessione ${String(data.session_id).slice(0, 8)} è nata in ${data.project}, ` +
      `ma la sua riga sta nel ledger di ${path.resolve(projectRoot)}. ` +
      'I totali sono quelli dell\'intera sessione: se la stessa riga finisce anche nel ' +
      'ledger del progetto di origine, quei crediti risultano rendicontati due volte.',
  };
}

function runAppendLedger(db, opts) {
  const { data, markdown } = buildLedgerRow(db, opts);
  const file = path.join(opts.projectRoot, LEDGER_FILE);
  const shortId = String(data.session_id).slice(0, 8);
  const crossProject = crossProjectWarning(data, opts.projectRoot, file);
  let action;

  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${ledgerTemplate(opts.projectRoot)}${markdown}\n`, 'utf8');
    action = 'created';
  } else {
    const raw = fs.readFileSync(file, 'utf8');
    const eol = dominantEol(raw);
    const lines = scanLines(raw);

    const existing = lines.find((l) => rowSessionId(l.text) === shortId);

    if (existing) {
      if (existing.text === markdown) {
        action = 'unchanged'; // già identica: non si riscrive, niente diff spurio
      } else {
        // Sostituzione chirurgica: solo il contenuto della riga, terminatore incluso intatto.
        fs.writeFileSync(file, raw.slice(0, existing.start) + markdown + raw.slice(existing.end), 'utf8');
        action = 'updated';
      }
    } else {
      const lastRow = [...lines].reverse().find((l) => isTableRow(l.text));
      let at;
      let insert;
      if (lastRow) {
        if (lastRow.eol) {
          at = lastRow.end + lastRow.eol.length;
          insert = markdown + lastRow.eol;
        } else {
          // Il file non termina con un a capo: preservo anche questo.
          at = lastRow.end;
          insert = eol + markdown;
        }
      } else {
        // File esistente senza tabella: aggiungo header + riga in fondo.
        at = raw.length;
        const lead = raw.length === 0 || raw.endsWith(eol) ? '' : eol;
        insert = `${lead}${eol}${LEDGER_HEADER.join(eol)}${eol}${markdown}${eol}`;
      }
      fs.writeFileSync(file, raw.slice(0, at) + insert + raw.slice(at), 'utf8');
      action = 'appended';
    }
  }

  if (opts.json) {
    print(JSON.stringify({ action, file, cross_project_warning: crossProject, ...data, markdown }, null, 2));
    return;
  }

  const msg = {
    created: `✅ Creato ${file} e aggiunta la riga della sessione ${shortId}.`,
    appended: `✅ Riga della sessione ${shortId} aggiunta in fondo al ledger: ${file}`,
    updated: `♻️  Riga della sessione ${shortId} aggiornata in place nel ledger (i valori erano cambiati): ${file}`,
    unchanged: `ℹ️  Riga della sessione ${shortId} già presente e identica: nessuna modifica a ${file}`,
  }[action];
  print(msg);
  print(`   ${markdown}`);

  // Dopo l'esito, non prima: in un terminale l'ultima riga è quella che si legge davvero.
  if (crossProject) {
    print('');
    print(`⚠️  Sessione di un ALTRO progetto. Non ho bloccato nulla: verifica che sia voluto.`);
    print(`      sessione ${shortId} è nata in : ${crossProject.session_cwd}`);
    print(`      ledger che stai scrivendo  : ${crossProject.ledger_file}`);
    print(`   I totali della riga sono quelli dell'INTERA sessione, non la quota di questo`);
    print(`   progetto. Se la stessa sessione finisce anche nel ledger del progetto di`);
    print(`   origine, quei crediti risultano rendicontati due volte.`);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function print(s) {
  process.stdout.write(`${s}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        project: { type: 'string' },
        'all-projects': { type: 'boolean', default: false },
        session: { type: 'string' },
        since: { type: 'string' },
        days: { type: 'string' },
        'group-by': { type: 'string', default: 'model' },
        json: { type: 'boolean', default: false },
        db: { type: 'string' },
        top: { type: 'string', default: '20' },
        'agent-map': { type: 'string' },
        'init-budget': { type: 'boolean', default: false },
        'budget-check': { type: 'boolean', default: false },
        'ledger-row': { type: 'boolean', default: false },
        'append-ledger': { type: 'boolean', default: false },
        'init-ledger': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail(String(err && err.message), 'Sintassi completa: node credits-report.mjs --help');
  }

  const v = parsed.values;

  const groupBy = String(v['group-by']).toLowerCase();
  if (!GROUP_DIMS.includes(groupBy)) {
    fail(`--group-by "${v['group-by']}" non è valido.`, `Valori ammessi: ${GROUP_DIMS.join(', ')}`);
  }

  let since = v.since ? String(v.since).trim() : null;
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    fail(`--since "${since}" non è una data valida.`, 'Formato atteso: YYYY-MM-DD');
  }

  let days = null;
  if (v.days !== undefined) {
    days = Number(v.days);
    if (!Number.isInteger(days) || days < 1) fail(`--days "${v.days}" non è valido.`, 'Atteso un intero >= 1.');
    const fromDays = sinceFromDays(days);
    // Con entrambi i filtri presenti vince il più restrittivo.
    since = since && since > fromDays ? since : fromDays;
  }

  const top = Number(v.top);
  if (!Number.isInteger(top) || top < 0) {
    fail(`--top "${v.top}" non è valido.`, 'Atteso un intero >= 0 (0 = tutte le righe).');
  }

  const root = path.resolve(v.project ? String(v.project) : process.cwd());

  return {
    projectPath: v['all-projects'] ? null : root,
    projectRoot: root, // root per .ai-credits.json / doc/credits-ledger.md
    allProjects: Boolean(v['all-projects']),
    session: v.session ? String(v.session).trim() : null,
    since,
    days,
    groupBy,
    json: Boolean(v.json),
    dbPath: v.db ? path.resolve(String(v.db)) : DEFAULT_DB,
    top,
    agentMap: loadAgentMap(v['agent-map'] ? path.resolve(String(v['agent-map'])) : null),
    initBudget: Boolean(v['init-budget']),
    budgetCheck: Boolean(v['budget-check']),
    ledgerRow: Boolean(v['ledger-row']),
    appendLedger: Boolean(v['append-ledger']),
    initLedger: Boolean(v['init-ledger']),
    help: Boolean(v.help),
  };
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.help) {
    print(HELP.trim());
    return 0;
  }

  // Modalità che non richiedono il DB.
  if (opts.initBudget || opts.initLedger) {
    if (opts.initBudget) runInitBudget(opts);
    if (opts.initLedger) runInitLedger(opts);
    return 0;
  }

  let db;
  try {
    db = openDatabase(opts.dbPath);
    assertSchema(db);

    if (opts.budgetCheck) runBudgetCheck(db, opts);
    else if (opts.appendLedger) runAppendLedger(db, opts);
    else if (opts.ledgerRow) runLedgerRow(db, opts);
    else runReport(db, opts);
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
    cleanupTemp();
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  cleanupTemp();
  // --budget-check non deve MAI far fallire una build: resta informativo.
  const budgetMode = process.argv.includes('--budget-check');
  if (err instanceof UserError) {
    process.stderr.write(`❌ ${err.message}\n`);
  } else {
    process.stderr.write(`❌ Errore inatteso: ${err && err.message ? err.message : String(err)}\n`);
    if (process.env.AGIC_CREDITS_DEBUG) process.stderr.write(`${err && err.stack}\n`);
    else process.stderr.write('   (imposta AGIC_CREDITS_DEBUG=1 per lo stacktrace completo)\n');
  }
  process.exitCode = budgetMode ? 0 : 1;
}
