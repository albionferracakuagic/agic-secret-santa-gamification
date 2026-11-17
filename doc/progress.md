# Avanzamento

> Aggiornata al: 17/11/2026 — **Phase 1–3 (build completo, deploy escluso)**

Stato: 46 todo, tutti ✅ tranne `deploy-mvp` ⏳ (dichiarato owner/Olly, 17/11/2026). Test: 799 unit, 33 e2e verdi (17/11/2026).`n`nFonte: todo ids in `doc/implementation-plan.md`. Stato = dichiarato dall'owner/Olly a questa data, non ricalcolato da CI.

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
| M7 | `docs-mvp` | ✅ |
| M7 | `deploy-mvp` | ⏳ serve subscription/tenant Azure owner + GitHub OIDC |
| Trasversale | `assets-licensing` | ✅ |

## Phase 2 — tutto ✅

`p2-guess-santa`, `p2-missions`, `p2-mini-games`, `p2-achievements-presentations`, `p2-certificates`. ADR: `adr/0007-phase2-privacy-and-games.md`.

## Phase 3 — tutto ✅

`p3-santa-coins`, `p3-auction`, `p3-history-hof` (+ link account), `p3-customization-scale` (editor custom; scale-out = solo interfaccia). ADR: `adr/0008-phase3-coins-auction-history-scale.md`.

## Git / PR`n`n- PR #6 (MVP) mergiata.`n- Branch `feat/phase2-backend`: Phase 2+3 committate **in locale, NON pushate** (il push si blocca sul prompt credenziali nella sessione agente).`n- Owner: `git push -u origin feat/phase2-backend`, poi aprire la PR da https://github.com/albionferracakuagic/agic-secret-santa-gamification/compare/main...feat/phase2-backend?expand=1 con il body `C:\Users\AlbionFerracaku\.copilot\session-state\5ff9e097-b339-4617-855d-8b23eea6eff2\files\pr-phase2.md` (include Phase 3).`n`n## Gap noti

- `git push` non autenticato: Phase 2+3 solo locali su `feat/phase2-backend`.`n- `deploy-mvp`: serve subscription/tenant Azure owner + GitHub OIDC.`n- Scale-out: solo interfaccia + in-memory (nessun adapter Redis/Web PubSub; cursori per istanza).`n- Form di assegnazione manuale per achievement custom: non costruito.`n- Countdown Display/asta basato su offset orologio realtime (niente `serverNow`).
- Suite con Postgres reale solo in CI (in locale PGlite).
- Immagine Docker non buildata.
- Email ACS mai provata dal vivo (idem Docker image sopra).
- Login Google/Microsoft non provati.
- Contatori rate-limit per processo (non condivisi; ok con 1 replica, da rivedere in scale-out).
- Testi legali (`doc/legal/`) da revisione owner.
- E2E su server reale: sessione organizer in parte simulata.
- Deduzione voti: regola `showTotals` e sequenze live non modellate (ADR-0003).
