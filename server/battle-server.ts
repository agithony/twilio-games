// The /battle WebSocket server for Voice Monsters. Turn-based + EVENT-DRIVEN: unlike the racer's
// GameServer (which ticks a continuous sim at 20Hz and streams snapshots), this pushes battle_state
// only when something changes — a join, a monster pick, a resolved turn. Wraps BattleRoom; keeps the
// racer's server untouched. Supports standalone (port) + mounted (attach + handleUpgrade) modes so
// the HTTP host can serve /game and /battle side by side.
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { BattleRoom } from './battle-room';
import { parseBattleClientMessage, type BattleServerMessage } from '../shared/battle-protocol';
import { rosterEntries } from '../shared/monster-roster';
import type { BattleEvent, BattleAction } from '../shared/battle-world';

interface Conn { ws: WebSocket; roomCode?: string; playerId?: string; isAlive: boolean; }

// How often we ping idle battle sockets. Battle traffic is event-driven (a push only on a change), so
// a player sitting on the monster-select screen sends/receives nothing — without a heartbeat an idle
// proxy/browser closes the socket after ~60s, the server drops the player, the room resets to lobby,
// and the reconnect lands in an empty lobby (the "select screen reverts to play-here" bug). 30s keeps
// it comfortably under typical idle-timeout windows.
const HEARTBEAT_MS = 30_000;

export class BattleServer {
  private wss: WebSocketServer | null = null;
  private conns = new Set<Conn>();
  private rooms = new Map<string, BattleRoom>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private seedCounter = 0x1234abcd;
  private readonly port: number | undefined;
  private readonly heartbeatMs: number;
  /** Fired with a room's drained battle events (super-effective/faint/win) so the voice layer speaks
   *  the caller-relevant ones — mirrors the racer's onRoomEvents seam. */
  private onRoomEvents: ((roomCode: string, events: BattleEvent[]) => void) | null = null;

  constructor(opts: { port?: number; server?: HttpServer; heartbeatMs?: number }) {
    this.port = opts.port;
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;   // overridable so tests can drive fast sweeps
    if (opts.server) this.attach(opts.server);
  }

  setOnRoomEvents(fn: (roomCode: string, events: BattleEvent[]) => void): void { this.onRoomEvents = fn; }

