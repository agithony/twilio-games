# Voice Setup

This guide configures the locale-specific Twilio numbers used by Voice Racer, Voice Monsters, and Voice Fighter. For the project overview and general development setup, see the [README](../README.md).

## How Calls Are Routed

Configure the Twilio number's incoming voice webhook as:

| Setting | Value |
|---|---|
| Handler | Webhook |
| URL | `https://<public-host>/voice/incoming` |
| Method | `POST` |

`POST /voice/incoming` connects an admitted active-event call directly to Conversation Relay. It does not gather a room code. When the event is paused, the server ignores retained station state and either routes an explicitly enabled standalone call or returns localized unavailable TwiML and hangs up.

In station mode, the server resolves the caller to one persisted admitted player and places the game, engine room, ready-entry ID, match ID, and launch generation in Relay custom parameters. These values are not signed claims. A dedicated `VOICE_RELAY_TOKEN` authenticates the Relay setup frame, and the server revalidates the call SID and every station parameter against the current call binding and persisted match before joining the room. Recent-display routing is used only for standalone Voice:

| Display | Local URL | WebSocket |
|---|---|---|
| Voice Racer | `http://localhost:5173/play.html?display=1&room=4821` | `/game` |
| Voice Monsters | `http://localhost:5173/monsters.html?display=1&room=4821` | `/battle` |
| Voice Fighter | `http://localhost:5173/fighter.html?display=1&room=4821` | `/fighter` |

Room `4821` is the standalone room only. Active station matches use generated 12-character engine room codes.

For standalone testing, open the intended shared display before placing the call and close unused game displays. An eligible display must belong to an operator-enabled game, connect as `display=1`, and remain open. Standalone display registration does not validate the station display token, so expose standalone routing only in a controlled deployment. If several eligible displays are open, the most recently registered one wins. If none is open, the call receives unavailable TwiML; it does not default to Voice Racer.

The selected game is passed to `/voice` as a Conversation Relay custom parameter and remains fixed for that call. `POST /voice/join` is a legacy alias: it uses a posted `Digits` value when present and otherwise uses `4821`. Do not configure new numbers to use `/voice/join`.

When Conversation Relay ends a session, Twilio calls `POST /voice/session-ended`. The server uses the call SID to recover or clean up all three games.

## Requirements

- Node.js 22.13 or later
- A primary Twilio account with the English Voice number, a separate SMS-capable number, and an approved WhatsApp sender required for preferred Portuguese Messaging entry; lead-capture mode retains a browser fallback
- A second Twilio account with the Portuguese Voice number
- Both account Auth Tokens for webhook signature validation
- A public HTTPS URL that forwards to the server on port `8080`
- A public WebSocket path on the same host; the server derives `wss://<public-host>/voice` from `PUBLIC_BASE_URL`

