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
3. After first deploy: put `better-auth-secret` and `database-url` in Key Vault, then run with `useKeyVaultSecrets=true`.
4. Replace the Azure-managed email domain with a verified custom domain (SPF/DKIM) before launch.
