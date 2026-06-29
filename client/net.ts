import type { Intent, Item, WorldSnapshot, GameEvent, LobbyPlayer, Phase, RaceResult } from '../shared/types';

export interface LobbyMsg { roomCode: string; players: LobbyPlayer[]; phase: Phase }
export interface SelectStateMsg { roomCode: string; phase: Phase; players: LobbyPlayer[]; maps: string[]; selectedMap: string | null }
export interface ResultsMsg { roomCode: string; map: string | null; results: RaceResult[] }

export class GameConnection {
  private ws: WebSocket;
  private onItemsCb?: (items: Item[]) => void;
  private onSnapCb?: (s: WorldSnapshot) => void;
  private onEventCb?: (e: GameEvent) => void;
  private onJoinedCb?: (playerId: string, lane: number) => void;
  private onErrorCb?: (code: string, message: string) => void;
  private onLobbyCb?: (msg: LobbyMsg) => void;
  private onSelectCb?: (msg: SelectStateMsg) => void;
  private onResultsCb?: (msg: ResultsMsg) => void;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'items') this.onItemsCb?.(m.items);
      else if (m.type === 'snapshot') this.onSnapCb?.(m.snapshot);
      else if (m.type === 'event') this.onEventCb?.(m.event);
      else if (m.type === 'joined') this.onJoinedCb?.(m.playerId, m.lane);
      else if (m.type === 'error') this.onErrorCb?.(m.code, m.message);
      else if (m.type === 'lobby') this.onLobbyCb?.(m);
      else if (m.type === 'select_state') this.onSelectCb?.(m);
      else if (m.type === 'results') this.onResultsCb?.(m);
    };
  }
  private send(o: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
    else this.ws.addEventListener('open', () => this.ws.send(JSON.stringify(o)), { once: true });
  }
  join(roomCode: string, name: string) { this.send({ type: 'join', roomCode, name }); }
  spectate(roomCode: string) { this.send({ type: 'spectate', roomCode }); }
  ready() { this.send({ type: 'ready' }); }
  restart() { this.send({ type: 'restart' }); }
  sendIntent(i: Intent) { this.send({ type: 'intent', intent: i }); }
  // Smash-style flow
  selectCar(carIndex: number) { this.send({ type: 'select_car', carIndex }); }
  selectMap(map: string) { this.send({ type: 'select_map', map }); }
  advance() { this.send({ type: 'advance' }); }
  back() { this.send({ type: 'back' }); }

  onItems(cb: (items: Item[]) => void) { this.onItemsCb = cb; }
  onSnapshot(cb: (s: WorldSnapshot) => void) { this.onSnapCb = cb; }
  onEvent(cb: (e: GameEvent) => void) { this.onEventCb = cb; }
  onJoined(cb: (playerId: string, lane: number) => void) { this.onJoinedCb = cb; }
  onError(cb: (code: string, message: string) => void) { this.onErrorCb = cb; }
  onLobby(cb: (msg: LobbyMsg) => void) { this.onLobbyCb = cb; }
  onSelectState(cb: (msg: SelectStateMsg) => void) { this.onSelectCb = cb; }
  onResults(cb: (msg: ResultsMsg) => void) { this.onResultsCb = cb; }
}
