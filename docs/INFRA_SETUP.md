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

## Twilio account topology

This deployment intentionally uses two Twilio accounts:

| Responsibility | Primary English/messaging account | Portuguese Voice account |
|---|---|---|
| English Voice number | Yes | No |
| SMS number | Yes | No |
| WhatsApp sender | Yes | No |
| TAC and Conversation Orchestrator | Yes | No |
| Conversation Memory store | Yes | No |
| Outbound Messaging API | Yes | No |
| Portuguese Voice number | No | Yes |
| Runtime Account SID/API key | Required | Not required |
| Webhook Auth Token | `TWILIO_AUTH_TOKEN` | `TWILIO_PT_AUTH_TOKEN` |

TAC has one account context, so `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_NUMBER`, `TWILIO_WHATSAPP_NUMBER`, the Memory store, and the Conversation Configuration must all belong to the primary account. The Portuguese account only needs its Voice number and Auth Token. Both accounts send Voice webhooks to the same application.

## Configure GitHub Actions secrets

Open **Settings > Secrets and variables > Actions > Secrets** and configure:

| Secret | Required | Use |
|---|---|---|
| `AZURE_CREDENTIALS` | Yes | `azure/login@v3` service-principal JSON |
| `TWILIO_AUTH_TOKEN` | Yes | Primary account Auth Token; validates English Voice, SMS, WhatsApp, TAC, and Messaging callbacks |
| `TWILIO_PT_AUTH_TOKEN` | Yes | Auth Token from the separate account that owns the Portuguese Voice number |
| `TWILIO_ACCOUNT_SID` | Yes | Primary account SID for TAC, Memory, Orchestrator, and Messaging |
| `TWILIO_API_KEY` | Yes | Twilio API key SID used by TAC and server-side REST clients |
| `TWILIO_API_SECRET` | Yes | Twilio API key secret used by TAC and server-side REST clients |
| `VOICE_RELAY_TOKEN` | Yes | Independent random token of at least 32 characters for Conversation Relay setup-frame authentication; do not reuse `TWILIO_AUTH_TOKEN` |
| `ARCADE_SIGNING_SECRET` | Yes | Exactly 64 hexadecimal characters; derives separate signed player-session and challenge-token keys |
| `ARCADE_DISPLAY_TOKEN` | Yes | Random pre-shared kiosk capability of at least 16 characters; required for display-ready and station game controls |
| `EDITOR_TOKEN` | Strongly recommended for public deployments | Stored as Container App secret `editor-token`; protects disk-writing editor and garage APIs |
| `GOOGLE_OAUTH_CLIENT_ID` | Required for analytics | Stored as Container App secret `google-oauth-client-id`; Google OAuth web client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Required for analytics | Stored as Container App secret `google-oauth-client-secret`; Google OAuth web client secret |
| `OPENAI_API_KEY` | No | Enables the OpenAI conversational host; empty uses scripted/deterministic behavior |

Credential sources:

| Value | Where to obtain it |
|---|---|
| Primary Account SID and Auth Token | Primary Twilio Console: **Develop > API Key & creds > Auth Tokens** |
| `TWILIO_PT_AUTH_TOKEN` | Portuguese account Console: **Develop > API Key & creds > Auth Tokens** |
| API Key SID and Secret | Primary account Console: **Develop > API Key & creds > API Keys > Create API Key**. Create a Standard key and save the secret when shown; it cannot be displayed again. |
| `VOICE_RELAY_TOKEN` | Generate it yourself. It is an application secret, not a Twilio credential: `openssl rand -hex 32`. |
| Arcade signing secret | Generate separately with `openssl rand -hex 32`. |
| Display/editor tokens | Generate separate random values, for example `openssl rand -base64 32`. |

`VOICE_RELAY_TOKEN` protects the public `/voice` WebSocket. The server embeds it in Conversation Relay custom parameters in its TwiML and validates the subsequent setup frame. You do not paste it into Twilio Console and must not reuse either account Auth Token.

The workflow validates webhook authentication, TAC credentials, the dedicated Relay token, and both Arcade secrets before touching Azure. A missing OpenAI key uses the placeholder `disabled`, which the server treats as unset.

An empty primary or Portuguese Auth Token makes the corresponding production webhooks fail closed. An empty `EDITOR_TOKEN` leaves editor and garage writes open. Missing Google OAuth credentials disable analytics sign-in.

## Configure GitHub Actions variables

Open **Settings > Secrets and variables > Actions > Variables** and configure as needed:

