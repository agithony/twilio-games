import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import {
  parseOwlClientMessage, isOwlAction, isOwlReagent,
  type OwlAction, type OwlActionEvent, type OwlCaller, type OwlEndReason,
  type OwlEvent, type OwlReagent, type OwlResult, type OwlRoomMode,
  type OwlServerMessage, type OwlState,
} from '../shared/owl-protocol';
import { speechSafeText } from '../shared/speech-text';

export const OWL_STATION_DURATION_MS = 120_000;
export const OWL_RECONNECT_GRACE_MS = 30_000;
export const OWL_RESULT_RECONNECT_GRACE_MS = 60_000;
export const OWL_MAX_CONNECTIONS = 64;
export const OWL_MAX_ROOMS = 64;
export const OWL_HEARTBEAT_MS = 30_000;

interface DisplayConnection {
  ws: WebSocket;
  roomCode: string | null;
  authenticatedRoomCode: string | null;
  locale: SupportedLocale;
  alive: boolean;
}

interface VoiceCaller extends OwlCaller {
  callSid: string;
  locale: SupportedLocale;
}

export interface OwlServerOptions {
  displayToken?: string;
  now?: () => number;
  maxRooms?: number;
  maxConnections?: number;
  reconnectGraceMs?: number;
  stationDurationMs?: number;
  heartbeatMs?: number;
  webSocketServer?: WebSocketServer;
}

/** A small, serializable one-caller game state. The server is its only writer. */
export class OwlRoom {
  readonly code: string;
  private readonly now: () => number;
  private generation = 1;
  private sequence = 0;
  private phaseValue: OwlState['phase'] = 'waiting';
  private callerValue: VoiceCaller | null = null;
  private roomModeValue: OwlRoomMode = 'study';
  private stationManagedValue = false;
  private startedAtMsValue: number | null = null;
  private endsAtMsValue: number | null = null;
  private interactionCountValue = 0;
  private resultValue: OwlResult | null = null;
  private lastEventValue: OwlEvent | null = null;

  constructor(code: string, now: () => number = Date.now) {
    this.code = code;
    this.now = now;
  }

  get phase(): OwlState['phase'] { return this.phaseValue; }
  get stationManaged(): boolean { return this.stationManagedValue; }
  get callerCallSid(): string | null { return this.callerValue?.callSid ?? null; }
  get callerConnected(): boolean { return this.callerValue?.connected ?? false; }
  get callerLocale(): SupportedLocale { return this.callerValue?.locale ?? DEFAULT_LOCALE; }

  state(): OwlState {
    const caller = this.callerValue;
    return {
      roomCode: this.code,
      phase: this.phaseValue,
      generation: this.generation,
      caller: caller ? {
        playerId: caller.playerId,
        name: caller.name,
        nameConfirmed: caller.nameConfirmed,
        connected: caller.connected,
      } : null,
      roomMode: this.roomModeValue,
      stationManaged: this.stationManagedValue,
      startedAtMs: this.startedAtMsValue,
      endsAtMs: this.endsAtMsValue,
      interactionCount: this.interactionCountValue,
      result: this.resultValue ? { ...this.resultValue } : null,
      lastEvent: this.lastEventValue ? cloneEvent(this.lastEventValue) : null,
      serverNowMs: this.now(),
    };
  }

  configureStation(): void { this.stationManagedValue = true; }

  /** A finished standalone scene can welcome another caller without leaking the old identity. */
  resetStandalone(): boolean {
    if (this.stationManagedValue || this.phaseValue !== 'finished') return false;
    this.generation++;
    this.sequence = 0;
    this.phaseValue = 'waiting';
    this.callerValue = null;
    this.roomModeValue = 'study';
    this.startedAtMsValue = null;
    this.endsAtMsValue = null;
    this.interactionCountValue = 0;
    this.resultValue = null;
    this.lastEventValue = null;
    return true;
  }

  joinVoice(name: string, callSid: string, locale: SupportedLocale,
    nameConfirmed: boolean): { playerId: string; resumed: boolean } | null {
    const current = this.callerValue;
    if (current) {
      if (current.callSid !== callSid) return null;
      current.connected = true;
      return { playerId: current.playerId, resumed: true };
    }
    if (this.phaseValue === 'finished') return null;
    this.callerValue = { playerId: 'o1', callSid, locale, name, nameConfirmed, connected: true };
    if (nameConfirmed) this.beginPlay();
    return { playerId: 'o1', resumed: false };
  }