The direct Conversation Relay gameplay path does not use the Twilio Account SID itself. The production station also enables TAC/Memory and therefore requires the primary account REST credentials documented in [Infrastructure Setup](INFRA_SETUP.md). Voice webhook and session-ended signatures are accepted when either configured Voice account Auth Token validates the request; the exact dialed `To` number then selects `en-US` or `pt-BR`. The signing token does not select the locale. Station mode uses the operator-configured locale Voice numbers; `GAME_PHONE_NUMBER` is only a legacy fallback. `TWILIO_SMS_NUMBER` is the independent primary-account TAC/SMS sender.

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
| `TWILIO_AUTH_TOKEN` | Yes for a public Twilio webhook | Validates Twilio signatures. When present, validation is enabled by default. |
| `TWILIO_PT_AUTH_TOKEN` | Required for the current production topology | Validates Voice and session-ended callbacks from the separate Portuguese Voice account. |
| `TWILIO_VALIDATE_SIGNATURES` | No | Set to `false` only for controlled local testing. Any other supplied value enables validation. Without `TWILIO_AUTH_TOKEN`, primary-account Messaging, TAC, and status webhooks return `500`; Voice requests can still validate with `TWILIO_PT_AUTH_TOKEN`. |
| `GAME_PHONE_NUMBER` | Optional | Legacy lobby fallback until locale-specific voice numbers are saved in Arcade runtime settings. |
| `TWILIO_SMS_NUMBER` | Required by production deployment | SMS-capable sender/receiver registered with TAC and used by the join chooser and outbound notices. |
| `PORT` | No | HTTP and WebSocket port. Defaults to `8080`. |
| `CR_TTS_VOICE` | No | ElevenLabs voice ID for Conversation Relay talk-back. If unset, Relay uses its default voice. |
| `CR_TTS_VOICE_PT_BR` | No | Optional Brazilian Portuguese ElevenLabs voice ID. Empty uses Relay's `pt-BR` default. |
| `DEFAULT_LOCALE` | No | Fallback when the dialed `To` number does not identify one locale and the selected display does not provide one. Defaults to `en-US`. |
| `ARCADE_STANDALONE_VOICE_ENABLED` | No | Set to `true` to permit standalone routing to an eligible open shared display. It does not make a game callable without a display. Production sets this to `true`. |
| `VOICE_RELAY_TOKEN` | Required by production deployment | Independent token of at least 32 characters that authenticates the Conversation Relay `setup` frame. The generated TwiML passes it to Twilio automatically; do not reuse `TWILIO_AUTH_TOKEN`. |
| `OPENAI_API_KEY` | No | Enables English free-form menu help for Voice Racer and Voice Monsters. Portuguese free-form OpenAI replies are disabled; deterministic localized setup and gameplay remain available. |
| `OPENAI_MODEL` | No | Overrides the OpenAI model when `OPENAI_API_KEY` is set. |
| `FIGHTER_DISPLAY_TOKEN` | No | Server-side standalone override for custom Fighter integrations. Browser URLs do not accept display credentials; station booth access is installed through `/operator`. |
| `NODE_ENV` | No | `production` enables signature validation by default when `TWILIO_VALIDATE_SIGNATURES` is unset, along with production-only warnings and serving behavior. |

`EDITOR_TOKEN`, map paths, arena paths, and persistence paths affect editing and deployment but are not required to place a voice call.

## Conversation Relay Configuration

The generated TwiML uses these settings:

| Option | Value | Effect |
|---|---|---|
| `transcriptionProvider` | `Deepgram` | Required transcription provider |
| `speechModel` | `flux` | Low-latency speech recognition |
| `partialPrompts` | `true` | Sends interim transcripts so a newer utterance can cancel stale work; gameplay waits for the final transcript |
| `transcriptionLanguage` | Resolved call locale (`en-US` or `pt-BR`) | Recognition language selected from the dialed number, then display or default fallback |
| `ttsLanguage` | Resolved call locale (`en-US` or `pt-BR`) | Spoken response language selected by the same route |
| `interruptible` | `any` | Caller speech or keypad input stops active TTS |
| `reportInputDuringAgentSpeech` | `any` | Delivers speech and keypad input while TTS is playing |
| `interruptSensitivity` | `medium` | Balances command barge-in against room noise |
| `ignoreBackchannel` | `true` | Reduces interruption from short acknowledgements |
| `dtmfDetection` | `true` | Enables keypad events |
| `speechTimeout` | `600` | End-of-speech timeout used by Relay |
| `eotThreshold` | `0.6` | End-of-turn threshold |

The server supplies localized, game-specific recognition hints. It leaves `welcomeGreeting` empty because each game speaks its own onboarding after the `/voice` WebSocket receives the `setup` frame. See [Localization](localization.md) for locale routing and extension details.

Talk-back is active. The server sends `{ "type": "text", "token": "...", "last": true }` messages for onboarding, menu guidance, countdowns, events, and results. It waits for Relay's `tokensPlayed` acknowledgement before sending the next line. A new prompt or interrupt clears unsent talk-back so old instructions do not play over the caller.

