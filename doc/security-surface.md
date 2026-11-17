# Security surface (input for `security-review`)

Inventory of everything an attacker can reach or abuse. Each row names the control that exists **today** (with the test that proves it) and the review focus. Paths are relative to `apps/server/src` unless stated. Privacy-specific proofs are in `doc/privacy-test-matrix.md`; architecture in ADR-0002/0004/0005.

## 1. Trust boundaries and principals

| Principal | Credential | Issued by | Lifetime | Scope |
|---|---|---|---|---|
| Organizer | Better Auth session cookie (magic link, Google, Microsoft) | `auth/auth.ts`, `auth/routes.ts` | Better Auth session default | Events with a row in `event_organizers`; platform-admin flag (`user.is_platform_admin`) for takedown |
| Participant (guest) | `sg_p` cookie = 256-bit random token; only its SHA-256 is stored (`participants.session_token_hash`, unique) | `routes/join.ts` claim flow | 14 days; replaced by a newer claim | One roster entry in one event |
| Display | `sg_d` cookie = 256-bit random token; hash in `event_access` (kind `display`) | `POST /api/join/display` | until `expiresAt` / revoked | Public projection of one event |
| Unmask grant | `x-unmask-grant` header = grant UUID bound to (user, event) | `POST /api/events/:id/unmask` | 10 min, non-extendable, revocable | Secret projections, `/pairings`, `/integrity/details`, `/pairings/correct` |
| Anonymous | none | - | - | `/health`, `/api/time`, `/api/config`, `/api/join/*`, `/api/auth/*`, `/media/*` (signed URL) |

Principal resolution: `principal.ts` (`DbPrincipalStore`), `routes/guards.ts` (`makeGuards`, `makeParticipantGuard`). Suspended events (platform takedown) reject guest and display principals everywhere (`join.ts` db helpers + `principal.ts`).

## 2. Authentication and session surfaces

| Surface | Controls | Tests | Review focus |
|---|---|---|---|
| Magic link (Better Auth) | Token TTL 600 s, rate limit 5/min (`auth.ts`), `trustedOrigins`, secure cookies on https | `auth/auth.test.ts` | Better Auth pinned at 1.7.25 (magic-link/OAuth fix); replay and open redirect on the callback URL. Email: ACS transport (managed identity) is implemented; **startup fails in production unless `EMAIL_TRANSPORT=acs`** with endpoint and sender, the console transport cannot be constructed in production, and nothing logs message bodies/links/recipients (`security.test.ts`) |
| Google / Microsoft OAuth | Secrets from env / Key Vault; state/PKCE by Better Auth | `auth/auth.test.ts` | Tenant restriction for Microsoft; account linking by verified email |
| Organizer session on routes | `authed` hook, `member`, `owner` (`guards.ts`) | `privacy-api.test.ts` sweep (anonymous/guest/display 401, non-member 403) | Every new route must keep `g.pre`; the sweep fails on unclassified routes |
| Platform admin | DB flag read per request (`isPlatformAdmin`), or bootstrap by a **verified** email listed in `PLATFORM_ADMIN_EMAILS` | `privacy-api.test.ts`, `show.test.ts`, `security.test.ts` | Review the env list when Key Vault values change |
| Guest claim paths | Join token / short code -> pick name -> verified paths (email link, personal code) for secrets; atomic claim; re-claim revokes the old session. Short codes are 10 chars (50 bits, grouped display `ABCDE-FGHJK`, input normalised) with a **global** lockout (per-code and failed-guess budget, not per IP; QR tokens unaffected) | `join.test.ts`, `security.test.ts`, `shortcode-guard.test.ts` | A deliberate guessing campaign can disable short-code entry for 60 s (QR still works); takeover of an unverified roster name (mitigated: unverified = base access, no secrets) |
| Display token exchange | Token hash lookup, expiry / revocation, rate limited | `join.test.ts` | Token shown in QR/URL: leakage via screenshots; rotation UX |
| Sockets | Cookie auth at handshake (`realtime/hub.ts`), **explicit `Origin` allowlist** (same origin + `allowedOrigins`; localhost only outside production; no-Origin non-browser clients allowed), per-event room check, grant-scoped channel with authz re-check before every send, forced disconnect on expiry / revocation / membership / session change | `hub.test.ts`, `organizer.test.ts`, `privacy-api.test.ts`, `security.test.ts` | Keep `BETTER_AUTH_URL` equal to the public origin |
| CSRF | `SameSite=Lax`; every mutation needs a custom `Idempotency-Key` header (not sendable cross-site without a CORS preflight; CORS is off) | `http/idempotency.test.ts` | Confirm no `GET` mutates state; Better Auth keeps its own origin checks |

