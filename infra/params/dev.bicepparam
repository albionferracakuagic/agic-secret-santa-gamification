using '../main.bicep'

param environment = 'dev'
param location = 'italynorth'
// Supplied at deploy time from the environment (GitHub environment secret); never committed.
param postgresAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD', '')
