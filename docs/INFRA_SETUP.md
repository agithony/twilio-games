# Infrastructure Setup

This runbook covers the Azure and GitHub configuration required by `.github/workflows/deploy.yml`. For application behavior and local setup, see the [README](../README.md). For image, runtime, persistence, URLs, and rollback details, see [Deployment](./DEPLOYMENT.md).

The workflow uses service-principal JSON credentials, Azure CLI provisioning, a remote ACR build, and an Azure Container Apps YAML specification. It does not use GitHub OIDC or `azure/container-apps-deploy-action`.

## Prerequisites

- An Azure subscription and permission to create a service principal and role assignment.
- Permission to create resources in the target subscription or resource group.
- GitHub repository administrator access for Actions secrets and variables.
- Git LFS objects available to GitHub Actions. Both CI and deploy explicitly check them out.
- A voice-capable Twilio number for live voice or SMS use.
- Asset redistribution rights appropriate for the deployment. See [Asset licensing](#asset-licensing).

No local Docker installation is required for the GitHub deployment because `az acr build` runs in Azure. Azure CLI is required only for manual setup and operations.

## Resource names

The workflow currently declares:

| Resource | Name or value |
|---|---|
| Resource group | `rg-twilio-games` |
| Region | `centralus` |
| Azure Container Registry | `twiliogames` |
| Container Apps environment | `cae-twilio-games` |
| Log Analytics workspace | `law-twilio-games` |
| Container App | `twilio-games` |
| Storage account | `twiliogamesdata` |
| Azure Files share | `twiliogamesdata` |
| Environment storage attachment | `appdata` |
| Image repository | `twilio-games` |

ACR and storage account names are globally unique. Change the values in the workflow `env` block if they are unavailable. Keep `.github/containerapp.yaml`, documentation, and operational commands aligned with any name changes.

The workflow applies `created_by=github-actions` and `managed_by=twilio-games-ci` to resources it creates, except the resource group. This satisfies the repository's documented tenant tag policy. The Log Analytics workspace is created explicitly so the Container Apps environment does not attempt to create an untagged workspace.

## Create the deployment identity

The checked-in workflow passes one JSON secret to `azure/login@v3` through its `creds` input. Create a client-secret-based service principal:

```bash
az ad sp create-for-rbac \
  --name twilio-games-deploy \
  --role Contributor \
  --scopes /subscriptions/<subscription-id> \
  --sdk-auth
```

Store the complete JSON output as the GitHub Actions secret `AZURE_CREDENTIALS`. This is client-secret authentication, not federated OIDC. Rotate the service-principal secret according to the organization's credential policy and replace the GitHub secret before expiration.

Subscription scope permits the workflow's first run to create `rg-twilio-games`. To reduce scope, create the resource group first and assign Contributor on:

```text
/subscriptions/<subscription-id>/resourceGroups/rg-twilio-games
```

Contributor is broad but matches the workflow's resource creation and update behavior. A custom role can be used if it includes the required resource group, ACR, storage, Log Analytics, Container Apps environment, Container App, and environment-storage operations.

## Configure GitHub Actions secrets

Open **Settings > Secrets and variables > Actions > Secrets** and configure:

| Secret | Required | Use |
|---|---|---|
| `AZURE_CREDENTIALS` | Yes | `azure/login@v3` service-principal JSON |
| `TWILIO_AUTH_TOKEN` | Required for authenticated Twilio voice/SMS | Stored as Container App secret `twilio-token`; validates Twilio webhook signatures and currently also authenticates Conversation Relay setup frames |
| `EDITOR_TOKEN` | Strongly recommended for public deployments | Stored as Container App secret `editor-token`; protects disk-writing editor and garage APIs |
| `GOOGLE_OAUTH_CLIENT_ID` | Required for analytics | Stored as Container App secret `google-oauth-client-id`; Google OAuth web client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Required for analytics | Stored as Container App secret `google-oauth-client-secret`; Google OAuth web client secret |
| `OPENAI_API_KEY` | No | Enables the OpenAI conversational host; empty uses scripted/deterministic behavior |

The workflow creates Container App secret references for `TWILIO_AUTH_TOKEN`, `EDITOR_TOKEN`, both Google OAuth credentials, and the generated ACR password. `OPENAI_API_KEY` is substituted into `.github/containerapp.yaml` as a plain Container App environment value, not a Container App secret reference.

An empty `TWILIO_AUTH_TOKEN` disables signature validation by default. An empty `EDITOR_TOKEN` leaves editor and garage writes open. Missing Google OAuth credentials disable analytics sign-in. Do not leave required protections empty on a public event deployment.

## Configure GitHub Actions variables

Open **Settings > Secrets and variables > Actions > Variables** and configure as needed:

| Variable | Required | Use |
|---|---|---|
| `GAME_PHONE_NUMBER` | Recommended for live events | Public phone number displayed and QR-encoded in all game lobbies; empty displays a setup placeholder |
| `CR_TTS_VOICE` | No | ElevenLabs voice ID for Conversation Relay TTS; empty uses the Relay default |
| `OPENAI_MODEL` | No | OpenAI model name; empty defaults to `gpt-4o-mini` |
| `ANALYTICS_ALLOWED_EMAIL` | No | One exact verified Google email allowed to view analytics in addition to `@twilio.com` accounts |

These values are rendered into the Container App specification on every deployment.

Create a Google OAuth 2.0 web client with `https://<app-fqdn>/auth/google/callback` as an authorized redirect URI. If `ANALYTICS_ALLOWED_EMAIL` belongs to an account outside Twilio Workspace, the OAuth application audience must permit external users. See [Analytics setup](./analytics.md).

## First deployment

Push to `main`, or run **Actions > Deploy to Azure Container Apps > Run workflow**. The deploy job proceeds only after the reusable `Validate` job succeeds.

The first successful run performs these operations:

1. Checks out repository and Git LFS content.
2. Signs in to Azure with `AZURE_CREDENTIALS`.
3. Creates or verifies the resource group, ACR, storage account, file share, Log Analytics workspace, Container Apps environment, and `appdata` environment storage.
4. Builds and pushes SHA and `latest` image tags in ACR.
5. Creates a tagged Container App with external ingress on port 8080.
6. Enables ACR admin credentials, obtains the admin username/password, and stores the password as the Container App secret `acr-password`.
7. Sets application secrets and applies `.github/containerapp.yaml`, including the Azure Files mount, one-replica limit, 2 vCPU, 4 GiB memory, and runtime environment.
8. Resolves the public FQDN and polls `/healthz` until it returns HTTP 200 or five minutes elapse.

The workflow is create-if-missing for supporting infrastructure, not a full declarative reconciliation system. For example, it does not change an existing storage SKU, share quota, region, or Log Analytics configuration to match the checked-in defaults.

## Configure Twilio webhooks

After deployment, let `<base>` be the printed `https://<fqdn>` value.

Configure the Twilio number's incoming voice webhook:

```text
POST <base>/voice/incoming
```

Configure the incoming messaging webhook if the SMS concierge is used:

```text
POST <base>/sms
```

The voice webhook returns TwiML that connects Conversation Relay to `wss://<fqdn>/voice` and sets `POST <base>/voice/session-ended` as the session-ended callback. `PUBLIC_BASE_URL` is populated from the Container App FQDN, so these derived URLs do not require separate configuration.

Open the desired shared screen before accepting calls. The server routes a new call to the game whose `/game`, `/battle`, or `/fighter` display WebSocket connected most recently; Racer is the fallback. Current launch URLs are listed in [Deployment](./DEPLOYMENT.md#public-urls), including `/fighter.html` and `/editor`.

Carrier registration requirements, including A2P 10DLC or toll-free verification, may apply to outbound US messaging. Confirm the Twilio number and campaign configuration before an event.

## Verify the deployment

```bash
FQDN=$(az containerapp show \
  --name twilio-games \
  --resource-group rg-twilio-games \
  --query properties.configuration.ingress.fqdn \
  --output tsv)

curl --fail "https://${FQDN}/healthz"
```

Expected response shape:

```json
{"status":"ok","rooms":0}
```

This endpoint confirms that the HTTP process can answer and reports the current Racer room count. It does not verify Azure Files writability, LFS asset integrity, Twilio connectivity, OpenAI connectivity, or WebSocket gameplay. The Container App YAML currently has no platform health probe.

For an event readiness check, also load `/play.html`, `/monsters.html`, `/fighter.html`, and `/editor`; verify representative GLB and FBX-backed scenes; save and reload a disposable editor change; and complete a real Twilio call.

## Persistent storage operations

Azure Files is mounted at `/app/appdata`; `scripts/start.sh` links `/app/data` to `/app/appdata/data`. Persistent files include activation analytics, the leaderboard, Racer maps, Monsters arena configuration after its first save, Fighter map catalog, and generated Fighter previews.

Back up the share before destructive editor work or rollback across a data-format change. The workflow does not create snapshots, backups, retention policies, or migrations. Image rollback does not roll back Azure Files content.

Do not place image-owned assets or `assets/manifest.json` on the share without changing application behavior deliberately. See [Deployment persistence](./DEPLOYMENT.md#persistence) for the exact boundary.

## Configuration gaps and security notes

`FIGHTER_DISPLAY_TOKEN` is supported by the server but is absent from both `deploy.yml` and `.github/containerapp.yaml`. The deployed Fighter display therefore has no host-token enforcement. Adding a GitHub secret alone has no effect; the workflow and Container App specification must also pass it as a secret reference.

`VOICE_RELAY_TOKEN` is also absent from the deployment configuration. The server currently falls back to `TWILIO_AUTH_TOKEN` for Conversation Relay setup-frame authentication, so Relay is authenticated when the Twilio token is configured. A separate relay token requires wiring it through the workflow and Container App specification.

`OPENAI_API_KEY` originates as a GitHub Actions secret but is rendered as a plain Container App environment value. It can be visible to principals allowed to inspect Container App configuration. Treat that access as secret-bearing or change the deployment to use an Azure Container App secret reference.

The workflow enables the ACR admin account and places an admin password in the Container App as `acr-password`. This works with the current YAML but uses long-lived registry credentials. A managed identity with `AcrPull` would reduce credential exposure and rotation work.

Manual `az containerapp update --set-env-vars` changes are not authoritative. A later `az containerapp update --yaml` can replace the container environment list with the checked-in specification. Persist runtime configuration by updating the workflow and `.github/containerapp.yaml`; this documentation-only runbook does not add missing secret wiring.

## Asset licensing

Git LFS checkout includes Fighter map GLBs and Fighter source FBX files in the build context and production image. `assets/CREDITS.md` states that Fighter asset source URLs, authors, and licenses are still unknown and must be verified before public redistribution. Do not treat successful LFS checkout as proof of redistribution rights.

The asset credits also identify `assets/maps/drift_race_track_free.glb` as CC-BY-ND 4.0. Distribute only an unmodified work and preserve required attribution. Review [assets/CREDITS.md](../assets/CREDITS.md) before every public or commercial deployment.

## Operational rollback

Every build pushes an immutable commit-SHA tag. Roll back the image with:

```bash
az containerapp update \
  --name twilio-games \
  --resource-group rg-twilio-games \
  --image twiliogames.azurecr.io/twilio-games:<old-commit-sha>
```

A later normal deployment reapplies the full YAML and the current commit image. Validate persistent-file compatibility before rolling back application code.
