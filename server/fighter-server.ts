import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { FighterRoom } from './fighter-room';
import { FIGHTER_MAPS, FIGHTER_ROSTER } from '../shared/fighter-roster';
import { parseFighterClientMessage, type FighterServerMessage } from '../shared/fighter-protocol';
import type { FighterCommand, FighterEvent } from '../shared/fighter-world';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';

interface Conn { ws: WebSocket; roomCode?: string; playerId?: string; sessionId?: string; display?: boolean; hostAuthorized?: boolean; locale?: SupportedLocale; }
interface Session {
  roomCode: string; playerId: string; conn: Conn | null; timer: ReturnType<typeof setTimeout> | null;
  display: boolean; wasHost: boolean;
}
const RECONNECT_MS = 30_000;

export class FighterServer {
  private wss: WebSocketServer;
  private conns = new Set<Conn>();
  private rooms = new Map<string, FighterRoom>();
  private sessions = new Map<string, Session>();
  private hosts = new Map<string, Conn>();
  private loop: ReturnType<typeof setInterval>;
  private lastTick = Date.now();
  private seed = 0x65ab12ef;
  private maps = FIGHTER_MAPS;
  private onRoomEvents: ((code: string, events: FighterEvent[]) => void) | null = null;
  private onRoomState: ((code: string) => void) | null = null;

  private readonly displayToken: string;

