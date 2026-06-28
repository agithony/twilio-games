# Multiplayer Lobby Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** A real lobby — the shared display shows players (phone + keyboard) as they join, by name + car color, with a room code and a count; the operator presses Enter to start. Fixes the invisible-room / awkward-ordering problems.

**Architecture:** While a room is in `lobby` phase the server broadcasts a `lobby` roster message (throttled, + immediate on join/leave). The display renders a lobby overlay from it, then switches to the race view once snapshots flow. No sim change.

**Tech Stack:** TypeScript strict, `ws`, three.js (display overlay is DOM), Vitest.

## Global Constraints
- ES modules, TS strict, noUncheckedIndexedAccess.
- A room sends EITHER a `lobby` message (phase==='lobby') OR `snapshot`s (racing) per tick — never both.
- Lobby roster entry shape EXACTLY: `LobbyPlayer = { playerId: string; name: string; color: string; lane: number }`.
- No simulation/RaceWorld change. Existing snapshot/event/voice behavior unchanged.
- DRY, YAGNI, TDD, frequent commits.

---

### Task 1: Protocol + Room roster + lobby broadcast

**Files:** Modify `shared/types.ts`, `server/room.ts`, `server/game-server.ts`. Test: extend `tests/room.test.ts` + `tests/game-server.test.ts`.

**Interfaces:**
- `shared/types.ts`: add
  `export interface LobbyPlayer { playerId: string; name: string; color: string; lane: number }`
  and `ServerMessage` variant `| { type: 'lobby'; roomCode: string; players: LobbyPlayer[]; phase: Phase }`.
