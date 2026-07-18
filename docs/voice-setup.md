# Voice Setup

This guide configures one Twilio number for Voice Racer, Voice Monsters, and Voice Fighter. For the project overview and general development setup, see the [README](../README.md).

## How Calls Are Routed

Configure the Twilio number's incoming voice webhook as:

| Setting | Value |
|---|---|
| Handler | Webhook |
| URL | `https://<public-host>/voice/incoming` |
| Method | `POST` |

`POST /voice/incoming` connects the call directly to Conversation Relay. It does not gather a room code. The call, shared display, and browser players use the single default room `4821`.

One number serves all three games. Before returning TwiML, the server selects the game whose shared-display WebSocket was opened most recently among the displays that are still connected:

| Display | Local URL | WebSocket |
|---|---|---|
| Voice Racer | `http://localhost:5173/play.html?display=1&room=4821` | `/game` |
| Voice Monsters | `http://localhost:5173/monsters.html?display=1&room=4821` | `/battle` |
| Voice Fighter | `http://localhost:5173/fighter.html?display=1&room=4821` | `/fighter` |

Open the intended display before placing the call. Close unused game displays to make routing unambiguous. If no display is connected, the call routes to Voice Racer.

The selected game is passed to `/voice` as a Conversation Relay custom parameter and remains fixed for that call. `POST /voice/join` is a legacy alias: it uses a posted `Digits` value when present and otherwise uses `4821`. Do not configure new numbers to use `/voice/join`.

When Conversation Relay ends a session, Twilio calls `POST /voice/session-ended`. The server uses the call SID to clean up Voice Monsters and Voice Fighter reconnect state.

## Requirements

- Node.js 20 or later
- A Twilio account and a voice-capable Twilio number
- The account Auth Token for webhook signature validation
- A public HTTPS URL that forwards to the server on port `8080`
- A public WebSocket path on the same host; the server derives `wss://<public-host>/voice` from `PUBLIC_BASE_URL`

The application does not read the Twilio Account SID. It also does not read `TWILIO_PHONE_NUMBER`; use `GAME_PHONE_NUMBER` to show the callable number and QR code in the UI.

## Run Locally With a Public Tunnel

Install dependencies and start the server:

```bash
npm install

PUBLIC_BASE_URL=https://<public-host> \
TWILIO_AUTH_TOKEN=<auth-token> \
GAME_PHONE_NUMBER=<e164-number> \
PORT=8080 \
npm run dev:server
```

Start the client in another terminal:

```bash
npm run dev:client
```

Expose port `8080` through one public HTTPS tunnel. Examples:

```bash
# Cloudflare quick tunnel
cloudflared tunnel --url http://localhost:8080

# ngrok
ngrok http 8080
```

VS Code public port forwarding also works. Forward port `8080`, set its visibility to public, and use its HTTPS URL as `PUBLIC_BASE_URL`. Do not tunnel the Vite port. Twilio must reach the Node server, which owns the webhooks and `/voice` WebSocket.

If the tunnel URL changes, update `PUBLIC_BASE_URL`, restart the server, and update the Twilio webhook. Twilio signs the exact public webhook URL, so the configured URL and `PUBLIC_BASE_URL` must match, including the scheme and host.

For a deployed environment, configure the same `POST /voice/incoming` webhook against the deployed host. See [Infrastructure Setup](INFRA_SETUP.md) and [Deployment](DEPLOYMENT.md).

## Environment Variables

| Variable | Required | Behavior |
|---|---|---|
| `PUBLIC_BASE_URL` | Yes for live calls | Public origin used to build webhook validation URLs, `wss://.../voice`, and `/voice/session-ended`. Defaults to local HTTP and is not usable by Twilio. A trailing slash is removed. |
| `TWILIO_AUTH_TOKEN` | Yes for a public Twilio webhook | Validates Twilio signatures. When present, validation is enabled by default. It is also the default Conversation Relay setup token. |
| `TWILIO_VALIDATE_SIGNATURES` | No | Set to `false` only for controlled local testing. Any other supplied value enables validation. If validation is enabled without `TWILIO_AUTH_TOKEN`, webhooks return `500`. |
| `GAME_PHONE_NUMBER` | Recommended | Number displayed and QR-encoded by the lobby. Use E.164 format, for example `+15551234567`. It does not affect call handling. |
| `PORT` | No | HTTP and WebSocket port. Defaults to `8080`. |
| `CR_TTS_VOICE` | No | ElevenLabs voice ID for Conversation Relay talk-back. If unset, Relay uses its default voice. |
| `CR_TTS_VOICE_PT_BR` | No | Optional Brazilian Portuguese ElevenLabs voice ID. Empty uses Relay's `pt-BR` default. |
| `DEFAULT_LOCALE` | No | Call locale used when no localized display is connected. Defaults to `en-US`. |
| `VOICE_RELAY_TOKEN` | Recommended for public deployments | Authenticates the Conversation Relay `setup` frame. Defaults to `TWILIO_AUTH_TOKEN`. The generated TwiML passes it to Twilio automatically. |
| `OPENAI_API_KEY` | No | Enables conversational menu help for Voice Racer and Voice Monsters. Deterministic selection and gameplay still work without it. |
| `OPENAI_MODEL` | No | Overrides the OpenAI model when `OPENAI_API_KEY` is set. |
| `FIGHTER_DISPLAY_TOKEN` | No | Requires the Voice Fighter display to provide `?displayToken=<token>` or `?hostToken=<token>` for host controls. |
| `NODE_ENV` | No | Production mode enables production-only warnings and serving behavior. It does not control Twilio signature validation. |

