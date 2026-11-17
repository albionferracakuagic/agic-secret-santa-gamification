targetScope = 'resourceGroup'

@description('Environment name (used in resource names).')
param environment string

@description('Tags applied to the action group.')
param tags object

@description('Monthly budget in USD for the resource group.')
param budgetAmountUsd int

@description('Emails to alert. Must not be empty (caller skips this module when empty).')
@minLength(1)
param contactEmails array

@description('Budget start: first day of a month (yyyy-MM-dd).')
param firstDayOfMonth string

// Alerts only: budgets never stop or throttle spending.
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'santa-${environment}-budget-ag'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take('santa${environment}', 12)
    enabled: true
    emailReceivers: [
      for (email, i) in contactEmails: {
        name: 'owner-${i}'
        emailAddress: email
        useCommonAlertSchema: true
      }
    ]
  }
}

var thresholds = [
  { key: 'actual50', threshold: 50, thresholdType: 'Actual' }
  { key: 'actual80', threshold: 80, thresholdType: 'Actual' }
  { key: 'actual100', threshold: 100, thresholdType: 'Actual' }
  { key: 'forecast100', threshold: 100, thresholdType: 'Forecasted' }
]

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: 'santa-${environment}-monthly'
  properties: {
    category: 'Cost'
    amount: budgetAmountUsd
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: firstDayOfMonth
      endDate: dateTimeAdd(firstDayOfMonth, 'P10Y', 'yyyy-MM-dd')
    }
    notifications: toObject(thresholds, t => t.key, t => {
      enabled: true
      operator: 'GreaterThan'
      threshold: t.threshold
      thresholdType: t.thresholdType
      contactEmails: contactEmails
      contactGroups: [actionGroup.id]
    })
  }
}

output budgetName string = budget.name
output actionGroupName string = actionGroup.name