## 3. Input and upload surfaces

| Surface | Limits | Controls | Tests | Review focus |
|---|---|---|---|---|
| Gift photo `POST /api/me/gift/photo` | multipart, 1 file, 5 MB | sharp decode with `limitInputPixels` 40 MP, format allowlist, resize <= 1600 px, re-encode JPEG (EXIF/GPS dropped), random server key (never the filename), private storage, 600 s signed URLs | `routes/gifts.test.ts`, `storage/storage.test.ts` | Pixel/decompression bombs, animated formats, libvips CVEs (Dependabot), concurrent-upload memory |
| Local media `GET /media/*` (dev) | - | HMAC-SHA256 signature + expiry, `timingSafeEqual`, key regex blocks traversal | `storage/storage.test.ts` | Dev only; production = Azure Blob user-delegation SAS via managed identity |
| Pairing import `POST .../pairing-imports` | multipart, 2 MB, 1 file | papaparse (CSV), read-excel-file (XLSX; npm `xlsx` not used), header mapping, raw file discarded, masked summary only | `pairing/pairing.test.ts` | XLSX zip-bomb guard before parsing (central-directory sizes: <= 200 entries, <= 50 MB total, ratio <= 200, no zip64; `pairing/zip.ts`); encoding sniffing; formula-looking cells are data, never evaluated |
| JSON bodies | strict Zod schemas on every route (`g.body`) | Unknown keys rejected, idempotency key format | route tests | Fastify default body limit (1 MiB); Socket.IO `maxHttpBufferSize` (1 MB default) |
| Path / header ids | UUID columns | Malformed ids give 400 `bad_request` (global handler maps Postgres `22P02`) | `privacy-api.test.ts` | Any param used outside SQL (paths, URLs) |
| Free text (names, gift text, reasons) | length caps in contracts | Rendered as text (no `dangerouslySetInnerHTML`), audit/log redaction | contracts tests, `logging.test.ts` | Stored XSS in the display scene (Fiammetta), unicode confusables in names |

## 3b. Phase 2 surfaces (guess, clues, missions, mini-games, presentations, certificates)

