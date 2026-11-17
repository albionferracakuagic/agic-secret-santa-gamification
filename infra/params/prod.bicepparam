using '../main.bicep'

param environment = 'prod'
param location = 'italynorth'
param postgresAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD', '')
// Public OAuth ids (GitHub environment variables); client secrets live in Key Vault only.
param googleClientId = readEnvironmentVariable('GOOGLE_CLIENT_ID', '')
param microsoftClientId = readEnvironmentVariable('MICROSOFT_CLIENT_ID', '')
param microsoftTenantId = readEnvironmentVariable('MICROSOFT_TENANT_ID', '')
// Budget alerts: comma-separated emails (GitHub environment variable); empty = no budget created.
param budgetContactEmails = filter(map(split(readEnvironmentVariable('BUDGET_CONTACT_EMAILS', ''), ','), e => trim(e)), e => !empty(e))
param budgetAmountUsd = 200