| Variable | Required | Use |
|---|---|---|
| `GAME_PHONE_NUMBER` | No | Legacy voice-number fallback until both locale numbers are saved in the operator console |
| `TWILIO_SMS_NUMBER` | Yes | E.164 SMS-capable Twilio number registered with TAC; intentionally separate from the US and Brazilian voice numbers |
| `TWILIO_WHATSAPP_NUMBER` | Required to offer WhatsApp | Approved WhatsApp sender; omit the `whatsapp:` prefix or include it, both are accepted |
| `TWILIO_MESSAGING_SERVICE_SID` | Required for out-of-session WhatsApp notices | Messaging Service SID containing the approved WhatsApp sender |
| `ARCADE_OUTBOUND_MESSAGING_ENABLED` | No | Set to literal `true` only after REST credentials, senders, callbacks, and templates are ready; defaults off. The operator console reports whether proactive delivery is effectively enabled separately from inbound onboarding. |
| `TWILIO_WHATSAPP_CONTENT_SID_STATION_*_{EN_US,PT_BR}` | Required only for out-of-session WhatsApp delivery | Ten approved Content SIDs covering five station notice kinds in English and Brazilian Portuguese |
| `CR_TTS_VOICE` | No | ElevenLabs voice ID for Conversation Relay TTS; empty uses the Relay default |
| `CR_TTS_VOICE_PT_BR` | No | Optional Brazilian Portuguese ElevenLabs voice ID; empty uses Relay's `pt-BR` default |
| `DEFAULT_LOCALE` | No | Locale used when no localized display is connected; defaults to `en-US` |
| `OPENAI_MODEL` | No | OpenAI model name; empty defaults to `gpt-4o-mini` |
| `ANALYTICS_ALLOWED_EMAIL` | No | One exact verified Google email allowed to view analytics in addition to `@twilio.com` accounts |
| `ARCADE_ADMIN_EMAILS` | Required to edit Twilio Games station settings | Comma-separated Google-authenticated emails allowed to use operator APIs; empty disables updates |
| `TWILIO_CONVERSATION_CONFIGURATION_ID` | Yes | Active Conversation Orchestrator configuration ID matching `conv_configuration_<26 lowercase letters or digits>` and linked to the Memory store |

These values are rendered into the Container App specification on every deployment.

Set secrets interactively so they do not appear in shell history:

```bash
gh secret set TWILIO_AUTH_TOKEN
gh secret set TWILIO_PT_AUTH_TOKEN
gh secret set TWILIO_ACCOUNT_SID
gh secret set TWILIO_API_KEY
gh secret set TWILIO_API_SECRET
openssl rand -hex 32 | gh secret set VOICE_RELAY_TOKEN
```

Set the non-secret IDs and senders after provisioning them:

```bash
gh variable set TWILIO_SMS_NUMBER --body '+1...'
gh variable set TWILIO_WHATSAPP_NUMBER --body '+1...'
gh variable set TWILIO_CONVERSATION_CONFIGURATION_ID --body 'conv_configuration_...'
```

Create a Google OAuth 2.0 web client with `https://<app-fqdn>/auth/google/callback` as an authorized redirect URI. If `ANALYTICS_ALLOWED_EMAIL` belongs to an account outside Twilio Workspace, the OAuth application audience must permit external users. See [Analytics setup](./analytics.md).

### First-deployment Orchestrator bootstrap

The production workflow validates `TWILIO_CONVERSATION_CONFIGURATION_ID` before Azure creates the app FQDN. For the first deployment, create the Memory store and Conversation Orchestrator configuration in the primary account first, but leave its final HTTPS callback unset (or point it at a controlled temporary endpoint). Store the configuration ID in GitHub, deploy the app to obtain its FQDN, then set the signed callback to `POST https://<app-fqdn>/tac/webhook`. Keep runtime mode `off` until the callback and Memory profile convergence are tested. Later deployments reuse the stable FQDN.

## First deployment

Push to `main`, or run **Actions > Deploy to Azure Container Apps > Run workflow**. The deploy job proceeds only after the reusable `Validate` job succeeds.

The first successful run performs these operations:

1. Checks out repository and Git LFS content.
2. Signs in to Azure with `AZURE_CREDENTIALS`.
3. Creates or verifies the resource group, ACR, storage account, file share, Log Analytics workspace, Container Apps environment, and `appdata` environment storage.
4. Builds and pushes SHA and `latest` image tags in ACR.
5. Creates a tagged zero-replica Container App shell with external ingress on port 8080, then replaces it with the full configured revision.
6. Enables ACR admin credentials, obtains the admin username/password, and stores the password as the Container App secret `acr-password`.
7. Records the existing active revision, switches to multiple mode, deactivates it, and waits until it is inactive with zero replicas. On first create, the temporary minimal revision is stopped and reaches zero replicas instead.
8. Applies `.github/containerapp.yaml` as a uniquely named full-spec revision, including the Azure Files mount, one-replica limit, 2 vCPU, 4 GiB memory, health probes, and runtime environment.
9. Requires the exact SHA image revision to be `Provisioned`, `Healthy`, and latest-ready with the expected mount and `/livez` probes; asserts it is the only running revision; then checks `/livez`, dependency-aware `/healthz`, `/`, `/join`, `/player`, and `/operator` through the candidate revision FQDN before public cutover.
10. Restores single revision mode only after those checks pass. Automatic snapshot restore is allowed only before the candidate can produce external or public durable side effects. Once outbound delivery may run or public traffic is admitted, failure leaves current data and the current revision intact for manual recovery rather than erasing accepted interactions.

