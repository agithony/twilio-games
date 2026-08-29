import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeConnection } from '../client/karaoke/karaoke-net';

class MockWebSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

function messages(socket: MockWebSocket): Record<string, unknown>[] {
  return socket.sent.map(value => JSON.parse(value) as Record<string, unknown>);
}

function nonClockMessages(socket: MockWebSocket): Record<string, unknown>[] {
  return messages(socket).filter(message => message.type !== 'clock_sync');
}

let sockets: MockWebSocket[];
let originalWebSocket: typeof WebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.useRealTimers();
});

describe('KaraokeConnection', () => {
  it('consumes optional clock sync frames with browser receipt time', () => {
    vi.setSystemTime(20_200);
    const connection = new KaraokeConnection('ws://karaoke');
    const synced = vi.fn();
    connection.onClockSync(synced);
    sockets[0]!.open();
    sockets[0]!.message({ type: 'clock_sync', clientSentAtMs: 20_000, serverNowMs: 30_100 });
    expect(synced).toHaveBeenCalledWith({
      clientSentAtMs: 20_000,
      clientReceivedAtMs: 20_200,
      serverNowMs: 30_100,
    });
    expect(messages(sockets[0]!)).toEqual([{ type: 'clock_sync', clientSentAtMs: 20_200 }]);
  });

  it('authenticates a station display before spectating when the capability is advertised', () => {
    const connection = new KaraokeConnection('ws://karaoke', 'pt-BR');
    connection.setDisplayAuth('ROOM', 'display-secret');
    connection.spectate('ROOM');
    sockets[0]!.open();
    expect(nonClockMessages(sockets[0]!)).toEqual([]);
    sockets[0]!.message({ type: 'karaoke_capabilities', displayAuth: true });
    expect(nonClockMessages(sockets[0]!)).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'display-secret' },
      { type: 'spectate', roomCode: 'ROOM', locale: 'pt-BR' },
    ]);
  });

  it('reuses the exact browser session identity after reconnect', () => {
    const connection = new KaraokeConnection('ws://karaoke', 'en-US');
    connection.join('ROOM', 'Avery');
    sockets[0]!.open();
    const first = nonClockMessages(sockets[0]!).find(message => message.type === 'join')!;
    expect(first).toMatchObject({ type: 'join', roomCode: 'ROOM', name: 'Avery', locale: 'en-US' });

    sockets[0]!.readyState = 3;
    sockets[0]!.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(500);
    sockets[1]!.open();
    const resumed = nonClockMessages(sockets[1]!).find(message => message.type === 'join')!;
    expect(resumed.sessionId).toBe(first.sessionId);
  });

  it('queues setup and lane controls without exposing browser score submission', () => {
    const connection = new KaraokeConnection('ws://karaoke');
    connection.spectate('ROOM');
    connection.selectSong('neon-hello-dev');
    connection.advance();
    connection.laneInput(2);
    sockets[0]!.open();
    expect(nonClockMessages(sockets[0]!)).toEqual([
      { type: 'spectate', roomCode: 'ROOM' },
      { type: 'select_song', songId: 'neon-hello-dev' },
      { type: 'advance' },
      { type: 'lane_input', lane: 2 },
    ]);
    expect('updateScore' in connection).toBe(false);
    expect('recordHit' in connection).toBe(false);
  });
});
