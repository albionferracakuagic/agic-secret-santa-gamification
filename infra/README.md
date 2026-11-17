# Infrastructure (Bicep)

Region: **Italy North** (`location` param; fallback `westeurope`). Decisions: `doc/adr/0005-azure-hosting-cicd-jobs.md`.

| Module | Resources |
|---|---|
| `monitoring` | Log Analytics + App Insights |
| `keyvault` | Key Vault (RBAC, soft delete; purge protection in prod) |
| `registry` | ACR (admin disabled, AcrPull for the managed identity) |
| `postgres` | PostgreSQL Flexible Server (Burstable), firewall = Azure services only |
| `storage` | Blob, private `media` container, no shared keys |
| `communication` | ACS Email (data location Europe; not Italy-resident) |
| `containerapp` | Container Apps env + app, 1 replica, sticky sessions, managed identity |

## Validate (read-only)
```
az bicep build -f infra/main.bicep --stdout > /dev/null
az bicep build-params -f infra/params/dev.bicepparam --stdout > /dev/null
```
Deploys only via `.github/workflows/deploy.yml` (manual, environment approval). Never deploy from a laptop
without owner confirmation; run `az account show` first.

## One-time setup (owner)
1. Resource group in Italy North; GitHub OIDC app registration with federated credentials per environment.
2. GitHub environments `dev`, `prod` (required reviewers) and `dev-plan`, `prod-plan`; variables
   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`; secret `PG_ADMIN_PASSWORD`.
3. Two-run flow: run 1 (`useKeyVaultSecrets=false`) provisions infra with the placeholder image, no secrets and no migration job. Then put `better-auth-secret` and `database-url` in Key Vault and run 2 with `useKeyVaultSecrets=true`: it creates the migration job, builds the image, runs migrations to completion, then rolls out the app.
4. Replace the Azure-managed email domain with a verified custom domain (SPF/DKIM) before launch.

## DB migrations
Production never auto-migrates (ADR-0005). With `useKeyVaultSecrets=true` Bicep creates the manual Container Apps job `<prefix>-migrate`; `deploy.yml` points it at the new image, runs `az containerapp job start`, polls the execution and fails the deploy unless `Succeeded`, all before the app rollout. Entry point: `packages/db/src/migrate-cli.ts` (advisory-locked, needs only `DATABASE_URL`). Failure logs: Log Analytics `ContainerAppConsoleLogs_CL` for the job. Manual re-run: `az containerapp job start -n <prefix>-migrate -g <rg>`.

## OAuth (optional)
Social sign-in is off unless configured; the app starts fine without it. Per provider, set both parts, and only with `useKeyVaultSecrets=true`:
- Public ids as GitHub environment **variables**: `GOOGLE_CLIENT_ID`, `MICROSOFT_CLIENT_ID`, optional `MICROSOFT_TENANT_ID` (read by the `.bicepparam` files).
- Client secrets as Key Vault secrets named exactly `google-client-secret` and `microsoft-client-secret` (referenced by the Container App via managed identity; never committed).
- Redirect URIs to register: `<appUrl>/api/auth/callback/google` and `<appUrl>/api/auth/callback/microsoft` (`appUrl` = deployment output, or `publicBaseUrl`).
- Create the Key Vault secret before the run that sets the client id, otherwise the revision cannot resolve it.

## Cost guards
Pay-as-you-go, no free credit and **no hard spending cap**: nothing below stops spending, it only alerts or lets you switch things off.
- **Budget alerts** (`modules/budget.bicep`): monthly resource-group budget (`budgetAmountUsd`: dev 60, prod 200 USD) + action group emailing `BUDGET_CONTACT_EMAILS` (comma-separated GitHub environment variable, read by the `.bicepparam`). Alerts at 50/80/100% actual and 100% forecasted. Empty variable = nothing is created. `firstDayOfMonth` defaults to `utcNow('yyyy-MM-01')`; redeploying in a later month moves the start date, which Azure may reject for an existing budget: pass the original value if so. Budget data lags by hours (up to ~24h), so an alert can arrive after the money is spent.
- **Pause / resume** (`.github/workflows/pause-resume.yml`, manual, same environment-approval gate as deploy): `pause` scales the app to 0/0 and stops PostgreSQL; `resume` starts PostgreSQL, waits for `Ready`, restores exactly 1/1 replicas (in-memory realtime state) and smoke-tests `/health`. Pausing prod needs `confirmProd=true`. Resources are found by tag `environment` in `AZURE_RESOURCE_GROUP`.
- **Auto-pause dev**: nightly 23:00 UTC, only if repo variable `AUTO_PAUSE_DEV=true` (default off). It runs in the `dev` environment (reviewers there make it wait for approval). Azure auto-restarts a stopped Flexible Server after 7 days; the nightly run stops it again.
- Paused still bills: PG storage/backups, storage account, ACR, Key Vault, Log Analytics. Idle for long: `az group delete -n <rg>` (destroys data; redeploy via `deploy.yml`).