The workflow is create-if-missing for supporting infrastructure, not a full declarative reconciliation system. For example, it does not change an existing storage SKU, share quota, region, or Log Analytics configuration to match the checked-in defaults.

## Configure Twilio, Orchestrator, and Memory

After deployment, let `<base>` be the printed `https://<fqdn>` value.

Configure both accounts' incoming Voice webhooks:

```text
POST <base>/voice/incoming
```

In the primary account, configure the English Voice number. In the Portuguese account, configure the Brazilian Voice number. Both use the same URL and `POST`. The application validates each request against the correct account token. In the Twilio Games operator console, save the primary-account number under **English voice number** and the second-account number under **Portuguese voice number**. The dialed `To` number selects the locale.

Create and configure the Twilio resources in this order:

1. Sign in to the primary account in Twilio Console.
2. Go to **Products & services > Conversation Orchestrator > Conversation configurations**.
3. Click **Create a Conversation configuration**, enter a name and description, and configure automatic capture for the primary SMS number and approved WhatsApp sender. Do not add the Portuguese number because it belongs to another account and TAC does not own Voice gameplay here.
4. Choose the Basic lifecycle and set channel inactive/closed timeouts suitable for the event.
5. On **Enable Conversation Memory**, create and select a Memory store. Use a promoted phone identifier such as `Contact.phone` so SMS and WhatsApp can converge on one profile.
6. Finish the configuration and copy the ID beginning with `conv_configuration_`. Set it as the GitHub variable `TWILIO_CONVERSATION_CONFIGURATION_ID`.
7. Edit the configuration webhook and set `POST <base>/tac/webhook`.
8. Confirm the primary SMS number and WhatsApp sender have both inbound and outbound capture rules (`number -> *` and `* -> number`).

