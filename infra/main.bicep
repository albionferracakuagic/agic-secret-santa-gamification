targetScope = 'resourceGroup'

@description('Deployment environment; drives SKUs and protection settings.')
@allowed(['dev', 'prod'])
param environment string

@description('Owner decision: Italy North. Fallback westeurope/northeurope (same template).')
@allowed(['italynorth', 'westeurope', 'northeurope'])
param location string = 'italynorth'

@description('Short lowercase prefix (3-8 chars) for resource names.')
@minLength(3)
@maxLength(8)
param appName string = 'santa'

@description('Container image; the first deploy uses a placeholder until CI pushes the real one.')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('PostgreSQL administrator login.')
param postgresAdminLogin string = 'santaadmin'

@secure()
@description('PostgreSQL admin password. Supply at deploy time (never commit); store the resulting URL in Key Vault.')
param postgresAdminPassword string

@description('Set true once Key Vault holds better-auth-secret and database-url.')
param useKeyVaultSecrets bool = false

@description('Public base URL (custom domain). Empty = generated Container Apps FQDN.')
param publicBaseUrl string = ''

var prod = environment == 'prod'
var namePrefix = '${appName}-${environment}'
var tags = {
  app: 'santa-gamification'
  environment: environment
  managedBy: 'bicep'
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: { namePrefix: namePrefix, location: location, tags: tags }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id'
  location: location
  tags: tags
}

module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    readerPrincipalId: identity.properties.principalId
    purgeProtection: prod
  }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    sku: prod ? 'Standard' : 'Basic'
    pullPrincipalId: identity.properties.principalId
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    skuName: prod ? 'Standard_B2s' : 'Standard_B1ms'
    storageGb: prod ? 64 : 32
    backupDays: prod ? 14 : 7
    administratorLogin: postgresAdminLogin
    administratorPassword: postgresAdminPassword
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    skuName: prod ? 'Standard_ZRS' : 'Standard_LRS'
    blobContributorPrincipalId: identity.properties.principalId
  }
}

module communication 'modules/communication.bicep' = {
  name: 'communication'
  params: { namePrefix: namePrefix, tags: tags, senderPrincipalId: identity.properties.principalId }
}

module app 'modules/containerapp.bicep' = {
  name: 'containerapp'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    logAnalyticsName: monitoring.outputs.logAnalyticsName
    identityId: identity.id
    identityClientId: identity.properties.clientId
    registryLoginServer: registry.outputs.loginServer
    image: image
    cpu: prod ? '1.0' : '0.5'
    memory: prod ? '2Gi' : '1Gi'
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    storageAccountName: storage.outputs.name
    postgresHost: postgres.outputs.host
    postgresDatabase: postgres.outputs.databaseName
    keyVaultUri: keyVault.outputs.uri
    acsEndpoint: communication.outputs.endpoint
    emailSenderAddress: communication.outputs.senderAddress
    useKeyVaultSecrets: useKeyVaultSecrets
    publicBaseUrl: publicBaseUrl
  }
}

output appUrl string = app.outputs.baseUrl
output acrName string = registry.outputs.name
output containerAppName string = app.outputs.appName
output keyVaultName string = keyVault.outputs.name
output senderDomain string = communication.outputs.senderDomain
