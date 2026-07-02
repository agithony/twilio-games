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
import type { BattleEvent } from '../shared/battle-world';

interface Conn { ws: WebSocket; roomCode?: string; playerId?: string; }

export class BattleServer {
  private wss: WebSocketServer | null = null;
  private conns = new Set<Conn>();
  private rooms = new Map<string, BattleRoom>();
  private seedCounter = 0x1234abcd;
  private readonly port: number | undefined;
  /** Fired with a room's drained battle events (super-effective/faint/win) so the voice layer speaks
   *  the caller-relevant ones — mirrors the racer's onRoomEvents seam. */
  private onRoomEvents: ((roomCode: string, events: BattleEvent[]) => void) | null = null;

  constructor(opts: { port?: number; server?: HttpServer }) {
    this.port = opts.port;
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

  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws };
    this.conns.add(conn);
    // The select screen needs the roster immediately (client renders creature cards from it).
    this.send(conn, { type: 'roster', monsters: rosterEntries() });
    ws.on('message', (d) => this.onMessage(conn, d.toString()));
    ws.on('error', () => { /* don't crash on a socket error; close handler cleans up */ });
    ws.on('close', () => {
      const code = conn.roomCode;
      if (code && conn.playerId) this.rooms.get(code)?.removePlayer(conn.playerId);
      this.conns.delete(conn);
      if (code) { this.pushState(code); this.reapIfEmpty(code); }
    });
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
          if (!conn.playerId) return;
          room.chooseMove(conn.playerId, msg.moveId);
          this.flushEvents(room);       // ordered animation/commentary events first…
          this.pushState(room.code);    // …then the settled state
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

  private reapIfEmpty(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room || !room.isEmpty) return;
    for (const c of this.conns) if (c.roomCode === roomCode) return;   // a spectator still watching
    this.rooms.delete(roomCode);
  }

  private send(conn: Conn, msg: BattleServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  stopLoopOnly(): void {
    for (const c of this.conns) c.ws.close();
    this.conns.clear();
  }
  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const c of this.conns) c.ws.close();
      this.conns.clear();
      if (this.wss) this.wss.close(() => resolve()); else resolve();
    });
  }
}