Speech barge-in stops Relay TTS. Voice Racer and Voice Monsters also invalidate stale in-flight conversational replies. Voice Fighter resets its interim-command state after an interrupt so a corrected command or selection can be recognized cleanly.

## Station Launch And Personal Setup

Station games admit up to two callers. The persisted match roster supplies an expected caller count of one or two and a stable slot for each caller. The server reuses each registered first name instead of asking for it again; only a station identity without a stored completed name falls back to voice name capture.

Each caller controls only their personal setup choices. Racer and Fighter keep explicit shared phase gates: after all expected callers connect, either caller advances into vehicle or fighter selection; after every caller makes that choice, either says `next`; after every caller casts a track or arena vote, either says `start`. Monsters advances from monster choices automatically. A one-caller Monsters or Fighter match creates an AI opponent after that caller finishes setup; solo Racer and Fighter follow the same explicit gates with one caller.

A station match starts only when the display has acknowledged the current launch generation, the selected engine has started, and every expected caller is connected and bound. The launch timeout is also the setup inactivity window. After all expected callers connect, each final speech prompt or DTMF input from either caller moves that deadline forward by the configured launch timeout; partial transcripts do not. Activity extends setup but does not mark gameplay started or redeem a coin.

At the deadline, a disconnected admitted caller is replaced by the first FIFO overflow caller when one exists. The dropped caller's active reservation is released, the replacement receives admitted and call-now notices, the launch generation increments, display readiness clears, and the game room receives the revised expected count. If no overflow caller exists, the automatic deadline fails the launch. Before gameplay, an operator can instead remove an unconnected caller; the same FIFO promotion applies, or the expected count drops to one when no replacement exists. That one-caller reconciliation enables the solo behavior above.

## Connection Recovery

All three games retain the call SID-to-player binding for 30 seconds after a Relay WebSocket disconnect. A replacement WebSocket for the same call SID and room resumes that player and preserves completed personal choices; a normal session-ended callback removes the binding immediately, subject to retaining completed station result state.

This 30-second binding grace is separate from Relay session recovery. When `SessionStatus=failed`, the call remains `in-progress`, and the error is absent or recoverable (`39001`, `64103`, `64105`, `64111`, or `64112`), `/voice/session-ended` can return new Conversation Relay TwiML up to two times. Station recovery refreshes the route when possible and still revalidates the setup against current state. A permanent error, a completed call, or an exhausted recovery count hangs up and clears the bindings.

## Voice Racer

Voice Racer supports up to two callers. Standalone play uses room `4821`; station play uses its generated engine room.

The voice flow is:

1. In standalone play, say your name. Station play greets you by your registered first name.
2. After the expected callers connect, either player says `start` to open car selection.
3. Each player says their own car name or number.
4. After every player picks a car, either player says `next` to open track voting.
5. Each player says their own track name or number. To correct a car or change a vote before advancing, say `actually` followed by the new choice (`na verdade` in Portuguese).
6. After every player votes, either player says `start` to begin the race.

Car and track selection is deterministic and never uses OpenAI. Station Racer prompts callers one at a time in participant order, while either connected caller may speak the phase-advance command after all required choices are complete. Unrecognized setup speech receives concise guidance for the current screen. No caller controls another player's choice. Near-simultaneous identical choices from different calls are treated as likely acoustic cross-talk and the second caller is asked to repeat. Interim-origin tracking, duplicate-final suppression, and a post-transition guard reduce the chance that delayed speech from an earlier phase is interpreted in the next phase; physically shared audio remains an operational risk and callers should avoid speakerphone near each other.

During countdown and racing, finalized transcripts use the fast local intent path. Command bursts can fire in order, while revisable interim hypotheses never mutate the car.

Racer simulates at 60Hz, sends display snapshots at 30Hz, and renders with a 100ms interpolation buffer. Lane changes remain smooth rather than snapping and reach roughly 90% of the new lane in 167ms.