| Surface | Controls | Tests | Review focus |
|---|---|---|---|
| Guess your secret Santa `GET /api/me/guess`, `PUT /api/me/guesses/:giftId` | Participant session only (organizer/display get 401); a guess is stored per (gift, guesser) and only ever returned to its owner; suspects = active roster minus self (`invalid_suspect`/`own_gift` otherwise); window = phases `gift_opening..reveal` and until that gift's giver is revealed (`guess_closed`); feature flag `features.guessSanta` (default off, `feature_disabled`); paused events refuse | `db/phase2.test.ts`, `routes/phase2.test.ts` | IDOR on `:giftId` (gift must belong to the caller's event), guesses on hidden gifts, suspect id from another event |
| Giver clues `POST/GET /api/me/clues`, organizer `GET/POST /api/events/:id/clues[/:clueId]` | Only the giver of an opened, unrevealed gift can add (max 3 live per gift, 5..140 chars); EN/IT keyword filter rejects insults/profanity, self-reveal ("it's me"), the giver's own name and contact details (`clue_not_allowed`); every clue waits in the organizer queue; queue projection = alias + text + status (no author, no timestamp, not even with a grant); approval is announced on `pub` as `{type:'clue', alias, text}` | `domain/phase2.test.ts` (filter), `db/phase2.test.ts`, `routes/phase2.test.ts`, `privacy-phase2.test.ts` (key allowlists) | Filter bypass (leet/spacing; best-effort, the queue is the real control), authorship inference through ordering or timing |
| Secret missions `/api/me/missions*`, organizer `/api/events/:id/missions*` | In-house EN/IT catalog (>= 20, safe/inclusive/voluntary); assignment random, per participant, readable only by that participant; opt-out cancels open ones; swap limited by `phase2.missionSwaps`; completion = honor or organizer verification (`phase2.missionVerification`); organizer sees counts + submitted-for-verification entries only; the display gets ONLY `{type:'mission_completed'}` from a durable job with 10..40 s random jitter and **no public delta at completion time**; audit/log redaction covers `mission*`, `note`, `guess*`, `clue*` | `db/phase2.test.ts`, `routes/phase2.test.ts` ("display learns only..."), `privacy-phase2.test.ts` | Timing correlation (jitter is mitigation, not proof), note free text shown to the organizer |
| Mini-games `/api/me/game*`, organizer `/api/events/:id/games*` | Games only in phase `games`; one active game per event (partial unique index); every step is a durable `game.step` job guarded by `stepVersion` (stale/early deliveries are no-ops); server timestamps decide windows (late/early answers rejected, never punished); one answer per round (unique); correct answers never in a payload before the round closes; participants read only their own submission/score/card; public output = top-N through canPublish() (>= 5 players), stored once at the `results` step | `db/phase2.test.ts`, `routes/phase2.test.ts` | Bot-speed tapping (Speed Challenge GO time is hidden until it happens, but a script can still win), custom-question text injection (rendered as text), bingo mark spam (unique per cell; organizer confirms) |
| Presentations `POST/DELETE /api/events/:id/presentations` | Organizer (masked). Santa Detective, Invisible Santa and Mission Master are computed ONLY by `publishPeopleBoard()` -> `canPublish()` (>= 5 distinct contributors, top-N, hidden tail, shared ties, no totals); on failure the display gets the neutral `christmas_magic` and only the organizer response carries the reason code; rank-1 achievements unlock once (idempotent) | `db/phase2.test.ts`, `routes/phase2.test.ts`, `privacy-phase2.test.ts` (property tests) | `detectiveMinGuessers` can only be raised; guess-derived data has no brute-force deduction run like ADR-0003 (the boards publish who is best, never which suspect anyone picked) |
| Certificates `GET /api/me/certificates`, `GET /api/me/achievements/:key/certificate.png` | Participant session; the achievement must be unlocked by the caller (same 404 for unknown / not yours); PNG rendered in-process with satori + resvg (MPL-2.0) from the web app's licensed fonts (WOFF2 unpacked in memory with wawoff2) and procedural SVG art, no remote fetch, no user-supplied markup (text only, folded to the font subset), `no-store`, per-route limit 20/min + small LRU | `certificates/render.test.ts`, `routes/phase2.test.ts` | CPU cost of rendering (rate limit), satori/resvg CVEs (Dependabot), font path resolution in the container image (`CERT_FONTS_DIR`) |
| Delete-my-data / removal | `purgePhase2Personal()` erases guesses, authored clues, missions, opt-out, game answers/marks/cards/scores; published snapshots are not rewritten (like locked awards) | `db/phase2.test.ts` | Result snapshots keep person ids of published winners until retention |
## 3c. Phase 3 surfaces (coins, auction, history, account link, editor, scale-out)

