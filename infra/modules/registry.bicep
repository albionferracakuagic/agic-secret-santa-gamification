param namePrefix string
param location string
param tags object
param sku string
param pullPrincipalId string

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: replace('${namePrefix}acr', '-', '')
  location: location
  tags: tags
  sku: { name: sku }
  properties: {
    adminUserEnabled: false
  }
}

// AcrPull
var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, pullPrincipalId, acrPull)
  properties: {
    principalId: pullPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPull)
  }
}

output name string = acr.name
output loginServer string = acr.properties.loginServer
