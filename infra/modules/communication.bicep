param namePrefix string
param tags object
@description('ACS is non-regional; data at rest stays in this geography (ADR-0005: Europe, not Italy-resident).')
param dataLocation string = 'Europe'

resource email 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: '${namePrefix}-email'
  location: 'global'
  tags: tags
  properties: { dataLocation: dataLocation }
}

// Azure-managed sender domain for MVP; replace with a verified custom domain (SPF/DKIM) before launch.
resource domain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: email
  name: 'AzureManagedDomain'
  location: 'global'
  properties: { domainManagement: 'AzureManaged' }
}

resource acs 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: '${namePrefix}-acs'
  location: 'global'
  tags: tags
  properties: {
    dataLocation: dataLocation
    linkedDomains: [domain.id]
  }
}

// The server sends mail with its managed identity (no connection string): Contributor on the ACS resource.
param senderPrincipalId string

resource sendRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acs.id, senderPrincipalId, 'acs-contributor')
  scope: acs
  properties: {
    principalId: senderPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  }
}

output communicationServiceName string = acs.name
output endpoint string = 'https://${acs.properties.hostName}'
output senderAddress string = 'DoNotReply@${domain.properties.mailFromSenderDomain}'
output senderDomain string = domain.properties.mailFromSenderDomain
