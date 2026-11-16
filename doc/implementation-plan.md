# Plan — Secret Santa Games

Source: `docs\Secret_Santa_Games_Functional_Requirements.md` (FR-001..047, TR-001..006, §17 phases, §18 AC1..14).

## Problem / approach
- Repo greenfield: only spec, no commits.
- Build public multi-tenant, mobile-first PWA: organizer console + participant app + public display. Realtime. Privacy by design (top-N only, hidden givers/votes enforced server-side, AC13).
- Plan covers all 3 spec phases: Phase 1 (MVP) detailed, Phases 2–3 outlined. No time estimates.

## Decisions (owner Q&A)
| Topic | Decision |
|---|---|
| Scope | All phases; MVP detailed |
| Audience | Public multi-tenant (anyone creates events) |
| Pairing | No in-app draw. Organizer uploads giver→recipient list (CSV/XLSX, name and/or email) from external draw app |
| Organizer plays | Yes. Secrets masked; explicit, logged, time-boxed "audit unmask" |
| Size | ≤100 participants/event (MVP hard cap) |
| Languages | EN + IT, i18n from day 1 |
| Stack | TS monorepo: React+Vite PWA / Node 24 Fastify+Socket.IO / PostgreSQL+Drizzle / shared zod contracts |
| Hosting | Azure, EU region |
| Organizer auth | Email magic link + Microsoft + Google |
| Participant identity | Guest per event (QR → claim roster name → device session); account linking in P3 |
| CI/CD | GitHub Actions + Bicep IaC |
| Staffing | Hire full-stack web/PWA specialist first (Luka → Laura) |

## Architecture
```
apps/web            React 19 + Vite + TS PWA: /o organizer, /e participant, /d display, /j join
apps/server         Node 24 + Fastify + Socket.IO: REST commands, realtime push, jobs; serves SPA (same origin)
packages/contracts  zod: REST DTOs, socket events, strict role output schemas
packages/domain     pure logic: phase machine, ranking + safeguards, XP, achievements, pairing validation
packages/db         Drizzle schema + migrations; PGlite for tests/local dev
infra/              Bicep (Azure)
e2e/                Playwright multi-device scenarios
.github/workflows/  CI, deploy
```
- Libs (confirm in ADR): Fastify (+cookie, helmet, rate-limit, multipart, static, zod type provider); Socket.IO 4; Drizzle + pg/PGlite; Better Auth (magic link, Microsoft, Google, Drizzle adapter); sharp (resize, EXIF strip); papaparse + read-excel-file (NOT npm `xlsx` 0.18.5 — known CVEs); TanStack Query, Zustand, React Router; Tailwind v4; i18next; motion, dotLottie, canvas-confetti, tsparticles-slim, howler; vite-plugin-pwa; Vitest, fast-check, Playwright, axe-core; pino + OpenTelemetry → App Insights.
- Azure: Container Apps (1 replica MVP) + ACR; PostgreSQL Flexible (Burstable); Storage Blob (private, short-lived SAS); Communication Services Email (magic links); Key Vault + managed identity; App Insights/Log Analytics; GitHub OIDC deploy. Scale-out later: Azure Web PubSub for Socket.IO or Redis adapter.
- Local dev, no Docker: PGlite (or winget Postgres), local-FS storage adapter (Azurite optional), console email transport.