  confirmName(callSid: string, name: string): boolean {
    if (this.callerValue?.callSid !== callSid || this.phaseValue === 'finished') return false;
    this.callerValue.name = name;
    this.callerValue.nameConfirmed = true;
    this.beginPlay();
    return true;
  }

  disconnect(callSid: string): boolean {
    if (this.callerValue?.callSid !== callSid || !this.callerValue.connected) return false;
    this.callerValue.connected = false;
    return true;
  }

  setDeadline(endsAtMs: number): boolean {
    if (!this.stationManagedValue || this.phaseValue !== 'playing'
      || !Number.isFinite(endsAtMs) || endsAtMs <= this.now()) return false;
    this.endsAtMsValue = endsAtMs;
    return true;
  }

  action(action: OwlAction, line: string, reagents?: readonly [OwlReagent, OwlReagent]): OwlActionEvent | null {
    if (!this.callerValue || this.phaseValue === 'finished') return null;
    if (action !== 'call' && action !== 'listen' && action !== 'hangup'
      && (!this.callerValue.nameConfirmed || this.phaseValue !== 'playing')) return null;
    if (action === 'mix' && (!reagents || !isOwlReagent(reagents[0])
      || !isOwlReagent(reagents[1]) || reagents[0] === reagents[1]
      || this.roomModeValue !== 'lab')) return null;
    const event: OwlActionEvent = {
      type: 'action', sequence: ++this.sequence, action,
      line: speechSafeText(line, 160) || 'Hoo.', atMs: this.now(),
      ...(action === 'mix' && reagents ? { reagents: [reagents[0], reagents[1]] as const } : {}),
    };
    if (action === 'lab') this.roomModeValue = 'lab';
    if (action === 'study') this.roomModeValue = 'study';
    // Opening the command list is guidance, not an owl reaction.
    if (!['call', 'listen', 'hangup', 'menu'].includes(action)) this.interactionCountValue++;
    this.lastEventValue = event;
    return cloneEvent(event) as OwlActionEvent;
  }

  finish(reason: OwlEndReason): OwlEvent | null {
    if (this.phaseValue === 'finished') return null;
    this.phaseValue = 'finished';
    const completedAtMs = this.now();
    const caller = this.callerValue;
    if (caller) {
      caller.connected = false;
      this.resultValue = {
        reason,
        playerId: caller.playerId,
        name: caller.name,
        interactionCount: this.interactionCountValue,
        durationSeconds: Math.max(0, Math.round((completedAtMs - (this.startedAtMsValue ?? completedAtMs)) / 1000)),
        completedAtMs,
      };
    }
    this.endsAtMsValue = null;
    const event: OwlEvent = { type: 'finished', sequence: ++this.sequence,
      reason, atMs: completedAtMs };
    this.lastEventValue = event;
    return cloneEvent(event);
  }

  private beginPlay(): void {
    if (this.phaseValue !== 'waiting') return;
    this.phaseValue = 'playing';
    this.startedAtMsValue = this.now();
  }
}

/** Authoritative display transport and one phone binding per Owl room. */
export class OwlServer {
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, OwlRoom>();
  private readonly displays = new Set<DisplayConnection>();
  private readonly stationRooms = new Set<string>();
  private readonly stationDurations = new Map<string, number>();
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly resultTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pickupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly displayToken: string;
  private readonly maxRooms: number;
  private readonly maxConnections: number;
  private readonly reconnectGraceMs: number;
  private readonly defaultStationDurationMs: number;
  private readonly heartbeatMs: number;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private requiresDisplayAuth: (roomCode: string) => boolean = () => false;
  private allowBrowserPlayer: (roomCode: string) => boolean = () => true;
  private onRoomState: ((roomCode: string) => void) | null = null;
  private onRoomEvents: ((roomCode: string, events: OwlEvent[]) => void) | null = null;
  private onDisplayRegistered: ((ws: WebSocket, roomCode: string) => void) | null = null;
  private onDisplayAuthenticated: ((ws: WebSocket) => void) | null = null;