| Surface | Controls | Tests | Review focus |
|---|---|---|---|
| Feature switches `PATCH /api/events/:id/features` | Organizer (masked), strict patch schema without floor keys, merged settings re-validated, locked at `completed`, no new switches in `awards`, audited; disabling the auction refunds the open leader | `db/phase3.test.ts`, `routes/phase3.test.ts` | Any future setting added to the patch schema must keep the floors out of reach |
| Coins `GET /api/me/coins`, organizer `GET /coins`, `POST /coins/grants` | Self-only balance; earn hook derives a unique `rewardKey` from the XP award (never from a request); grants idempotent per `(key, participant)`; no purchase/transfer/convert path exists | `db/phase3.test.ts`, `routes/phase3.test.ts` | Mass-grant abuse by an organizer (bounded 1..1000 per key, audited) |
| Auction `/api/me/auction*`, organizer `/auction/prizes*` | Bids under a row lock on the bidder + prize (no overspend, no double hold); holds as ledger entries; durable `auction.close` job guarded by `closeVersion`; anti-snipe bounded; public payload = price + deadline, never bidders; secret prize text only after `reveal`; organizer prize list never lists bidders | `db/phase3.test.ts`, `routes/phase3.test.ts` | Winner is named at close (positive recognition, by design); bid timing can still reveal that someone is active |
| History / Hall of Fame / lifetime `GET /api/me/history`, `/api/events/:id/archive`, `.../hall-of-fame`, `/api/me/lifetime`, `/api/account/profile` | Public-results-only snapshot, deleted at `retention.archiveDays`; HoF scoped to the owner's archived events; seasonal board via canPublish; account profile needs a Better Auth session | `db/phase3.test.ts`, `routes/phase3.test.ts`, `privacy-api.test.ts` sweep | Snapshot keeps ids of published winners until retention; seasonal board only covers account-linked people |
| Account link `POST /api/me/account-link`, `POST /api/account-link/confirm` | Verified claim required; 256-bit single-use token (SHA-256 stored), 30 min TTL, per-IP limits (5/min start, 10/min confirm), generic 401; email sent through the existing transport (console transport refused in production) | `db/phase3.test.ts`, `routes/phase3.test.ts` | Mail-bomb/enumeration (limits + same response), someone entering a stranger's address (only attaches THEIR positive titles to that account after the owner clicks) |
| Custom editor `/api/events/:id/categories*`, `.../custom-achievements*` | Organizer only; categories frozen once voting opens; `c_[a-z0-9_]` keys; categories in use cannot be deleted; manual awards only for category-less achievements in `games..awards`; names are text only | `db/phase3.test.ts`, `routes/phase3.test.ts` | Free-text names on the display (rendered as text) |
| Scale-out prep (`apps/server/src/scale`, `outbox_events`) | `FanoutBus` interface + in-memory default; hub relays role-guarded deltas, never `grant:*`; outbox written in the business tx and relayed with `FOR UPDATE SKIP LOCKED` in order; job runner leases recover dead workers (`SCALE_OUT=true` disables the blanket startup requeue) | `scale/scale.test.ts` | Cursors are per instance until a shared cursor store exists (ADR-0008); rate-limit counters remain per process |
## 4. Rate limiting and abuse controls

| Control | Where | Value | Note |
|---|---|---|---|
| Global per-IP | `@fastify/rate-limit` (`app.ts`) | 300/min on API routes; non-API GETs (static SPA) exempt | In-memory: resets on restart, per replica. A venue behind one NAT shares the budget: raise `rateLimitMax` for big events |
| Public join endpoints | `routes/join.ts` `publicLimit` + `ShortCodeGuard` | resolve/display 20/min, claim 10/min per IP; globally: 30 lookups/code/min, 100 failed short-code lookups/min -> 60 s lockout | IP-independent lockout (`http/shortcode-guard.ts`), in-memory per replica |
| Auth | Better Auth rate limit | 100/min general, magic link 5/min | Keyed on `x-sg-client-ip` = Fastify `req.ip` (trusted hops only); client `X-Forwarded-For`/`X-Real-IP` are stripped before the request reaches Better Auth |
| Socket messages | per-socket `Bucket` (`hub.ts`) | 20 msg/s | |
| Reactions | `ReactionService` | 5/s per participant, aggregated broadcast, organizer mute | `reactions.test.ts` |
| Idempotency | `http/idempotency.ts` + `idempotency-db.ts` (Postgres table, atomic claim, daily purge) | key reused with another request gives 422; replay survives restarts | Per-request DB round trips (negligible at MVP load) |
| Trusted proxy hops | `app.ts` (`TRUST_PROXY_HOPS`, default 1) | exact hop count: only the address the ingress appended is believed, a forged leftmost `X-Forwarded-For` is ignored | Must match the real number of proxies in front (Container Apps ingress = 1); 0 behind nothing; tests in `security.test.ts` |

