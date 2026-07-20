import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const ARCADE_PLAYER_SESSION_COOKIE = 'twilio_arcade_player';
export const ARCADE_PLAYER_SESSION_VERSION = 1 as const;
export const ARCADE_PLAYER_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const ARCADE_PLAYER_SESSION_MAX_BYTES = 2_048;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CLOCK_SKEW_SECONDS = 60;

export type ArcadePlayerSessionSecret = string | Buffer | Uint8Array;

export type ArcadePlayerSessionPayload = Readonly<{
  v: typeof ARCADE_PLAYER_SESSION_VERSION;
  player: string;
  audience: string;
  jti: string;
  issuedAt: number;
  expiry: number;
}>;

export class ArcadePlayerSessionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArcadePlayerSessionError';
  }
}

export interface ArcadePlayerSessionServiceOptions {
  readonly now?: () => number;
  readonly idGenerator?: () => string;
  readonly secureCookies: boolean;
}

export class ArcadePlayerSessionService {
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly secureCookies: boolean;

  constructor(secret: ArcadePlayerSessionSecret, options: ArcadePlayerSessionServiceOptions) {
    this.secret = secretBuffer(secret);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.secureCookies = options.secureCookies;
  }

  issue(player: string, audience: string): { payload: ArcadePlayerSessionPayload; token: string; cookie: string } {
    const now = epochSeconds(this.now(), 'session clock');
    const payload = validatePayload({
      v: ARCADE_PLAYER_SESSION_VERSION,
      player,
      audience,
      jti: requireIdentifier(this.idGenerator(), 'session ID'),
      issuedAt: now,
      expiry: now + ARCADE_PLAYER_SESSION_TTL_SECONDS,
    });
    const token = signPayload(payload, this.secret);
    return {
      payload,
      token,
      cookie: sessionCookie(token, ARCADE_PLAYER_SESSION_TTL_SECONDS, this.secureCookies),
    };
  }

  verify(token: string, audience: string): ArcadePlayerSessionPayload {
    return verifyToken(token, this.secret, audience, this.now());
  }

  readCookie(cookieHeader: string | undefined, audience: string): ArcadePlayerSessionPayload | null {
    const values: string[] = [];
    for (const part of (cookieHeader ?? '').split(';')) {
      const index = part.indexOf('=');
      if (index < 0 || part.slice(0, index).trim() !== ARCADE_PLAYER_SESSION_COOKIE) continue;
      try { values.push(decodeURIComponent(part.slice(index + 1).trim())); }
      catch { throw new ArcadePlayerSessionError('MALFORMED_COOKIE', 'Arcade player session cookie is malformed'); }
    }
    if (values.length === 0) return null;
    if (values.length !== 1) {
      throw new ArcadePlayerSessionError('DUPLICATE_COOKIE', 'multiple Arcade player session cookies were supplied');
    }
    return this.verify(values[0]!, audience);
  }

  clearCookie(): string {
    return sessionCookie('', 0, this.secureCookies);
  }
}

function secretBuffer(secret: ArcadePlayerSessionSecret): Buffer {
  const value = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (value.byteLength < 32) {
    throw new ArcadePlayerSessionError('WEAK_SECRET', 'Arcade player session secret must be at least 32 bytes');
  }
  return value;
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_IDENTIFIER_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ArcadePlayerSessionError('INVALID_PAYLOAD', `${field} must be a non-empty bounded string`);
  }
  return value;
}

function epochSeconds(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ArcadePlayerSessionError('INVALID_TIME', `${field} must be a positive Unix timestamp`);
  }
  return value;
}

function validatePayload(value: unknown): ArcadePlayerSessionPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArcadePlayerSessionError('INVALID_PAYLOAD', 'Arcade player session payload must be an object');
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== 6 || keys.join(',') !== 'audience,expiry,issuedAt,jti,player,v') {
    throw new ArcadePlayerSessionError('INVALID_PAYLOAD', 'Arcade player session payload has unexpected fields');
  }
  if (object.v !== ARCADE_PLAYER_SESSION_VERSION) {
    throw new ArcadePlayerSessionError('INVALID_VERSION', 'unsupported Arcade player session version');
  }
  const issuedAt = epochSeconds(object.issuedAt, 'issuedAt');
  const expiry = epochSeconds(object.expiry, 'expiry');
  if (expiry <= issuedAt || expiry - issuedAt > ARCADE_PLAYER_SESSION_TTL_SECONDS) {
    throw new ArcadePlayerSessionError('INVALID_PAYLOAD', 'Arcade player session lifetime is invalid');
  }
  return Object.freeze({
    v: ARCADE_PLAYER_SESSION_VERSION,
    player: requireIdentifier(object.player, 'player'),
    audience: requireIdentifier(object.audience, 'audience'),
    jti: requireIdentifier(object.jti, 'session ID'),
    issuedAt,
    expiry,
  });
}

function signPayload(payload: ArcadePlayerSessionPayload, secret: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded, 'ascii').digest('base64url');
  const token = `${encoded}.${signature}`;
  if (Buffer.byteLength(token, 'utf8') > ARCADE_PLAYER_SESSION_MAX_BYTES) {
    throw new ArcadePlayerSessionError('TOKEN_TOO_LARGE', 'Arcade player session token is too large');
  }
  return token;
}

function verifyToken(
  token: string,
  secret: Buffer,
  audienceInput: string,
  nowInput: number,
): ArcadePlayerSessionPayload {
  if (typeof token !== 'string' || token.length === 0
    || Buffer.byteLength(token, 'utf8') > ARCADE_PLAYER_SESSION_MAX_BYTES) {
    throw new ArcadePlayerSessionError('MALFORMED_TOKEN', 'Arcade player session token is malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 2) throw new ArcadePlayerSessionError('MALFORMED_TOKEN', 'Arcade player session token is malformed');
  const payloadPart = canonicalBase64Url(parts[0]!, 'payload');
  const supplied = canonicalBase64Url(parts[1]!, 'signature');
  const expected = createHmac('sha256', secret).update(parts[0]!, 'ascii').digest();
  const comparable = supplied.byteLength === expected.byteLength ? supplied : Buffer.alloc(expected.byteLength);
  if (!timingSafeEqual(expected, comparable) || supplied.byteLength !== expected.byteLength) {
    throw new ArcadePlayerSessionError('INVALID_SIGNATURE', 'Arcade player session signature is invalid');
  }
  let decoded: unknown;
  try { decoded = JSON.parse(payloadPart.toString('utf8')) as unknown; }
  catch { throw new ArcadePlayerSessionError('INVALID_PAYLOAD', 'Arcade player session payload is invalid'); }
  const payload = validatePayload(decoded);
  const audience = requireIdentifier(audienceInput, 'expected audience');
  if (payload.audience !== audience) {
    throw new ArcadePlayerSessionError('WRONG_AUDIENCE', 'Arcade player session belongs to another cabinet');
  }
  const now = epochSeconds(nowInput, 'session clock');
  if (payload.issuedAt > now + MAX_CLOCK_SKEW_SECONDS) {
    throw new ArcadePlayerSessionError('NOT_YET_VALID', 'Arcade player session was issued in the future');
  }
  if (now >= payload.expiry) throw new ArcadePlayerSessionError('EXPIRED', 'Arcade player session has expired');
  return payload;
}

function canonicalBase64Url(value: string, field: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ArcadePlayerSessionError('MALFORMED_TOKEN', `${field} is not canonical base64url`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new ArcadePlayerSessionError('MALFORMED_TOKEN', `${field} is not canonical base64url`);
  }
  return decoded;
}

function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  return `${ARCADE_PLAYER_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
