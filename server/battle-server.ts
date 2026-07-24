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
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';

interface Conn { ws: WebSocket; roomCode?: string; playerId?: string; sessionId?: string; isAlive: boolean; locale?: SupportedLocale; stationDisplay?: boolean; hostAuthorized?: boolean; }
interface PlayerSession {
  roomCode: string;
  playerId: string;
  conn: Conn | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}

// How often we ping idle battle sockets. Battle traffic is event-driven (a push only on a change), so
// a player sitting on the monster-select screen sends/receives nothing — without a heartbeat an idle
// proxy/browser closes the socket after ~60s, the server drops the player, the room resets to lobby,
// and the reconnect lands in an empty lobby (the "select screen reverts to play-here" bug). 30s keeps
// it comfortably under typical idle-timeout windows.
const HEARTBEAT_MS = 30_000;
const PLAYER_RECONNECT_GRACE_MS = 30_000;

export class BattleServer {
  private wss: WebSocketServer | null = null;
  private conns = new Set<Conn>();
  private rooms = new Map<string, BattleRoom>();
  private playerSessions = new Map<string, PlayerSession>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private seedCounter = 0x1234abcd;
  private readonly port: number | undefined;
  private readonly heartbeatMs: number;
  /** Fired with a room's drained battle events (super-effective/faint/win) so the voice layer speaks
   *  the caller-relevant ones — mirrors the racer's onRoomEvents seam. */
  private onRoomEvents: ((roomCode: string, events: BattleEvent[]) => void) | null = null;
  private onRoomState: ((roomCode: string) => void) | null = null;
  private allowBrowserPlayer: (roomCode: string) => boolean = () => true;
  private readonly displayToken: string;

  constructor(opts: { port?: number; server?: HttpServer; heartbeatMs?: number; displayToken?: string }) {
    this.port = opts.port;
    this.displayToken = opts.displayToken?.trim() ?? '';
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;   // overridable so tests can drive fast sweeps
    if (opts.server) this.attach(opts.server);
  }

