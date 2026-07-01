import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { RoomManager } from './room-manager';
import { Room, type RoomConfig } from './room';
import { STEP } from '../shared/constants';
import { INTENTS } from '../shared/types';
import type { ClientMessage, ServerMessage, GameEvent } from '../shared/types';

type ParseResult = ClientMessage | { type: 'error'; code: string; message: string };

export function parseClientMessage(raw: string): ParseResult {
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return err('bad_json', 'invalid JSON'); }
  if (!obj || typeof obj.type !== 'string') return err('bad_message', 'missing type');
  switch (obj.type) {
    case 'join':
      if (typeof obj.roomCode !== 'string' || typeof obj.name !== 'string')
        return err('bad_join', 'roomCode and name required');
      return { type: 'join', roomCode: obj.roomCode, name: obj.name,
               ...(typeof obj.color === 'string' ? { color: obj.color } : {}) };
    case 'intent':
      if (!INTENTS.includes(obj.intent)) return err('bad_intent', 'unknown intent');
      return { type: 'intent', intent: obj.intent };
    case 'ready':   return { type: 'ready' };
    case 'restart': return { type: 'restart' };
    case 'spectate':
      if (typeof obj.roomCode !== 'string') return err('bad_spectate', 'roomCode required');
      return { type: 'spectate', roomCode: obj.roomCode };
    case 'leave':   return { type: 'leave' };
    case 'select_car':
      if (!Number.isInteger(obj.carIndex)) return err('bad_select_car', 'carIndex (int) required');
      return { type: 'select_car', carIndex: obj.carIndex };
    case 'select_map':
      if (typeof obj.map !== 'string') return err('bad_select_map', 'map required');
      return { type: 'select_map', map: obj.map };
    case 'advance': return { type: 'advance' };
    case 'back':    return { type: 'back' };
    default:        return err('unknown_type', `unknown type ${obj.type}`);
  }
}
function err(code: string, message: string): ParseResult { return { type: 'error', code, message }; }

interface Conn { ws: WebSocket; roomCode?: string; playerId?: string; }

export class GameServer {
  private wss: WebSocketServer | null = null;
  private rooms = new RoomManager();
  private conns = new Set<Conn>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private broadcastAccum = 0;
  private roomAccum = new Map<Room, number>();
  private lobbyTick = 0;
  private readonly port: number | undefined;
  private readonly broadcastEvery: number;
  /** Supplies the selectable cars/maps for newly created rooms (set by the http server, which owns
   *  the manifest + map list). Sync + cached so getOrCreate stays synchronous. */
  private roomConfig: (() => RoomConfig) | null = null;
  /** Fired once when a room's race finishes (transitions into results), for leaderboard persistence. */
  private onRaceFinished: ((room: Room) => void) | null = null;
  /** Fired with a room's drained game events each broadcast (countdown/go/finish/…), so the voice
   *  layer can speak the caller-relevant ones. Same events the screen gets; voice picks a subset. */
  private onRoomEvents: ((roomCode: string, events: GameEvent[]) => void) | null = null;
  /** Rooms whose finished race we've already reported (cleared when they leave results). */
  private reported = new WeakSet<Room>();

  constructor(opts: { port?: number; server?: HttpServer; broadcastHz?: number }) {
    this.port = opts.port;
    this.broadcastEvery = 1 / (opts.broadcastHz ?? 20);
    if (opts.server) this.attach(opts.server);
  }

  /** Register the room-config provider (car count + map list). Existing rooms are reconfigured too. */
  setRoomConfigProvider(fn: () => RoomConfig): void {
    this.roomConfig = fn;
  }

  /** Register a hook fired once when a room's race finishes (results phase) — for leaderboard saves. */
  setOnRaceFinished(fn: (room: Room) => void): void {
    this.onRaceFinished = fn;
  }

  /** Register a hook fired with a room's game events each broadcast — for the voice talk-back layer. */
  setOnRoomEvents(fn: (roomCode: string, events: GameEvent[]) => void): void {
    this.onRoomEvents = fn;
  }

  /** Create-or-fetch a room, configuring brand-new rooms with the current car/map choices. */
  private room(code: string): Room {
    const existed = !!this.rooms.find(code);
    const room = this.rooms.getOrCreate(code);
    if (!existed && this.roomConfig) {
      try { room.configure(this.roomConfig()); } catch { /* config unavailable → empty choices */ }
    }
    return room;
  }

