import type { OwlEvent, OwlServerMessage, OwlState } from '../../shared/owl-protocol';
import type { SupportedLocale } from '../../shared/i18n/locales';
import { withDisplaySession } from '../display-session';

export type OwlConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export function owlWebSocketUrl(page: Location): string {
  if (page.protocol !== 'http:' && page.protocol !== 'https:') {
    throw new Error('Talking Owl needs an HTTP or HTTPS page.');
  }
  return `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}/ws/owl?display=1`;
}

/** The display observes the voice-owned room; only the caller can choose Owl's actions. */
export class OwlConnection {
  private socket: WebSocket | null = null;
  private stopped = false;
  private generation = 0;
  private backoffMs = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private roomAckTimer: ReturnType<typeof setTimeout> | null = null;
  private stateListener?: (state: OwlState) => void;
  private eventsListener?: (events: readonly OwlEvent[]) => void;
  private errorListener?: (code: string, message: string) => void;
  private connectionListener?: (state: OwlConnectionState) => void;

  constructor(
    private readonly url: string,
    private readonly roomCode: string,
    private readonly displayToken: string | null,
    private readonly locale: SupportedLocale,
  ) {
    this.connect();
  }

  onState(listener: (state: OwlState) => void): void { this.stateListener = listener; }
  onEvents(listener: (events: readonly OwlEvent[]) => void): void { this.eventsListener = listener; }
  onError(listener: (code: string, message: string) => void): void { this.errorListener = listener; }
  onConnection(listener: (state: OwlConnectionState) => void): void { this.connectionListener = listener; }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.roomAckTimer) clearTimeout(this.roomAckTimer);
    this.reconnectTimer = null;
    this.clockTimer = null;
    this.roomAckTimer = null;
    try { this.socket?.close(); } catch { /* The socket may already be closed. */ }
    this.connectionListener?.('closed');
  }

  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    const socket = this.socket = new WebSocket(withDisplaySession(this.url));
    let roomAcknowledged = false;
    this.connectionListener?.(generation === 1 ? 'connecting' : 'reconnecting');
    socket.onopen = () => {
      if (this.stopped || generation !== this.generation) return;
      this.backoffMs = 500;
      // The station token must be the first room frame. WebSocket preserves frame order.
      if (this.displayToken) this.send(socket, { type: 'display_auth', roomCode: this.roomCode, token: this.displayToken });
      this.send(socket, { type: 'clock_sync', clientSentAtMs: Date.now() });
      this.send(socket, { type: 'spectate', roomCode: this.roomCode, locale: this.locale });
      if (this.clockTimer) clearInterval(this.clockTimer);
      this.clockTimer = setInterval(() => this.send(socket, { type: 'clock_sync', clientSentAtMs: Date.now() }), 30_000);
      // A raw socket can be open while the server has not accepted spectate. Keep the call
      // card offline until the authoritative room snapshot arrives, and retry a lost subscribe.
      if (this.roomAckTimer) clearTimeout(this.roomAckTimer);
      this.roomAckTimer = setTimeout(() => {
        if (!roomAcknowledged && socket.readyState === WebSocket.OPEN) socket.close(4000, 'room subscription timed out');
      }, 8_000);
    };
    socket.onmessage = messageEvent => {
      if (this.stopped || generation !== this.generation) return;
      let value: unknown;
      try { value = JSON.parse(String(messageEvent.data)) as unknown; }
      catch { this.errorListener?.('bad_json', 'Talking Owl sent an unreadable response.'); return; }
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      const message = value as OwlServerMessage;
      if (message.type === 'owl_state'
        && message.roomCode.trim().toUpperCase() === this.roomCode.trim().toUpperCase()) {
        if (!roomAcknowledged) {
          roomAcknowledged = true;
          if (this.roomAckTimer) clearTimeout(this.roomAckTimer);
          this.roomAckTimer = null;
          this.connectionListener?.('connected');
        }
        this.stateListener?.(message);
      } else if (message.type === 'owl_events' && Array.isArray(message.events)) {
        this.eventsListener?.(message.events);
      } else if (message.type === 'error') {
        this.errorListener?.(message.code, message.message);
      }
    };
    socket.onclose = event => {
      if (this.stopped || generation !== this.generation) return;
      if (this.clockTimer) clearInterval(this.clockTimer);
      if (this.roomAckTimer) clearTimeout(this.roomAckTimer);
      this.clockTimer = null;
      this.roomAckTimer = null;
      if (event.code === 4001) {
        this.connectionListener?.('closed');
        return;
      }
      this.connectionListener?.('reconnecting');
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 8_000);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
    socket.onerror = () => undefined;
  }

  private send(socket: WebSocket, value: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  }
}
