# Deploy to Azure Container Apps

Not yet run end to end: Docker and the Azure CLI were not available where this was
written. Check each step's output.

**Requirements:** Azure CLI (`az login`), a resource group in India Central (close to
JournL), DNS access for `journl.in`.

## 1. Registry and image (built in the cloud; no local Docker needed)

```bash
RG=journl-mcp-rg; LOC=centralindia; ACR=journlmcpacr   # ACR name must be globally unique
az group create -n $RG -l $LOC
az acr create -g $RG -n $ACR --sku Basic
az acr build -r $ACR -t journl-mcp:1.0.0 .
```

## 2. Persistent storage for registered OAuth clients

`data/clients.json` must survive restarts; losing it breaks every existing ChatGPT
connection (`invalid_client`). It holds no tokens or accounting data.

```bash
SA=journlmcpdata$RANDOM
az storage account create -g $RG -n $SA -l $LOC --sku Standard_LRS
az storage share-rm create -g $RG --storage-account $SA -n journl-mcp-data --quota 1
KEY=$(az storage account keys list -g $RG -n $SA --query "[0].value" -o tsv)

az containerapp env create -g $RG -n journl-mcp-env -l $LOC
az containerapp env storage set -g $RG -n journl-mcp-env --storage-name journlmcpdata \
  --azure-file-account-name $SA --azure-file-account-key "$KEY" \
  --azure-file-share-name journl-mcp-data --access-mode ReadWrite
```

## 3. Create the app

Fill in the `<…>` values in [containerapp.yaml](containerapp.yaml): subscription, resource
group, environment and registry name, and confirm `JOURNL_API_BASE_URL` (set to production
`https://api.bizpolebooks.com`). Then:

```bash
az containerapp create -g $RG -n journl-mcp --yaml deploy/containerapp.yaml
APP_ID=$(az containerapp show -g $RG -n journl-mcp --query identity.principalId -o tsv)
az role assignment create --assignee $APP_ID --role AcrPull \
  --scope $(az acr show -n $ACR --query id -o tsv)
az containerapp show -g $RG -n journl-mcp --query properties.configuration.ingress.fqdn -o tsv
```

Keep `minReplicas: 1` and `maxReplicas: 1`. Sign-in sessions live in memory: two replicas
break sign-in, and scaling to zero signs everyone out. Every redeploy also signs users
out once; ChatGPT then shows "Reconnect".

## 4. Custom domain `mcp.journl.in` with a managed certificate

```bash
FQDN=$(az containerapp show -g $RG -n journl-mcp --query properties.configuration.ingress.fqdn -o tsv)
VERIFY=$(az containerapp show -g $RG -n journl-mcp --query properties.customDomainVerificationId -o tsv)
# DNS at journl.in:
#   CNAME  mcp          -> $FQDN
#   TXT    asuid.mcp    -> $VERIFY
az containerapp hostname add  -g $RG -n journl-mcp --hostname mcp.journl.in
az containerapp hostname bind -g $RG -n journl-mcp --hostname mcp.journl.in \
  --environment journl-mcp-env --validation-method CNAME
```

## 5. Verify

```bash
curl https://mcp.journl.in/health                                        # {"ok":true}
curl https://mcp.journl.in/.well-known/oauth-protected-resource/mcp     # resource = https://mcp.journl.in/mcp
curl -i -X POST https://mcp.journl.in/mcp                               # 401 + WWW-Authenticate
npx @modelcontextprotocol/inspector@latest                              # Streamable HTTP → https://mcp.journl.in/mcp
VERIFY_EMAIL=<demo account> VERIFY_PASSWORD=<…> PUBLIC_URL=https://mcp.journl.in npm run verify
```

Then add the server in ChatGPT (Plugins → Add custom MCP server) and run the review test
cases from `plugin/plugin.template.json`.

## 6. Plugin portal domain verification

When the portal shows the challenge token (MCPs → Connect):

```bash
az containerapp secret set -g $RG -n journl-mcp --secrets openai-apps-challenge=<token>
az containerapp revision restart -g $RG -n journl-mcp \
  --revision $(az containerapp revision list -g $RG -n journl-mcp --query "[0].name" -o tsv)
curl https://mcp.journl.in/.well-known/openai-apps-challenge             # prints the token only
```

## Updating

```bash
az acr build -r $ACR -t journl-mcp:1.0.1 .
az containerapp update -g $RG -n journl-mcp --image $ACR.azurecr.io/journl-mcp:1.0.1
```

After tool changes, use **Rescan** in the plugin portal (published plugin) or **Refresh
tools** in ChatGPT (custom connection).
