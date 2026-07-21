# Twilio Arcade: One-Display Expo Station Plan

**Date:** 2026-07-21
**Status:** Approved for implementation
**Scope:** One shared display at one conference booth, one active game at a time
**Supersedes:** The station, queue-wave, game-selection, capacity, and QR journey in
`TWILIO_ARCADE_PLAN.md` where this document is more specific.

This is the durable product and implementation source of truth for the one-display expo flow. Future
sessions must read this document before changing Arcade station, round, QR, coin insertion,
messaging, game-selection, or display behavior.

## 1. Locked Decisions

| Area | Decision |
|---|---|
| Physical setup | One shared display, one persistent station, one active game at a time |
| Public terminology | Use **station**, **round**, **ready for next game**, and **coin inserted** |
| Hidden identifiers | Station ID and engine room IDs are internal and never shown to visitors |
| Persistent entry | One localized station QR remains discoverable before, during, and after games |
| Primary onboarding | SMS or WhatsApp through a mobile channel chooser |
| Fallback onboarding | Collapsed fast web form for visitors who cannot use Messaging |
| Coin ownership | Server-side wallet; never a transferable text code |
| Coin insertion | Player replies `COIN`; server reserves one coin for the station ready pool |
| Coin cost | One coin per human per game; AI never consumes coins |
| Grouping | FIFO individual ready pool for v1; no explicit party codes |
| Game selection | Ready pool locks first, then staff selects from the existing game cards |
| Manual control | Staff can advance early whenever at least one player is ready |
| Automatic control | Timers provide unattended fallback and hard throughput bounds |
| Overflow | Players beyond selected-game capacity keep reservation and FIFO priority for next game |
| Racer capacity | **Maximum 4 human players** |
| Monsters capacity | Maximum 2 human players; AI fills solo play |
| Fighter capacity | Maximum 2 human players; AI fills solo play |
| Trivia | Not selectable until a playable authoritative engine exists |
| Browser display voice | No browser `speechSynthesis`; caller audio remains Conversation Relay |
| Language | Display language flows into QR, chooser, messaging, wallet, queue, and Memory preference |
| Authority | Deterministic station/game services own state; TAC/LLM may converse but never mutate directly |

## 2. Visitor Mental Model

The booth behaves like one physical arcade machine:

1. Scan the station QR.
2. Choose SMS or WhatsApp.
3. Complete quick conversational registration.
4. Receive one wallet coin.
5. Reply `COIN` when ready to play.
6. Watch the display animate the inserted coin and add the player to the ready pool.
7. Staff selects a game after the pool locks.
8. Admitted players play; overflow stays first for the next game.

The confirmation message is not the coin. The wallet ledger is authoritative.

## 3. Display State Machine

```text
ATTRACT / RECRUITING
  no ready players: no timer
  first COIN: start 90-second recruiting deadline
  staff may advance early
  hard deadline: 120 seconds
          |
          v
GAME_SELECTION
  render the existing game-card visual
  show how many ready players each game can admit
  staff selects; 30-second fallback selects best-fit rotation game
          |
          v
LOCKED
  assign admitted players by FIFO and game capacity
  preserve overflow for next round
  10-second visible countdown
          |
          v
LAUNCHING
  request authoritative game display/lobby
  wait for display-ready acknowledgement
          |
          v
PLAYING
  redeem admitted reservations only after authoritative engine start
  compact QR rail accepts players for the next ready pool
          |
          v
RESULTS
  complete match from authoritative game result
  if next pool exists: 45-second final join window
  otherwise return to attract with no timer
```

Deadlines are persisted timestamps. In-memory timers are wakeups only. Restart processing must
immediately apply overdue transitions exactly once.

## 4. Timing Defaults

| Timer | Default | Starts when | Behavior |
|---|---:|---|---|
| Idle recruiting | None | No coins inserted | QR remains available indefinitely |
| Recruiting window | 90 seconds | First valid `COIN` while no game is active | Staff may advance early |
| Hard recruiting deadline | 120 seconds | First valid `COIN` | Cannot be extended indefinitely |
| Game selection fallback | 30 seconds | Recruiting closes | Auto-select best-fit playable game |
| Locked countdown | 10 seconds | Participants assigned | Launch preparation |
| Post-game join window | 45 seconds | Results with next-pool players | Staff may skip early |

Registration never starts a round timer. A visitor can take as long as needed to register; only
`COIN` means physically ready near the display.

## 5. Ready Pool and Capacity

Ready entries are ordered by `(originalReadyAt, id)`. The same order survives overflow, restart, and
temporary deferral.

At selection time, cards show capacity impact:

```text
5 ready

Voice Racer     4 play now, 1 remains first next
Voice Monsters  2 play now, 3 remain next
Voice Fighter   2 play now, 3 remain next
```

