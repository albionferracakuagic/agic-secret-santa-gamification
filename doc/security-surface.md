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