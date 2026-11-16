# ADR-0001 — Stack and libraries

Status: Accepted (versions: verify at scaffold; pin in lockfile)

## Context
- Public multi-tenant, mobile-first PWA: organizer console, participant app, public display. Realtime. ≤100 participants/event. EN+IT. Azure EU.
- Privacy by projection (FR-046/FR-013) → shared zod contracts + pure domain logic must be reusable by server, web and tests.
- Greenfield, one writer at a time, no Docker required locally.

## Decision
npm-workspaces TS-strict monorepo:

| Path | Content |
|---|---|
| `apps/web` | React 19 + Vite PWA. Routes `/o` organizer, `/e` participant, `/d` display, `/j` join |
| `apps/server` | Node 24 + Fastify 5; REST commands, Socket.IO push, jobs; serves SPA same-origin |
| `packages/contracts` | zod: REST DTOs, socket events, strict per-role output schemas |
| `packages/domain` | pure: phase machine, ranking, `canPublish()`, XP, pairing validation |
| `packages/db` | Drizzle schema + migrations |
| `infra/`, `e2e/` | Bicep; Playwright |

Libraries:
- **Server**: Fastify + `@fastify/cookie|helmet|rate-limit|multipart|static` + zod type provider; Socket.IO 4; pino + OpenTelemetry → App Insights; sharp (resize, EXIF strip).
- **DB**: PostgreSQL 16+ (Flexible Server) + Drizzle ORM + drizzle-kit. Tests/local dev: **PGlite** via `drizzle-orm/pglite` (+ `drizzle-orm/pglite/migrator`). CI also runs a real Postgres service for advisory-lock/concurrency tests (PGlite is single-connection; not representative for locks).
- **Auth**: Better Auth, organizers only (magic link, Microsoft, Google), Drizzle adapter (`@better-auth/drizzle-adapter`), mounted on Fastify via the documented catch-all handler (no 3rd-party plugin). Guests do not use Better Auth (ADR-0004).
- **Import**: `papaparse` (CSV) + `read-excel-file` (XLSX). **Not** npm `xlsx` 0.18.5 (unpatched prototype-pollution/ReDoS CVEs; npm copy abandoned).
- **Web**: TanStack Query, Zustand, React Router, Tailwind v4, i18next, vite-plugin-pwa; FX: motion, dotLottie, canvas-confetti, tsparticles-slim, howler.
- **Test**: Vitest, fast-check, Playwright, @axe-core/playwright, k6 or Artillery (load).
- **Email**: Azure Communication Services Email (magic links; console transport locally).

Rules:
- Dependency policy: exact-pin via lockfile, `npm audit --omit=dev` gate in CI, Dependabot weekly.
- Better Auth: pin a release at/after the magic-link vs OAuth state-token fix (reported 1.7.x line; confirm in changelog at scaffold), because we combine both. Re-verify adapter package + Microsoft provider config at install.
- Socket.IO: client `transports: ['websocket']` first, polling fallback allowed; stickiness per ADR-0005.
- Any new runtime dependency touching uploads/parsing/auth needs a line in this ADR or a new ADR.

## Consequences
- + One language, shared contracts → projections validated identically in server, tests, client.
- + PGlite → fast hermetic DB tests, no Docker.
- − PGlite ≠ Postgres: dual-run critical suites (jobs, claims atomicity) on real Postgres in CI.
- − Better Auth is young/fast-moving: wrap behind a thin `auth` module; security advisories monitored.
- − read-excel-file is low-activity: files ≤ few hundred rows, size cap (2 MB), parse in try/catch; swap cost low (one adapter).
- − Socket.IO needs sticky/single replica or adapter to scale (ADR-0005).
