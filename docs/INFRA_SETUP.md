# Infrastructure setup (one-time runbook)

This is the one-time setup needed before the deploy workflow (`.github/workflows/deploy.yml`) can
ship Voice Racer to **Azure Container Apps**. The workflow is **self-bootstrapping** — it creates
the resource group, container registry, storage account, file share, and Container Apps environment
on first run if they don't exist. So the only manual prerequisites are: an Azure service principal
(for the workflow to log in) and the GitHub secrets below.

Deploy style: **service-principal credentials + inline idempotent provisioning + `az acr build`**
(the same pattern as `twilio-cartoon-printer`). The build runs in the cloud on ACR agents, so no
local Docker is needed.

## Resource names (set in deploy.yml `env:`)

| Resource | Name |
|---|---|
| Resource group | `rg-twilio-games` |
| Container registry (ACR) | `twiliogames` |
| Container Apps environment | `cae-twilio-games` |
| Container App | `twilio-games` |
| Storage account | `twiliogamesdata` |
| Azure Files share | `twiliogamesdata` |
| Region | `centralus` |

Change these in `deploy.yml`'s `env:` block if your subscription needs different names (ACR +
storage account names are globally unique).

## 1. Create the service principal

The workflow logs in with `azure/login@v3` using a single `AZURE_CREDENTIALS` JSON secret. Create a
service principal scoped to the subscription (it needs Contributor to create/manage the resources
above on first run):

```bash
az ad sp create-for-rbac \
  --name "twilio-games-deploy" \
  --role Contributor \
  --scopes /subscriptions/<SUBSCRIPTION_ID> \
  --sdk-auth
```

`--sdk-auth` prints the JSON object (clientId/clientSecret/subscriptionId/tenantId) that goes into
the `AZURE_CREDENTIALS` GitHub secret verbatim.

> Tighter scope: once the resource group exists you can re-scope the SP to just
> `/subscriptions/<id>/resourceGroups/rg-twilio-games`. The first run needs subscription scope only
> if it must create the resource group itself.

## 2. GitHub repo secrets

Set under **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Purpose | Required? |
|---|---|---|
| `AZURE_CREDENTIALS` | SP login JSON from step 1 | **Yes** |
| `TWILIO_AUTH_TOKEN` | Validates inbound Twilio webhook signatures. When set, validation is ON (fail-closed). | Yes for voice/SMS |
| `EDITOR_TOKEN` | Gates the level-editor `/api` writes on the public deploy. Pick any strong string. | Recommended |
| `OPENAI_API_KEY` | Powers the conversational AI host (natural-language chat + voice-driven car/map/start actions in the menus + end-of-race, via Conversation Relay). **Empty/unset → the game falls back to scripted phrase-bank lines and still works.** | Optional (for the AI demo) |

Optional **repo variables** (Settings → … → Variables) — all safe to leave unset:

| Variable | Purpose |
|---|---|
| `CR_TTS_VOICE` | ElevenLabs voiceId for the spoken race-host talk-back (empty → Conversation Relay default voice). |
| `OPENAI_MODEL` | Which OpenAI model the AI host uses (empty → server default, currently `gpt-4o-mini`). Bump this as OpenAI ships newer models — no code change needed. |

## Tenant tag policy (already handled)

The tenant root management group enforces `tag-enforcement-policy`: it **denies creating any resource
(except resource groups) without a non-empty `created_by` tag**. The deploy already satisfies this —
every create passes `--tags created_by=github-actions managed_by=twilio-games-ci` (the Container App
carries it via `tags:` in `containerapp.yaml`). Nothing to do; noted so a future name/resource change
remembers to keep the tag.

## 3. First deploy

Push to `main` (or run the workflow manually: **Actions → Deploy to Azure Container Apps → Run
workflow**). The run will: gate on CI → bootstrap infra → `az acr build` the image → create the
Container App with the Azure Files mount → patch `PUBLIC_BASE_URL` to the real FQDN → smoke
`/healthz`. The final step prints the app URL + webhook URLs.

## 4. Point Twilio at the deployed app

After the first successful deploy, take the printed FQDN (`https://<app>.<region>.azurecontainerapps.io`)
and configure your Twilio number:

- **Voice** → A call comes in → Webhook → `https://<FQDN>/voice/incoming` (HTTP POST).
- **Messaging** (SMS concierge) → A message comes in → Webhook → `https://<FQDN>/sms` (HTTP POST).

The app derives the Conversation Relay `wss://` URL and the `/voice/join` action URL from
`PUBLIC_BASE_URL`, which the deploy sets to the FQDN automatically — no manual URL config beyond the
two webhook fields above.

> Sending SMS from the concierge requires A2P 10DLC / toll-free verification on the Twilio number
> (carriers filter unregistered traffic). Inbound + reply works for testing without it.

## 5. Out-of-band runtime config (env vars NOT in the workflow)

The Container App's env is defined in `.github/containerapp.yaml`. The deploy sets `PORT`,
`NODE_ENV`, `PUBLIC_BASE_URL`, `DATA_MOUNT`, and the two secret-refs. If you need to add a one-off
runtime var without a redeploy:

```bash
az containerapp update --name twilio-games --resource-group rg-twilio-games \
  --set-env-vars SOME_VAR=value
```

…but prefer editing `containerapp.yaml` so it survives the next deploy (a `--set-env-vars` not in
the YAML is overwritten on the next `containerapp update --yaml`).

## Persistence

The global leaderboard (`data/leaderboard.json`) lives on the Azure Files share mounted at
`/app/appdata`; `scripts/start.sh` symlinks `/app/data` → the mount so writes survive restarts and
redeploys. Maps (`assets/maps/maps.json`) and the GLB models ship **in the image** (committed to
git), so they update with each deploy and are not on the share.

## Rollback

Images are tagged by commit SHA (`twilio-games:<sha>`). To roll back, redeploy an older SHA:

```bash
az containerapp update --name twilio-games --resource-group rg-twilio-games \
  --image twiliogames.azurecr.io/twilio-games:<old-sha>
```