  // ── lifecycle: standalone vs mounted (parallels GameServer) ─────────────────────────────────────
  attach(_server: HttpServer): void { this.wss = new WebSocketServer({ noServer: true }); }
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }
  start(): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port }, () => {
        const addr = this.wss!.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.port!);
      });
      this.wss.on('connection', (ws) => this.onConnection(ws));
    });
  }

  private room(code: string): BattleRoom {
    let r = this.rooms.get(code);
    if (!r) { r = new BattleRoom(code, this.seedCounter = (this.seedCounter + 0x9e3779b9) >>> 0); this.rooms.set(code, r); }
    return r;
  }
  findRoom(code: string): BattleRoom | undefined { return this.rooms.get(code); }
  /** Live WS connections (displays + device players). The voice router uses this to auto-join a caller
   *  to Voice Monsters when its display is the one that's open. */
  get connectionCount(): number { return this.conns.size; }

  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws, isAlive: true };
    this.conns.add(conn);
    this.ensureHeartbeat();
    // A pong (reply to our ping) marks the socket live for the next sweep. Some clients also send an
    // unsolicited ping — reply so we keep THEM alive too.
    ws.on('pong', () => { conn.isAlive = true; });
    // The select screen needs the roster immediately (client renders creature cards from it).
    this.send(conn, { type: 'roster', monsters: rosterEntries() });
    ws.on('message', (d) => { conn.isAlive = true; this.onMessage(conn, d.toString()); });
    ws.on('error', () => { /* don't crash on a socket error; close handler cleans up */ });
    ws.on('close', () => {
      const code = conn.roomCode;
      if (code && conn.playerId) this.rooms.get(code)?.removePlayer(conn.playerId);
      this.conns.delete(conn);
      if (code) { this.pushState(code); this.reapIfEmpty(code); }
    });
  }

  /** Start the liveness sweep once (on the first connection). Every HEARTBEAT_MS: terminate any socket
   *  that didn't pong since the last sweep (truly dead), then ping the rest — the ping is also what
   *  keeps idle intermediaries from closing the connection. */
  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const c of this.conns) {
        if (!c.isAlive) { c.ws.terminate(); continue; }   // missed the previous ping → drop it
        c.isAlive = false;
        try { c.ws.ping(); } catch { /* terminating socket; close handler cleans up */ }
      }
    }, this.heartbeatMs);
    // Don't let the heartbeat keep the process alive on its own (Node): unref if available.
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  private onMessage(conn: Conn, raw: string): void {
    const msg = parseBattleClientMessage(raw);
    if (msg.type === 'error') { this.send(conn, msg); return; }
    switch (msg.type) {
      case 'join': {
        const room = this.room(msg.roomCode);
        const res = room.addPlayer(msg.name);
        if ('error' in res) { this.send(conn, { type: 'error', code: res.error, message: res.error }); return; }
        conn.roomCode = msg.roomCode; conn.playerId = res.playerId;
        this.send(conn, { type: 'joined', playerId: res.playerId, roomCode: msg.roomCode });
        this.pushState(msg.roomCode);
        break;
      }
      case 'spectate': {
        this.room(msg.roomCode);
        conn.roomCode = msg.roomCode;   // display / spectator: no slot
        this.pushState(msg.roomCode);
        break;
      }
      case 'select_monster':
        this.withRoom(conn, (room) => { if (conn.playerId) { room.selectMonster(conn.playerId, msg.monsterId); this.pushState(room.code); } });
        break;
      case 'choose_move':
        this.withRoom(conn, (room) => {
          if (conn.playerId) this.commitTurn(room, () => room.chooseMove(conn.playerId!, msg.moveId));
        });
        break;
      case 'choose_action':
        this.withRoom(conn, (room) => {
          if (conn.playerId) this.commitTurn(room, () => room.chooseAction(conn.playerId!, msg.action));
        });
        break;
      case 'advance':
        this.withRoom(conn, (room) => { room.advance(); this.flushEvents(room); this.pushState(room.code); });
        break;
      case 'back':
        this.withRoom(conn, (room) => { room.back(); this.pushState(room.code); });
        break;
      case 'leave':
        this.withRoom(conn, (room) => {
          if (conn.playerId) { room.removePlayer(conn.playerId); conn.playerId = undefined; this.pushState(room.code); this.reapIfEmpty(room.code); }
        });
        break;
    }
  }

  private withRoom(conn: Conn, fn: (room: BattleRoom) => void): void {
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
    if (room) fn(room);
  }

  /** Commit a player's turn action (via `commit`), then flush events + push state; in single-player,
   *  schedule the CPU's deferred beat if it still owes a move. Shared by choose_move + choose_action. */
  private commitTurn(room: BattleRoom, commit: () => void): void {
    commit();
    this.flushEvents(room);       // any events from a 2P turn resolving…
    this.pushState(room.code);    // …then state (shows "you chose — waiting" if AI still owes)
    if (room.aiPending()) this.scheduleAiTurn(room.code);
  }

  /** Rooms with a scheduled AI turn (avoids double-scheduling if extra pushes arrive). */
  private aiTimers = new Set<string>();
  /** After the human commits, take the CPU's turn a beat later so it reads as a separate move:
   *  the "Waiting for Rival…" state is already on screen; ~700ms later the rival attacks + resolves. */
  private scheduleAiTurn(roomCode: string): void {
    if (this.aiTimers.has(roomCode)) return;
    this.aiTimers.add(roomCode);
    setTimeout(() => {
      this.aiTimers.delete(roomCode);
      const room = this.rooms.get(roomCode);
      if (!room) return;
      room.resolveAiTurn();
      this.flushEvents(room);
      this.pushState(roomCode);
    }, 700);
  }

  /** Push the current battle_state to every connection watching a room. Sent on every change (join,
   *  pick, resolved turn) — the client is a pure function of this. */
  private pushState(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const res = room.result();
    const msg: BattleServerMessage = {
      type: 'battle_state', roomCode, phase: room.phase,
      players: room.lobbyPlayers(), snapshot: room.snapshot(),
      result: res ? { winner: res.winner, winnerName: res.winnerName } : null,
    };
    for (const c of this.conns) if (c.roomCode === roomCode) this.send(c, msg);
  }

  /** Drain the room's ordered battle events → screen (as battle_events) + voice layer. Sent BEFORE
   *  the settled state so the renderer can animate the hits, then snap to the final HP. */
  private flushEvents(room: BattleRoom): void {
    const events = room.drainEvents();
    if (!events.length) return;
    for (const c of this.conns) if (c.roomCode === room.code) this.send(c, { type: 'battle_events', events });
    this.onRoomEvents?.(room.code, events);
  }

  // ── VOICE API ──────────────────────────────────────────────────────────────────────────────────
  // Callable from the HTTP server's Conversation Relay adapter so a phone caller drives a battle by
  // voice. Each mutates the room + broadcasts to the display EXACTLY like the equivalent WS message,
  // so a voice pick/action shows on screen identically. Room is created on demand (the caller may
  // arrive before any browser opens the display).
  getOrCreateRoom(code: string): BattleRoom { return this.room(code); }

  /** A caller joins `code` as a player. Returns the new playerId, or null if the room is full. */
  voiceJoin(code: string, name: string): string | null {
    const room = this.room(code);
    const res = room.addPlayer(name);
    if ('error' in res) return null;
    this.pushState(code);
    return res.playerId;
  }
  voiceLeave(code: string, playerId: string): void {
    const room = this.rooms.get(code); if (!room) return;
    room.removePlayer(playerId); this.pushState(code); this.reapIfEmpty(code);
  }
  voiceSetName(code: string, playerId: string, name: string): void {
    const room = this.rooms.get(code); if (!room) return;
    room.setPlayerInfo(playerId, { name }); this.pushState(code);
  }
  voiceSelectMonster(code: string, playerId: string, monsterId: string): void {
    const room = this.rooms.get(code); if (!room) return;
    room.selectMonster(playerId, monsterId); this.pushState(code);
  }
  /** Commit a voice-driven turn action; resolves + schedules the AI beat exactly like the WS path. */
  voiceChooseAction(code: string, playerId: string, action: BattleAction): void {
    const room = this.rooms.get(code); if (!room) return;
    this.commitTurn(room, () => room.chooseAction(playerId, action));
  }
  voiceAdvance(code: string): void {
    const room = this.rooms.get(code); if (!room) return;
    room.advance(); this.flushEvents(room); this.pushState(code);
  }

  private reapIfEmpty(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room || !room.isEmpty) return;
    for (const c of this.conns) if (c.roomCode === roomCode) return;   // a spectator still watching
    this.rooms.delete(roomCode);
  }

  private send(conn: Conn, msg: BattleServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
  }
  stopLoopOnly(): void {
    this.stopHeartbeat();
    for (const c of this.conns) c.ws.close();
    this.conns.clear();
  }
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.stopHeartbeat();
      for (const c of this.conns) c.ws.close();
      this.conns.clear();
      if (this.wss) this.wss.close(() => resolve()); else resolve();
    });
  }
}