  constructor(options: OwlServerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.displayToken = options.displayToken?.trim() ?? '';
    this.maxRooms = boundedInteger(options.maxRooms ?? OWL_MAX_ROOMS, 1, 4096, 'maxRooms');
    this.maxConnections = boundedInteger(options.maxConnections ?? OWL_MAX_CONNECTIONS, 1, 4096, 'maxConnections');
    this.reconnectGraceMs = boundedInteger(options.reconnectGraceMs ?? OWL_RECONNECT_GRACE_MS,
      1, 300_000, 'reconnectGraceMs');
    this.defaultStationDurationMs = boundedInteger(options.stationDurationMs ?? OWL_STATION_DURATION_MS,
      1_000, 900_000, 'stationDurationMs');
    this.heartbeatMs = boundedInteger(options.heartbeatMs ?? OWL_HEARTBEAT_MS, 1_000, 300_000, 'heartbeatMs');
    this.wss = options.webSocketServer ?? new WebSocketServer({
      noServer: true, maxPayload: 8 * 1024, perMessageDeflate: false,
    });
  }

  get connectionCount(): number { return this.displays.size; }
  get roomCount(): number { return this.rooms.size; }
  setOnRoomState(fn: (roomCode: string) => void): void { this.onRoomState = fn; }
  setOnRoomEvents(fn: (roomCode: string, events: OwlEvent[]) => void): void { this.onRoomEvents = fn; }
  setOnDisplayRegistered(fn: (ws: WebSocket, roomCode: string) => void): void { this.onDisplayRegistered = fn; }
  setOnDisplayAuthenticated(fn: (ws: WebSocket) => void): void { this.onDisplayAuthenticated = fn; }
  setDisplayAuthenticationRequirement(fn: (roomCode: string) => boolean): void { this.requiresDisplayAuth = fn; }
  setBrowserPlayerAdmission(fn: (roomCode: string) => boolean): void { this.allowBrowserPlayer = fn; }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, connected?: (ws: WebSocket) => void): void {
    if (this.displays.size >= this.maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, ws => {
      if (this.displays.size >= this.maxConnections) {
        ws.close(1013, 'owl capacity');
        return;
      }
      connected?.(ws);
      this.onConnection(ws);
    });
  }

  getOrCreateRoom(rawCode: string): OwlRoom | null {
    const code = canonicalRoomCode(rawCode);
    if (!code) return null;
    let room = this.rooms.get(code);
    if (room) return room;
    if (this.rooms.size >= this.maxRooms) return null;
    room = new OwlRoom(code, this.now);
    this.rooms.set(code, room);
    return room;
  }

  findRoom(rawCode: string): OwlRoom | undefined {
    const code = canonicalRoomCode(rawCode);
    return code ? this.rooms.get(code) : undefined;
  }

  snapshot(rawCode: string): OwlState | null { return this.findRoom(rawCode)?.state() ?? null; }

  preferredLocale(rawCode: string, fallback: SupportedLocale = DEFAULT_LOCALE): SupportedLocale {
    const code = canonicalRoomCode(rawCode);
    return [...this.displays].find(display => display.roomCode === code)?.locale ?? fallback;
  }

  hasAuthenticatedDisplay(rawCode: string): boolean {
    const code = canonicalRoomCode(rawCode);
    return Boolean(code && [...this.displays].some(display => display.roomCode === code
      && display.authenticatedRoomCode === code && display.ws.readyState === WebSocket.OPEN));
  }

  hasStandaloneDisplay(ws: WebSocket, rawCode: string): boolean {
    const code = canonicalRoomCode(rawCode);
    return Boolean(code && this.rooms.has(code) && [...this.displays].some(display => display.ws === ws
      && display.roomCode === code && display.ws.readyState === WebSocket.OPEN
      && (!this.requiresDisplayAuth(code) || display.authenticatedRoomCode === code)));
  }

  hasVoiceBinding(rawCode: string, callSid: string): boolean {
    const code = canonicalRoomCode(rawCode);
    return Boolean(code && callSid.trim() && this.rooms.get(code)?.callerCallSid === callSid.trim());
  }

  configureStationRoom(rawCode: string, durationMs = this.defaultStationDurationMs): boolean {
    const code = canonicalRoomCode(rawCode);
    if (!code || !Number.isInteger(durationMs) || durationMs < 1_000 || durationMs > 900_000) return false;
    const room = this.getOrCreateRoom(code);
    if (!room || room.phase === 'finished' || (room.state().caller && !room.stationManaged)) return false;
    room.configureStation();
    this.stationRooms.add(code);
    this.stationDurations.set(code, durationMs);
    this.pushState(code);
    return true;
  }

  /** Start the bounded station clock only once a named caller has actually joined. */
  beginStationRoom(rawCode: string): boolean {
    const code = canonicalRoomCode(rawCode);
    const room = code ? this.rooms.get(code) : undefined;
    if (!code || !room?.stationManaged || room.phase !== 'playing' || !room.state().caller?.nameConfirmed) return false;
    if (this.deadlineTimers.has(code)) return true;
    const duration = this.stationDurations.get(code) ?? this.defaultStationDurationMs;
    const deadline = this.now() + duration;
    if (!room.setDeadline(deadline)) return false;
    const timer = setTimeout(() => {
      this.deadlineTimers.delete(code);
      if (this.rooms.get(code) === room) this.finishRoom(code, 'timeout');
    }, duration);
    timer.unref?.();
    this.deadlineTimers.set(code, timer);
    this.pushState(code);
    return true;
  }

  finishStationRoom(rawCode: string): boolean {
    const code = canonicalRoomCode(rawCode);
    return Boolean(code && this.stationRooms.has(code) && this.finishRoom(code, 'station_stop'));
  }

  voiceJoin(rawCode: string, name: string, callSid: string, locale: SupportedLocale,
    stationManaged = false, nameConfirmed = false): { playerId: string; resumed: boolean } | null {
    const code = canonicalRoomCode(rawCode);
    const sid = callSid.trim();
    const cleanName = safeName(name);
    if (!code || !sid || sid.length > 128 || !cleanName) return null;
    // A replacement Relay transport for the same CallSid may hear a finished
    // station recap. It must not reconfigure the completed match or its timer.
    if (stationManaged && !this.stationRooms.has(code) && !this.configureStationRoom(code)) return null;
    const room = this.getOrCreateRoom(code);
    if (!room) return null;
    if (room.stationManaged && !stationManaged && room.callerCallSid !== sid) return null;
    if (!stationManaged && this.requiresDisplayAuth(code) && !this.hasAuthenticatedDisplay(code)) return null;
    if (room.phase === 'finished' && room.callerCallSid !== sid) {
      if (!room.resetStandalone()) return null;
      this.clearResultTimer(code);
    }
    const joined = room.joinVoice(cleanName, sid, locale, nameConfirmed);
    if (!joined) return null;
    this.clearDisconnectTimer(code);
    this.clearResultTimer(code);
    this.pushState(code);
    if (!joined.resumed) {
      this.publishEvent(code, room.action('call', locale === 'pt-BR'
        ? 'Quem será que está ligando?' : 'Who could that be?'));
      if (nameConfirmed) this.schedulePickup(code, room, sid);
    }
    if (stationManaged && room.phase === 'playing') this.beginStationRoom(code);
    return joined;
  }

  voiceConfirmName(rawCode: string, callSid: string, name: string): boolean {
    const code = canonicalRoomCode(rawCode);
    const room = code ? this.rooms.get(code) : undefined;
    const cleanName = safeName(name);
    if (!code || !room || !cleanName || !room.confirmName(callSid.trim(), cleanName)) return false;
    this.clearPickupTimer(code);
    this.pushState(code);
    this.publishEvent(code, room.action('listen', room.callerLocale === 'pt-BR'
      ? `Olá, ${cleanName}. Estou ouvindo.` : `Hello, ${cleanName}. I can hear you.`));
    if (room.stationManaged) this.beginStationRoom(code);
    return true;
  }

  voiceAction(rawCode: string, callSid: string, action: OwlAction, line: string,
    reagents?: readonly [OwlReagent, OwlReagent]): OwlActionEvent | null {
    const code = canonicalRoomCode(rawCode);
    const room = code ? this.rooms.get(code) : undefined;
    if (!code || !room || !room.callerConnected || room.callerCallSid !== callSid.trim()
      || action === 'call' || action === 'listen' || action === 'hangup'
      || !isOwlAction(action)) return null;
    const event = room.action(action, line, reagents);
    if (event) {
      this.publishEvent(code, event);
      this.pushState(code);
    }
    return event;
  }

  /** Preserve the phone seat while Twilio reconnects the same call SID. */
  voiceDisconnect(rawCode: string, callSid: string): void {
    const code = canonicalRoomCode(rawCode);
    const room = code ? this.rooms.get(code) : undefined;
    if (!code || !room || room.callerCallSid !== callSid.trim() || room.phase === 'finished') return;
    if (!room.disconnect(callSid.trim())) return;
    this.pushState(code);
    this.clearDisconnectTimer(code);
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(code);
      if (this.rooms.get(code) === room && !room.callerConnected) this.finishRoom(code, 'hangup');
    }, this.reconnectGraceMs);
    timer.unref?.();
    this.disconnectTimers.set(code, timer);
  }

  /** Called when the phone call has actually ended, rather than a replaceable Relay socket. */
  voiceLeave(rawCode: string, callSid: string, reason: 'hangup' | 'goodbye' = 'hangup'): void {
    const code = canonicalRoomCode(rawCode);
    const room = code ? this.rooms.get(code) : undefined;
    if (!code || !room || room.callerCallSid !== callSid.trim()) return;
    this.finishRoom(code, reason);
  }

  abortRoom(rawCode: string): boolean {
    const code = canonicalRoomCode(rawCode);
    if (!code || !this.rooms.has(code)) return false;
    this.clearRoomTimers(code);
    for (const display of this.displays) {
      if (display.roomCode !== code) continue;
      display.roomCode = null;
      display.authenticatedRoomCode = null;
      display.ws.close(4002, 'station recovery');
    }
    this.rooms.delete(code);
    this.stationRooms.delete(code);
    this.stationDurations.delete(code);
    return true;
  }

  /** Test/runtime shutdown without destroying the shared HTTP server. */
  stopLoopOnly(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const code of this.rooms.keys()) this.clearRoomTimers(code);
    for (const display of this.displays) display.ws.terminate();
    this.displays.clear();
    this.wss.close();
  }

  private onConnection(ws: WebSocket): void {
    const display: DisplayConnection = {
      ws, roomCode: null, authenticatedRoomCode: null, locale: DEFAULT_LOCALE, alive: true,
    };
    this.displays.add(display);
    this.send(display, { type: 'owl_capabilities', displayAuth: Boolean(this.displayToken) });
    this.ensureHeartbeat();
    ws.on('pong', () => { display.alive = true; });
    ws.on('message', data => {
      display.alive = true;
      this.onMessage(display, data.toString());
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      const code = display.roomCode;
      this.displays.delete(display);
      if (code) this.reap(code);
      if (!this.displays.size && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    });
  }

  private onMessage(display: DisplayConnection, raw: string): void {
    const message = parseOwlClientMessage(raw);
    if (message.type === 'error') { this.send(display, message); return; }
    if (message.type === 'clock_sync') {
      this.send(display, { type: 'clock_sync', clientSentAtMs: message.clientSentAtMs,
        serverNowMs: this.now() });
      return;
    }
    if (message.type === 'display_auth') {
      const code = canonicalRoomCode(message.roomCode);
      if (!code || !this.displayToken || message.token !== this.displayToken) {
        this.send(display, { type: 'error', code: 'bad_display_auth', message: 'Invalid display token.' });
        return;
      }
      display.authenticatedRoomCode = code;
      if (display.roomCode === code) this.onDisplayAuthenticated?.(display.ws);
      return;
    }
    if (message.type === 'spectate') {
      const code = canonicalRoomCode(message.roomCode);
      if (!code) {
        this.send(display, { type: 'error', code: 'bad_room', message: 'Invalid room code.' });
        return;
      }
      if (this.requiresDisplayAuth(code) && display.authenticatedRoomCode !== code) {
        this.send(display, { type: 'error', code: 'bad_display_auth', message: 'Display authentication required.' });
        return;
      }
      const room = this.getOrCreateRoom(code);
      if (!room) {
        this.send(display, { type: 'error', code: 'room_capacity', message: 'Owl room capacity exhausted.' });
        return;
      }
      const previous = display.roomCode;
      display.roomCode = code;
      display.locale = resolveLocale(message.locale, DEFAULT_LOCALE);
      this.clearResultTimer(code);
      if (previous && previous !== code) this.reap(previous);
      if (display.authenticatedRoomCode === code) this.onDisplayAuthenticated?.(display.ws);
      this.onDisplayRegistered?.(display.ws, code);
      this.send(display, { type: 'owl_state', ...room.state() });
      this.onRoomState?.(code);
      return;
    }
    if (message.type === 'leave') {
      const code = display.roomCode;
      display.roomCode = null;
      display.authenticatedRoomCode = null;
      if (code) this.reap(code);
    }
  }

  private finishRoom(code: string, reason: OwlEndReason): boolean {
    const room = this.rooms.get(code);
    if (!room) return false;
    this.clearDisconnectTimer(code);
    this.clearPickupTimer(code);
    this.clearDeadlineTimer(code);
    if (room.state().caller?.connected) {
      const pt = room.callerLocale === 'pt-BR';
      this.publishEvent(code, room.action('hangup', reason === 'timeout'
        ? pt ? 'Nosso tempo acabou. Até logo!' : 'Our time is up. Hoo hoo, goodbye.'
        : pt ? 'Clique. Agora, um pouco de silêncio.' : 'Click. Peace and quiet.'));
    }
    const event = room.finish(reason);
    if (!event) return false;
    this.publishEvent(code, event);
    this.pushState(code);
    this.reap(code);
    return true;
  }

  private schedulePickup(code: string, room: OwlRoom, callSid: string): void {
    this.clearPickupTimer(code);
    const generation = room.state().generation;
    const timer = setTimeout(() => {
      this.pickupTimers.delete(code);
      if (this.rooms.get(code) !== room || room.state().generation !== generation
        || room.phase !== 'playing' || room.callerCallSid !== callSid) return;
      this.publishEvent(code, room.action('listen', room.callerLocale === 'pt-BR'
        ? 'Alô? Sim, estou ouvindo.' : 'Hello? Yes, I can hear you.'));
    }, 1_350);
    timer.unref?.();
    this.pickupTimers.set(code, timer);
  }

  private publishEvent(code: string, event: OwlEvent | null): void {
    if (!event) return;
    for (const display of this.displays) if (display.roomCode === code) {
      this.send(display, { type: 'owl_events', events: [event] });
    }
    this.onRoomEvents?.(code, [event]);
  }

  private pushState(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const message: OwlServerMessage = { type: 'owl_state', ...room.state() };
    for (const display of this.displays) if (display.roomCode === code) this.send(display, message);
    this.onRoomState?.(code);
  }

  private send(display: DisplayConnection, message: OwlServerMessage): void {
    if (display.ws.readyState === WebSocket.OPEN) display.ws.send(JSON.stringify(message));
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const display of this.displays) {
        if (!display.alive) { display.ws.terminate(); continue; }
        display.alive = false;
        try { display.ws.ping(); } catch { display.ws.terminate(); }
      }
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private reap(code: string): void {
    const room = this.rooms.get(code);
    if (!room || room.stationManaged || [...this.displays].some(display => display.roomCode === code)) return;
    if (room.phase === 'finished') {
      if (!this.resultTimers.has(code)) {
        const timer = setTimeout(() => {
          this.resultTimers.delete(code);
          if (this.rooms.get(code) === room && ![...this.displays].some(display => display.roomCode === code)) {
            this.clearRoomTimers(code);
            this.rooms.delete(code);
          }
        }, OWL_RESULT_RECONNECT_GRACE_MS);
        timer.unref?.();
        this.resultTimers.set(code, timer);
      }
    } else if (!room.state().caller) {
      this.clearRoomTimers(code);
      this.rooms.delete(code);
    }
  }

  private clearDeadlineTimer(code: string): void {
    const timer = this.deadlineTimers.get(code);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(code);
  }
  private clearDisconnectTimer(code: string): void {
    const timer = this.disconnectTimers.get(code);
    if (timer) clearTimeout(timer);
    this.disconnectTimers.delete(code);
  }
  private clearResultTimer(code: string): void {
    const timer = this.resultTimers.get(code);
    if (timer) clearTimeout(timer);
    this.resultTimers.delete(code);
  }
  private clearPickupTimer(code: string): void {
    const timer = this.pickupTimers.get(code);
    if (timer) clearTimeout(timer);
    this.pickupTimers.delete(code);
  }
  private clearRoomTimers(code: string): void {
    this.clearDeadlineTimer(code);
    this.clearDisconnectTimer(code);
    this.clearResultTimer(code);
    this.clearPickupTimer(code);
  }
}

function canonicalRoomCode(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,16}$/.test(code) ? code : null;
}

function safeName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().normalize('NFC');
  return name && name.length <= 40 && !/\p{Cc}/u.test(name) ? name : null;
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${label} out of range`);
  return value;
}

function cloneEvent(event: OwlEvent): OwlEvent {
  return event.type === 'action'
    ? { ...event, ...(event.reagents ? { reagents: [event.reagents[0], event.reagents[1]] as const } : {}) }
    : { ...event };
}
