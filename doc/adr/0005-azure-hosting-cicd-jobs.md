# ADR-0005 — Azure hosting, CI/CD, durable jobs

Status: Accepted (MVP single replica); scale-out path defined

## Context
- Azure, EU region. Small team, low ops. Socket.IO needs connection affinity or an adapter to scale. Timers (voting close, board cadence, ceremony) must survive restarts.

## Decision
**Hosting (Bicep, `infra/`)**
- Azure Container Apps (Consumption), **min=max=1 replica** in MVP + ACR. Single revision mode, HTTP ingress.
- PostgreSQL Flexible Server (Burstable), PITR backups.
- Storage Blob (private; short-lived SAS; photos renamed, EXIF stripped by sharp).
- Azure Communication Services Email (magic/claim links).
- Key Vault + managed identity; App Insights + Log Analytics (pino/OTel, redacted).
- **Region: Italy North (Milan)** — owner decision. Availability (web-checked, re-verify SKUs with `az` read-only/what-if before deploy): Container Apps, PostgreSQL Flexible, Key Vault available; Blob Storage, ACR, Log Analytics/App Insights assumed available, verify.
- **ACS Email caveat**: ACS is non-regional; resource "data location" is chosen from a geography list (e.g. Europe), not Italy North. Email data at rest stays in the chosen geography (EU) but is not Italy-resident. Domain must be verified (SPF/DKIM). Document in privacy policy; if Italy-only residency is required, fallback = another EU SMTP/mail provider behind the same `EmailTransport` interface.
- Caveats: Italy North has no paired region → DR/backups: PITR in-region + optional geo-redundant backup to another EU region if offered for the SKU (verify); newer SKUs/features may land later than in West/North Europe → fallback region West Europe (same Bicep, `location` param).
- Subscription/RG from owner.
- Ingress **session affinity = sticky** enabled anyway (supported in single-revision HTTP ingress; required once replicas >1). Deploys disconnect sockets: clients reconnect + snapshot-recover (ADR-0002). Prefer websocket transport.
- Local dev (no Docker): PGlite, local-FS storage, console email; Azurite optional.

**CI/CD (GitHub Actions)**
- Audit gate (decided at ci-pipeline): `npm audit --omit=dev --audit-level=high` blocks; full `npm audit` is report-only. Status at 2026-11-16: 0 high/critical; 4 moderate on the runtime-tree scan, 8 moderate overall, all build/dev tooling (drizzle-kit → @esbuild-kit/esbuild dev-server advisory; vite-plugin-pwa → workbox-build → glob/minimatch). Not shipped in the server image; `npm audit fix --force` would downgrade drizzle-kit/vite-plugin-pwa, so wait for upstream fixes (Dependabot tracks). Revisit: raise gate to `moderate` once clean.
- CI sets `TEST_DATABASE_URL` (Postgres 17 service) to run the real-Postgres suites; they are skipped locally when it is unset.
- PR: install, `tsc -b`, ESLint, Vitest (PGlite), Postgres-service suite (jobs/claims), privacy contract suite, `npm audit --omit=dev`, `az bicep build`, Playwright + axe.
- Main: build image → ACR → staging; manual approval → prod. Azure auth via **GitHub OIDC** federated credential. `what-if` on infra PRs.
- Migrations: drizzle-kit, applied before traffic shift, expand/contract.
- Azure writes need explicit owner confirmation; `az account show` first.

**Durable jobs**
- `scheduled_jobs(eventId, kind, runAt, payload, status, lockedBy, attempts)`; poller ~1 s with advisory lock / `FOR UPDATE SKIP LOCKED`; idempotent handlers; startup recovery of overdue jobs; backoff retries; dead-letter status.
- Covers voting auto-close, board cadence, ceremony timers, grant expiry, retention. **No timer lives only in memory.** Crash tests between DB commit and socket emit (recovered via snapshot).

**Scale-out (Phase 3)**
- Socket.IO Redis adapter (Azure Cache for Redis) or Azure Web PubSub for Socket.IO; cursors + `lastPublished` already in DB; transactional outbox for deltas; poller already multi-instance-safe.

## Implementation notes (infra-azure, 2026-11-16)
- `infra/` Bicep validated with `az bicep build` only (no deployment, no what-if run). Region param default `italynorth`, allowed `westeurope|northeurope`.
- PostgreSQL uses public access limited by the "Azure services" firewall rule + TLS + admin password (from a deploy-time secret → Key Vault). Entra-only auth and private networking (VNet-integrated Container Apps env) are a hardening follow-up.
- `deploy.yml`: manual dispatch; read-only validate/what-if job, then a `deploy` job bound to a GitHub Environment (required reviewers = approval gate). OIDC login, no stored Azure secrets.
- The server image does not yet serve the SPA (static serving is still to do); the Dockerfile has not been built locally.

## Consequences
- + Simple, cheap MVP; scale-out needs no data-model change.
- − Single replica: reconnect blip on deploy/node maintenance → policy: no deploys during an event window.
- − Burstable PG is a ceiling (ADR-0006 load test validates).
- − Single region; DR = PITR only.

## Addendum: production migrations (deploy fix)
- The server skips `migrate()` in production, so the deploy workflow runs migrations itself: a manual-trigger Container Apps **Job** (`<prefix>-migrate`, Bicep `Microsoft.App/jobs`) using the same image, managed identity and `database-url` Key Vault secret, command `node packages/db/dist/migrate-cli.js`.
- It runs *before* the new revision rolls out (expand/contract keeps the running revision compatible). The workflow updates the job image to the new tag, starts it, polls until `Succeeded`, and fails the deploy otherwise.
- Concurrency-safe: a session-level Postgres advisory lock (`MIGRATE_LOCK_KEY`) on a dedicated connection; re-runs are idempotent (drizzle journal). Logs never print the connection string.
- Rejected: running from a GitHub runner (Postgres firewall = Azure services only) and `az containerapp exec`.
- Bootstrap: the job exists only when `useKeyVaultSecrets=true`; the first (quickstart-image) deploy skips migration.

## Addendum: cost guards
- Owner is on pay-as-you-go with no hard cap. Added monthly Cost Management budgets (alerts only, hours of lag) per environment and a manual `pause-resume.yml` (app 0/0 + PG stop; resume restores 1/1). Optional nightly dev auto-pause via `AUTO_PAUSE_DEV`.
- Limits: budgets never stop spending; paused environments still incur storage/ACR/Key Vault/log costs; prod pause needs explicit confirmation. Details: `infra/README.md`.