| Action | Speech |
|---|---|
| Move left | `left` |
| Move right | `right` |
| Boost | `boost`, `go` |
| Brake | `brake`, `slow`, `stop` |
| Use power | `nitro`, `power` |

Racer keypad fallback is `1` left, `2` boost, `3` right, `4` brake, and `5` power. Monsters uses its displayed menu numbers and `0` to back out of the move list. Fighter uses `0` for fighter 10, `*` for fighter 11, and `#` for fighter 12; during combat, `1` through `6` map to forward, back, jump, punch, kick, and block.

The caller hears onboarding, menu prompts, the final countdown, `Go`, selected race events, their finish, and a race-over recap. Mid-race commentary is throttled so it does not continuously cover commands. A full standalone room leaves the call connected but unbound, so commands do not move a car; check the server log for `addPlayer rejected`.

## Voice Monsters

Voice Monsters is a one-on-one room with up to two human callers. A solo player receives an AI opponent when the battle starts. A late caller can wait for the next round when a battle is already active. If both slots are occupied, the caller hears that the battle is full or in progress.

The voice flow is:

1. In standalone play, say your name. Station play greets you by your registered first name.
2. Monster selection opens automatically when the expected callers are ready.
3. Each player says their own monster name, number, or ordinal such as `the second one`.
4. The battle begins automatically after every player picks.
5. On your turn, say `fight` to hear the four moves, then say a move name or number. A move name can also be spoken directly from the root menu.
6. In standalone play, say `rematch` after the final result is ready. Station play returns to the station results and requeue flow instead.

Root battle commands are:

| Action | Speech | Root number |
|---|---|---|
| Open moves | `fight` (canonical), `attack` (accepted alias) | `1` |
| Guard | `guard`, `block`, `brace`, `defend`, `shield` | `2` |
| Use potion | `item`, `potion`, `heal`, `bag`, `medicine` | `3` |
| Taunt | `taunt`, `mock`, `provoke`, `jeer`, `insult` | `4` |
| Leave move list | `back`, `cancel`, `return`, `never mind`, `undo` | Not applicable |

Inside the move list, numbers `1` through `4` choose the corresponding move. Move names support exact and distinctive partial matches. Battle actions use final transcripts only, are accepted only on the caller's turn, and are held while prior move commentary is still resolving. Commentary is paced with the display.

The common 30-second caller binding and up-to-two Relay recovery attempts apply to Monsters.

## Voice Fighter

Voice Fighter accepts up to two humans during the lobby or fighter-selection phase. A solo player receives an AI rival. New callers cannot join after setup has moved beyond fighter selection. Each caller owns their fighter choice and arena vote, and every setup screen requires an explicit voice command before advancing.

The voice flow is:

1. In standalone play, say your name. Station play greets you by your registered first name.
2. Listen to the controls and how-to-play instructions while the display remains in the lobby.
3. After the expected callers are ready, either player says `next` to open fighter selection.
4. Each player says their own fighter name or number.
5. After every player chooses, either player says `next` to open arena voting.
6. Each player says their own arena name or number, then either player says `start` after every vote is in.
7. The selected arena loads, then starts the intro and countdown.
8. In standalone play, say `rematch` after the fight and result sequence. The caller hears whether they were victorious or lost. Station play returns to the station results and requeue flow instead.

Combat commands are:

| Action | Speech |
|---|---|
| Move toward rival | `forward`, `closer`, `in` |
| Move away | `back`, `backward`, `away` |
| Jump | `jump`, `leap`, `hop` |
| Punch | `punch`, `jab`, `strike`, `hit` |
| Kick | `kick`, `roundhouse` |
| Block | `block`, `guard`, `defend` |

