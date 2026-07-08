// Client WebSocket for Voice Monsters (/battle). Mirrors net.ts (GameConnection): auto-reconnect with
// backoff + identity replay, typed callbacks. Turn-based, so it just relays battle_state / roster /
// battle_events rather than a snapshot stream.
import type { BattleServerMessage, RosterEntry, BattleLobbyPlayer } from '../../shared/battle-protocol';
import type { BattleSnapshot, BattleEvent, BattleAction } from '../../shared/battle-world';

export interface BattleStateMsg {
  roomCode: string; phase: string; players: BattleLobbyPlayer[];
  snapshot: BattleSnapshot | null; result: { winner: string; winnerName: string } | null;
  activeSide?: 'a' | 'b' | null; activeMenu?: 'root' | 'fight';
}

export class BattleConnection {
  private ws!: WebSocket;
  private closed = false;
  private backoff = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private identity: { type: 'join'; roomCode: string; name: string } | { type: 'spectate'; roomCode: string } | null = null;

  private onRosterCb?: (m: RosterEntry[]) => void;
  private onStateCb?: (m: BattleStateMsg) => void;
  private onEventsCb?: (e: BattleEvent[]) => void;
  private onJoinedCb?: (playerId: string) => void;
  private onErrorCb?: (code: string, message: string) => void;

  constructor(private url: string) { this.connect(); }

  private connect(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data) as BattleServerMessage;
      if (m.type === 'roster') this.onRosterCb?.(m.monsters);
      else if (m.type === 'battle_state') this.onStateCb?.(m);
      else if (m.type === 'battle_events') this.onEventsCb?.(m.events);
      else if (m.type === 'joined') this.onJoinedCb?.(m.playerId);
      else if (m.type === 'error') this.onErrorCb?.(m.code, m.message);
    };
    this.ws.onopen = () => { this.backoff = 500; if (this.identity) this.rawSend(this.identity); };
    this.ws.onclose = () => { if (!this.closed) this.scheduleReconnect(); };
    this.ws.onerror = () => { /* onclose drives retry */ };
  }
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.backoff; this.backoff = Math.min(this.backoff * 2, 8000);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }
  private rawSend(o: unknown): void { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }
  private send(o: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
    else this.ws.addEventListener('open', () => this.ws.send(JSON.stringify(o)), { once: true });
  }

  // join/spectate set the IDENTITY (the single source of truth, replayed on every (re)connect by
  // onopen). If the socket is already open, send it once now; otherwise onopen will. Do NOT also go
  // through send()'s open-listener queue, or the join fires TWICE → two player slots → a room stuck
  // waiting on a phantom 2nd player (the "stuck on waiting…" bug).
  join(roomCode: string, name: string) { this.identity = { type: 'join', roomCode, name }; this.rawSend(this.identity); }
  spectate(roomCode: string) { this.identity = { type: 'spectate', roomCode }; this.rawSend(this.identity); }
  /** Drop this client's player slot but keep watching (the shared screen's P-toggle-off). Reverts the
   *  replayed identity to spectator so a reconnect doesn't silently rejoin as a player. */
  leave(roomCode: string) { this.identity = { type: 'spectate', roomCode }; this.send({ type: 'leave' }); }
  selectMonster(monsterId: string) { this.send({ type: 'select_monster', monsterId }); }
  openFight() { this.send({ type: 'open_fight' }); }
  backMenu() { this.send({ type: 'back_menu' }); }
  chooseMove(moveId: string) { this.send({ type: 'choose_move', moveId }); }
  chooseAction(action: BattleAction) { this.send({ type: 'choose_action', action }); }
  advance() { this.send({ type: 'advance' }); }
  back() { this.send({ type: 'back' }); }

  onRoster(cb: (m: RosterEntry[]) => void) { this.onRosterCb = cb; }
  onState(cb: (m: BattleStateMsg) => void) { this.onStateCb = cb; }
  onEvents(cb: (e: BattleEvent[]) => void) { this.onEventsCb = cb; }
  onJoined(cb: (playerId: string) => void) { this.onJoinedCb = cb; }
  onError(cb: (code: string, message: string) => void) { this.onErrorCb = cb; }

  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws.close(); } catch { /* already closing */ }
  }
}
