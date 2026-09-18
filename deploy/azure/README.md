# The customer cloud path

The same commit that deploys to Vercel runs here. Nothing in the application is
conditional on where it is running: what changes is configuration.

| | Vercel | Azure |
|---|---|---|
| Application | Vercel functions | the container in `Dockerfile`, on Azure Container Apps |
| Database | Neon Postgres | Azure Database for PostgreSQL |
| Evidence files | Vercel Blob | Azure Blob |
| Sign on | Clerk | Entra ID, terminated by the platform |
| Chat | Slack | Teams |
| Model | Anthropic under zero retention | Azure OpenAI in the tenant, or open weights in the boundary |
| Durability | Inngest Cloud | the database queue in `lib/runtime/queue.ts` |
| Telemetry | the same OTLP export | the same OTLP export, to the customer's collector |

## Deploying

```
az acr build --registry <registry> --image work-ledger:$(git rev-parse --short HEAD) .
az deployment group create \
  --resource-group <group> \
  --template-file deploy/azure/containerapp.bicep \
  --parameters image=<registry>.azurecr.io/work-ledger@<digest> \
               tenantId=<tenant> clientId=<app> \
               databaseUrl=@Microsoft.KeyVault(...) \
               teamsTeamId=<team> teamsChannelId=<channel> \
               otlpEndpoint=<collector>
```

The image is deployed by digest rather than by tag, so which commit is running is
provable rather than asserted.

## Outbound network

The container app sits in an internal environment with no public ingress of its
own. Outbound is limited to the model provider and the connectors in use; with
Azure OpenAI and Teams both inside the tenant, and the database queue instead of
Inngest, a deployment can be configured so that nothing leaves the tenant at all.
`GET /api/health` reports which of these are in use, and every audit archive
carries the same statement, read from the configuration rather than from a
document that can drift.

## Checking it is the same system

`make parity` runs the Day One scenario twice, once under the Vercel shaped
configuration and once under the Azure shaped one, and compares the two audit
exports row by row. They have to match.
