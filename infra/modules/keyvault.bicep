param namePrefix string
param location string
param tags object
@description('Identity that reads secrets (managed identity, no stored credentials).')
param readerPrincipalId string
@description('Purge protection is irreversible: enable only for prod.')
param purgeProtection bool

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('${namePrefix}-kv', 24)
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: purgeProtection ? true : null
    publicNetworkAccess: 'Enabled'
  }
}

// Key Vault Secrets User
var secretsUserRole = '4633458b-17de-408a-b874-0445c86b69e6'
resource readerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, readerPrincipalId, secretsUserRole)
  properties: {
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRole)
  }
}

output name string = kv.name
output uri string = kv.properties.vaultUri