Selecting a game atomically divides the pool:

- First `capacity` eligible entries become admitted.
- Remaining entries become overflow with unchanged original priority.
- Admitted reservations are redeemed only on authoritative engine start.
- Overflow reservations remain active for the next game.
- Cancel, leave, or unrecoverable launch failure releases the affected reservation.

Friends are not explicitly grouped in v1. Players inserting coins together normally remain adjacent
under FIFO. Party codes are deferred until expo observation proves they are needed.

## 6. Persistent QR Layout

### 6.1 Attract and Recruiting

The root shared-display experience is one viewport with no vertical scrolling:

```text
┌──────────────────────────────────────┬─────────────────────┐
│ Rotating asymmetric gameplay mosaic │ SCAN TO PLAY        │
│ Racer / Monsters / Fighter           │ [large station QR]  │
│ Muted looping clips                  │ Choose channel      │
│ Ready-player animation               │ Register            │
│                                      │ Receive coin        │
│                                      │ Reply COIN          │
└──────────────────────────────────────┴─────────────────────┘
```

- Gameplay media: 65-70% width.
- QR/instructions/ready count: 30-35% width.
- Existing game cards are not changed visually; they become the `GAME_SELECTION` phase.

### 6.2 Active Gameplay

Games reserve a fixed 220-260px right rail on a 1080p display:

```text
┌────────────────────────────────────────────┬──────────────┐
│ Existing game viewport                     │ JOIN NEXT    │
│                                            │ GAME         │
│ No QR overlay over active play             │ [compact QR] │
│                                            │ N ready next │
└────────────────────────────────────────────┴──────────────┘
```

The rail is preset, not draggable. Operator settings are `auto`, `always`, or `hidden`, with an
optional temporary hotkey. `auto` means large on attract/results and compact during gameplay.

The QR encodes only:

```text
/join?station=ARCADE-01&locale=en-US
```

No PII, balance, player ID, round ID, or bearer credential appears in the QR.

## 7. Mobile Join and Messaging

`/join` is a small localized channel chooser:

- Continue with SMS
- Continue with WhatsApp
- Can't use Messaging? Open the collapsed fast web form

Channel links prefill a deterministic command:

```text
JOIN ARCADE-01 LANG en-US
```

Messaging flow:

```text
QR chooser
  -> SMS or WhatsApp
  -> Twilio Conversations / Orchestrator
  -> TAC callback
  -> deterministic registration and wallet tools
  -> localized reply
```

The channel address supplies the trusted phone destination. TAC conversationally gathers missing
fields, but deterministic application code validates exact fields, consent, idempotency, wallet,
ready-pool, and match operations.

After registration:

```text
You have 1 Arcade coin.

Reply COIN when you are ready to play at the screen.
```

After insertion:

```text
Coin inserted.
You are ready for the next game.
Position: 3
Stay near the screen.
```

Deterministic commands are parsed before TAC/LLM fallback:

- `JOIN`
- `COIN`
- `STATUS`
- `LEAVE`
- `HELP`
- localized equivalents

Inbound provider message IDs are durably idempotent. SMS and WhatsApp addresses normalize into a
channel-address model linked to the authoritative player and Memory profile.

## 8. Language

The selected display language is appended to the QR and initial message. It controls:

- Attract/recruiting instructions
- Mobile channel chooser
- SMS/WhatsApp prefilled command
- TAC registration prompts
- Wallet and coin confirmation
- Queue status and call messages
- Post-game messages
- Conversation Memory language preference

Supported v1 languages remain `en-US` and `pt-BR`. A player can explicitly switch language in the
conversation without changing the shared display language.

## 9. Authoritative Domain Additions

Add schema-versioned durable records:

```text
Station
  id, phase, activeRoundId, activeGame, activeMatchId, revision, updatedAt

RecruitingRound
  id, stationId, phase, firstCoinAt, recruitingEndsAt, hardEndsAt,
  selectionEndsAt, selectedGame, startedAt, closedAt, configVersion

ReadyEntry
  id, roundId, stationId, playerId, originalReadyAt, readyAt,
  status, reservationId, assignment, overflowOrdinal

ArcadeMatch
  id, roundId, stationId, game, phase, participantReadyEntryIds,
  overflowReadyEntryIds, engineRoomCode, launchGeneration,
  launchRequestedAt, displayReadyAt, startedAt, completedAt, configVersion

ChannelAddress
  id, playerId, channel, normalizedAddress, providerAddress,
  firstSeenAt, lastSeenAt

InboundMessage
  providerMessageId, channelAddressId, normalizedCommand, receivedAt, resultFingerprint
```

State schema changes require explicit migration. Existing schema-v1 files must not become unreadable.