  setOnRoomEvents(fn: (roomCode: string, events: BattleEvent[]) => void): void { this.onRoomEvents = fn; }
  setOnRoomState(fn: (roomCode: string) => void): void { this.onRoomState = fn; }
  setBrowserPlayerAdmission(fn: (roomCode: string) => boolean): void { this.allowBrowserPlayer = fn; }

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
  anonymizePlayer(code: string, playerId: string): void {
    const room=this.rooms.get(code);if(!room)return;room.anonymizePlayer(playerId);this.pushState(code);
  }
  /** Live WS connections (displays + device players). The voice router uses this to auto-join a caller
   *  to Voice Monsters when its display is the one that's open. */
  get connectionCount(): number { return this.conns.size; }
  preferredLocale(roomCode?: string, fallback: SupportedLocale = DEFAULT_LOCALE): SupportedLocale {
    const matching = [...this.conns].filter(conn => (!roomCode || conn.roomCode === roomCode) && conn.locale);
    return matching.find(conn => !conn.playerId)?.locale ?? matching[0]?.locale ?? fallback;
  }

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
      if (code && conn.playerId && !this.holdPlayerForReconnect(conn)) this.rooms.get(code)?.removePlayer(conn.playerId);
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
    if (conn.stationDisplay && !conn.hostAuthorized && msg.type !== 'spectate' && msg.type !== 'leave') {
      this.send(conn, { type: 'error', code: 'bad_display_auth', message: 'bad_display_auth' }); return;
    }
    switch (msg.type) {
      case 'join': {
        if (msg.locale) conn.locale = msg.locale;
        if (!this.allowBrowserPlayer(msg.roomCode)) {
          this.send(conn, { type: 'error', code: 'station_voice_only', message: 'station_voice_only' }); return;
        }
        if (conn.playerId && conn.roomCode) {
          this.send(conn, { type: 'joined', playerId: conn.playerId, roomCode: conn.roomCode });
          this.pushState(conn.roomCode);
          break;
        }
        if (msg.sessionId) {
          const resumed = this.resumePlayerSession(msg.roomCode, msg.sessionId, conn);
          if (resumed) {
            this.send(conn, { type: 'joined', playerId: resumed, roomCode: msg.roomCode });
            this.pushState(msg.roomCode);
            break;
          }
        }
        const room = this.room(msg.roomCode);
        const res = room.addPlayer(msg.name);
        if ('error' in res) { this.send(conn, { type: 'error', code: res.error, message: res.error }); return; }
        conn.roomCode = msg.roomCode; conn.playerId = res.playerId; conn.sessionId = msg.sessionId;
        if (msg.sessionId) this.rememberPlayerSession(msg.sessionId, conn);
        this.send(conn, { type: 'joined', playerId: res.playerId, roomCode: msg.roomCode });
        this.pushState(msg.roomCode);
        break;
      }
      case 'spectate': {
        if (msg.locale) conn.locale = msg.locale;
        if (conn.playerId) { this.send(conn, { type: 'error', code: 'already_joined', message: 'leave before spectating' }); return; }
        const stationDisplay = !this.allowBrowserPlayer(msg.roomCode);
        if (stationDisplay && (!this.displayToken || msg.displayToken !== this.displayToken)) {
          this.send(conn, { type: 'error', code: 'bad_display_auth', message: 'bad_display_auth' }); return;
        }
        conn.stationDisplay = stationDisplay;
        conn.hostAuthorized = !stationDisplay || msg.displayToken === this.displayToken;
        this.room(msg.roomCode);
        conn.roomCode = msg.roomCode;   // display / spectator: no slot
        this.pushState(msg.roomCode);
        break;
      }
      case 'select_monster':
        this.withRoom(conn, (room) => { if (conn.playerId) { room.selectMonster(conn.playerId, msg.monsterId); this.pushState(room.code); } });
        break;
      case 'open_fight':
        this.withRoom(conn, (room) => { if (conn.playerId) { room.openFightMenu(conn.playerId); this.pushState(room.code); } });
        break;
      case 'back_menu':
        this.withRoom(conn, (room) => { if (conn.playerId) { room.backMenu(conn.playerId); this.pushState(room.code); } });
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
        if (conn.playerId) {
          const playerId = conn.playerId;
          this.withRoom(conn, (room) => {
            this.forgetPlayerSession(conn.sessionId);
            room.removePlayer(playerId); conn.playerId = undefined; conn.sessionId = undefined;
            this.pushState(room.code); this.reapIfEmpty(room.code);
          });
        } else if (msg.sessionId) {
          this.releasePlayerSession(msg.sessionId);
        }
        break;
    }
  }

  private withRoom(conn: Conn, fn: (room: BattleRoom) => void): void {
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
    if (room) fn(room);
  }

  private rememberPlayerSession(sessionId: string, conn: Conn): void {
    const prior = this.playerSessions.get(sessionId);
    if (prior?.leaveTimer) clearTimeout(prior.leaveTimer);
    this.playerSessions.set(sessionId, {
      roomCode: conn.roomCode!, playerId: conn.playerId!, conn, leaveTimer: null,
    });
  }

  private resumePlayerSession(roomCode: string, sessionId: string, conn: Conn): string | null {
    const session = this.playerSessions.get(sessionId);
    if (!session || session.roomCode !== roomCode) return null;
    const room = this.rooms.get(roomCode);
    if (!room?.lobbyPlayers().some(p => p.playerId === session.playerId)) {
      this.forgetPlayerSession(sessionId);
      return null;
    }
    if (session.leaveTimer) { clearTimeout(session.leaveTimer); session.leaveTimer = null; }
    if (session.conn && session.conn !== conn) {
      session.conn.playerId = undefined;
      session.conn.roomCode = undefined;
      session.conn.sessionId = undefined;
      session.conn.ws.close(4001, 'session replaced');
    }
    session.conn = conn;
    conn.roomCode = roomCode; conn.playerId = session.playerId; conn.sessionId = sessionId;
    return session.playerId;
  }

  private holdPlayerForReconnect(conn: Conn): boolean {
    const sessionId = conn.sessionId;
    if (!sessionId) return false;
    const session = this.playerSessions.get(sessionId);
    if (!session || session.conn !== conn) return false;
    if (session.leaveTimer) clearTimeout(session.leaveTimer);
    session.conn = null;
    const leaveTimer = setTimeout(() => {
      const current = this.playerSessions.get(sessionId);
      if (!current || current.conn || current.leaveTimer !== leaveTimer) return;
      this.playerSessions.delete(sessionId);
      const room = this.rooms.get(current.roomCode);
      room?.removePlayer(current.playerId);
      this.pushState(current.roomCode);
      this.reapIfEmpty(current.roomCode);
    }, PLAYER_RECONNECT_GRACE_MS);
    (leaveTimer as { unref?: () => void }).unref?.();
    session.leaveTimer = leaveTimer;
    return true;
  }

  private forgetPlayerSession(sessionId?: string): void {
    if (!sessionId) return;
    const session = this.playerSessions.get(sessionId);
    if (session?.leaveTimer) clearTimeout(session.leaveTimer);
    this.playerSessions.delete(sessionId);
  }

  private releasePlayerSession(sessionId: string): void {
    const session = this.playerSessions.get(sessionId);
    if (!session) return;
    if (session.leaveTimer) clearTimeout(session.leaveTimer);
    this.playerSessions.delete(sessionId);
    this.rooms.get(session.roomCode)?.removePlayer(session.playerId);
    this.pushState(session.roomCode);
    this.reapIfEmpty(session.roomCode);
  }

  /** Commit a player's turn action (via `commit`), then flush events + push state; in single-player,
   *  schedule the CPU's deferred beat if it still owes a move. Shared by choose_move + choose_action. */
  private commitTurn(room: BattleRoom, commit: () => boolean): void {
    if (!commit()) return;
    this.flushEvents(room);       // any events from a 2P turn resolving…
    this.pushState(room.code);    // …then state (shows "you chose — waiting" if AI still owes)
    if (room.aiPending()) this.scheduleAiTurn(room);
  }

  /** One generation/turn-bound AI timer per room. A rematch replaces any stale prior timer. */
  private aiTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; generation: number }>();
  /** After the human commits, take the CPU's turn a beat later so it reads as a separate move:
   *  the "Waiting for Rival…" state is already on screen; ~700ms later the rival attacks + resolves. */
  private scheduleAiTurn(room: BattleRoom): void {
    const roomCode = room.code;
    const generation = room.generation;
    const expectedTurn = room.snapshot()?.turn ?? -1;
    const existing = this.aiTimers.get(roomCode);
    if (existing?.generation === generation) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const scheduled = this.aiTimers.get(roomCode);
      if (!scheduled || scheduled.timer !== timer) return;
      this.aiTimers.delete(roomCode);
      if (this.rooms.get(roomCode) !== room) return;
      if (room.generation !== generation || room.snapshot()?.turn !== expectedTurn || !room.aiPending()) return;
      room.resolveAiTurn();
      this.flushEvents(room);
      this.pushState(roomCode);
    }, 700);
    this.aiTimers.set(roomCode, { timer, generation });
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
      activeSide: room.activeSide(), activeMenu: room.activeMenu(),
      canRematch: room.canRematch,
      result: res ? { winner: res.winner, winnerName: res.winnerName } : null,
    };
    for (const c of this.conns) if (c.roomCode === roomCode) this.send(c, msg);
    this.onRoomState?.(roomCode);
    this.scheduleResultsReady(room);
  }

  private resultsTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleResultsReady(room: BattleRoom): void {
    const existing = this.resultsTimers.get(room.code);
    if (room.phase !== 'results' || room.canRematch) {
      if (existing) { clearTimeout(existing); this.resultsTimers.delete(room.code); }
      return;
    }
    if (existing) return;
    const timer = setTimeout(() => {
      this.resultsTimers.delete(room.code);
      if (this.rooms.get(room.code) === room) this.pushState(room.code);
    }, room.rematchReadyInMs + 5);
    (timer as { unref?: () => void }).unref?.();
    this.resultsTimers.set(room.code, timer);
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

  abortRoom(code: string): boolean {
    const room = this.rooms.get(code);
    if (!room) return false;
    for (const conn of this.conns) {
      if (conn.roomCode !== code) continue;
      conn.roomCode = undefined;
      conn.playerId = undefined;
      conn.sessionId = undefined;
      conn.ws.close(4002, 'station recovery');
    }
    for (const [sessionId, session] of this.playerSessions) {
      if (session.roomCode !== code) continue;
      if (session.leaveTimer) clearTimeout(session.leaveTimer);
      this.playerSessions.delete(sessionId);
    }
    const ai = this.aiTimers.get(code);
    if (ai) clearTimeout(ai.timer);
    this.aiTimers.delete(code);
    const results = this.resultsTimers.get(code);
    if (results) clearTimeout(results);
    this.resultsTimers.delete(code);
    this.rooms.delete(code);
    return true;
  }

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
  voiceOpenFight(code: string, playerId: string): void {
    const room = this.rooms.get(code); if (!room) return;
    room.openFightMenu(playerId); this.pushState(code);
  }
  voiceBackMenu(code: string, playerId: string): void {
    const room = this.rooms.get(code); if (!room) return;
    room.backMenu(playerId); this.pushState(code);
  }
  /** Commit a voice-driven turn action; resolves + schedules the AI beat exactly like the WS path. */
  voiceChooseAction(code: string, playerId: string, action: BattleAction): boolean {
    const room = this.rooms.get(code); if (!room) return false;
    let accepted = false;
    this.commitTurn(room, () => { accepted = room.chooseAction(playerId, action); return accepted; });
    return accepted;
  }
  voiceAdvance(code: string): void {
    const room = this.rooms.get(code); if (!room) return;
    room.advance(); this.flushEvents(room); this.pushState(code);
  }

  private reapIfEmpty(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room || !room.isEmpty) return;
    for (const c of this.conns) if (c.roomCode === roomCode) return;   // a spectator still watching
    const ai = this.aiTimers.get(roomCode);
    if (ai) { clearTimeout(ai.timer); this.aiTimers.delete(roomCode); }
    const results = this.resultsTimers.get(roomCode);
    if (results) { clearTimeout(results); this.resultsTimers.delete(roomCode); }
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
    for (const session of this.playerSessions.values()) if (session.leaveTimer) clearTimeout(session.leaveTimer);
    this.playerSessions.clear();
    for (const { timer } of this.aiTimers.values()) clearTimeout(timer);
    this.aiTimers.clear();
    for (const timer of this.resultsTimers.values()) clearTimeout(timer);
    this.resultsTimers.clear();
    for (const c of this.conns) c.ws.close();
    this.conns.clear();
  }
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.stopHeartbeat();
      for (const session of this.playerSessions.values()) if (session.leaveTimer) clearTimeout(session.leaveTimer);
      this.playerSessions.clear();
      for (const { timer } of this.aiTimers.values()) clearTimeout(timer);
      this.aiTimers.clear();
      for (const timer of this.resultsTimers.values()) clearTimeout(timer);
      this.resultsTimers.clear();
      for (const c of this.conns) c.ws.close();
      this.conns.clear();
      if (this.wss) this.wss.close(() => resolve()); else resolve();
    });
  }
}
