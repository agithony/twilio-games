# Deployment

Voice Racer, Voice Monsters, and Voice Fighter ship to **Azure Container Apps (ACA)** as a
single-process container, gated behind CI.
This doc explains how the pipeline works (for app devs). For the one-time cloud/secrets setup, see
[INFRA_SETUP.md](./INFRA_SETUP.md).

## TL;DR

Push to `main` → CI runs (typecheck + tests + client build) → on green, the image builds in ACR and
rolls out to the Container App → `/healthz` is smoke-tested → the app URL is printed. Manual
redeploy/rollback: **Actions → Deploy to Azure Container Apps → Run workflow**.

## Why one container, one replica

In dev the app is two processes: Vite serves the client (`:5173`) and the Node server serves the
API + GLB assets + WebSockets (`:8080`). In production it's **one process**: the Node server serves
the Vite-built client too (`server/http-server.ts` → `serveClient`/`serveAsset` + `/healthz`).

It runs at **exactly one replica** (`containerapp.yaml` → `minReplicas: 1, maxReplicas: 1`). This is
a correctness requirement, not a perf knob: room/lobby/race state and the SMS-concierge sessions are
**in-memory in this one process**, and the game/voice WebSockets are long-lived to it. A second
replica would let a player and the shared display connect to different instances and never share a
race. Scaling out would require moving room state to shared storage (e.g. Redis) + a pub/sub layer —
a real re-architecture.

## The pipeline (`.github/workflows/deploy.yml`)

1. **`ci`** — calls `.github/workflows/ci.yml` (the `Validate` job: typecheck, vitest, client
   build). The whole deploy gates on it: red CI ⇒ no build, no deploy. No `secrets: inherit`.
2. **`build-and-deploy`** (`needs: ci`, `if: success`):
   - `azure/login@v3` with `AZURE_CREDENTIALS`.
   - **Idempotent infra**: create-if-missing the resource group, ACR, storage account, file share,
     Container Apps environment, and the Azure Files storage mount. Safe to run every deploy.
   - **`az acr build`** — builds the image in the cloud (no local Docker), tagged `:<sha>` + `:latest`.
   - **Deploy** — render `containerapp.yaml` via `envsubst` (image, app name, `BASE_URL`), then
     `az containerapp create`/`update`. A brand-new app is patched a second time once its FQDN
     exists so `PUBLIC_BASE_URL` is correct for Twilio webhooks.
   - **`/healthz` smoke** — poll the live FQDN up to 30× (5 min) for a 200; the job fails loudly if
     the new revision never comes up healthy.

## Image + runtime

- `Dockerfile`: `node:20-bookworm-slim`, `npm ci --include=dev` (the build needs vite+typescript;
  the server runs on `tsx`), `npm run build` (client → `client/dist`), `tini` as PID-1.
- `scripts/start.sh`: symlinks `/app/data` → the Azure Files mount (`DATA_MOUNT=/app/appdata`) so the
  leaderboard persists, then `exec npx tsx server/index.ts`.
- Served on port `8080`: the client pages (`/`, `/play.html`, `/fighter`, `/editor`, `/garage`), the API
  (`/api/*`), GLB models + JS bundles (`/assets/*`), `/brand` + `/fonts`, the game/voice WebSockets
  (`/game`, `/battle`, `/fighter`, `/voice`), the Twilio webhooks (`/voice/*`, `/sms`), and
  `/healthz`. `/fighter` is both the Fighter HTTP page and, for an HTTP Upgrade request, its realtime
  game WebSocket endpoint.

## Persistence

The Azure Files mount backs `/app/data`. The global leaderboard, live racer level configuration,
Voice Monsters arena configuration, Fighter map catalog, and Fighter-generated previews survive
restarts and redeploys there. Racer, arena, and Fighter map config are
seeded once from bundled defaults when their persistent copies do not exist; a later deploy does not
overwrite an existing persistent copy.

Runtime models, Fighter FBX animations, previews, and map GLBs are bundled under `/app/assets` in the
immutable image and update only with a new image. Raw authoring files under `assets/_raw`,
`assets/maps/_raw`, and `assets/fighters/maps/_raw` are excluded from the Docker context and image.

### Fighter editor behavior

The Fighter map editor is available from `/editor`. It lists only bundled GLBs in
`assets/fighters/maps`, edits the complete Fighter map catalog, and can capture map-card previews.
Set `EDITOR_TOKEN` on public deployments: map and preview writes require that token when configured.
The live catalog is stored at `data/fighter-maps.json`, seeded from the bundled catalog, and generated
previews are stored under `data/fighter-previews/`. Set `FIGHTER_DISPLAY_TOKEN` and open the kiosk URL
with `?displayToken=...` to require host authentication. Set `VOICE_RELAY_TOKEN` to authenticate
Conversation Relay WebSocket setup frames (the TwiML webhook passes it to Twilio automatically).
Runtime GLBs remain image-owned; do not place a required GLB only in an `_raw` directory.

## Rollback

Redeploy an older SHA tag — see INFRA_SETUP.md → Rollback.

## Local production check (no Docker needed)

You can exercise the exact single-process serving locally:

```bash
npm run build                 # build the client → client/dist
PORT=8099 npx tsx server/index.ts
# then: curl localhost:8099/healthz , open http://localhost:8099/
```
