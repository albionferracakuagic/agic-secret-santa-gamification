@minLength(3)
param namePrefix string
param location string
param tags object
param skuName string
param blobContributorPrincipalId string

resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  #disable-next-line BCP334
  name: take(replace('${namePrefix}st', '-', ''), 24)
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: skuName }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    defaultToOAuthAuthentication: true
  }
}

resource blob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: sa
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

// Private container: reads go through short-lived SAS minted with the managed identity (user-delegation SAS).
resource media 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'media'
  properties: { publicAccess: 'None' }
}

// Storage Blob Data Contributor
var blobContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
resource contributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sa
  name: guid(sa.id, blobContributorPrincipalId, blobContributor)
  properties: {
    principalId: blobContributorPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributor)
  }
}

output name string = sa.name
output blobEndpoint string = sa.properties.primaryEndpoints.blob