`EDITOR_TOKEN`, map paths, arena paths, and persistence paths affect editing and deployment but are not required to place a voice call.

## Conversation Relay Configuration

The generated TwiML uses these settings:

| Option | Value | Effect |
|---|---|---|
| `transcriptionProvider` | `Deepgram` | Required transcription provider |
| `speechModel` | `flux` | Low-latency speech recognition |
| `partialPrompts` | `true` | Sends interim transcripts for low-latency controls |
| `transcriptionLanguage` | Active display locale (`en-US` or `pt-BR`) | Recognition language |
| `ttsLanguage` | Active display locale (`en-US` or `pt-BR`) | Spoken response language |
| `interruptible` | `speech` | Caller speech stops active TTS |
| `reportInputDuringAgentSpeech` | `speech` | Delivers caller speech while TTS is playing |
| `interruptSensitivity` | `medium` | Balances command barge-in against room noise |
| `ignoreBackchannel` | `true` | Reduces interruption from short acknowledgements |
| `dtmfDetection` | `true` | Enables keypad events |
| `speechTimeout` | `600` | End-of-speech timeout used by Relay |
| `eotThreshold` | `0.6` | End-of-turn threshold |

The server supplies localized, game-specific recognition hints. It leaves `welcomeGreeting` empty because each game speaks its own onboarding after the `/voice` WebSocket receives the `setup` frame. See [Localization](localization.md) for locale routing and extension details.

Talk-back is active. The server sends `{ "type": "text", "token": "...", "last": true }` messages for onboarding, menu guidance, countdowns, events, and results. It spaces queued lines by at least 420 ms. A new prompt or interrupt clears unsent talk-back so old instructions do not play over the caller.

Speech barge-in stops Relay TTS. Voice Racer and Voice Monsters also invalidate stale in-flight conversational replies. Voice Fighter resets its interim-command state after an interrupt so a corrected command or selection can be recognized cleanly.

## Voice Racer

Voice Racer supports up to eight players in room `4821`.

The voice flow is:

1. Say your name.
2. Say `start` to open car selection.
3. Say a car name or its number.
4. Say `next` to open track selection.
5. Say a track name or its number.
6. Say `start`, `go`, `race`, or another advance phrase to begin.

Car and track selection has a deterministic name/number path and does not require OpenAI. A caller cannot advance from car selection without choosing a car or start from track selection without choosing a track.

During countdown and racing, interim transcripts use the fast local intent path. Accumulating partials are deduplicated, appended commands can fire in order, and an ASR correction can issue the corrected command.

| Action | Speech |
|---|---|
| Move left | `left` |
| Move right | `right` |
| Boost | `boost`, `go` |
| Brake | `brake`, `slow`, `stop` |
| Use power | `nitro`, `power` |

Keypad fallback is `1` left, `2` boost, `3` right, `4` brake, and `5` power. The keypad mapping applies only to Voice Racer.

The caller hears onboarding, menu prompts, the final countdown, `Go`, selected race events, their finish, and a race-over recap. Mid-race commentary is throttled so it does not continuously cover commands. A full room leaves the call connected but unbound, so commands do not move a car; check the server log for `addPlayer rejected`.

## Voice Monsters

Voice Monsters is a one-on-one room with up to two human callers. A solo player receives an AI opponent when the battle starts. A late caller can wait for the next round when a battle is already active. If both slots are occupied, the caller hears that the battle is full or in progress.

The voice flow is:

1. Say your name.
2. Say `start` to open monster selection.
3. Say a monster name, number, or ordinal such as `the second one`.
4. Say `battle` or `fight` after the required picks are complete.
5. On your turn, say `fight` to hear the four moves, then say a move name or number. A move name can also be spoken directly from the root menu.
6. Say `rematch` after the final result is ready.

Root battle commands are:

| Action | Speech | Root number |
|---|---|---|
| Open moves | `fight`, `attack` | `1` |
| Guard | `guard`, `block`, `brace`, `defend`, `shield` | `2` |
| Use potion | `item`, `potion`, `heal`, `bag`, `medicine` | `3` |
| Taunt | `taunt`, `mock`, `provoke`, `jeer`, `insult` | `4` |
| Leave move list | `back`, `cancel`, `return`, `never mind`, `undo` | Not applicable |

