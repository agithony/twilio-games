import type { IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { OwlServer, type OwlServerOptions } from '../server/owl-server';
import { parseOwlClientMessage } from '../shared/owl-protocol';

let owl: OwlServer | null = null;

afterEach(() => {
  owl?.stopLoopOnly();
  owl = null;
  vi.useRealTimers();
});

function makeOwl(options: OwlServerOptions = {}): OwlServer {
  owl = new OwlServer(options);
  return owl;
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly frames: Record<string, any>[] = [];
  send(raw: string): void { this.frames.push(JSON.parse(raw)); }
  clientSend(message: Record<string, unknown>): void { this.emit('message', Buffer.from(JSON.stringify(message))); }
  ping(): void { this.emit('pong'); }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  terminate(): void { this.close(); }
}

function connectInMemory(options: OwlServerOptions = {}): { owl: OwlServer; socket: FakeSocket } {
  const socket = new FakeSocket();
  const wss = {
    handleUpgrade: (_req: IncomingMessage, _socket: Duplex, _head: Buffer,
      connected: (socket: WebSocket) => void) => connected(socket as unknown as WebSocket),
    close: () => {},
  } as unknown as WebSocketServer;
  const instance = makeOwl({ ...options, webSocketServer: wss });
  instance.handleUpgrade({} as IncomingMessage, {} as Duplex, Buffer.alloc(0));
  return { owl: instance, socket };
}

describe('Talking Owl authoritative room', () => {
  it('holds a single caller, confirms their first name, and keeps a result until a fresh standalone call', () => {
    const server = makeOwl();
    const events: string[] = [];
    server.setOnRoomEvents((_code, list) => events.push(...list.map(event => event.type === 'action' ? event.action : event.type)));
    expect(server.voiceJoin('HOOT', 'Visitor', 'CA-one', 'en-US')).toEqual({ playerId: 'o1', resumed: false });
    expect(server.snapshot('HOOT')).toMatchObject({ phase: 'waiting', generation: 1,
      caller: { name: 'Visitor', nameConfirmed: false, connected: true } });
    expect(server.voiceJoin('HOOT', 'Other', 'CA-two', 'en-US')).toBeNull();
    expect(server.voiceAction('HOOT', 'CA-one', 'dance', 'Dance!')).toBeNull();
    expect(server.voiceConfirmName('HOOT', 'CA-one', 'Ada')).toBe(true);
    expect(server.snapshot('HOOT')).toMatchObject({ phase: 'playing', caller: { name: 'Ada', nameConfirmed: true } });
    expect(server.voiceAction('HOOT', 'CA-one', 'dance', 'One, two, flap, flap.')?.sequence).toBe(3);
    expect(server.voiceAction('HOOT', 'CA-two', 'laugh', 'Ha!')).toBeNull();
    server.voiceLeave('HOOT', 'CA-one', 'goodbye');
    expect(server.snapshot('HOOT')).toMatchObject({ phase: 'finished', interactionCount: 1,
      result: { reason: 'goodbye', playerId: 'o1', name: 'Ada', interactionCount: 1 } });
    expect(events).toEqual(['call', 'listen', 'dance', 'hangup', 'finished']);

    expect(server.voiceJoin('HOOT', 'Bea', 'CA-next', 'en-US', false, true))
      .toEqual({ playerId: 'o1', resumed: false });
    expect(server.snapshot('HOOT')).toMatchObject({ generation: 2, phase: 'playing',
      result: null, interactionCount: 0, caller: { name: 'Bea' } });
  });

  it('runs a bounded station session and allows only the same CallSid to hear its finished recap', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
    const server = makeOwl({ now: Date.now, stationDurationMs: 1_500 });
    const phases: string[] = [];
    server.setOnRoomState(code => phases.push(server.snapshot(code)?.phase ?? 'missing'));
    expect(server.voiceJoin('STATION', 'Nia', 'CA-station', 'en-US', true, true))
      .toEqual({ playerId: 'o1', resumed: false });
    expect(server.snapshot('STATION')).toMatchObject({ phase: 'playing', stationManaged: true,
      startedAtMs: Date.now(), endsAtMs: Date.now() + 1_500 });
    expect(server.voiceAction('STATION', 'CA-station', 'wave', 'A wave!')).not.toBeNull();
    vi.advanceTimersByTime(1_500);
    expect(server.snapshot('STATION')).toMatchObject({ phase: 'finished',
      result: { reason: 'timeout', playerId: 'o1', name: 'Nia', interactionCount: 1, durationSeconds: 2 } });
    expect(phases).toContain('playing');
    expect(phases.at(-1)).toBe('finished');
    expect(server.hasVoiceBinding('STATION', 'CA-station')).toBe(true);
    expect(server.voiceJoin('STATION', 'Nia', 'CA-station', 'en-US', true, true))
      .toEqual({ playerId: 'o1', resumed: true });
    expect(server.voiceJoin('STATION', 'Sam', 'CA-other', 'en-US', true, true)).toBeNull();
    expect(server.voiceAction('STATION', 'CA-station', 'laugh', 'Ha!')).toBeNull();
  });

  it('preserves a disconnected caller for same-SID Relay recovery, then ends after grace', () => {
    vi.useFakeTimers();
    const server = makeOwl({ reconnectGraceMs: 500 });
    server.voiceJoin('RECOVER', 'Ada', 'CA-a', 'en-US', false, true);
    server.voiceDisconnect('RECOVER', 'CA-a');
    expect(server.snapshot('RECOVER')?.caller?.connected).toBe(false);
    expect(server.voiceJoin('RECOVER', 'Ada', 'CA-b', 'en-US', false, true)).toBeNull();
    vi.advanceTimersByTime(400);
    expect(server.voiceJoin('RECOVER', 'Ada', 'CA-a', 'en-US', false, true))
      .toEqual({ playerId: 'o1', resumed: true });
    vi.advanceTimersByTime(200);
    expect(server.snapshot('RECOVER')?.phase).toBe('playing');
    server.voiceDisconnect('RECOVER', 'CA-a');
    vi.advanceTimersByTime(500);
    expect(server.snapshot('RECOVER')).toMatchObject({ phase: 'finished',
      result: { reason: 'hangup' } });
  });

  it('validates reagent pairs and ignores forged or stale caller actions', () => {
    const server = makeOwl();
    server.voiceJoin('LAB', 'Ada', 'CA-a', 'en-US', false, true);
    expect(server.voiceAction('LAB', 'CA-a', 'mix', 'Boom', ['berry', 'berry'])).toBeNull();
    expect(server.voiceAction('LAB', 'CA-a', 'lab', 'Lab!')).toMatchObject({ action: 'lab' });
    expect(server.voiceAction('LAB', 'CA-a', 'mix', 'Glow', ['berry', 'mint']))
      .toMatchObject({ action: 'mix', reagents: ['berry', 'mint'] });
    expect(server.snapshot('LAB')).toMatchObject({ roomMode: 'lab', interactionCount: 2 });
    server.voiceDisconnect('LAB', 'CA-a');
    expect(server.voiceAction('LAB', 'CA-a', 'sneeze', 'Achoo!')).toBeNull();
    expect(server.voiceAction('LAB', 'CA-b', 'sneeze', 'Achoo!')).toBeNull();
  });

  it('streams a requested command menu without counting it as a reaction', () => {
    const server = makeOwl();
    server.voiceJoin('MENU', 'Ada', 'CA-menu', 'en-US', false, true);
    expect(server.voiceAction('MENU', 'CA-menu', 'menu', 'Here are my tricks.')?.action).toBe('menu');
    expect(server.snapshot('MENU')).toMatchObject({ interactionCount: 0, lastEvent: { action: 'menu' } });
    expect(server.voiceAction('MENU', 'CA-menu', 'wave', 'Hello!')?.action).toBe('wave');
    expect(server.snapshot('MENU')).toMatchObject({ interactionCount: 1 });
  });
});