  constructor(opts: { server: HttpServer; displayToken?: string }) {
    this.displayToken = opts.displayToken?.trim() ?? '';
    this.wss = new WebSocketServer({ noServer: true });
    this.loop = setInterval(() => this.tick(), 50);
    (this.loop as { unref?: () => void }).unref?.();
  }
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, ws => this.onConnection(ws));
  }
  get connectionCount(): number { return this.conns.size; }
  preferredLocale(roomCode?: string, fallback: SupportedLocale = DEFAULT_LOCALE): SupportedLocale {
    const matching = [...this.conns].filter(conn => (!roomCode || conn.roomCode === roomCode) && conn.locale);
    return matching.find(conn => conn.display)?.locale ?? matching[0]?.locale ?? fallback;
  }
  getOrCreateRoom(code: string): FighterRoom { return this.room(canonicalRoomCode(code)); }
  findRoom(code: string): FighterRoom | undefined { return this.rooms.get(canonicalRoomCode(code)); }
  setOnRoomEvents(fn: (code: string, events: FighterEvent[]) => void): void { this.onRoomEvents = fn; }
  setOnRoomState(fn: (code: string) => void): void { this.onRoomState = fn; }
  setMaps(maps: typeof FIGHTER_MAPS): void {
    if (!maps.length) return;
    this.maps = maps; for (const room of this.rooms.values()) room.setMaps(maps);
    for (const conn of this.conns) this.send(conn, { type: 'fighter_roster', fighters: FIGHTER_ROSTER, maps: this.maps });
  }

  private room(code: string): FighterRoom {
    let room = this.rooms.get(code);
    if (!room) { room = new FighterRoom(code, this.seed = (this.seed + 0x9e3779b9) >>> 0, this.maps); this.rooms.set(code, room); }
    return room;
  }
  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws };
    this.conns.add(conn);
    this.send(conn, { type: 'fighter_capabilities', displayAuth: Boolean(this.displayToken) });
    this.send(conn, { type: 'fighter_roster', fighters: FIGHTER_ROSTER, maps: this.maps });
    ws.on('message', data => this.onMessage(conn, data.toString()));
    ws.on('error', () => {});
    ws.on('close', () => {
      const code = conn.roomCode;
      if (conn.playerId && code && !this.holdSession(conn)) this.rooms.get(code)?.removePlayer(conn.playerId);
      this.conns.delete(conn);
      if (code) {
        if (this.hosts.get(code) === conn) { this.hosts.delete(code); this.designateHost(code); }
        this.pushState(code); this.reap(code);
      }
    });
  }
  private onMessage(conn: Conn, raw: string): void {
    const msg = parseFighterClientMessage(raw);
    if (msg.type === 'error') { this.send(conn, msg); return; }
    if (msg.type === 'join') {
      if (msg.locale) conn.locale = msg.locale;
      const code = canonicalRoomCode(msg.roomCode);
      if (conn.playerId && conn.roomCode) { this.send(conn, { type: 'joined', playerId: conn.playerId, roomCode: conn.roomCode }); return; }
      if (conn.roomCode && conn.roomCode !== code) this.detachDisplay(conn);
      if (msg.sessionId && this.resume(code, msg.sessionId, conn)) {
        this.send(conn, { type: 'joined', playerId: conn.playerId!, roomCode: code }); this.pushHostIdentity(code); this.pushState(code); return;
      }
      const result = this.room(code).addPlayer(msg.name);
      if ('error' in result) { this.send(conn, { type: 'error', code: result.error, message: result.error }); return; }
      conn.roomCode = code; conn.playerId = result.playerId; conn.sessionId = msg.sessionId;
      if (msg.sessionId) this.sessions.set(sessionKey(code, msg.sessionId), {
        roomCode: code, playerId: result.playerId, conn, timer: null,
        display: conn.display === true, wasHost: this.hosts.get(code) === conn,
      });
      this.send(conn, { type: 'joined', playerId: result.playerId, roomCode: code }); this.pushHostIdentity(code); this.pushState(code); return;
    }
    if (msg.type === 'display_auth') {
      const code = canonicalRoomCode(msg.roomCode);
      if (!this.displayToken || msg.token !== this.displayToken) {
        this.send(conn, { type: 'error', code: 'bad_display_auth', message: 'Invalid display token.' }); return;
      }
      conn.hostAuthorized = true;
      if (conn.roomCode === code && conn.display && !this.hosts.has(code)) { this.hosts.set(code, conn); this.pushHostIdentity(code); }
      return;
    }
    if (msg.type === 'spectate') {
      if (msg.locale) conn.locale = msg.locale;
      if (conn.playerId) { this.send(conn, { type: 'error', code: 'already_joined', message: 'Leave before spectating.' }); return; }
      const code = canonicalRoomCode(msg.roomCode);
      if (conn.roomCode && conn.roomCode !== code) this.detachDisplay(conn);
      conn.roomCode = code; conn.display = true; this.room(code);
      if (!this.hosts.has(code) && (!this.displayToken || conn.hostAuthorized)) this.hosts.set(code, conn);
      this.pushHostIdentity(code); this.pushState(code); return;
    }
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
    if (!room) return;
    const isHost = this.hosts.get(room.code) === conn;
    switch (msg.type) {
      case 'select_fighter': {
        // A display can also own a local keyboard player. In that case card clicks always edit its
        // own pick; spectator-only hosts fill the next unselected phone caller.
        const target = conn.playerId ?? (isHost ? room.nextUnselectedPlayerId() : undefined);
        if (!target) { this.rejectAuthority(conn); break; }
        if (target && !room.selectFighter(target, msg.fighterId)) this.send(conn, { type: 'error', code: 'select_rejected', message: 'That fighter is unavailable.' });
        break;
      }
      case 'select_map':
        if (!isHost) this.rejectAuthority(conn);
        else if (!room.selectMap(msg.mapId)) this.send(conn, { type: 'error', code: 'select_rejected', message: 'That map is unavailable.' });
        break;
      case 'command': if (conn.playerId) room.command(conn.playerId, msg.command); break;
      case 'advance':
        if (!isHost) this.rejectAuthority(conn);
        else if (!room.advance()) this.send(conn, { type: 'error', code: 'not_ready', message: 'Complete the current selection first.' });
        break;
      case 'ready':
        if (!isHost) this.rejectAuthority(conn);
        else if (!room.ready(msg.loadingGeneration)) this.send(conn, { type: 'error', code: 'stale_ready', message: 'The arena is not awaiting this ready signal.' });
        break;
      case 'back': if (!isHost) this.rejectAuthority(conn); else room.back(); break;
      case 'leave':
        if (conn.playerId) {
          room.removePlayer(conn.playerId);
          if (conn.sessionId) this.dropSession(room.code, conn.sessionId, conn);
          conn.playerId = undefined; conn.sessionId = undefined;
        }
        break;
      default: break;
    }
    this.flush(room);
    if (room.phase === 'loading') this.pushHostIdentity(room.code);
    this.pushState(room.code); this.reap(room.code);
  }
  private tick(): void {
    const now = Date.now(); const delta = Math.min((now - this.lastTick) / 1000, 0.1); this.lastTick = now;
    for (const room of this.rooms.values()) {
      if (room.phase !== 'loading' && room.phase !== 'intro' && room.phase !== 'fight' && room.phase !== 'countdown' && room.phase !== 'victory') continue;
      room.tick(delta); this.flush(room); this.pushState(room.code);
    }
  }
  private flush(room: FighterRoom): void {
    const events = room.drainEvents(); if (!events.length) return;
    for (const conn of this.conns) if (conn.roomCode === room.code) this.send(conn, { type: 'fighter_events', events });
    this.onRoomEvents?.(room.code, events);
  }
  private pushState(code: string): void {
    const room = this.rooms.get(code); if (!room) return;
    const msg: FighterServerMessage = { type: 'fighter_state', ...room.state() };
    for (const conn of this.conns) if (conn.roomCode === code) this.send(conn, msg);
    this.onRoomState?.(code);
  }
  private send(conn: Conn, message: FighterServerMessage): void { if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(message)); }

  private resume(code: string, id: string, conn: Conn): boolean {
    const key = sessionKey(code, id); const session = this.sessions.get(key);
    if (!session) return false;
    if (!this.rooms.get(code)?.hasPlayer(session.playerId)) { this.sessions.delete(key); return false; }
    if (session.timer) clearTimeout(session.timer);
    conn.display = session.display;
    if (session.conn && session.conn !== conn) {
      const old = session.conn;
      if (this.hosts.get(code) === old) this.hosts.set(code, conn);
      old.playerId = undefined; old.sessionId = undefined; old.ws.close(4001, 'session replaced');
    }
    if (session.wasHost && !this.hosts.has(code)) this.hosts.set(code, conn);
    session.conn = conn; session.timer = null; conn.roomCode = code; conn.playerId = session.playerId; conn.sessionId = id; return true;
  }
  private holdSession(conn: Conn): boolean {
    if (!conn.sessionId || !conn.roomCode) return false;
    const key = sessionKey(conn.roomCode, conn.sessionId); const session = this.sessions.get(key); if (!session || session.conn !== conn) return false;
    session.conn = null; session.display = conn.display === true; session.wasHost = this.hosts.get(conn.roomCode) === conn;
    session.timer = setTimeout(() => this.release(key), RECONNECT_MS);
    (session.timer as { unref?: () => void }).unref?.(); return true;
  }
  private release(key: string): void {
    const session = this.sessions.get(key); if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(key); this.rooms.get(session.roomCode)?.removePlayer(session.playerId); this.pushState(session.roomCode); this.reap(session.roomCode);
  }

  private dropSession(code: string, id: string, owner: Conn): void {
    const key = sessionKey(code, id); const session = this.sessions.get(key);
    if (!session || session.conn !== owner) return;
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(key);
  }

  private rejectAuthority(conn: Conn): void { this.send(conn, { type: 'error', code: 'forbidden', message: 'This connection cannot control the display.' }); }
  private detachDisplay(conn: Conn): void {
    const code = conn.roomCode; if (!code) return;
    conn.roomCode = undefined; conn.display = false;
    if (this.hosts.get(code) === conn) { this.hosts.delete(code); this.designateHost(code); }
    this.pushState(code); this.reap(code);
  }
  private designateHost(code: string): void {
    const next = [...this.conns].find(candidate => candidate.roomCode === code && candidate.display
      && (!this.displayToken || candidate.hostAuthorized) && candidate.ws.readyState === WebSocket.OPEN);
    if (next) this.hosts.set(code, next);
    this.pushHostIdentity(code);
  }
  private pushHostIdentity(code: string): void {
    const loadingGeneration = this.rooms.get(code)?.state().loadingGeneration ?? 0;
    for (const candidate of this.conns) if (candidate.roomCode === code) {
      this.send(candidate, { type: 'host_identity', roomCode: code, isHost: this.hosts.get(code) === candidate, loadingGeneration });
    }
  }
  private reap(code: string): void {
    const room = this.rooms.get(code); if (!room?.isEmpty) return;
    if ([...this.conns].some(conn => conn.roomCode === code)) return;
    if ([...this.sessions.values()].some(session => session.roomCode === code)) return;
    this.hosts.delete(code); this.rooms.delete(code);
  }

  voiceJoin(code: string, name: string): string | null { code = canonicalRoomCode(code); const result = this.room(code).addPlayer(name); if ('error' in result) return null; this.pushState(code); return result.playerId; }
  voiceLeave(code: string, id: string): void { code = canonicalRoomCode(code); this.rooms.get(code)?.removePlayer(id); this.pushState(code); this.reap(code); }
  voiceSetName(code: string, id: string, name: string): void { code = canonicalRoomCode(code); this.rooms.get(code)?.setName(id, name); this.pushState(code); }
  voiceSelectFighter(code: string, id: string, fighterId: string): boolean { code = canonicalRoomCode(code); const ok = this.rooms.get(code)?.selectFighter(id, fighterId) ?? false; this.pushState(code); return ok; }
  voiceSelectMap(code: string, id: string, mapId: string): boolean {
    code = canonicalRoomCode(code); const room = this.rooms.get(code);
    const ok = !!room?.canControlSetup(id) && room.selectMap(mapId); this.pushState(code); return ok;
  }
  voiceAdvance(code: string, id: string): boolean {
    code = canonicalRoomCode(code); const room = this.rooms.get(code);
    const ok = !!room?.canControlSetup(id) && room.advance();
    if (room?.phase === 'loading') this.pushHostIdentity(code);
    this.pushState(code); return ok;
  }
  voiceCommand(code: string, id: string, command: FighterCommand): boolean {
    code = canonicalRoomCode(code); const room = this.rooms.get(code); if (!room) return false;
    const accepted = room.voiceCommand(id, command); this.flush(room); this.pushState(code); return accepted;
  }
  releaseBrowserSession(code: string, sessionId: string): boolean {
    const key = sessionKey(canonicalRoomCode(code), sessionId);
    if (!this.sessions.has(key)) return false;
    this.release(key); return true;
  }

  stopLoopOnly(): void {
    clearInterval(this.loop); for (const session of this.sessions.values()) if (session.timer) clearTimeout(session.timer);
    this.sessions.clear(); this.hosts.clear(); for (const conn of this.conns) conn.ws.close(); this.conns.clear();
  }
}

function canonicalRoomCode(code: string): string { return code.trim().toUpperCase(); }
function sessionKey(code: string, id: string): string { return `${code}\u0000${id}`; }
