using '../main.bicep'

param environment = 'prod'
param location = 'italynorth'
param postgresAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD', '')
