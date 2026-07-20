import type http from 'node:http';
import {
  ArcadeConfigValidationError,
  projectPublicArcadeConfig,
} from '../shared/arcade-config';
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

const ADMIN_CONFIG_BODY_LIMIT = 512 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_EVENT_STREAMS = 100;
const IDEMPOTENCY_KEY_LIMIT = 255;

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
    this.started = true;
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
    await this.configStore.flush();
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
    if (origin && origin !== this.expectedOrigin) {
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

    if (error instanceof ArcadeHttpError) {
      ({ status, code, message } = error);
      allow = (error as ArcadeHttpError & { allowed?: string }).allowed;
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
    }

    sendJson(response, status, { error: { code, message, ...(details ? { details } : {}) } }, {
      'Cache-Control': 'no-store',
      ...(allow ? { Allow: allow } : {}),
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
