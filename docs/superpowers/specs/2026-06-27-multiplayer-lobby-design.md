# Multiplayer Lobby — Design

**Date:** 2026-06-27
**Status:** Approved (autonomous build, user-approved direction)

## Purpose & Scope

Right now there is no lobby: the room is invisible until a race starts, so players can't
see each other join, and the "call → press Enter" ordering is confusing. This adds a real
**lobby** — the shared display shows each player (phone caller or keyboard) as they join, by
name and car color, and the operator starts when everyone's in.

This fixes the root cause behind several bugs we hit live: "press Enter does nothing" (empty
room), call-then-Enter ordering, and not knowing if your call connected.

**In scope:**
- **Server:** broadcast a `lobby` message (the player roster) to a room's connections while in
  the `lobby` phase — at a low rate (e.g. 2/s) and immediately on join/leave. Roster entry =
  `{ playerId, name, color, lane }`.
- **Protocol:** add `ServerMessage` variant `{ type:'lobby'; roomCode; players: LobbyPlayer[]; phase }`.
- **Client (display/spectator):** a lobby screen — big room code, a grid of joined players
  (name + car-color chip), a live count ("3 racers — call 4821 to join"), and "Press ENTER to
  start". When the race starts, the lobby screen hides and the race renders (as today).
- **Phone caller feedback:** when a caller joins during lobby, the display roster updates so
  they can see they're in (the phone has no screen; the shared display is their confirmation).

**Explicitly NOT in scope:** car *selection* (next), persistent identity/avatars, ready-up per
player (operator-start is enough), spectator-only viewers list.

## Architecture

- **`shared/types.ts`:** add `LobbyPlayer = { playerId; name; color; lane }` and
  `ServerMessage` variant `{ type:'lobby'; roomCode:string; players:LobbyPlayer[]; phase:Phase }`.
- **`server/room.ts`:** expose `lobbyPlayers(): LobbyPlayer[]` (maps the existing `players[]`).
- **`server/game-server.ts`:** in the broadcast loop, for rooms in `lobby` phase send a `lobby`
  message (throttled ~2/s) instead of snapshots; also push one immediately when a player
  joins/leaves so it feels instant. Keep snapshot broadcasting unchanged for racing rooms.
- **`client/net.ts`:** `onLobby(cb)` handler.
- **`client/main.ts` + `play.html`:** a `#lobby` overlay (room code, player grid, count, start
  hint). Show it while `phase==='lobby'` / before the first snapshot; hide once racing. Reuse
  the existing big-text for countdown/GO.

## Testing

- **Pure/unit:** `Room.lobbyPlayers()` returns the roster with correct shape after joins; a
  `lobby` message is well-formed. (Add to existing room/game-server tests.)
- **Integration:** two WS clients join the same room → both receive a `lobby` message listing
  both players; after start, lobby stops and snapshots flow. (Extend game-server integration test.)
- **Display lobby UI:** verified by build + headless smoke (roster shows joined players; hides
  on race start). No browser unit test for the DOM.

## Risks

- **Lobby vs snapshot broadcast confusion** — a room is either lobby OR racing; send exactly one
  kind per room per tick based on phase. Tested.
- **Roster churn on reconnect** — a player who drops and re-joins gets a new id/row; acceptable
  (the empty-room reset already prevents stuck rooms). 
- **Throttle** — lobby messages at ~2/s (not 20/s) to avoid spam; immediate push on join/leave
  keeps it responsive without flooding.
