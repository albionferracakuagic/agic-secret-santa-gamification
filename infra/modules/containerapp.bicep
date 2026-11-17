param namePrefix string
param location string
param tags object
param logAnalyticsName string
param identityId string
param identityClientId string
param registryLoginServer string
param image string
param cpu string
param memory string
param appInsightsConnectionString string
param storageAccountName string
param postgresHost string
param postgresDatabase string
param keyVaultUri string
param acsEndpoint string
param emailSenderAddress string
@description('Set true only after the Key Vault secrets exist (better-auth-secret, database-url).')
param useKeyVaultSecrets bool
@description('Public base URL; empty = the generated Container Apps FQDN.')
param publicBaseUrl string = ''

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsName
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-cae'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var appName = '${namePrefix}-app'
var baseUrl = empty(publicBaseUrl) ? 'https://${appName}.${env.properties.defaultDomain}' : publicBaseUrl

var kvSecrets = useKeyVaultSecrets
  ? [
      {
        name: 'better-auth-secret'
        keyVaultUrl: '${keyVaultUri}secrets/better-auth-secret'
        identity: identityId
      }
      {
        name: 'database-url'
        keyVaultUrl: '${keyVaultUri}secrets/database-url'
        identity: identityId
      }
    ]
  : []

var secretEnv = useKeyVaultSecrets
  ? [
      { name: 'BETTER_AUTH_SECRET', secretRef: 'better-auth-secret' }
      { name: 'DATABASE_URL', secretRef: 'database-url' }
    ]
  : []

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        // Socket.IO: required once replicas > 1 (ADR-0005); harmless with a single replica.
        stickySessions: { affinity: 'sticky' }
      }
      registries: [{ server: registryLoginServer, identity: identityId }]
      secrets: kvSecrets
    }
    template: {
      containers: [
        {
          name: 'server'
          image: image
          resources: { cpu: json(cpu), memory: memory }
          env: concat(
            [
              { name: 'NODE_ENV', value: 'production' }
              { name: 'PORT', value: '3000' }
              { name: 'BETTER_AUTH_URL', value: baseUrl }
              { name: 'EMAIL_TRANSPORT', value: 'acs' }
              { name: 'ACS_ENDPOINT', value: acsEndpoint }
              { name: 'ACS_SENDER_ADDRESS', value: emailSenderAddress }
              { name: 'TRUST_PROXY_HOPS', value: '1' }
              { name: 'AZURE_CLIENT_ID', value: identityClientId }
              { name: 'STORAGE_ACCOUNT_NAME', value: storageAccountName }
              { name: 'POSTGRES_HOST', value: postgresHost }
              { name: 'POSTGRES_DB', value: postgresDatabase }
              { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            ],
            secretEnv
          )
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 3000 } }
            { type: 'Readiness', httpGet: { path: '/health', port: 3000 } }
          ]
        }
      ]
      // MVP: exactly one replica (in-memory cursors/idempotency, ADR-0005). Scale-out needs Redis/Web PubSub.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

output appName string = app.name
output fqdn string = app.properties.configuration.ingress.fqdn
output baseUrl string = baseUrl
