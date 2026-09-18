// The Work Ledger in a customer's Azure boundary.
//
// The same container image as the Vercel deployment, with Azure Database for
// PostgreSQL instead of Neon, Azure Blob for evidence, Entra ID through the
// platform's own authentication, Teams as the chat surface, a model provider
// inside the tenant, and outbound network limited to the model provider and the
// connectors in use. Inngest is replaced by the built in database queue; the
// code path through the durable functions is identical.

@description('Where this deployment lives.')
param location string = resourceGroup().location

@description('The container image, by digest, so the deployed commit is provable.')
param image string

@description('The Entra tenant this deployment belongs to.')
param tenantId string

@description('The Entra application registration that fronts the app.')
param clientId string

@secure()
@description('Reference to the Postgres connection string in Key Vault.')
param databaseUrl string

@description('The Teams team and channel the run threads live in.')
param teamsTeamId string
param teamsChannelId string

@description('The OpenTelemetry collector the security team already watches.')
param otlpEndpoint string

var name = 'work-ledger'

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    // The application has no public ingress of its own; the platform terminates
    // authentication in front of it.
    vnetConfiguration: {
      internal: true
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 3000
        transport: 'http'
      }
      secrets: [
        { name: 'database-url', value: databaseUrl }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            { name: 'LEDGER_ENVIRONMENT', value: 'azure' }
            { name: 'LEDGER_AUTH', value: 'entra' }
            { name: 'LEDGER_CHAT', value: 'teams' }
            { name: 'AZURE_TENANT_ID', value: tenantId }
            { name: 'AZURE_CLIENT_ID', value: clientId }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'TEAMS_TENANT_ID', value: tenantId }
            { name: 'TEAMS_TEAM_ID', value: teamsTeamId }
            { name: 'TEAMS_CHANNEL_ID', value: teamsChannelId }
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: otlpEndpoint }
            // Inngest is deliberately unset: the database queue carries the
            // durable state so nothing crosses the boundary to a queue service.
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/api/health', port: 3000 }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/health', port: 3000 }
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 4
      }
    }
  }
}

output appFqdn string = app.properties.configuration.ingress.fqdn
output principalId string = app.identity.principalId
