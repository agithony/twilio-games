import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwlConnection } from '../client/talking-owl/owl-net';

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly sockets: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) { FakeWebSocket.sockets.push(this); }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

afterEach(() => {
  FakeWebSocket.sockets.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Talking Owl live display connection', () => {
  it('reports Live only after the server accepts the room subscription', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const connection = new OwlConnection('ws://example.test/ws/owl?display=1', '4821', null, 'en-US');
    const states: string[] = [];
    const snapshots: string[] = [];
    connection.onConnection(state => states.push(state));
    connection.onState(state => snapshots.push(state.roomCode));
    const socket = FakeWebSocket.sockets[0]!;
    socket.open();
    expect(socket.sent.some(raw => JSON.parse(raw).type === 'spectate')).toBe(true);
    expect(states).not.toContain('connected');
    socket.receive({ type: 'owl_state', roomCode: '4821', phase: 'waiting' });
    expect(states.at(-1)).toBe('connected');
    expect(snapshots).toEqual(['4821']);
    connection.close();
  });

  it('reconnects when an open socket never receives an accepted room snapshot', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const connection = new OwlConnection('ws://example.test/ws/owl?display=1', '4821', null, 'en-US');
    const states: string[] = [];
    connection.onConnection(state => states.push(state));
    FakeWebSocket.sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(8_500);
    expect(states).not.toContain('connected');
    expect(states).toContain('reconnecting');
    expect(FakeWebSocket.sockets).toHaveLength(2);
    connection.close();
  });
});