  /**
   * Mounted mode: attach to an externally-owned http.Server. The WebSocketServer
   * runs in noServer mode; the http layer routes upgrades via handleUpgrade().
   * The game loop starts immediately so mounted rooms tick without a separate start().
   */
  attach(_server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });
    this.startLoop();
  }

  /** Route a /game upgrade from the owning http server into this game's WebSocketServer. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/game') { socket.destroy(); return; }
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port }, () => {
        const addr = this.wss!.address();
        const boundPort = typeof addr === 'object' && addr ? addr.port : this.port!;
        this.startLoop();
        resolve(boundPort);
      });
      this.wss.on('connection', (ws) => this.onConnection(ws));
    });
  }

  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws };
    this.conns.add(conn);
    ws.on('message', (data) => this.onMessage(conn, data.toString()));
    ws.on('error', () => { /* a socket error shouldn't crash the process; close handler cleans up */ });
    ws.on('close', () => {
      const roomCode = conn.roomCode;
      if (roomCode && conn.playerId) this.rooms.find(roomCode)?.removePlayer(conn.playerId);
      this.conns.delete(conn);
      if (roomCode) {
        this.pushLobby(roomCode);     // refresh roster after a disconnect
        this.reapRoomIfEmpty(roomCode);
      }
    });
  }

  private onMessage(conn: Conn, raw: string): void {
    const msg = parseClientMessage(raw);
    if (msg.type === 'error') return this.send(conn, msg as ServerMessage);
    switch (msg.type) {
      case 'join': {
        const room = this.room(msg.roomCode);
        const res = room.addPlayer(msg.name, msg.color);
        if ('error' in res) return this.send(conn, { type: 'error', code: res.error, message: res.error });
        conn.roomCode = msg.roomCode; conn.playerId = res.playerId;
        this.send(conn, { type: 'joined', playerId: res.playerId, lane: res.lane, roomCode: msg.roomCode });
        this.pushLobby(msg.roomCode);   // update every conn's roster instantly
        break;
      }
      case 'ready': {
        // Start from the lobby OR after a finished race ("Enter to race again") — both reroll the
        // per-race seed for a fresh course. Mid-race Enter is ignored (race already running).
        if (conn.roomCode) {
          const room = this.rooms.find(conn.roomCode);
          if (room && (room.phase === 'lobby' || room.phase === 'finished')) {
            room.start();
            this.broadcastItems(conn.roomCode);
          }
        }
        break;
      }
      case 'intent':
        if (conn.roomCode && conn.playerId)
          this.rooms.find(conn.roomCode)?.applyIntent(conn.playerId, msg.intent);
        break;
      case 'select_car': {
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        if (room && conn.playerId) {
          room.selectCar(conn.playerId, msg.carIndex);
          this.pushLobby(conn.roomCode!);
          // Playful host reaction to the pick (screen + the picking caller's phone).
          const who = room.lobbyPlayers().find(p => p.playerId === conn.playerId);
          this.emitEvent(conn.roomCode!, { kind: 'car_picked', playerId: conn.playerId,
            name: who?.name ?? 'Racer', car: room.carName(msg.carIndex) });
        }
        break;
      }
      case 'select_map': {
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        if (room) {
          room.selectMap(msg.map);
          this.pushLobby(conn.roomCode!);
          this.emitEvent(conn.roomCode!, { kind: 'map_picked', map: msg.map });
        }
        break;
      }
      case 'advance': {
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        if (room) {
          const before = room.phase;
          room.advance();
          const after = room.phase;
          // Crossing into a race broadcasts items (with the chosen map) to EVERY conn in the room
          // so all displays/players load the right level; otherwise refresh the select screen.
          if (after === 'countdown' || after === 'racing') this.broadcastItems(conn.roomCode!);
          else this.pushLobby(conn.roomCode!);
          // Announce entering a NEW pre-race phase (the AI host guiding the menus).
          if (after !== before) {
            if (after === 'car_select') this.emitEvent(conn.roomCode!, { kind: 'enter_car_select' });
            else if (after === 'map_select') this.emitEvent(conn.roomCode!, { kind: 'enter_map_select' });
          }
        }
        break;
      }
      case 'back': {
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        if (room) { room.back(); this.pushLobby(conn.roomCode!); }
        break;
      }
      case 'restart': {
        // The host display's explicit "new race" button (the 'r' key) — ALWAYS rebuilds a fresh
        // race for the current players. This is what evolves the per-race seed, so each restart
        // gets a NEW procedural course. Only the browser display can send this (phone callers via
        // Conversation Relay emit movement intents only), so it isn't a griefing vector — and a
        // host wanting to reroll the course mid-race is legitimate, not griefing.
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        if (room) { room.start(); this.broadcastItems(conn.roomCode!); }
        break;
      }
      case 'spectate': {
        this.room(msg.roomCode);
        conn.roomCode = msg.roomCode;   // no playerId: receives broadcasts, occupies no slot
        this.pushLobby(msg.roomCode);   // send the display the current select/lobby state immediately
        break;
      }
      case 'leave': {
        // Drop this connection's PLAYER slot but keep it connected as a spectator (same roomCode).
        // Used by the shared screen toggling "I'm playing" → back to spectating, without reconnecting.
        if (conn.roomCode && conn.playerId) {
          this.rooms.find(conn.roomCode)?.removePlayer(conn.playerId);
          conn.playerId = undefined;
          this.pushLobby(conn.roomCode);
          this.reapRoomIfEmpty(conn.roomCode);
        }
        break;
      }
    }
  }

  getOrCreateRoom(code: string): Room { return this.room(code); }
  findRoom(code: string): Room | undefined { return this.rooms.find(code); }
  /** Test seam: advance one room's simulation by `dt` (drives the same stepRoom path the loop uses),
   *  so the racing→results→leaderboard reporting can be verified deterministically without real time. */
  stepRoomForTest(room: Room, dt: number): void { this.stepRoom(room, dt); }
  /** Number of live rooms (test/diagnostic hook for the room-leak fix). */
  get roomCount(): number { return this.rooms.count; }

  /**
   * Drop a room once nothing references it — no players AND no connections (spectators included)
   * still pointing at it. Prevents the room + its accumulator from leaking for the life of the
   * process after an event's worth of one-off room codes.
   */
  private reapRoomIfEmpty(roomCode: string): void {
    const room = this.rooms.find(roomCode);
    if (!room || !room.isEmpty) return;
    for (const c of this.conns) if (c.roomCode === roomCode) return;   // a spectator is still watching
    this.roomAccum.delete(room);
    this.rooms.remove(roomCode);
  }

  private startLoop(): void {
    let last = process.hrtime.bigint();
    // Run the loop at ~120Hz target. The sim steps by real dt (frame-rate independent) so this only
    // affects the GRANULARITY at which the broadcast accumulator is checked: a faster loop means the
    // accumulator reaches broadcastEvery (50ms) close to on-time even when the container starves the
    // timer to ~60ms actual. At 60Hz target, a starved tick meant broadcasts landed at ~64ms (≈15Hz);
    // the tighter target keeps the effective broadcast rate near the intended 20Hz. The loop body is
    // cheap (one small room), so the extra wakeups cost almost nothing.
    this.loop = setInterval(() => {
      const now = process.hrtime.bigint();
      let dt = Number(now - last) / 1e9; last = now;
      dt = Math.min(dt, 0.1);
      // step every active room at fixed timestep
      const seen = new Set<Room>();
      for (const c of this.conns) {
        const room = c.roomCode ? this.rooms.find(c.roomCode) : undefined;
        if (room && !seen.has(room)) { seen.add(room); this.stepRoom(room, dt); }
      }
      this.broadcastAccum += dt;
      if (this.broadcastAccum >= this.broadcastEvery) {
        // Reset to the REMAINDER (not 0) so timing errors don't accumulate — keeps the long-run rate
        // locked to broadcastEvery instead of slipping slower with each late tick.
        this.broadcastAccum = this.broadcastAccum % this.broadcastEvery;
        this.broadcastAll();
      }
    }, 1000 / 120);
  }

  private stepRoom(room: Room, dt: number): void {
    if (room.phase !== 'countdown' && room.phase !== 'racing') {
      // Not racing: nothing to simulate. Clear the "already reported" flag for non-results phases
      // so the NEXT race reports too. (A room sitting in results was reported the tick it finished.)
      this.roomAccum.delete(room);
      if (room.phase !== 'results') this.reported.delete(room);
      else this.reportFinishedOnce(room);   // belt-and-suspenders if it slipped through
      return;
    }
    let acc = (this.roomAccum.get(room) ?? 0) + dt;
    while (acc >= STEP) { room.tick(STEP); acc -= STEP; }
    this.roomAccum.set(room, acc);
    // A tick may have flipped racing→results INSIDE this call. Report it NOW (same call as the
    // transition) so the standings persist even if the player disconnects this very tick and the
    // room gets reaped before the next stepRoom. (Read fresh — phase changed during tick().)
    const phaseAfter: string = room.phase;
    if (phaseAfter === 'results') this.reportFinishedOnce(room);
  }

  /** Fire onRaceFinished exactly once per finished race (the WeakSet clears when it leaves results). */
  private reportFinishedOnce(room: Room): void {
    if (this.reported.has(room)) return;
    this.reported.add(room);
    this.onRaceFinished?.(room);
  }

  /** True for the non-racing phases that broadcast roster/selection/results rather than snapshots. */
  private static isPreOrPost(phase: string): boolean {
    return phase === 'lobby' || phase === 'car_select' || phase === 'map_select' || phase === 'results';
  }

  /** The right out-of-race message for a room's current phase (roster / car+map select / results). */
  private preRaceMessage(room: Room): ServerMessage {
    const phase = room.phase;
    if (phase === 'results') {
      return { type: 'results', roomCode: room.code, map: room.selectedMap, results: room.results() };
    }
    if (phase === 'car_select' || phase === 'map_select') {
      return { type: 'select_state', roomCode: room.code, phase, players: room.lobbyPlayers(),
        maps: room.mapChoices, selectedMap: room.selectedMap };
    }
    // lobby
    return { type: 'lobby', roomCode: room.code, players: room.lobbyPlayers(), phase };
  }

  private broadcastAll(): void {
    const tick = this.lobbyTick++;   // once per broadcast call, not per connection
    const cached = new Set<Room>();
    for (const c of this.conns) {
      if (!c.roomCode) continue;
      const room = this.rooms.find(c.roomCode); if (!room) continue;
      // A room is EITHER pre/post-race (roster/select/results) OR racing per tick — send one kind.
      if (GameServer.isPreOrPost(room.phase)) {
        // Throttle to ~2/s (every 10th broadcast ≈ 2/s at 20Hz). No snapshot/events out of race.
        if (tick % 10 === 0) this.send(c, this.preRaceMessage(room));
        continue;
      }
      if (!cached.has(room)) {
        room.cacheEventsForBroadcast(); cached.add(room);
        // Fan the SAME events out to the voice layer once per room (it speaks the caller-relevant
        // subset — countdown/go/finish). Done here so the screen + phone hear the same beats.
        const evs = room.drainEventsOnce();
        if (evs.length && this.onRoomEvents) this.onRoomEvents(room.code, evs);
      }
      const snap = room.snapshot(); if (!snap) continue;
      this.send(c, { type: 'snapshot', snapshot: snap });
      for (const event of room.drainEventsOnce()) this.send(c, { type: 'event', event });
    }
  }

  /** Fan a single event to BOTH audiences in a room: the screen conns (as an `event` message → the
   *  screen announcer) AND the voice callers (via onRoomEvents → their TTS). Used for the PRE-RACE
   *  moments (car/map select) that don't flow through the racing broadcast loop, so the AI host
   *  talks during the menus too — not just the race. */
  private emitEvent(roomCode: string, event: GameEvent): void {
    for (const c of this.conns) if (c.roomCode === roomCode) this.send(c, { type: 'event', event });
    this.onRoomEvents?.(roomCode, [event]);
  }

  /** Immediately send the current pre/post-race state to every connection in a room. */
  private pushLobby(roomCode: string): void {
    const room = this.rooms.find(roomCode);
    if (!room || !GameServer.isPreOrPost(room.phase)) return;
    const msg = this.preRaceMessage(room);
    for (const c of this.conns) if (c.roomCode === roomCode) this.send(c, msg);
  }

  /** Broadcast the items list (with the chosen map) to EVERY connection in a room at race start, so
   *  all displays/players load the same level + per-level scales — not just whoever pressed start. */
  private broadcastItems(roomCode: string): void {
    const room = this.rooms.find(roomCode);
    if (!room) return;
    const msg = anyItems(room);
    for (const c of this.conns) if (c.roomCode === roomCode) this.send(c, msg);
  }

  private send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  /** Clear the game loop. Used in standalone stop() and by the http server in mounted mode. */
  clearLoop(): void {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
  }

  /**
   * Mounted-mode shutdown: stop the loop and close client connections without
   * closing a port the game server no longer owns (the http server owns shutdown).
   */
  stopLoopOnly(): void {
    this.clearLoop();
    for (const c of this.conns) c.ws.close();
    this.conns.clear();
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.clearLoop();
      for (const c of this.conns) c.ws.close();
      this.conns.clear();
      if (this.wss) this.wss.close(() => resolve()); else resolve();
    });
  }
}

function anyItems(room: Room): ServerMessage {
  const snap = room.snapshot();
  // Carry the chosen level so the client loads the right map + per-level car/item scales for THIS
  // race (the lobby picks the map; the display has no ?map= URL param to fall back on).
  return { type: 'items', items: snap ? snap.items : [], map: room.selectedMap };
}
