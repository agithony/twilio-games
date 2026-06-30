<div align="center">

# 🏎️ Twilio Games — Voice Racer

**Voice-controlled, multiplayer party games for live events — powered by Twilio.**

Up to 8 players control real 3D cars on one shared screen by *calling in and speaking* —
"left!", "right!", "boost!" — while an AI host calls the race live.

![status](https://img.shields.io/badge/status-playable-EF223A)
![tests](https://img.shields.io/badge/tests-119_passing-EF223A)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![Twilio](https://img.shields.io/badge/Twilio-Conversation_Relay-F22F46)
![license](https://img.shields.io/badge/license-private-657)

</div>

---

## What this is

A platform of voice-controlled games designed to **showcase Twilio products at IRL events**.
The first (and current) game is **Voice Racer**: a lane-based "dodge-and-grab" race. Cars
auto-drive forward; players steer between lanes by voice to dodge red barriers and grab green
boost pads. First across the line wins.

The headline trick is the control scheme: players don't use a gamepad — each player is on a
**phone call**, and their spoken commands become car movements. The game is deliberately
designed to be *latency-tolerant* (lanes, not fine steering; hazards visible ahead) so it feels
good even with real voice round-trip delay.

> **Why voice + lanes?** A spoken "left" takes ~250ms–1s to land. That's hopeless for
> frame-by-frame steering but perfect for *intentions* ("move to the inside lane", "boost
> now"). The whole game is built around that constraint — see `docs/superpowers/specs/`.

## Architecture

Three cleanly separated layers, connected by an abstract **intent** seam
(`MOVE_LEFT`, `MOVE_RIGHT`, `BOOST`, `BRAKE`, `USE_POWER`). The game consumes intents and never
knows their source — keyboard, or Twilio voice, are just adapters.

```mermaid
flowchart TB
  subgraph Display["🖥️ Shared Display (browser, three.js)"]
    home["Home / lobby<br/>(game select + join)"]
    racer["Racer renderer<br/>(real GLB models, themed zones)"]
    host["AI announcer<br/>(Web Speech + ticker)"]
    editor["Model studio<br/>(/editor)"]
  end
  subgraph Server["⚙️ Game Server (Node, authoritative)"]
    world["RaceWorld sim<br/>(fixed-timestep, deterministic)"]
    rooms["Rooms + RoomManager"]
    httpd["HTTP + WebSocket<br/>(/game, /voice, /api, /assets)"]
  end
  subgraph Voice["📞 Voice Layer (Twilio)"]
    cr["Conversation Relay<br/>(built-in STT → intents)"]
  end

  phone["📱 Player phones"] -->|"dial + speak"| cr
  cr -->|"intents"| httpd
  Display <-->|"WebSocket: intents in,<br/>state snapshots out"| httpd
  world --> rooms --> httpd
```

- **`shared/`** — pure, deterministic game logic + the typed protocol. No I/O. Reused by server
  and client. (`race-world.ts`, `zones.ts`, `asset-manifest.ts`, `asset-fit.ts`, `types.ts`.)
- **`server/`** — authoritative simulation + transport. Owns the truth (fairness/anti-cheat,
  online-ready). (`game-server.ts`, `http-server.ts`, `room.ts`, `conversation-relay.ts`.)
- **`client/`** — the browser: home page, three.js renderer, asset loader, AI announcer, and the
  model editor. Renders server snapshots; sends intents.
- **`tools/`** — asset pipeline CLIs (inspect / optimize GLB models).

## Quick start

Requires **Node ≥ 20**.

```bash
npm install

# Terminal 1 — game server (WebSocket + asset/manifest API) on :8080
npm run dev:server

# Terminal 2 — client (Vite) on :5173
npm run dev:client
```

Then open **http://localhost:5173/** — the home page. It has just two ways in (plus the editor/garage):

| Role | URL | What it is |
|------|-----|------------|
| **Home** | `/` | Branded landing + game selection + launcher |
| **Shared screen** | `/play.html?display=1&room=4821` | The TV/projector: shows the room code, the live race, the scoreboard; driven by keyboard. Players join by calling/texting. **The primary way to run a session.** |
| **Play on this device** | `/play.html?room=4821&name=Ada` | Drive a car in this browser — a distributed online player, or keyboard testing. |
| **Level editor** | `/editor` | Author levels, set per-map preview shots |
| **Garage** | `/garage` | Arrange/scale/rotate the 3D car models, save to manifest |

The home page's two buttons — **Open shared screen** and **Play on this device** — just build those
URLs for you. Everyone (screen, phones, device players) shares one 4-digit room code.

**Play it (keyboard, no Twilio needed):** open the **shared screen** URL, press **Enter** to start,
then drive with **← →** (lanes), **↑** (boost), **↓** (brake). Open a **Play on this device** tab with
`?room=4821&name=Ada` before starting to add another car.

## Voice controls (Twilio)

Voice is wired via **Twilio Conversation Relay** (built-in speech-to-text — no second STT
vendor). The full live-call runbook (number config, public tunnel, env vars, latency tuning) is
in **[`docs/voice-setup.md`](docs/voice-setup.md)**. In short: players dial one Twilio number,
enter a 4-digit room code on the keypad, and speak to drive.

```
TWILIO_ACCOUNT_SID   TWILIO_AUTH_TOKEN   TWILIO_PHONE_NUMBER   PUBLIC_BASE_URL   NODE_ENV=production
```

## 3D assets

19 free **CC-BY** car models (from Sketchfab) drive the visuals, compressed from ~590 MB → ~35 MB
(Draco geometry + WebP textures). Attribution for every model is in
[`assets/CREDITS.md`](assets/CREDITS.md). The game falls back to primitive shapes for any role
without a model, so it always runs.

```bash
npm run inspect-assets   # scan assets/, report sizes + wheels, regen starter manifest
npm run optimize-assets  # compress raw GLBs (draco + webp)
```

Roles (which model is a car / barrier / boost pad) live in `assets/manifest.json` and are tuned
visually in the **model studio** (`/editor`).

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev:server` | Run the game server (watch mode) |
| `npm run dev:client` | Run the Vite client dev server |
| `npm run build` | Typecheck both projects + build all pages |
| `npm test` | Run the Vitest suite (119 tests) |
| `npm run typecheck` | Typecheck server + client |
| `npm run inspect-assets` / `optimize-assets` | Asset pipeline tools |

## Testing

```bash
npm test
```

The pure layers (`shared/`, asset + zone math, commentary, nav) are fully unit-tested offline;
the server has WebSocket integration tests; GL/browser code is verified by build + headless smoke.

## Deployment

Ships to **Azure Container Apps** as a single-process container (the Node server serves the
Vite-built client + API + WebSockets), gated behind CI. Push to `main` → CI → `az acr build` →
rollout → `/healthz` smoke.

- **How the pipeline works:** [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- **One-time cloud + secrets setup + Twilio webhook config:** [`docs/INFRA_SETUP.md`](docs/INFRA_SETUP.md)

Runs at a single replica by design — room/race state is in-memory in one process, so all players +
the shared display must hit the same instance.

## Roadmap

- [x] Core game engine (server-authoritative, keyboard-playable)
- [x] Voice controls via Twilio Conversation Relay *(live phone test pending)*
- [x] Real 3D models + compression pipeline + model studio editor
- [x] Themed atmosphere zones (neon → city → desert → night)
- [x] In-game AI announcer (Web Speech) + commentary ticker
- [x] Branded home / game-selection page
- [x] Persistent leaderboard + player history
- [x] Twilio SMS concierge (text to join, pick car + map)
- [x] Azure Container Apps deployment (Docker, CI-gated)
- [ ] More games (2D voice fighter, monster battler)

Design specs and implementation plans for each piece live in
[`docs/superpowers/`](docs/superpowers/).

---

<div align="center">
<sub>Built as a Twilio showcase · Voice · Conversation Relay · and more.</sub>
</div>