## 5. Data protection surfaces

| Surface | Control | Tests |
|---|---|---|
| Secrets in DB | Hashed tokens (SHA-256); no plaintext session/claim tokens; short codes in clear by design (low value, expiring) | `join.test.ts` |
| Secret data in APIs/sockets | Strict per-role projections + send-guard; unmask grants; audit of every grant and detail read | `doc/privacy-test-matrix.md` |
| Logs | Pino redaction, query strings dropped, token-like path segments masked, default 404 handler does not log the URL | `logging.test.ts` |
| Audit log | Append-only table, `redactAuditData` strips vote/pairing keys | db tests |
| Retention / erasure | Daily `retention.daily` job, delete-my-data, takedown | `admin.test.ts`, `show.test.ts` |
| Transport headers | `@fastify/helmet` with a strict CSP (self-only scripts, no eval/inline script, `frame-ancestors 'none'`, `object-src 'none'`, blob-storage images, `upgrade-insecure-requests` + HSTS in production), `Cache-Control: no-store` on `/api/*`; SPA served by the server with immutable hashed assets and never-cached `index.html`/`sw.js` | `http/web.test.ts`, `app.test.ts`, `e2e/fullstack` (no CSP violations in a real browser) |
| Secrets / config | `.env.example` only; production requires `BETTER_AUTH_SECRET` (>= 32 chars) and `DATABASE_URL`; Key Vault + managed identity in Azure | `auth/config.ts`, ADR-0005 |

## 6. Infrastructure and supply chain

| Surface | State | Review focus |
|---|---|---|
| Azure (`infra/` Bicep) | Container Apps (single replica), PG Flexible, private Blob, Key Vault, ACS Email, managed identity; validated with `az bicep build` only, **never deployed** | PG network exposure, Blob public access off, RBAC least privilege, ingress restrictions |
| CI/CD | `ci.yml`, `codeql.yml`, `deploy.yml` (manual dispatch, environment approval, OIDC) | Workflow permissions, action pinning by SHA, secrets on forks |
| Dependencies | Dependabot; `npm audit --omit=dev --audit-level=high` gate (4 moderate dev-only findings accepted) | Better Auth, Socket.IO, sharp, Fastify plugins; lockfile integrity |
| Web (`apps/web`, Fiammetta) | Static PWA; service worker caches the shell only | CSP on the static host (Fastify's CSP covers the API), no inline script, service worker scope |

## 7. Triage of the original 8 gaps

| # | Gap | Status |
|---|---|---|
| 1 | Production email transport | **Fixed**: `AcsEmailTransport` (managed identity), env-flagged, startup guard, Bicep wiring (`EMAIL_TRANSPORT`, `ACS_ENDPOINT`, `ACS_SENDER_ADDRESS`, Contributor role on the ACS resource). Unverified against a live ACS resource: needs a verified sender domain before launch |
| 2 | Socket.IO `Origin` check | **Fixed** (allowlist + tests) |
| 3 | XLSX decompression limits | **Fixed** (central-directory guard) |
| 4 | Per-process idempotency / rate-limit state | Idempotency **fixed** (Postgres). Rate-limit counters (global, auth, short codes) and the Socket.IO hub remain per process: **open**, required before scale-out (Redis / Web PubSub, ADR-0005) |
| 5 | Short-code guessing | **Fixed**: 10-char codes + IP-independent lockout |
| 6 | `trustProxy: true` | **Fixed**: exact hop count, Better Auth uses the trusted IP only |
| 7 | Vote/board-tick timing correlation for small cohorts | **Accepted** (ADR-0003) |
| 8 | Platform-admin bootstrap | **Fixed** (verified-email allowlist via env) |

New items to track: Dockerfile and ACS delivery are not exercised in CI (no Docker daemon or ACS resource here); the venue-NAT rate-limit budget; a short-code lockout can be triggered on purpose to disable short-code entry for 60 s (QR joins keep working).