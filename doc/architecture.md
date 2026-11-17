# Architettura — Secret Santa Games

> Aggiornata al: 17/11/2026 — **MVP (M0–M7, deploy escluso)**

Fonti: `doc/implementation-plan.md`, `doc/adr/`, `.env.example`, `package.json`, `e2e/package.json`.

## Layout

| Path | Contenuto |
|---|---|
| `apps/web` | PWA React 19 + Vite, Tailwind v4, i18next EN/IT. Rotte `/o` organizer, `/e` partecipante, `/d` display, `/j` join |
| `apps/server` | Fastify 5 + Socket.IO: REST, realtime, job durevoli; serve la SPA (`WEB_DIST`) same-origin |
| `packages/contracts` | zod: DTO REST, eventi socket, schemi output strict per ruolo |
| `packages/domain` | logica pura: phase machine, ranking, `canPublish()`, XP, achievements, validazione pairing |
| `packages/db` | schema/migrazioni Drizzle; PGlite per test/dev; `seed` |
| `e2e` | Playwright multi-device + harness load |
| `infra` | Bicep Azure (`main.bicep`, moduli containerapp/keyvault/communication) |
| `.github/workflows` | `ci.yml`, `codeql.yml`, `deploy.yml` |

## Data flow

1. Mutazioni = REST + header `Idempotency-Key`; server autoritativo (ADR-0002).
2. Socket.IO = solo push server→client + reazioni positive effimere.
3. Ogni payload (REST e socket) passa da un projector di ruolo (`participant`, `display`, `organizer-masked`, `organizer-unmasked`) e viene validato con schema zod `.strict()`. Dev/test: throw. Prod: strip + alert.
4. Mai serializzare righe DB direttamente. `Cache-Control: no-store` sulle API di stato; service worker cacha solo asset statici.
5. Scheduling durevole: tabella `scheduled_jobs` + poller (advisory lock) + recovery allo startup (chiusura voto, cadenza board, timer cerimonia).

## Realtime / projection model (ADR-0002)

- Room: `e:{id}:pub`, `e:{id}:org` (solo masked), `e:{id}:p:{pid}`; il server decide i join.
- Cursori per proiezione (pub, ogni privato, ogni organizer); nessuna versione globale.
- Recovery: subscribe → snapshot con cursore → scarta delta ≤ cursore; gap → nuovo snapshot.
- Snapshot board solo da `board_publications.lastPublished` (reconnect non aggira la cadenza).
- Canale unmask `grant:{grantId}` per-socket; authz ricontrollata prima di ogni invio; scadenza/revoca → leave + disconnect.
- Deadline = timestamp server + offset orologio stimato dal client.

## Privacy — sintesi

- **ADR-0003**: unica funzione `canPublish()` per ogni output derivato dai voti. Soglie non sovrascrivibili: ≥5 votanti distinti per categoria, `hiddenMin = 2`, solo voci con ≥1 voto, soglia minima voti totali. Fallimento → categoria saltata ("magia di Natale").
- Board live: cadenza T (default 10 s) solo se proiezione cambiata e `canPublish()` ok; **<10 votanti → board live off** (mostrata a chiusura/cerimonia; l'organizer può attivarla). Nessun totale, nessun "ha votato" per persona.
- Anonimato giver: alias casuali, galleria regali nascosta fino all'apertura, EXIF rimosso, log senza voti/pairing. Rivelazione giver irreversibile a livello DB.
- Organizer mascherato (parità col partecipante); "audit unmask" = conferma + motivo + grant 10 min + banner + audit log (ADR-0004).
- Matrice test: `doc/privacy-test-matrix.md`. Superficie sicurezza: `doc/security-surface.md`. Testi legali: `doc/legal/` (da revisione owner).
- ADR: [0001 stack](adr/0001-stack-and-libraries.md), [0002 realtime](adr/0002-realtime-projections-and-recovery.md), [0003 privacy](adr/0003-privacy-publication-policy.md), [0004 identity](adr/0004-identity-and-auth.md), [0005 Azure/CI/jobs](adr/0005-azure-hosting-cicd-jobs.md), [0006 performance](adr/0006-performance-targets.md).

## Variabili d'ambiente (`.env.example`)

| Variabile | Default | Note |
|---|---|---|
| `NODE_ENV` | `development` | |
| `PORT` | `3000` | |
| `DATABASE_URL` | vuoto | Vuoto = PGlite locale (`.data/`); es. `postgres://user:pass@localhost:5432/santa` |
| `BETTER_AUTH_URL` | `http://localhost:3000` | |
| `BETTER_AUTH_SECRET` | vuoto | ≥32 caratteri casuali |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | vuoto | Vuoto = provider disattivo |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | vuoto | Vuoto = provider disattivo |
| `MICROSOFT_TENANT_ID` | `common` | |
| `EMAIL_TRANSPORT` | `console` | In produzione `acs` obbligatorio (startup fallisce con `console`) |
| `ACS_ENDPOINT` | — | Solo con `acs`; auth via managed identity |
| `ACS_SENDER_ADDRESS` | — | Solo con `acs`; dominio verificato |
| `TRUST_PROXY_HOPS` | `1` | Numero esatto di proxy davanti (Container Apps = 1) |
| `WEB_DIST` | vuoto | Es. `apps/web/dist`; vuoto = solo API |
| `PLATFORM_ADMIN_EMAILS` | vuoto | Email verificate, separate da virgola |

In Azure i segreti arrivano da Key Vault via managed identity.

## Comandi (Node ≥ 24)

| Comando | Effetto |
|---|---|
| `npm install` | Dipendenze workspace |
| `npm run dev` | Server :3000 + web :5173 (proxy) |
| `npm test` | `tsc -b` + Vitest |
| `npm run build` | `tsc -b` + build web |
| `npm run typecheck` / `lint` / `format` | Controlli statici |
| `npm run test:e2e` | Playwright (prima volta: `npx playwright install chromium`) |
| `npm run load -w e2e` | Harness carico (5 eventi × 100 client, batch 25) |
| `npm run seed -w packages/db` | Dati di esempio |

## Deploy — panoramica (ADR-0005)

- Azure, regione Italy North. Container Apps (1 replica MVP) + ACR; PostgreSQL Flexible; Blob Storage privato (SAS brevi); ACS Email; Key Vault + managed identity; App Insights.
- IaC Bicep in `infra/`; deploy via GitHub Actions con OIDC (`deploy.yml`).
- Stato: **non eseguito** — richiede subscription/tenant Azure dell'owner e app registration OIDC. Immagine Docker non ancora buildata. Vedi `doc/progress.md`.
- Scale-out futuro: Azure Web PubSub o adapter Redis; cursori su DB/Redis.
