# SESSION_RESTART — Secret Santa Games

> Aggiornata al: 17/11/2026 — **MVP**

## Sommario

MVP (M0–M7) implementato: PWA React + server Fastify/Socket.IO, privacy per proiezione (`canPublish()`), import pairing, voto, board, cerimonia, display, admin, e2e/load. Mancano `deploy-mvp` (bloccato: serve Azure + OIDC owner), `docs-mvp` (in corso) e `assets-licensing` (in corso). Phase 2/3 non iniziate. Dettaglio: `doc/progress.md`.

## Task completati ✅

- M0–M7 tranne `deploy-mvp`, `docs-mvp`.
- ADR 0001–0006, matrice test privacy, security surface, testi legali (bozza).
- Doc MVP: `doc/architecture.md`, `doc/organizer-guide.{en,it}.md`, `doc/progress.md`.

## Gotcha tecniche

- `git push` non autenticato → commit solo locali.
- Prod: `EMAIL_TRANSPORT=acs` obbligatorio, altrimenti startup fallisce.
- Soglie privacy (≥5 votanti, `hiddenMin 2`) solo rialzabili; ogni cambio policy → rilanciare `packages/domain/src/deduction.test.ts`.
- Niente `xlsx` npm 0.18.5 (CVE): usare `read-excel-file`.
- Postgres reale testato solo in CI; locale = PGlite.
- Nessun deploy durante eventi.

## File modificati

- `doc/architecture.md`, `doc/organizer-guide.en.md`, `doc/organizer-guide.it.md`, `doc/progress.md`, `SESSION_RESTART.md` (nuovi, non committati).

## Prossimi passi

1. Gio: commit dei doc.
2. Owner: fornire subscription/tenant Azure + app registration OIDC → `deploy-mvp`.
3. Buildare immagine Docker; provare ACS email e login Google/Microsoft.
4. Revisione owner testi legali; chiudere `assets-licensing`.
5. Poi Phase 2.

Consumi: vedi `doc/credits-ledger.md`.
