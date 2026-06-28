import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { RoomManager } from './room-manager';
import { Room } from './room';
import { STEP } from '../shared/constants';
import { INTENTS } from '../shared/types';
import type { ClientMessage, ServerMessage } from '../shared/types';

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

  constructor(opts: { port?: number; server?: HttpServer; broadcastHz?: number }) {
    this.port = opts.port;
    this.broadcastEvery = 1 / (opts.broadcastHz ?? 20);
    if (opts.server) this.attach(opts.server);
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
        const room = this.rooms.getOrCreate(msg.roomCode);
        const res = room.addPlayer(msg.name, msg.color);
        if ('error' in res) return this.send(conn, { type: 'error', code: res.error, message: res.error });
        conn.roomCode = msg.roomCode; conn.playerId = res.playerId;
        this.send(conn, { type: 'joined', playerId: res.playerId, lane: res.lane, roomCode: msg.roomCode });
        this.pushLobby(msg.roomCode);   // update every conn's roster instantly
        break;
      }
      case 'ready': {
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        if (room && room.phase === 'lobby') { room.start(); this.send(conn, anyItems(room)); }
        break;
      }
      case 'intent':
        if (conn.roomCode && conn.playerId)
          this.rooms.find(conn.roomCode)?.applyIntent(conn.playerId, msg.intent);
        break;
      case 'restart': {
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        // Only restart from a settled phase (lobby or a finished race) — never interrupt a
        // race in progress, so one client can't grief everyone mid-race.
        if (room && (room.phase === 'lobby' || room.phase === 'finished')) {
          room.start();
          this.send(conn, anyItems(room));
        }
        break;
      }
      case 'spectate': {
        this.rooms.getOrCreate(msg.roomCode);
        conn.roomCode = msg.roomCode;   // no playerId: receives broadcasts, occupies no slot
        break;
      }
    }
  }

  getOrCreateRoom(code: string): Room { return this.rooms.getOrCreate(code); }
  findRoom(code: string): Room | undefined { return this.rooms.find(code); }
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
      if (this.broadcastAccum >= this.broadcastEvery) { this.broadcastAccum = 0; this.broadcastAll(); }
    }, 1000 / 60);
  }

  private stepRoom(room: Room, dt: number): void {
    // Only an active race (countdown/racing) needs simulating. A lobby or a finished race has
    // no world to advance — stepping it just burns CPU and grows the accumulator pointlessly.
    if (room.phase !== 'countdown' && room.phase !== 'racing') { this.roomAccum.delete(room); return; }
    let acc = (this.roomAccum.get(room) ?? 0) + dt;
    while (acc >= STEP) { room.tick(STEP); acc -= STEP; }
    this.roomAccum.set(room, acc);
  }

  private broadcastAll(): void {
    const tick = this.lobbyTick++;   // once per broadcast call, not per connection
    const cached = new Set<Room>();
    for (const c of this.conns) {
      if (!c.roomCode) continue;
      const room = this.rooms.find(c.roomCode); if (!room) continue;
      // A room is EITHER in lobby OR racing per tick — send exactly one kind.
      if (room.phase === 'lobby') {
        // Throttle the roster to ~2/s (every 10th broadcast ≈ 2/s at 20Hz). No snapshot/events in lobby.
        if (tick % 10 === 0)
          this.send(c, { type: 'lobby', roomCode: room.code, players: room.lobbyPlayers(), phase: room.phase });
        continue;
      }
      if (!cached.has(room)) { room.cacheEventsForBroadcast(); cached.add(room); }
      const snap = room.snapshot(); if (!snap) continue;
      this.send(c, { type: 'snapshot', snapshot: snap });
      for (const event of room.drainEventsOnce()) this.send(c, { type: 'event', event });
    }
  }

  /** Immediately send the current lobby roster to every connection in a room (join/disconnect). */
  private pushLobby(roomCode: string): void {
    const room = this.rooms.find(roomCode);
    if (!room || room.phase !== 'lobby') return;
    const msg: ServerMessage = { type: 'lobby', roomCode: room.code, players: room.lobbyPlayers(), phase: room.phase };
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
  return { type: 'items', items: snap ? snap.items : [] };
}