Official references: [TAC quickstart](https://www.twilio.com/docs/conversations/agent-connect/quickstart) and [Conversation Orchestrator quickstart](https://www.twilio.com/docs/conversations/orchestrator/quickstart). The optional TAC Python setup wizard can create the Memory store and Conversation Configuration automatically; run `make setup` from the [TAC Python repository](https://github.com/twilio/twilio-agent-connect-python).

Keep the Twilio phone number's direct incoming Messaging webhook as the fail-safe endpoint:

```text
POST <base>/sms
```

The direct `/sms` route returns empty TwiML while connected TAC owns an active event, preventing duplicate replies. Conversation Orchestrator must deliver the captured communication to `/tac/webhook`; without that callback, active-event messages are acknowledged but not processed. Configure the approved WhatsApp sender in the same Orchestrator capture configuration, open the generated join link, and verify that the prefilled `JOIN` command creates one Conversation, one Memory profile, and one deterministic reply.

The voice webhook returns TwiML that connects Conversation Relay to `wss://<fqdn>/voice` and sets `POST <base>/voice/session-ended` as the session-ended callback. `PUBLIC_BASE_URL` is populated from the Container App FQDN, so these derived URLs do not require separate configuration.

In station mode, the server routes each call by its persisted admitted identity, match, room, and launch generation. Recent-display routing remains only the standalone fallback. Current launch URLs are listed in [Deployment](./DEPLOYMENT.md#public-urls).

Carrier registration requirements, including A2P 10DLC or toll-free verification, may apply to outbound US messaging. Confirm the Twilio number and campaign configuration before an event.

Approved WhatsApp Content Templates must match the application variables: admitted uses `{{1}}` for game, overflow uses `{{1}}` for position, call-now uses `{{1}}` for number and `{{2}}` for game, results uses `{{1}}` for game and optionally `{{2}}` for balance, and next-game uses no variables. Configure both `EN_US` and `PT_BR` Content SIDs before enabling out-of-session delivery.

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

`/healthz` is dependency-aware and returns 503 for repairable station/TAC/configuration degradation. ACA startup, readiness, and liveness probes call `/livez` instead, so a Twilio outage does not restart the process or hide the operator console. The deployment workflow also verifies the home, join, player, and operator pages, but it does not perform live Twilio, Memory, Azure Files write, or WebSocket gameplay tests.

There is no safe existing persistent-store write probe. Every public write endpoint changes real editor, Arcade, or messaging state, so the workflow intentionally does not call one. Do not substitute an unauthenticated or production-data mutation. A future persistent write smoke should use an authenticated, idempotent endpoint designed to create and remove a disposable probe record.

For an event readiness check, also load `/play.html`, `/monsters.html`, `/fighter.html`, and `/editor`; verify representative GLB and FBX-backed scenes; save and reload a disposable editor change; and complete a real Twilio call.

### Live acceptance checklist

Keep runtime mode `off` during provisioning. After item 1 passes, open the event from `/operator` and continue:

1. Confirm `/livez` and `/healthz` return `200`.
2. In the primary account, send `JOIN` by SMS and confirm exactly one reply, one Conversation, and one Memory profile. Send `ENTRAR` to verify Portuguese inference; legacy `LANG` commands remain supported.
3. Send the WhatsApp join message and confirm it resolves to the same profile for the same phone identity.
4. Register through `/player` and confirm the player can join immediately without an OTP.
5. Run a paid two-player game. During game selection, vote by SMS with `1` or `RACER`, change the vote by sending another enabled game, and confirm the browser player can vote from `/player`. Confirm the shared display shows looping previews and live totals. When gameplay starts, confirm one coin is redeemed from each admitted player and an overflow player's coin remains reserved.
6. Switch the event to free play and confirm no wallet grants, reservations, or redemptions are created.
7. Call the English number and confirm the request is accepted with the primary account signature and uses English recognition/TTS.
8. Call the Portuguese number and confirm the request is accepted with `TWILIO_PT_AUTH_TOKEN` and uses `pt-BR` recognition/TTS.
9. Complete Racer, Monsters, and Fighter once and confirm the operator sees authoritative results.
10. If proactive messaging is enabled, confirm SMS delivery callbacks and one approved out-of-session WhatsApp template.
11. Open the booth display with `#displayToken=<ARCADE_DISPLAY_TOKEN>`. Verify an absent or rejected token shows the visible setup form instead of a stuck countdown, then restart the Container App and confirm persisted event recovery, wallet balances, and Memory-linked messaging still work.

## Persistent storage operations

Azure Files is mounted at `/app/appdata`; `scripts/start.sh` links `/app/data` to `/app/appdata/data`. Persistent files include activation analytics, the leaderboard, Racer maps, Monsters arena configuration after its first save, Fighter map catalog, and generated Fighter previews.

Back up the share before destructive editor work or rollback across a data-format change. The workflow creates a temporary pre-rollout share snapshot after the old writer stops. It deletes the snapshot after success and restores it automatically only while no external or public side effects can have occurred. Azure retention policies and long-lived backups remain an operator responsibility.

Do not place image-owned assets or `assets/manifest.json` on the share without changing application behavior deliberately. See [Deployment persistence](./DEPLOYMENT.md#persistence) for the exact boundary.

## Configuration gaps and security notes

`FIGHTER_DISPLAY_TOKEN` remains available as a standalone override. The deployed server passes `ARCADE_DISPLAY_TOKEN` to Fighter, Racer, and Monsters, so station engine rooms share one validated kiosk capability.

`VOICE_RELAY_TOKEN` is wired as its own Container App secret and is mandatory in the deployment workflow. Rotate it independently from `TWILIO_AUTH_TOKEN`; the server places the current value in newly generated Conversation Relay setup parameters.

`OPENAI_API_KEY` is stored as a Container App secret and referenced from the container environment; it is not rendered into the checked deployment YAML.

The workflow enables the ACR admin account and places an admin password in the Container App as `acr-password`. This works with the current YAML but uses long-lived registry credentials. A managed identity with `AcrPull` would reduce credential exposure and rotation work.

Manual `az containerapp update --set-env-vars` changes are not authoritative. A later `az containerapp update --yaml` can replace the container environment list with the checked-in specification. Persist runtime configuration by updating the workflow and `.github/containerapp.yaml`; this documentation-only runbook does not add missing secret wiring.

## Asset licensing

Git LFS checkout includes Fighter map GLBs and Fighter source FBX files in the build context and production image. `assets/CREDITS.md` states that Fighter asset source URLs, authors, and licenses are still unknown and must be verified before public redistribution. Do not treat successful LFS checkout as proof of redistribution rights.

The asset credits also identify `assets/maps/drift_race_track_free.glb` as CC-BY-ND 4.0. Distribute only an unmodified work and preserve required attribution. Review [assets/CREDITS.md](../assets/CREDITS.md) before every public or commercial deployment.

## Operational rollback

Every build pushes an immutable commit-SHA tag. Follow the zero-overlap procedure in [Deployment rollback](./DEPLOYMENT.md#rollback); do not run a direct image update while the old revision is active. A later normal deployment reapplies the full YAML and the current commit image. Validate persistent-file compatibility before rolling back application code.
