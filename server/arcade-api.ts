import type http from 'node:http';
import { createHash } from 'node:crypto';
import {
  ArcadeConfigValidationError,
  projectPublicArcadeConfig,
} from '../shared/arcade-config';
import { ArcadeDomainError, type LeadInput } from '../shared/arcade-domain';
import { ArcadeQueueError } from '../shared/arcade-queue';
import {
  ArcadeConfigDegradedError,
  ArcadeConfigIdempotencyConflictError,
  ArcadeConfigStore,
  ArcadeConfigStoreError,
  ArcadeConfigVersionConflictError,
} from './arcade-config-store';
import {
  ARCADE_CONFIG_UPDATED_EVENT,
  ArcadeEventHub,
  type ArcadeEvent,
} from './arcade-events';
import {
  ArcadePlayerRuntime,
  ArcadePlayerRuntimeError,
} from './arcade-player-runtime';
import {
  ArcadePlayerSessionError,
  type ArcadePlayerSessionService,
} from './arcade-player-session';
import { ArcadeRateLimiter } from './arcade-rate-limiter';
import { ArcadeServiceError, type ArcadeQueueStatus } from './arcade-service';
import { ArcadeStateStoreError } from './arcade-state-store';

const ADMIN_CONFIG_BODY_LIMIT = 512 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_EVENT_STREAMS = 100;
const IDEMPOTENCY_KEY_LIMIT = 255;
const PLAYER_IDEMPOTENCY_KEY_LIMIT = 128;
const SESSION_BODY_LIMIT = 2 * 1024;
const REGISTRATION_BODY_LIMIT = 8 * 1024;
const QUEUE_BODY_LIMIT = 4 * 1024;

export interface ArcadeAdminPrincipal {
  readonly email: string;
}

export interface ArcadeApiOptions {
  readonly configStore: ArcadeConfigStore;
  readonly events: ArcadeEventHub;
  readonly authorizeAdmin: (request: http.IncomingMessage) => ArcadeAdminPrincipal | null;
  readonly publicBaseUrl: string;
  readonly heartbeatMs?: number;
  readonly maxEventStreams?: number;
  readonly tacStatus?: () => unknown;
  readonly playerRuntime?: ArcadePlayerRuntime;
  readonly now?: () => number;
}

type EventStream = {
  readonly response: http.ServerResponse;
  readonly close: () => void;
};

class ArcadeHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ArcadeHttpError';
  }
}

export class ArcadeApi {
  private readonly configStore: ArcadeConfigStore;
  private readonly events: ArcadeEventHub;
  private readonly authorizeAdmin: ArcadeApiOptions['authorizeAdmin'];
  private readonly expectedOrigin: string;
  private readonly heartbeatMs: number;
  private readonly maxEventStreams: number;
  private readonly tacStatus?: () => unknown;
  private readonly playerRuntime?: ArcadePlayerRuntime;
  private readonly rateLimiter: ArcadeRateLimiter;
  private readonly processRateLimiter: ArcadeRateLimiter;
  private readonly streams = new Set<EventStream>();
  private started = false;
  private stopped = false;

  constructor(options: ArcadeApiOptions) {
    this.configStore = options.configStore;
    this.events = options.events;
    this.authorizeAdmin = options.authorizeAdmin;
    this.expectedOrigin = new URL(options.publicBaseUrl).origin;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.maxEventStreams = options.maxEventStreams ?? DEFAULT_MAX_EVENT_STREAMS;
    this.tacStatus = options.tacStatus;
    this.playerRuntime = options.playerRuntime;
    this.rateLimiter = new ArcadeRateLimiter(options.now ?? Date.now);
    this.processRateLimiter = new ArcadeRateLimiter(options.now ?? Date.now, 16);
    if (!Number.isSafeInteger(this.heartbeatMs) || this.heartbeatMs < 10) {
      throw new TypeError('Arcade API heartbeatMs must be an integer of at least 10ms');
    }
    if (!Number.isSafeInteger(this.maxEventStreams) || this.maxEventStreams < 1) {
      throw new TypeError('Arcade API maxEventStreams must be a positive integer');
    }
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Arcade API cannot restart after it has stopped');
    if (this.started) return;
    await this.configStore.load();
    await this.playerRuntime?.start();
    this.started = true;
  }

  getHealthStatus(): { degraded: boolean } {
    const players = this.playerRuntime?.getStatus();
    return {
      degraded: Boolean(players && players.mode !== 'off' && players.degraded),
    };
  }

