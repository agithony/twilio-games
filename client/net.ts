import type { Intent, Item, WorldSnapshot, GameEvent } from '../shared/types';

export class GameConnection {
  private ws: WebSocket;
  private onItemsCb?: (items: Item[]) => void;
  private onSnapCb?: (s: WorldSnapshot) => void;
  private onEventCb?: (e: GameEvent) => void;
  private onJoinedCb?: (playerId: string, lane: number) => void;
  private onErrorCb?: (code: string, message: string) => void;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'items') this.onItemsCb?.(m.items);
      else if (m.type === 'snapshot') this.onSnapCb?.(m.snapshot);
      else if (m.type === 'event') this.onEventCb?.(m.event);
      else if (m.type === 'joined') this.onJoinedCb?.(m.playerId, m.lane);
      else if (m.type === 'error') this.onErrorCb?.(m.code, m.message);
    };
  }
  private send(o: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
    else this.ws.addEventListener('open', () => this.ws.send(JSON.stringify(o)), { once: true });
  }
  join(roomCode: string, name: string) { this.send({ type: 'join', roomCode, name }); }
  ready() { this.send({ type: 'ready' }); }
  restart() { this.send({ type: 'restart' }); }
  sendIntent(i: Intent) { this.send({ type: 'intent', intent: i }); }
  onItems(cb: (items: Item[]) => void) { this.onItemsCb = cb; }
  onSnapshot(cb: (s: WorldSnapshot) => void) { this.onSnapCb = cb; }
  onEvent(cb: (e: GameEvent) => void) { this.onEventCb = cb; }
  onJoined(cb: (playerId: string, lane: number) => void) { this.onJoinedCb = cb; }
  onError(cb: (code: string, message: string) => void) { this.onErrorCb = cb; }
}
