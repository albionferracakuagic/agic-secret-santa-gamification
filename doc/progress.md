# Avanzamento

> Aggiornata al: 17/11/2026 — **MVP**

Fonte: todo ids in `doc/implementation-plan.md`. Stato = dichiarato dall'owner/Olly a questa data, non ricalcolato da CI.

Legenda: ✅ done · 🔄 in corso · ⏳ pending

## Phase 1 — MVP

| Milestone | Todo | Stato |
|---|---|---|
| M0 Team & foundations | `hire-fullstack-specialist`, `doc-conventions`, `adr-architecture`, `scaffold-monorepo`, `ci-pipeline`, `infra-azure` | ✅ |
| M1 Platform core | `db-schema-mvp`, `contracts-projections`, `auth-organizer`, `xp-ledger`, `durable-jobs`, `realtime-core`, `web-shell`, `fx-engine` | ✅ |
| M2 Events, roster, join | `event-setup`, `pairing-import`, `invites-join`, `organizer-masking-audit` | ✅ |
| M3 Gifts | `gift-registration`, `gift-opening`, `giver-reveal` | ✅ |
| M4 Voting & leaderboards | `ranking-engine`, `voting`, `leaderboards-live` | ✅ |
| M5 Achievements | `achievements` | ✅ |
| M6 Display, reactions, ceremony | `public-display`, `reactions`, `award-ceremony` | ✅ |
| M7 Admin, privacy, quality, launch | `admin-moderation`, `privacy-data-controls`, `privacy-contract-tests`, `e2e-mvp`, `perf-load`, `security-review-mvp` | ✅ |
| M7 | `docs-mvp` | 🔄 |
| M7 | `deploy-mvp` | ⏳ serve subscription/tenant Azure owner + GitHub OIDC |
| Trasversale | `assets-licensing` | 🔄 |

## Phase 2 — tutto ⏳

`p2-guess-santa`, `p2-missions`, `p2-mini-games`, `p2-achievements-presentations`, `p2-certificates`.

## Phase 3 — tutto ⏳

`p3-santa-coins`, `p3-auction`, `p3-history-hof`, `p3-customization-scale`.

## Gap noti

- `git push` non autenticato: i commit sono solo locali.
- Suite con Postgres reale solo in CI (in locale PGlite).
- Immagine Docker non buildata.
- Email ACS mai provata dal vivo.
- Login Google/Microsoft non provati.
- Contatori rate-limit per processo (non condivisi; ok con 1 replica, da rivedere in scale-out).
- Testi legali (`doc/legal/`) da revisione owner.
- E2E su server reale: sessione organizer in parte simulata.
- Deduzione voti: regola `showTotals` e sequenze live non modellate (ADR-0003).
