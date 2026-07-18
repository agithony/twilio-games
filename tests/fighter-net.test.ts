import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FighterConnection } from '../client/fighter/fighter-net';

class MockWebSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { sockets.push(this); }
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

let sockets: MockWebSocket[];
let originalWebSocket: typeof WebSocket;

beforeEach(() => {
  vi.useFakeTimers(); sockets = []; originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});
afterEach(() => { globalThis.WebSocket = originalWebSocket; vi.useRealTimers(); });

describe('fighter connection', () => {
  it('preserves unsent commands across reconnect generations', () => {
    const connection = new FighterConnection('ws://fighter');
    connection.spectate('ROOM'); connection.command('punch'); sockets[0]!.open();
    expect(sockets[0]!.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'spectate', roomCode: 'ROOM' }, { type: 'command', command: 'punch' },
    ]);

    sockets[0]!.readyState = 3; sockets[0]!.onclose?.({ code: 1006 });
    connection.command('kick'); vi.advanceTimersByTime(500); sockets[1]!.open();
    expect(sockets[1]!.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'spectate', roomCode: 'ROOM' }, { type: 'command', command: 'kick' },
    ]);
  });

  it('authenticates a display once before identity when advertised', () => {
    const connection = new FighterConnection('ws://fighter');
    connection.setDisplayAuth('ROOM', 'secret'); connection.spectate('ROOM'); sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.message({ type: 'fighter_capabilities', displayAuth: true });
    sockets[0]!.message({ type: 'fighter_capabilities', displayAuth: true });
    expect(sockets[0]!.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'secret' },
      { type: 'spectate', roomCode: 'ROOM' },
    ]);
  });

  it('includes the selected locale in display and player identities', () => {
    const connection = new FighterConnection('ws://fighter', 'pt-BR');
    connection.spectate('ROOM'); sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'spectate', roomCode: 'ROOM', locale: 'pt-BR' });
    connection.join('ROOM', 'Ana');
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({ type: 'join', roomCode: 'ROOM', name: 'Ana', locale: 'pt-BR' });
  });
});