### Core design rules
1. Server-authoritative. Mutations = REST w/ idempotency-key header. Socket.IO = server→client push + ephemeral reactions.
2. Privacy by projection: every payload built by role projector (participant / display / organizer-masked / organizer-unmasked), validated vs strict zod output schema before send (dev/test: throw; prod: strip + alert). Rooms `e:{id}:pub`, `e:{id}:org` (masked only), `e:{id}:p:{pid}`; unmasked data only on grant-scoped per-socket channel (rule 10).
3. Sync/recovery (TR-004): per-projection cursors (public stream, each private stream, each organizer stream) — no global event version (avoids false gaps + leaking private-activity cadence). Recovery: subscribe → snapshot w/ cursor → drop deltas ≤ cursor; gap → resnapshot. Board snapshots served only from `lastPublished` (reconnect can't bypass cadence). Deadlines = server timestamps + clock-offset estimate → synced countdowns.
4. Live board cadence: privacy eligibility separate from scheduling. Publish every T s (default 10) if projection changed AND `canPublish()` passes; vote edits count as changes; staleness ≤ T. "N voted" counter on same cadence. No vote totals by default (per-board toggle w/ warning, still under policy). No per-person "has voted". Manual publish + voting close use same guard. <10 voters → live board off by default (shown at close/ceremony), organizer may enable. ADR documents residual timing-correlation risk.
5. One publication policy `canPublish()` for ALL vote-derived output: live boards, ceremony nominees/winners, winner achievements/badges, certificates, history. Non-overridable floors: ≥5 distinct voters per category; shown = max(0, min(configN, eligible − hiddenMin)), hiddenMin 2; only entries w/ ≥1 vote; tie straddling cutoff → cut above tie group if it breaks hiddenMin; min total-votes threshold. Fail → neutral fallback (category skipped, "Christmas magic" message; no promise of later reveal). Participation recognition unaffected. Brute-force tests: "own vote + published projection ⇒ another ballot uniquely deducible?" must be false for small cohorts; calibrate floors from results.
6. Giver anonymity: random aliases (not registration order); no createdAt/order in gift DTOs; gift gallery hidden until opening (registration phase = counts only); random opening order default; EXIF strip + renamed blobs; logs redact votes, pairings, missions.
7. Profiles: others see name, avatar, achievements only. XP/level visible to self only; masked organizers = participant parity; others' XP only via unmask grant → no full-ranking reconstruction (FR-016, FR-046.8).
8. Reactions ephemeral; no per-gift reaction counts (popularity proxy).
9. Surprise: category winners locked at voting close; achievements unlocked/announced only at ceremony step.
10. Masked organizer: pairing list, givers, full rankings, vote details, others' XP hidden. "Audit unmask" = confirm + reason + 10-min grant + banner + audit log. Unmasked data only on grant-scoped channel; authz re-checked before every send; grant expiry/revocation, membership removal, session replacement → forced room leave/disconnect. Required for assignment corrections + integrity details. Non-playing co-organizer can own these tasks.
11. Animations never block input: overlay portal, pointer-events none; intensity off/low/normal/high; prefers-reduced-motion respected; every FX cue has text/ARIA-live equivalent; sound opt-in (autoplay unlock).
12. `Cache-Control: no-store` on event/state APIs; service worker caches static assets only.
13. Durable scheduling: `scheduled_jobs` table + poller (advisory lock) + startup recovery for voting auto-close, board cadence, ceremony timers. No timer lives only in memory. Crash tests around commit/delivery.
14. XP rewards keyed server-side: unique(eventId, participantId, rewardKey); rewardKey = activity + source occurrence (`joined`, `gift_registered`, `voted` — once per event); written in same tx as qualifying action; independent of request idempotency keys.
15. Christmas Champion uses qualifying XP = participation activities only (excludes achievement-unlock XP → no vote-result leak via XP). XP board (FR-019) supported w/ participant-metric eligibility + same policy; default off in MVP events (low signal until P2 games/missions).
16. Claims gate secrets: own recipient (later missions) released only after verified claim (personal credential or organizer in-person approval) — see Join & identity.

### FR-046 enforcement map
| Rule | Mechanism | Test |
|---|---|---|
| 1–3 no last place / negative / low scorers | ranking engine returns top-N only; no projection for others; no totals | domain property tests + contract scan |
| 4 no failure animations | FX catalog has no negative cues; neutral exit anim | UI review + e2e |
| 5 no individual voting history | votes only in organizer-unmasked projection; participant sees own selections | contract tests |
| 6 no giver disclosure pre-reveal | projector drops giverId until gift revealed; value scan for giver IDs | contract tests |
| 7 no negative reactions | fixed positive enum server-side | API test |
| 8 no percentile/hidden position | no rank for non-top; XP self-only (masked-organizer parity) | contract tests |
| 9 no unpublished rankings via API | full-ranking endpoint + socket channel need active unmask grant; participants 403 | API negative + grant-expiry tests |
| 10 recognition independent of votes | Christmas Spirit for participation + participation achievements | domain test |
| FR-013 anonymous ballots | ≥5-voter floor, cadence publish, per-projection cursors, unified `canPublish()` | brute-force deduction tests |

## Data model (MVP, Drizzle/Postgres)
- Better Auth tables (user, session, account, verification); `user.isPlatformAdmin`.
- `events`: owner, name, startsAt + tz, description, theme, budgetText, maxParticipants ≤100, phase, paused, milestones (giftOpeningStartedAt, votingClosedAt, revealStartedAt, ceremonyStartedAt), votingRound, settings jsonb (zod: categories, boards, topN, hiddenMin, minVotes, cadence, tieBreak, xpValues, features, retention), defaultLocale.
- `event_organizers`: eventId, userId, role owner|co, participantId?.
- `event_access`: kind join|display, tokenHash, shortCode, expiresAt, revokedAt.
- `participants`: eventId, displayName, avatar, email?, status unclaimed|pending|active|removed, source import|join, claimMethod email_link|personal_code|organizer_approved, claimVerifiedAt, claimCodeHash?, sessionTokenHash, locale, prefs, userId?; claim atomic (one active session per entry).
- `pairing_imports`: file meta, column mapping, issue summary, status draft|ready (raw file not stored).
- `pairings`: eventId, giverId, recipientId, source import|manual, importId; unique(eventId, giverId).
- `gifts`: eventId, giverId, aliasNo, name, description, photoKey, status, openingOrder, openedAt, giverRevealedAt (recipient derived from `pairings`, never copied).
- `voting_categories`: key, name/desc i18n jsonb, enabled, sort, boardEnabled.
- `votes`: PK(categoryId, voterId), giftId, timestamps (upsert = one active selection).
- `board_publications`: boardKey, state hidden|live|paused, lastPublished jsonb, lastPublishedAt, cursor.
- `xp_ledger`: participantId, activity, amount, rewardKey, qualifying; unique(eventId, participantId, rewardKey).
- `participant_achievements`: key, unlockedAt, announcedAt, source; unique(participantId, key).
- `awards`: boardKey, votingRound, winners, tieInfo, publishable, lockedAt, invalidatedAt, confirmedBy, revealedAt.
- `scheduled_jobs`: eventId, kind, runAt, payload, status, lockedBy, attempts.
- `ceremony_state`: script, stepIndex.
- `audit_log`: actor, action, target, reason, data, at.
- `media`: key, owner, kind, mime, size, deletedAt.
- Later: clues, guesses, mission_catalog, mission_assignments, games, game_rounds, game_answers, certificates, coin_ledger, auction_items, bids, player_profiles.

## Phase machine (FR-007)
- preparation → registration → gift_registration → gift_opening → voting → games (skippable; empty in MVP) → reveal → awards → completed.
- Organizer-driven. Optional auto: voting close timer; opening → voting when all opened.
- Back-steps allowed before reveal (audited). Irreversibility enforced by milestones, not current phase: giftOpeningStartedAt → pairing re-import disabled forever; revealStartedAt → no back-steps.
- Reopen voting = explicit tx: invalidate locked awards, bump votingRound, cancel pending jobs, audit.
- Activity matrix per phase (join, gift edit, vote, reactions…). Pause/resume flag over any phase.

## Pairing import (owner-supplied list)
- CSV/XLSX upload. Sniff delimiter (`,`/`;` — IT Excel uses `;`) + encoding (UTF-8/BOM, UTF-16, CP1252). XLSX: sheet pick.
- Header auto-map w/ EN/IT synonyms (giver/santa/from/donatore…, recipient/to/destinatario…); manual mapping UI.
- Match rows → roster: email (case-insens.) else normalized name (NFKD, no diacritics, case, spaces). Unmatched → new unclaimed roster entries.
- Validate: self-pair (error), duplicate rows (error), ambiguous name (error until resolved), giver w/ >1 recipient (error — one gift per giver), recipient receiving 0 or >1 (warning, acceptable), roster entry w/o pairing (warning).
- Import status draft (issues open) | ready (consistent). Ready required before gift_registration.
- Masked result: counts + row-numbered issues; pairs never re-rendered unless unmasked. Raw file discarded after parse.
- Re-import (replace) until giftOpeningStartedAt; later corrections only via unmask, audited, until voting closes (FR-045). Correction tx updates pairing + invalidates votes made invalid (voter now giver of that gift).

## Join & identity
- Event QR/link (128-bit token) + short code (6–8 chars, rate-limited, expiring) → join page (EN/IT auto-detect).
- Verified claim paths: (a) personal email claim link when roster has email; (b) per-person claim code (organizer exports name+code list, no pairings); (c) pick roster name → pending → organizer in-person approval. Auto-approve toggle grants base access only, never secrets.
- Claims atomic (one active claim per roster entry). New-device re-claim / recovery → verified path again, old session revoked, audited.
- Organizer-player binds own roster entry once (audited); rebinding / privileged identity reassignment needs unmask + audit.
- Guest session: httpOnly + Secure + SameSite=Lax cookie, opaque token (hashed in DB), per event. Display: separate revocable token.

## Phase 1 — MVP workstreams (todo ids)
- **M0 Team & foundations**: `hire-fullstack-specialist`, `doc-conventions`, `adr-architecture`, `scaffold-monorepo`, `ci-pipeline`, `infra-azure`.
- **M1 Platform core**: `db-schema-mvp`, `contracts-projections`, `auth-organizer`, `xp-ledger`, `durable-jobs`, `realtime-core`, `web-shell`, `fx-engine`.
- **M2 Events, roster, join**: `event-setup`, `pairing-import`, `invites-join`, `organizer-masking-audit`.
- **M3 Gifts**: `gift-registration`, `gift-opening`, `giver-reveal`.
- **M4 Voting & leaderboards**: `ranking-engine`, `voting`, `leaderboards-live`.
- **M5 Achievements**: `achievements`.
- **M6 Display, reactions, ceremony**: `public-display`, `reactions`, `award-ceremony`.
- **M7 Admin, privacy, quality, launch**: `admin-moderation`, `privacy-data-controls`, `privacy-contract-tests`, `e2e-mvp`, `perf-load`, `security-review-mvp`, `deploy-mvp`, `docs-mvp`.
- Details per todo in SQL `todos` table.

## Phase 2 — outline
- `p2-guess-santa` FR-025..027: suspects = all active participants except self, alphabetical; one editable guess until reveal; clues → moderated queue (+ EN/IT keyword filter); per-gift reveal, playful wrong-guess FX, no penalty; Santa Detective board (top-N rules); Invisible Santa.
- `p2-missions` FR-028..030: EN/IT safe catalog, opt-out, random assign, private, submit → optional organizer verify, reassign, XP, Mission Master; display shows only "secret mission completed!".
- `p2-mini-games` FR-031/032: game framework (intro → rounds → submission counter → scoring → top-N winners); Trivia (EN/IT bank + custom), Guess the Gift, Bingo (generated cards, organizer-confirmed marks), Speed Challenge, Mystery Santa Predictions (feeds Invisible Santa).
- `p2-achievements-presentations`: expanded achievements + advanced animated presentations.
- `p2-certificates` FR-041: PNG award cards (satori + resvg, EN/IT), Web Share API / download.

## Phase 3 — outline
- `p3-santa-coins` FR-033: idempotent coin ledger; never purchasable/convertible.
- `p3-auction` FR-034: mystery prizes, coin holds, countdown (+ anti-snipe extension), winner + box-reveal FX, organizer toggle.
- `p3-history-hof` FR-042..044: archive (public results only), guest → account claim (magic link) for lifetime titles/badges, Hall of Fame, seasonal top-N.
- `p3-customization-scale`: custom themes/categories/achievements editor, scale-out (Web PubSub for Socket.IO / Redis, outbox, multi-instance timers). In-app draw only if owner asks later (external list import stays default).

## Testing & acceptance (spec §18)
- domain: Vitest + fast-check — ranking invariants, safe-N, ties, phase transitions, XP idempotency, pairing validation, recognition guarantee.
- server: integration (PGlite local / Postgres service in CI) via Fastify inject + socket.io-client. Privacy contract suite = key allowlist + forbidden-value scan per role × phase; ballot-deduction brute force; unmask grant isolation/expiry; reconnect can't bypass cadence; scheduled-job crash/restart recovery; claim-hijack attempts.
- web: component tests — vote, leaderboard, join, prefs.
- e2e: Playwright multi-context — organizer desktop + 6 mobile participants + 1080p display; axe; reducedMotion=reduce; EN/IT; reconnect.
- AC map: AC1 invites; AC2 mobile join; AC3 giver anonymity; AC4/5 voting rules; AC6 live top-N; AC7/13 privacy contract + API negatives; AC8 FX cues; AC9 display sync; AC10 achievements; AC11 phase control; AC12 ceremony; AC14 reduced motion/sound off.
- load: k6/Artillery socket scenario, 100 clients/event × several concurrent events.

## Delivery workflow / agents
- Build: new specialist (hired first). One repo writer at a time (Olly rule 5-bis).
- Per milestone: specialist → `code-review` agent → `security-review` (auth, join, uploads, privacy milestones) → Gio commit/push (+ PR) → Dora docs + SESSION_RESTART.md.
- Gio: GitHub Actions, Azure deploy; `az account show` + explicit owner confirmation before any Azure write.
- Session close: Dora ledger row (`doc/credits-ledger.md`).

## Assumptions / open items
- "Own gift" = gift participant registered (gave); voting for received gift allowed.
- Grand Champion = Best Overall winner (configurable); subject to `canPublish()` like any category.
- Privacy floor ≥5 voters/category, non-overridable (owner decision): tiny events get no vote-derived winners; organizer warned at setup.
- <10 voters → live board off by default, organizer may enable (owner decision).
- Extra default achievements for Biggest Surprise / Best Presentation (EN/IT names TBD).
- No billing; per-organizer caps (active events, storage).
- Animation/audio assets royalty-free or commissioned; license manifest required; art direction TBD by owner.
- Owner provides Azure subscription/tenant + GitHub OIDC app registration.
- Family events may include minors: guests w/ minimal data; ToS requires organizer 18+.
- Privacy policy / ToS texts need owner/legal review.
- Retention default proposal: photos deleted 90 d after completion unless history kept; anonymize on participant request.
- `docs/` → `doc/` rename (Dora + credits tooling expect `doc/`); owner may veto.