describe('Talking Owl display protocol', () => {
  it('strictly rejects malformed and authority-bearing browser frames', () => {
    expect(parseOwlClientMessage('{')).toMatchObject({ type: 'error', code: 'bad_json' });
    expect(parseOwlClientMessage(JSON.stringify({ type: 'spectate', roomCode: 'ROOM', action: 'mix' })))
      .toMatchObject({ type: 'error', code: 'bad_spectate' });
    expect(parseOwlClientMessage(JSON.stringify({ type: 'owl_action', action: 'dance' })))
      .toMatchObject({ type: 'error', code: 'unknown_type' });
    expect(parseOwlClientMessage(JSON.stringify({ type: 'clock_sync', clientSentAtMs: -1 })))
      .toMatchObject({ type: 'error', code: 'bad_clock_sync' });
  });

  it('authenticates a station display and streams live actions after its initial snapshot', () => {
    const { owl: server, socket } = connectInMemory({ displayToken: 'owl-display-token' });
    server.setDisplayAuthenticationRequirement(code => code === 'NEST');
    let registered = 0;
    let authenticated = 0;
    server.setOnDisplayRegistered(() => { registered++; });
    server.setOnDisplayAuthenticated(() => { authenticated++; });
    const frames = socket.frames;
    expect(frames[0]).toMatchObject({ type: 'owl_capabilities' });
    socket.clientSend({ type: 'spectate', roomCode: 'NEST' });
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'bad_display_auth' });
    expect(registered).toBe(0);
    socket.clientSend({ type: 'display_auth', roomCode: 'NEST', token: 'owl-display-token' });
    socket.clientSend({ type: 'spectate', roomCode: 'NEST' });
    expect(frames.some(frame => frame.type === 'owl_state' && frame.roomCode === 'NEST')).toBe(true);
    expect(registered).toBe(1);
    expect(authenticated).toBe(1);
    expect(server.hasStandaloneDisplay(socket as unknown as WebSocket, 'NEST')).toBe(true);
    const snapshot = frames.find(frame => frame.type === 'owl_state' && frame.roomCode === 'NEST');
    expect(snapshot).toMatchObject({ phase: 'waiting', caller: null });
    server.voiceJoin('NEST', 'Ada', 'CA-a', 'en-US', true, true);
    server.voiceAction('NEST', 'CA-a', 'wave', 'Hello from the phone.');
    expect(frames.some(frame => frame.type === 'owl_events'
      && frame.events.some((event: Record<string, unknown>) => event.action === 'wave'))).toBe(true);
    server.voiceAction('NEST', 'CA-a', 'menu', 'Here are my tricks.');
    expect(frames.some(frame => frame.type === 'owl_events'
      && frame.events.some((event: Record<string, unknown>) => event.action === 'menu'))).toBe(true);
    socket.clientSend({ type: 'clock_sync', clientSentAtMs: 123 });
    expect(frames.some(frame => frame.type === 'clock_sync' && frame.clientSentAtMs === 123)).toBe(true);
  });
});