Fighter and arena choices and combat commands act only on finalized transcripts, preventing revised interim speech from firing the wrong move. The parser recognizes chains and repeat phrases, but the room executes one action immediately and retains at most two waiting actions. Waiting commands expire after 2.25 seconds so stale moves cannot fire much later.

Combat locks remain long enough for readable animation, but punch, kick, block, jump, and hit reactions use shorter synchronized timings. Forward and back retain their measured animation durations so movement distance and presentation stay aligned.

The common 30-second caller binding and up-to-two Relay recovery attempts apply to Fighter. Hit and miss cues are throttled, and the phone host narrates the intro, countdown, health context, and result.

## Test Without Twilio

Run the voice-focused unit and integration tests:

```bash
npm test -- voice-intent battle-intent fighter-intent twiml conversation-relay battle-voice fighter-voice voice-integration
```

The integration tests open fake Conversation Relay WebSockets and verify room binding, Racer selection, spoken controls, and Voice Monsters and Voice Fighter reconnection. They do not test Twilio account configuration, public networking, real transcription, TTS quality, or carrier latency.

## Troubleshooting

### The call reaches the wrong game

For standalone testing, open the intended shared display before dialing and close stale display tabs. For station testing, join through `/join`, reach `ADMITTED`, request launch, and call the locale-specific number; persisted admission overrides display recency.

### The webhook returns `403 invalid signature`

Confirm that the Twilio Console webhook URL exactly matches `${PUBLIC_BASE_URL}/voice/incoming`. Restart the server after changing `PUBLIC_BASE_URL`. Confirm either `TWILIO_AUTH_TOKEN` or `TWILIO_PT_AUTH_TOKEN` belongs to the Twilio account making the request. Reverse proxies must preserve the public scheme and host represented by `PUBLIC_BASE_URL`.

### The webhook returns `500` about the Auth Token

Signature validation is enabled while `TWILIO_AUTH_TOKEN` is empty. Set the primary token for SMS, WhatsApp, TAC, and messaging-status callbacks. Voice requests may validate with `TWILIO_PT_AUTH_TOKEN`, but production still requires the primary token. Use `TWILIO_VALIDATE_SIGNATURES=false` only for a controlled request that is not coming from Twilio.

### The call connects but no game responds

Confirm the public host supports WebSocket upgrades at `/voice` and that the generated URL uses `wss://`. Check for `unauthorized relay` in the server log; `VOICE_RELAY_TOKEN` must remain stable between the webhook response and the Relay setup frame. For standalone play, confirm the display uses room `4821`. For station play, confirm the display acknowledged the current generated room and launch generation.

### The caller hears the right game but cannot join

Voice Racer may already have two players. Voice Monsters may have two occupied slots. Voice Fighter may have two players or may already be past fighter selection. End stale calls or reset the shared display before retrying.

### Speech works only after the caller finishes talking

Confirm the returned TwiML contains `partialPrompts="true"`, `speechModel="flux"`, and `transcriptionProvider="Deepgram"`. All three games act only on finalized gameplay transcripts so revised interim speech cannot execute the wrong command.

### Barge-in does not stop the host

Inspect the returned TwiML for `interruptible="any"` and `reportInputDuringAgentSpeech="any"`. Relay should send an `interrupt` frame when speech or keypad input cuts off TTS. Background noise may not interrupt because sensitivity is `medium` and backchannels are ignored.

### Menus are quiet without an OpenAI key

Voice Racer and Voice Monsters keep deterministic name, number, advance, help, and gameplay paths without OpenAI. English open-ended questions and recommendations require `OPENAI_API_KEY`. Portuguese sessions never send free-form prompts or replies to OpenAI. Voice Fighter does not use the OpenAI host.

### The displayed phone number is missing

For standalone local testing, set `GAME_PHONE_NUMBER` and restart the server. For Twilio Games station events, save both locale voice numbers in the operator console instead; those values are exposed through `/api/config` and take precedence without a restart.

Return to the [README](../README.md) for architecture, general scripts, and the rest of the project documentation.
