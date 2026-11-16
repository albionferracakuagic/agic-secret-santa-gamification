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

output communicationServiceName string = acs.name
output senderDomain string = domain.properties.mailFromSenderDomain