Inside the move list, numbers `1` through `4` choose the corresponding move. Move names support exact and distinctive partial matches. Battle actions use final transcripts only, are accepted only on the caller's turn, and are held while prior move commentary is still resolving. Commentary is paced with the display.

A Conversation Relay reconnect with the same call SID resumes the existing player for 30 seconds instead of repeating onboarding. A normal session-ended callback removes the binding immediately.

## Voice Fighter

Voice Fighter accepts up to two humans during the lobby or fighter-selection phase. A solo player receives an AI rival. New callers cannot join after setup has moved beyond fighter selection. Player one controls shared setup transitions and arena selection; player two chooses a fighter and waits for player one to advance.

The voice flow is:

1. Say your name.
2. Player one says `start` to open fighter selection.
3. Each player says a fighter name or number.
4. Player one says `next` and chooses an arena by name or number.
5. Player one says `fight` to load the arena and start the intro and countdown.
6. After the fight and victory sequence, player one says `rematch`.

Combat commands are:

| Action | Speech |
|---|---|
| Move toward rival | `forward`, `closer`, `in` |
| Move away | `back`, `backward`, `away` |
| Jump | `jump`, `leap`, `hop` |
| Punch | `punch`, `jab`, `strike`, `hit` |
| Kick | `kick`, `roundhouse` |
| Block | `block`, `guard`, `defend` |

Fighter and arena choices can apply from a recognized interim transcript; the matching final transcript is not applied twice. During combat, the server waits for two matching interim frames before firing one low-latency command. Final transcripts can contain a chain such as `forward then block` or a repeat such as `punch five times`; command bursts are capped at six actions.

A Voice Fighter reconnect with the same call SID resumes the existing player for 30 seconds. Hit and miss cues are throttled, and the phone host narrates the intro, countdown, health context, and result.

## Test Without Twilio

Run the voice-focused unit and integration tests:

```bash
npm test -- voice-intent battle-intent fighter-intent twiml conversation-relay battle-voice fighter-voice voice-integration
```

The integration tests open fake Conversation Relay WebSockets and verify room binding, Racer selection, spoken controls, and Voice Monsters and Voice Fighter reconnection. They do not test Twilio account configuration, public networking, real transcription, TTS quality, or carrier latency.

## Troubleshooting

### The call reaches the wrong game

Open the intended shared display before dialing. Close stale display tabs. Routing uses the most recently opened WebSocket among displays that remain connected, not the most recently focused browser tab. With no connected display, routing defaults to Voice Racer.

### The webhook returns `403 invalid signature`

Confirm that the Twilio Console webhook URL exactly matches `${PUBLIC_BASE_URL}/voice/incoming`. Restart the server after changing `PUBLIC_BASE_URL`. Confirm `TWILIO_AUTH_TOKEN` belongs to the Twilio account making the request. Reverse proxies must preserve the public scheme and host represented by `PUBLIC_BASE_URL`.

### The webhook returns `500` about the Auth Token

Signature validation is enabled while `TWILIO_AUTH_TOKEN` is empty. Set the token. Use `TWILIO_VALIDATE_SIGNATURES=false` only for a controlled request that is not coming from Twilio.

### The call connects but no game responds

Confirm the public host supports WebSocket upgrades at `/voice` and that the generated URL uses `wss://`. Check for `unauthorized relay` in the server log; `VOICE_RELAY_TOKEN` must remain stable between the webhook response and the Relay setup frame. Also confirm the display and call both use room `4821`.

### The caller hears the right game but cannot join

Voice Racer may already have eight players. Voice Monsters may have two occupied slots. Voice Fighter may have two players or may already be past fighter selection. End stale calls or reset the shared display before retrying.

### Speech works only after the caller finishes talking

Confirm the returned TwiML contains `partialPrompts="true"`, `speechModel="flux"`, and `transcriptionProvider="Deepgram"`. Voice Monsters intentionally acts only on final transcripts. Voice Racer uses partials during countdown and racing. Voice Fighter uses partials for selection and requires two matching interim command frames during combat.

### Barge-in does not stop the host

Inspect the returned TwiML for `interruptible="speech"` and `reportInputDuringAgentSpeech="speech"`. Relay should send an `interrupt` frame when speech cuts off TTS. Background noise may not interrupt because sensitivity is `medium` and backchannels are ignored.

### Menus are quiet without an OpenAI key

Voice Racer and Voice Monsters keep deterministic name, number, advance, and gameplay paths without OpenAI. Open-ended questions and conversational recommendations require `OPENAI_API_KEY`. Voice Fighter does not use the OpenAI host.

### The displayed phone number is missing

Set `GAME_PHONE_NUMBER` and restart the server. `TWILIO_PHONE_NUMBER` is not read. The value is exposed through `/api/config` for display and QR rendering only.

Return to the [README](../README.md) for architecture, general scripts, and the rest of the project documentation.