## 10. Playable Game Registry

Create one canonical registry consumed by scheduler, APIs, display, launch coordinator, and engine
admission:

| Game | Route | Human capacity | Minimum | AI fallback | Playable |
|---|---|---:|---:|---|---|
| Voice Racer | `/play.html` | **4** | 1 | Race with fewer humans | Yes |
| Voice Monsters | `/monsters.html` | 2 | 1 | AI opponent | Yes |
| Voice Fighter | `/fighter.html` | 2 | 1 | AI opponent | Yes |
| Voice Trivia | Future | TBD | TBD | TBD | No |

Engine admission must enforce the same capacity and assigned participant set. Direct browser, Voice,
or stale WebSocket joins must not bypass station assignment.

## 11. Game Launch Contract

The station coordinator, not the most recently connected display socket, becomes authoritative for
active-game routing.

```text
Station LAUNCHING
  -> persist launch intent
  -> command shared display to selected route
  -> display sends ready acknowledgement
  -> bind admitted player identities/calls to game-local IDs
  -> authoritative engine starts
  -> redeem admitted coin reservations
  -> station PLAYING
```

On launch failure, keep or release reservations according to a deterministic compensation policy.
Never claim an engine launch and a file-store write are one transaction.

Engine completion emits one normalized result into the station coordinator, which completes the
Arcade match and transitions to results/recruiting.

## 12. Realtime Events

Expand the privacy-safe station event stream:

- `station_state_updated`
- `recruiting_started`
- `ready_entry_added`
- `ready_entry_removed`
- `selection_started`
- `game_selected`
- `participants_assigned`
- `overflow_updated`
- `launch_requested`
- `display_ready`
- `match_started`
- `match_completed`
- `station_recovered`

Station events use a monotonic station event sequence, not configuration version. Shared displays
receive aliases/first names only.

## 13. Operator Controls

Authenticated staff can:

- Advance recruiting early
- Extend once within a configured bound
- Select the game
- Override admitted entries with an audited reason
- Launch, cancel, or recover a round
- Release reservations
- Toggle QR rail preset
- Reset the station after an unrecoverable display/game failure

Automatic timers remain active when no operator acts.

## 14. Implementation Phases

### Phase A: Domain and Persistence

- Reconcile Racer engine capacity from 8 to 4.
- Add canonical playable-game registry.
- Add station/round/ready/match/channel state schema and migration.
- Implement pure station reducer and invariant tests.
- Implement serialized station service and first-COIN atomicity.

### Phase B: Timers, Scheduling, and APIs

- Persist and recover all deadlines.
- Implement FIFO admission and overflow.
- Implement manual advance plus automatic deadlines.
- Add public station projection, operator APIs, and station events.

### Phase C: Display

- Replace root with attract/recruiting mosaic plus large QR.
- Move existing game cards into game-selection phase unchanged.
- Add compact fixed QR rail to all active games.
- Add ready roster, countdown, capacity impact, overflow, and results states.

### Phase D: Messaging

- Add localized `/join` channel chooser and collapsed form.
- Add deterministic SMS/WhatsApp command router.
- Add durable channel identity and provider-message idempotency.
- Add TAC registration/Memory tool adapters.
- Add compliant outbound confirmations and status notifications.

### Phase E: Game Coordination

- Replace recent-display voice routing with station active game.
- Gate engine joins to assigned players.
- Launch selected game and await display ready.
- Bind Arcade identities to game-local players/calls.
- Redeem on authoritative engine start and complete from authoritative results.
- Add recovery and compensation.

## 15. Required Verification

- Simultaneous duplicate first `COIN` messages start one round and reserve once.
- Restart at every deadline and phase boundary.
- Racer admits 4 and preserves overflow priority.
- Monsters/Fighter admit 2 and preserve overflow priority.
- Staff early-start and automatic timeout produce the same valid state.
- COIN during play enters next pool, never current match.
- Full selected match participant set is required for completion.
- Launch failure never loses a coin.
- Stale display connections cannot steal voice routing.
- SMS/WhatsApp/browser identities converge without exposing PII.
- Locale flows from display QR through chooser and messaging.
- QR remains scannable on actual 1080p booth display and physical phones.
- Desktop/mobile/browser, full unit/integration, build, audit, and live Twilio tests pass.

## 16. Known Constraints

- One process and one replica remain required until shared state/session infrastructure exists.
- File persistence is acceptable for the first expo spike but not indefinite high-volume production.
- WhatsApp requires approved sender, opt-in, session-window, and template compliance.
- TAC standard Voice still omits low-level final/DTMF events required by gameplay; retain the hybrid
  Conversation Relay path until a custom adapter passes capability tests.
- Messaging, Memory, and live Twilio resources require account credentials and Console provisioning.