  async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    pathname = requestPath(request),
  ): Promise<void> {
    try {
      if (!this.started || this.stopped) {
        throw new ArcadeHttpError(503, 'ARCADE_UNAVAILABLE', 'Arcade API is not available');
      }

      if (pathname === '/api/arcade/config/public') {
        this.requireMethod(request, ['GET']);
        const config = await this.configStore.read();
        sendJson(response, 200, projectPublicArcadeConfig(config), {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
          ETag: configEtag(config.version),
        });
        return;
      }

      if (pathname === '/api/arcade/events') {
        this.requireMethod(request, ['GET']);
        this.openEventStream(request, response);
        return;
      }

      if (pathname === '/api/arcade/session') {
        await this.handlePlayerSession(request, response);
        return;
      }

      if (pathname === '/api/arcade/register') {
        await this.handleRegistration(request, response);
        return;
      }

      if (pathname === '/api/arcade/player') {
        await this.handlePlayerStatus(request, response);
        return;
      }

      if (pathname === '/api/arcade/wallet') {
        await this.handleWalletStatus(request, response);
        return;
      }

      if (pathname === '/api/arcade/queue/status') {
        await this.handleQueueStatus(request, response);
        return;
      }

      if (pathname === '/api/arcade/queue/join') {
        await this.handleJoinQueue(request, response);
        return;
      }

      if (pathname === '/api/arcade/queue/confirm') {
        await this.handleCurrentQueueAction(request, response, 'confirm');
        return;
      }

      if (pathname === '/api/arcade/queue/snooze') {
        await this.handleCurrentQueueAction(request, response, 'snooze');
        return;
      }

      if (pathname === '/api/arcade/queue/leave') {
        await this.handleCurrentQueueAction(request, response, 'leave');
        return;
      }

      if (pathname === '/api/arcade/check-in') {
        await this.handleCurrentQueueAction(request, response, 'check-in');
        return;
      }

      if (pathname === '/api/admin/arcade/config') {
        const principal = this.requireAdmin(request);
        if (request.method === 'GET') {
          const config = await this.configStore.read();
          sendJson(response, 200, config, {
            'Cache-Control': 'no-store',
            ETag: configEtag(config.version),
          });
          return;
        }
        if (request.method === 'PATCH') {
          this.requireSameOrigin(request);
          requireJsonContentType(request);
          const expectedVersion = parseIfMatch(request.headers['if-match']);
          const idempotencyKey = requireHeader(
            request.headers['idempotency-key'],
            'Idempotency-Key',
            IDEMPOTENCY_KEY_LIMIT,
          );
          const settings = await readJson(request, ADMIN_CONFIG_BODY_LIMIT);
          const config = await this.configStore.update({
            expectedVersion,
            idempotencyKey,
            updatedBy: principal.email,
            settings,
          });
          sendJson(response, 200, config, {
            'Cache-Control': 'no-store',
            ETag: configEtag(config.version),
          });
          return;
        }
        this.methodNotAllowed(['GET', 'PATCH']);
      }

      if (pathname === '/api/admin/arcade/status') {
        this.requireMethod(request, ['GET']);
        this.requireAdmin(request);
        sendJson(response, 200, {
          config: this.configStore.getStatus(),
          tac: this.tacStatus?.() ?? null,
          players: this.playerRuntime?.getStatus() ?? null,
        }, { 'Cache-Control': 'no-store' });
        return;
      }

      if (pathname.startsWith('/api/arcade/') || pathname.startsWith('/api/admin/arcade/')) {
        throw new ArcadeHttpError(404, 'NOT_FOUND', 'Arcade endpoint was not found');
      }
      throw new ArcadeHttpError(404, 'NOT_FOUND', 'Arcade endpoint was not found');
    } catch (error) {
      this.sendError(response, error);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const stream of [...this.streams]) stream.close();
    await Promise.all([this.configStore.flush(), this.playerRuntime?.stop()]);
  }

  private async handlePlayerSession(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    requireExactObject(await readJson(request, SESSION_BODY_LIMIT), [], []);
    this.enforceProcessRate('session-process', 120, 60_000);

    const runtime = this.requirePlayerRuntime();
    const resources = await runtime.getActive();
    const config = this.configStore.getSnapshot();
    if (config.arcade.mode === 'off') {
      throw new ArcadeHttpError(409, 'ARCADE_MODE_DISABLED', 'Arcade mode is off');
    }
    const audience = config.arcade.cabinetId;
    let playerId: string | null = null;
    try {
      playerId = resources.sessions.readCookie(request.headers.cookie, audience)?.player ?? null;
    } catch (error) {
      if (error instanceof ArcadePlayerSessionError && error.code === 'DUPLICATE_COOKIE') throw error;
      playerId = null;
    }

    let issuance: ReturnType<ArcadePlayerSessionService['issue']> | null = null;
    if (!playerId) {
      issuance = resources.sessions.issue(runtime.newPlayerId(), audience);
      playerId = issuance.payload.player;
    }

    let player = await resources.service.getPlayerStatus(playerId);
    if (config.arcade.mode === 'coin_only' && !player) {
      await resources.service.identifyCoinOnly({
        playerId,
        destination: null,
        idempotencyKey: playerServiceKey(playerId, 'session', issuance?.payload.jti ?? 'existing-session'),
      });
      player = await resources.service.getPlayerStatus(playerId);
    }
    const wallet = await resources.service.getWalletStatus(playerId);
    sendJson(response, 200, {
      mode: config.arcade.mode,
      registered: player?.registered ?? false,
      availableBalance: wallet?.availableBalance ?? null,
    }, {
      'Cache-Control': 'no-store',
      ...(issuance ? { 'Set-Cookie': issuance.cookie } : {}),
    });
  }

  private async handleRegistration(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'],
      'Idempotency-Key',
      PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, REGISTRATION_BODY_LIMIT),
      ['lead', 'termsAccepted'],
      ['marketingConsent'],
    );
    const resources = await this.requirePlayerRuntime().getActive();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`registration-player:${playerId}`, 5, 10 * 60_000);
    this.enforceProcessRate('registration-process', 60, 60_000);
    const result = await resources.service.registerPlayer({
      playerId,
      destination: null,
      idempotencyKey: playerServiceKey(playerId, 'register', idempotencyKey),
      lead: body.lead as LeadInput,
      termsAccepted: body.termsAccepted as boolean,
      marketingConsent: body.marketingConsent as boolean | undefined,
    });
    const player = await resources.service.getPlayerStatus(playerId);
    sendJson(response, 200, {
      ...player,
      availableBalance: result.availableBalance,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handlePlayerStatus(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const resources = await this.requirePlayerRuntime().getActive();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player:${playerId}`, 120, 60_000);
    this.enforceProcessRate('read-process', 3_000, 60_000);
    const player = await resources.service.getPlayerStatus(playerId);
    sendJson(response, 200, player ?? {
      registered: false,
      firstName: null,
      preferredLocale: null,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleWalletStatus(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const resources = await this.requirePlayerRuntime().getActive();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player:${playerId}`, 120, 60_000);
    this.enforceProcessRate('read-process', 3_000, 60_000);
    const wallet = await resources.service.getWalletStatus(playerId);
    if (!wallet) {
      throw new ArcadeHttpError(409, 'REGISTRATION_REQUIRED', 'player registration is required');
    }
    sendJson(response, 200, wallet, { 'Cache-Control': 'no-store' });
  }

  private async handleQueueStatus(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const resources = await this.requirePlayerRuntime().getActive();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player:${playerId}`, 120, 60_000);
    this.enforceProcessRate('read-process', 3_000, 60_000);
    const queue = await resources.service.getQueueStatus(playerId);
    sendJson(response, 200, { queue: publicQueueStatus(queue) }, { 'Cache-Control': 'no-store' });
  }

  private async handleJoinQueue(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, QUEUE_BODY_LIMIT), ['preferredGame'], ['flexibleGame'],
    );
    const resources = await this.requirePlayerRuntime().getActive();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`mutation-player:${playerId}`, 30, 60_000);
    this.enforceProcessRate('mutation-process', 600, 60_000);
    const result = await resources.service.joinQueue({
      playerId,
      preferredGame: body.preferredGame as 'racer' | 'monsters' | 'fighter' | 'trivia',
      flexibleGame: body.flexibleGame as boolean | undefined,
      idempotencyKey: playerServiceKey(playerId, 'queue-join', idempotencyKey),
    });
    const queue = await resources.service.getQueueStatus(playerId);
    sendJson(response, 200, {
      queue: publicQueueStatus(queue),
      availableBalance: result.availableBalance,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleCurrentQueueAction(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    action: 'confirm' | 'snooze' | 'leave' | 'check-in',
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, QUEUE_BODY_LIMIT),
      action === 'check-in' ? ['game'] : [],
      [],
    );
    const runtime = this.requirePlayerRuntime();
    const resources = action === 'leave'
      ? await runtime.getForCleanup()
      : await runtime.getActive();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`mutation-player:${playerId}`, 30, 60_000);
    this.enforceProcessRate('mutation-process', 600, 60_000);
    const current = await resources.service.getQueueStatus(playerId);
    if (!current) throw new ArcadeHttpError(409, 'QUEUE_ENTRY_REQUIRED', 'player has no active queue entry');
    const common = {
      playerId,
      queueEntryId: current.queueEntryId,
      idempotencyKey: playerServiceKey(playerId, `queue-${action}`, idempotencyKey),
    };
    const result = action === 'confirm'
      ? await resources.service.confirmPresence(common)
      : action === 'snooze'
        ? await resources.service.snoozeQueueEntry(common)
        : action === 'leave'
          ? await resources.service.leaveQueue(common)
          : await resources.service.checkInQueueEntry({
            ...common,
            game: body.game as 'racer' | 'monsters' | 'fighter' | 'trivia',
          });
    const queue = await resources.service.getQueueStatus(playerId);
    sendJson(response, 200, {
      status: result.entry.status,
      queue: publicQueueStatus(queue),
      availableBalance: result.availableBalance,
      reservation: result.reservation
        ? { amount: result.reservation.amount, status: result.reservation.status }
        : null,
    }, { 'Cache-Control': 'no-store' });
  }

  private openEventStream(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (this.streams.size >= this.maxEventStreams) {
      throw new ArcadeHttpError(503, 'EVENT_STREAM_LIMIT', 'Arcade event stream capacity is exhausted');
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    let closed = false;
    let unsubscribe: () => void = () => undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream: EventStream = {
      response,
      close: () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        this.streams.delete(stream);
        response.end();
      },
    };
    this.streams.add(stream);
    const writeChunk = (chunk: string) => {
      if (closed || response.destroyed) return;
      if (!response.write(chunk)) stream.close();
    };
    const write = (event: ArcadeEvent) => writeChunk(formatEvent(event));
    unsubscribe = this.events.subscribe(write);
    heartbeat = setInterval(() => {
      writeChunk(': keep-alive\n\n');
    }, this.heartbeatMs);
    heartbeat.unref?.();
    write({
      type: ARCADE_CONFIG_UPDATED_EVENT,
      version: this.configStore.getSnapshot().version,
    });
    request.once('aborted', stream.close);
    response.once('close', stream.close);
  }

  private requirePlayerRuntime(): ArcadePlayerRuntime {
    if (!this.playerRuntime) {
      throw new ArcadeHttpError(503, 'ARCADE_STATE_UNAVAILABLE', 'Arcade player state is unavailable');
    }
    return this.playerRuntime;
  }

  private requirePlayerSession(
    request: http.IncomingMessage,
    sessions: ArcadePlayerSessionService,
  ): string {
    const audience = this.configStore.getSnapshot().arcade.cabinetId;
    const session = sessions.readCookie(request.headers.cookie, audience);
    if (!session) {
      throw new ArcadeHttpError(401, 'ARCADE_SESSION_REQUIRED', 'Arcade player session is required');
    }
    return session.player;
  }

  private enforceRate(key: string, limit: number, windowMs: number): void {
    this.enforceRateWith(this.rateLimiter, key, limit, windowMs);
  }

  private enforceProcessRate(key: string, limit: number, windowMs: number): void {
    this.enforceRateWith(this.processRateLimiter, key, limit, windowMs);
  }

  private enforceRateWith(
    limiter: ArcadeRateLimiter,
    key: string,
    limit: number,
    windowMs: number,
  ): void {
    const result = limiter.consume(key, limit, windowMs);
    if (result.allowed) return;
    const error = new ArcadeHttpError(429, 'RATE_LIMITED', 'Arcade request rate limit exceeded');
    Object.defineProperty(error, 'retryAfter', {
      value: String(result.retryAfterSeconds), enumerable: false,
    });
    throw error;
  }

  private requireAdmin(request: http.IncomingMessage): ArcadeAdminPrincipal {
    let principal: ArcadeAdminPrincipal | null = null;
    try {
      principal = this.authorizeAdmin(request);
    } catch {
      principal = null;
    }
    const email = principal?.email.trim().toLowerCase() ?? '';
    if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
      throw new ArcadeHttpError(401, 'ADMIN_AUTH_REQUIRED', 'Arcade administrator authentication is required');
    }
    return { email };
  }

  private requireSameOrigin(request: http.IncomingMessage): void {
    const origin = firstHeader(request.headers.origin);
    if (origin !== this.expectedOrigin) {
      throw new ArcadeHttpError(403, 'ORIGIN_FORBIDDEN', 'request origin is not allowed');
    }
  }

  private requireMethod(request: http.IncomingMessage, allowed: readonly string[]): void {
    if (!allowed.includes(request.method ?? '')) this.methodNotAllowed(allowed);
  }

  private methodNotAllowed(allowed: readonly string[]): never {
    const error = new ArcadeHttpError(405, 'METHOD_NOT_ALLOWED', 'method is not allowed for this endpoint');
    Object.defineProperty(error, 'allowed', { value: allowed.join(', '), enumerable: false });
    throw error;
  }

  private sendError(response: http.ServerResponse, error: unknown): void {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }
    let status = 500;
    let code = 'ARCADE_INTERNAL_ERROR';
    let message = 'Arcade request failed';
    let details: Record<string, unknown> | undefined;
    let allow: string | undefined;
    let retryAfter: string | undefined;

    if (error instanceof ArcadeHttpError) {
      ({ status, code, message } = error);
      allow = (error as ArcadeHttpError & { allowed?: string }).allowed;
      retryAfter = (error as ArcadeHttpError & { retryAfter?: string }).retryAfter;
    } else if (error instanceof ArcadeConfigValidationError) {
      status = 400;
      code = 'INVALID_ARCADE_CONFIG';
      message = error.message;
    } else if (error instanceof ArcadeConfigVersionConflictError) {
      status = 412;
      code = 'ARCADE_CONFIG_VERSION_CONFLICT';
      message = error.message;
      details = { expectedVersion: error.expectedVersion, currentVersion: error.actualVersion };
    } else if (error instanceof ArcadeConfigIdempotencyConflictError) {
      status = 409;
      code = 'IDEMPOTENCY_CONFLICT';
      message = error.message;
    } else if (error instanceof ArcadeConfigDegradedError) {
      status = 503;
      code = 'ARCADE_CONFIG_DEGRADED';
      message = error.message;
    } else if (error instanceof ArcadeConfigStoreError) {
      message = error.message;
    } else if (error instanceof ArcadePlayerRuntimeError) {
      status = error.code === 'MODE_DISABLED' ? 409 : 503;
      code = error.code === 'MODE_DISABLED' ? 'ARCADE_MODE_DISABLED' : 'ARCADE_STATE_UNAVAILABLE';
      message = error.code === 'MODE_DISABLED' ? 'Arcade mode is off' : 'Arcade player state is unavailable';
    } else if (error instanceof ArcadePlayerSessionError) {
      status = 401;
      code = 'ARCADE_SESSION_REQUIRED';
      message = 'Arcade player session is invalid or expired';
    } else if (error instanceof ArcadeServiceError) {
      ({ status, code, message } = playerServiceError(error.code));
    } else if (error instanceof ArcadeDomainError) {
      ({ status, code, message } = playerDomainError(error.code));
    } else if (error instanceof ArcadeQueueError) {
      ({ status, code, message } = playerQueueError(error.code));
    } else if (error instanceof ArcadeStateStoreError) {
      status = 503;
      code = 'ARCADE_STATE_UNAVAILABLE';
      message = 'Arcade player state is unavailable';
    }

    sendJson(response, status, { error: { code, message, ...(details ? { details } : {}) } }, {
      'Cache-Control': 'no-store',
      ...(allow ? { Allow: allow } : {}),
      ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
    });
  }
}

function requestPath(request: http.IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    throw new ArcadeHttpError(400, 'INVALID_URL', 'request URL is invalid');
  }
}

function configEtag(version: number): string {
  return `"arcade-config-${version}"`;
}

function parseIfMatch(value: string | string[] | undefined): number {
  const header = firstHeader(value);
  const match = /^"arcade-config-([1-9][0-9]*)"$/.exec(header ?? '');
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(version)) {
    throw new ArcadeHttpError(428, 'ARCADE_CONFIG_VERSION_REQUIRED', 'a current Arcade config ETag is required');
  }
  return version;
}

function requireHeader(value: string | string[] | undefined, name: string, maximum: number): string {
  const header = firstHeader(value)?.trim() ?? '';
  if (!header || header.length > maximum || /[\u0000-\u001f\u007f]/.test(header)) {
    throw new ArcadeHttpError(400, 'INVALID_HEADER', `${name} must be a non-empty bounded header`);
  }
  return header;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireJsonContentType(request: http.IncomingMessage): void {
  const contentType = firstHeader(request.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ArcadeHttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
}

function requireExactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArcadeHttpError(400, 'INVALID_REQUEST', 'request body must be an object');
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(object);
  if (keys.some(key => !allowed.has(key))
    || required.some(key => !Object.prototype.hasOwnProperty.call(object, key))) {
    throw new ArcadeHttpError(400, 'INVALID_REQUEST', 'request body has unexpected or missing fields');
  }
  return object;
}

function playerServiceKey(playerId: string, route: string, externalKey: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([playerId, route, externalKey]), 'utf8')
    .digest('hex');
  return `api:${digest}`;
}

function publicQueueStatus(status: ArcadeQueueStatus | null): Omit<ArcadeQueueStatus, 'queueEntryId'> | null {
  if (!status) return null;
  const { queueEntryId: _queueEntryId, ...safe } = status;
  return safe;
}

function playerServiceError(serviceCode: string): { status: number; code: string; message: string } {
  switch (serviceCode) {
    case 'INVALID_INPUT':
    case 'INVALID_REGISTRATION':
    case 'INVALID_GAME':
      return { status: 400, code: serviceCode, message: 'Arcade request is invalid' };
    case 'TERMS_REQUIRED':
      return { status: 422, code: serviceCode, message: 'terms acknowledgement is required' };
    case 'IDEMPOTENCY_CONFLICT':
      return { status: 409, code: serviceCode, message: 'idempotency key was reused for another request' };
    case 'MODE_DISABLED':
      return { status: 409, code: 'ARCADE_MODE_DISABLED', message: 'Arcade mode does not allow this operation' };
    case 'UNSUPPORTED_CHARGE_POLICY':
    case 'QUEUE_DISABLED':
      return { status: 503, code: serviceCode, message: 'Arcade operation is unavailable' };
    case 'PLAYER_NOT_FOUND':
    case 'WALLET_NOT_FOUND':
      return { status: 409, code: 'REGISTRATION_REQUIRED', message: 'player registration is required' };
    case 'QUEUE_FULL':
    case 'GAME_NOT_ELIGIBLE':
      return { status: 409, code: serviceCode, message: 'Arcade queue operation cannot be completed' };
    case 'QUEUE_ENTRY_NOT_FOUND':
    case 'QUEUE_ENTRY_FORBIDDEN':
      return { status: 409, code: 'QUEUE_ENTRY_REQUIRED', message: 'player has no active queue entry' };
    default:
      return { status: 500, code: 'ARCADE_INTERNAL_ERROR', message: 'Arcade request failed' };
  }
}

function playerDomainError(domainCode: string): { status: number; code: string; message: string } {
  if (domainCode === 'INSUFFICIENT_BALANCE' || domainCode === 'IDEMPOTENCY_CONFLICT') {
    return { status: 409, code: domainCode, message: 'Arcade wallet operation cannot be completed' };
  }
  return { status: 400, code: 'INVALID_REQUEST', message: 'Arcade request is invalid' };
}

function playerQueueError(queueCode: string): { status: number; code: string; message: string } {
  if (queueCode === 'INVALID_QUEUE_VALUE' || queueCode === 'INVALID_SELECTION_LIMIT') {
    return { status: 400, code: 'INVALID_REQUEST', message: 'Arcade queue request is invalid' };
  }
  return { status: 409, code: queueCode, message: 'Arcade queue transition cannot be completed' };
}

async function readJson(request: http.IncomingMessage, maximumBytes: number): Promise<unknown> {
  const contentLength = firstHeader(request.headers['content-length']);
  if (contentLength !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new ArcadeHttpError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid');
    }
    if (Number(contentLength) > maximumBytes) {
      request.resume();
      throw new ArcadeHttpError(413, 'REQUEST_TOO_LARGE', `request body exceeds ${maximumBytes} bytes`);
    }
  }

  const body = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximumBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(bytes);
    });
    request.once('end', () => {
      if (tooLarge) reject(new ArcadeHttpError(413, 'REQUEST_TOO_LARGE', `request body exceeds ${maximumBytes} bytes`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.once('aborted', () => reject(new ArcadeHttpError(400, 'REQUEST_ABORTED', 'request body was aborted')));
    request.once('error', reject);
  });
  if (!body.trim()) throw new ArcadeHttpError(400, 'INVALID_JSON', 'request body must contain JSON');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ArcadeHttpError(400, 'INVALID_JSON', 'request body is not valid JSON');
  }
}

function formatEvent(event: ArcadeEvent): string {
  return `id: ${event.version}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}
