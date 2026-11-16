param namePrefix string
param location string
param tags object
param skuName string
param storageGb int
param backupDays int
param administratorLogin string
@secure()
param administratorPassword string
param databaseName string = 'santa'

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${namePrefix}-pg'
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: 'Burstable'
  }
  properties: {
    version: '17'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: { storageSizeGB: storageGb }
    backup: {
      backupRetentionDays: backupDays
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// Limited access: only Azure-hosted services (the Container App) may connect; TLS is enforced by default.
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

output host string = pg.properties.fullyQualifiedDomainName
output databaseName string = db.name