- `server/room.ts`: `lobbyPlayers(): LobbyPlayer[]` (maps internal players → roster; `playerId` = the player's `id`).

- [ ] **Step 1: Add the type + variant** in `shared/types.ts` (LobbyPlayer interface + the `lobby` ServerMessage member). Run `npm run typecheck` (will fail later until used — that's fine for this step; just ensure it parses).

- [ ] **Step 2: Write the failing Room test** — add to `tests/room.test.ts`

```ts
it('lobbyPlayers returns the roster with id/name/color/lane', () => {
  const room = new Room('4821', 1);
  const a = room.addPlayer('Ada', '#f22f46') as { playerId: string; lane: number };
  room.addPlayer('Rex');
  const roster = room.lobbyPlayers();
  expect(roster).toHaveLength(2);
  expect(roster[0]).toMatchObject({ playerId: a.playerId, name: 'Ada', color: '#f22f46', lane: 0 });
  expect(roster[1]!.name).toBe('Rex');
  expect(typeof roster[1]!.color).toBe('string');
});
```

- [ ] **Step 3: Run → fails** (`npm test -- room.test`, `lobbyPlayers` not a function).

- [ ] **Step 4: Implement `lobbyPlayers()` in `server/room.ts`**

```ts
lobbyPlayers(): import('../shared/types').LobbyPlayer[] {
  return this.players.map(p => ({ playerId: p.id, name: p.name, color: p.color, lane: p.lane }));
}
```
(Import `LobbyPlayer` at the top if not using the inline import.)

- [ ] **Step 5: Run → passes** (`npm test -- room.test`).

- [ ] **Step 6: Broadcast lobby in `server/game-server.ts`**

In `broadcastAll()` (the per-room loop), branch on phase. For a room in `lobby` phase, send a
`lobby` message instead of a snapshot, but throttled to ~2/s. Simplest: keep a counter so
lobby messages go out every Nth broadcast tick (broadcastHz≈20 → every 10th ≈ 2/s). Pseudocode
to integrate with the existing loop:

```ts
// fields:
private lobbyTick = 0;

// in broadcastAll(), per room c with a roomCode:
const room = this.rooms.find(c.roomCode); if (!room) continue;
if (room.phase === 'lobby') {
  // throttle: only emit on every 10th broadcast (≈2/s at 20Hz)
  if (this.lobbyTick % 10 === 0) {
    this.send(c, { type: 'lobby', roomCode: room.code, players: room.lobbyPlayers(), phase: 'lobby' });
  }
  continue;   // no snapshot/events while in lobby
}
// ...existing snapshot + events send for racing rooms...
```
Increment `this.lobbyTick++` once per `broadcastAll()` call (not per connection). Also add a
helper `pushLobby(roomCode)` that immediately sends the lobby message to every conn in that
room, and call it right after a successful `join` and after a `removePlayer` (disconnect) so
the roster updates instantly. Keep it null-safe.

- [ ] **Step 7: Write the failing integration test** — add to `tests/game-server.test.ts`

```ts
it('two players in lobby both receive a lobby roster with both names', async () => {
  server = new GameServer({ port: 0, broadcastHz: 30 });
  const port = await server.start();
  const a = connect(port); await a.open();
  const b = connect(port); await b.open();
  a.ws.send(JSON.stringify({ type: 'join', roomCode: '8200', name: 'Ada' }));
  b.ws.send(JSON.stringify({ type: 'join', roomCode: '8200', name: 'Rex' }));
  await wait(250);
  const lob = [...b.inbox].reverse().find((m: any) => m.type === 'lobby') as any;
  expect(lob).toBeDefined();
  const names = lob.players.map((p: any) => p.name).sort();
  expect(names).toEqual(['Ada', 'Rex']);
  expect(lob.phase).toBe('lobby');
});
```
(Reuse the test file's existing `connect`/`wait` helpers.)

- [ ] **Step 8: Run → passes** (`npm test -- game-server`). Then full `npm test` + `npm run typecheck` clean.

- [ ] **Step 9: Commit**
```bash
git add shared/types.ts server/room.ts server/game-server.ts tests/room.test.ts tests/game-server.test.ts
git commit -m "feat: lobby roster + lobby-phase broadcast (server)"
```

---

### Task 2: Client lobby overlay

**Files:** Modify `client/net.ts`, `client/main.ts`, `client/play.html`. Verified by build + headless smoke.

- [ ] **Step 1: Add `onLobby` to `client/net.ts`**

Mirror the existing handlers: add a private `onLobbyCb?: (msg: { roomCode: string; players: {playerId:string;name:string;color:string;lane:number}[]; phase: string }) => void`, an `onLobby(cb)` registrar, and in the message switch handle `m.type === 'lobby'` → `this.onLobbyCb?.(m)`.

- [ ] **Step 2: Add the lobby overlay markup to `client/play.html`**

Add (near the existing `#big`):
```html
<div id="lobby" style="position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;background:rgba(4,8,20,.82);font-family:'Twilio Sans Text',system-ui,sans-serif;color:#fff">
  <div style="font-family:ui-monospace,monospace;color:#9aa0b4;letter-spacing:.08em;text-transform:uppercase;font-size:13px">Room code</div>
  <div id="lobbyCode" style="font-size:88px;font-weight:800;letter-spacing:.06em;color:#ef223a;line-height:1">----</div>
  <div id="lobbyCount" style="margin:6px 0 18px;color:#cdd3e0;font-size:16px">Call in to join</div>
  <div id="lobbyPlayers" style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;max-width:760px"></div>
  <div style="margin-top:26px;color:#9aa0b4;font-size:14px">Press <b style="color:#fff">ENTER</b> to start the race</div>
</div>
```

- [ ] **Step 3: Wire the lobby in `client/main.ts`**

Get the elements; render the roster on each `lobby` message; show the lobby overlay while in
lobby and hide it once snapshots arrive (race started). Add near the other conn handlers:
```ts
const lobbyEl = document.getElementById('lobby')!;
const lobbyCodeEl = document.getElementById('lobbyCode')!;
const lobbyCountEl = document.getElementById('lobbyCount')!;
const lobbyPlayersEl = document.getElementById('lobbyPlayers')!;
let raceLive = false;
conn.onSnapshot((s) => { raceLive = true; lobbyEl.style.display = 'none'; started = true; buffer.push(s, performance.now()); });
conn.onLobby((m) => {
  if (raceLive) return;                       // race already running; ignore stale lobby
  lobbyEl.style.display = 'flex';
  big.textContent = '';                       // lobby overlay replaces the "waiting" text
  lobbyCodeEl.textContent = m.roomCode;
  const n = m.players.length;
  lobbyCountEl.textContent = n === 0 ? `Call ${m.roomCode} to join`
    : `${n} racer${n === 1 ? '' : 's'} in — call ${m.roomCode} to join more`;
  lobbyPlayersEl.innerHTML = '';
  for (const p of m.players) {
    const chip = document.createElement('div');
    chip.style.cssText = 'display:flex;align-items:center;gap:8px;background:rgba(35,43,69,.9);border:1px solid #38425e;border-radius:999px;padding:8px 14px;font-size:15px';
    const dot = document.createElement('span');
    dot.style.cssText = `width:14px;height:14px;border-radius:50%;background:${p.color};display:inline-block`;
    const nm = document.createElement('span'); nm.textContent = p.name;
    chip.append(dot, nm); lobbyPlayersEl.appendChild(chip);
  }
});
```
Note: the `onSnapshot` handler above REPLACES the existing one (it adds `raceLive`/hide-lobby).
Keep the existing `started` logic and the `else if (!started)` waiting-text branch as a fallback
for before the first lobby message arrives. The existing `conn.spectate(roomCode)` in the
display path already makes the server send lobby messages; no change to the join flow.
`p.color`/`p.name` are server-supplied (trusted), but use `textContent` for the name (it's the
caller's number-derived "Racer NNNN"); the color is a hex from our COLORS list.

- [ ] **Step 4: Verify** — `npm run typecheck && npm run build` clean; `npm test` (Task 1 tests pass).

- [ ] **Step 5: Headless smoke** — start server+vite; open `play.html?display=1&room=4821`;
open a 2nd ws/tab joining room 4821 as a player; confirm the display shows the lobby with the
room code + a player chip, and that pressing Enter (then a snapshot) hides the lobby. Report.

- [ ] **Step 6: Commit**
```bash
git add client/net.ts client/main.ts client/play.html
git commit -m "feat: display lobby overlay (room code + live player roster)"
```

---

## Self-Review
(author check below)
