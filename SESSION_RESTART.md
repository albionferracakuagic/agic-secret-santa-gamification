# SESSION_RESTART — Secret Santa Games

> Aggiornata al: 19/11/2026 — **v1.1.0**

## Sommario

Phase 1–3 costruite: 46 todo ✅ salvo `deploy-mvp` ⏳ (serve Azure + OIDC owner). Test: 799 unit, 33 e2e verdi. PR #6 (MVP) mergiata; `feat/phase2-backend` ha Phase 2+3 committate in locale, NON pushate. Dettaglio: `doc/progress.md`.

## Task completati ✅

- M0–M7 tranne `deploy-mvp`; Phase 2 (guess Santa, missioni, mini-giochi, presentazioni, certificati) e Phase 3 (coins, asta, storico/HoF + link account, editor custom, scale-out solo interfaccia).
- ADR 0001–0008, matrice test privacy, security surface, testi legali (bozza).
- Doc MVP: `doc/architecture.md`, `doc/organizer-guide.{en,it}.md`, `doc/progress.md`.

## Gotcha tecniche

- `git push` si blocca sul prompt credenziali nella sessione agente → Phase 2+3 solo locali.
- Env nuove: `SCALE_OUT`, `CERT_FONTS_DIR` (vedi `doc/architecture.md`).
- Prod: `EMAIL_TRANSPORT=acs` obbligatorio, altrimenti startup fallisce.
- Soglie privacy (≥5 votanti, `hiddenMin 2`) solo rialzabili; ogni cambio policy → rilanciare `packages/domain/src/deduction.test.ts`.
- Niente `xlsx` npm 0.18.5 (CVE): usare `read-excel-file`.
- Postgres reale testato solo in CI; locale = PGlite.
- Nessun deploy durante eventi.

## File modificati

- `doc/progress.md`, `doc/architecture.md`, `doc/organizer-guide.{en,it}.md`, `SESSION_RESTART.md`.

## Prossimi passi

1. Owner: `git push -u origin feat/phase2-backend`, poi PR: https://github.com/albionferracakuagic/agic-secret-santa-gamification/compare/main...feat/phase2-backend?expand=1 (body: `C:\Users\AlbionFerracaku\.copilot\session-state\5ff9e097-b339-4617-855d-8b23eea6eff2\files\pr-phase2.md`).
2. Owner: subscription/tenant Azure + OIDC → `deploy-mvp`.
3. Revisione testi legali `doc/legal/`.
4. Provare dal vivo ACS email, Google/Microsoft, immagine Docker, suite Postgres reale.
5. Gap: scale-out adapter (Redis/Web PubSub), form assegnazione manuale achievement custom, contatori rate-limit per processo, `serverNow` per countdown.

Consumi: vedi `doc/credits-ledger.md`.

## Stato implementazione corrente (modifiche non committate)

- Show Autopilot implementato localmente ma non ancora committato: console a tab `Live/Setup/People/Show/Admin`, preset `quick/standard/relaxed`, override tempi, `Start Show`, Hold, Stop, Skip, timeline e log organizer-only.
- Motore a job durevoli: stato per evento in `autopilot_state`, tick `autopilot.tick` con `seq` e claim; override manuale riallineato tramite `resync`; freeze evento distinto da Hold; parità auto-risolte come vittoria condivisa; cerimonia annullata resta in attesa senza auto-riavvio.
- Rivelazione lato server: drumroll durevole, unveil idempotente e anti-early-leak; `/d` scena drammatica, `/e` reveal personale del destinatario, `/e/recap` bloccato prima della fase premi.
- Documentazione aggiornata: guide EN/IT, ADR-0009 e indice ADR, matrice privacy reveal/autopilot. Le modifiche tecniche e i test correlati restano diff di lavoro e non sono stati eseguiti commit/push o deploy.
- Incoerenza tecnica da correggere/decidere: il readiness `display` di Start Show verifica solo che la proiezione pubblica realtime sia attiva dal client organizzatore, non la presenza di una schermata `/d` realmente connessa.
