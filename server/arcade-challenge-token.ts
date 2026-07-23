import { createHmac, timingSafeEqual } from 'node:crypto';

export const ARCADE_CHALLENGE_TOKEN_VERSION = 1 as const;
export const ARCADE_CHALLENGE_TOKEN_MAX_BYTES = 4_096;
export const ARCADE_CHALLENGE_TOKEN_MAX_TTL_SECONDS = 15 * 60;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CLOCK_SKEW_SECONDS = 60;

export interface ArcadeChallengeTokenPayload {
  readonly v: typeof ARCADE_CHALLENGE_TOKEN_VERSION;
  readonly player: string;
  readonly challenge: string;
  readonly audience: string;
  readonly jti: string;
  /** Issuance as a Unix timestamp in seconds. */
  readonly issuedAt: number;
  /** Expiration as a Unix timestamp in seconds. */
  readonly expiry: number;
}

export type ArcadeChallengeTokenSecret = string | Buffer | Uint8Array;

export interface ArcadeChallengeTokenVerification {
  readonly challenge: string;
  readonly player: string;
  readonly audience: string;
  /** Current Unix timestamp in seconds. Defaults to the system clock. */
  readonly now?: number | Date;
}

export type ArcadeChallengeTokenAuthentication = Pick<ArcadeChallengeTokenVerification, 'audience' | 'now'>;

export class ArcadeChallengeTokenError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArcadeChallengeTokenError';
  }
}

function secretBuffer(secret: ArcadeChallengeTokenSecret): Buffer {
  const value = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (value.byteLength < 32) {
    throw new ArcadeChallengeTokenError('WEAK_SECRET', 'Twilio Games challenge token secret must be at least 32 bytes');
  }
  return value;
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new ArcadeChallengeTokenError(
      'INVALID_PAYLOAD',
      `${field} must be a non-empty string of at most ${MAX_IDENTIFIER_LENGTH} characters`,
    );
  }
  return value;
}

function requireEpochSeconds(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ArcadeChallengeTokenError('INVALID_PAYLOAD', `${field} must be a positive Unix timestamp`);
  }
  return value as number;
}

function validatePayload(value: unknown): ArcadeChallengeTokenPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArcadeChallengeTokenError('INVALID_PAYLOAD', 'challenge token payload must be an object');
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== 7 || keys.join(',') !== 'audience,challenge,expiry,issuedAt,jti,player,v') {
    throw new ArcadeChallengeTokenError('INVALID_PAYLOAD', 'challenge token payload has unexpected fields');
  }
  if (object.v !== ARCADE_CHALLENGE_TOKEN_VERSION) {
    throw new ArcadeChallengeTokenError('INVALID_VERSION', 'unsupported Twilio Games challenge token version');
  }
  const player = requireIdentifier(object.player, 'player');
  const challenge = requireIdentifier(object.challenge, 'challenge');
  const audience = requireIdentifier(object.audience, 'audience');
  const jti = requireIdentifier(object.jti, 'jti');
  const issuedAt = requireEpochSeconds(object.issuedAt, 'issuedAt');
  const expiry = requireEpochSeconds(object.expiry, 'expiry');
  if (expiry <= issuedAt) {
    throw new ArcadeChallengeTokenError('INVALID_PAYLOAD', 'expiry must be later than issuedAt');
  }
  if (expiry - issuedAt > ARCADE_CHALLENGE_TOKEN_MAX_TTL_SECONDS) {
    throw new ArcadeChallengeTokenError('TTL_TOO_LONG', 'challenge token lifetime exceeds the maximum TTL');
  }
  return {
    v: ARCADE_CHALLENGE_TOKEN_VERSION,
    player,
    challenge,
    audience,
    jti,
    issuedAt,
    expiry,
  };
}

function signature(payloadPart: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(payloadPart, 'ascii').digest();
}

function decodeBase64Url(part: string, field: string): Buffer {
  if (part.length === 0 || !/^[A-Za-z0-9_-]+$/.test(part)) {
    throw new ArcadeChallengeTokenError('MALFORMED_TOKEN', `${field} is not canonical base64url`);
  }
  const decoded = Buffer.from(part, 'base64url');
  if (decoded.toString('base64url') !== part) {
    throw new ArcadeChallengeTokenError('MALFORMED_TOKEN', `${field} is not canonical base64url`);
  }
  return decoded;
}

export function signArcadeChallengeToken(
  payloadInput: ArcadeChallengeTokenPayload,
  secretInput: ArcadeChallengeTokenSecret,
): string {
  const secret = secretBuffer(secretInput);
  const payload = validatePayload(payloadInput);
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const token = `${payloadPart}.${signature(payloadPart, secret).toString('base64url')}`;
  if (Buffer.byteLength(token, 'utf8') > ARCADE_CHALLENGE_TOKEN_MAX_BYTES) {
    throw new ArcadeChallengeTokenError('TOKEN_TOO_LARGE', 'challenge token exceeds the maximum size');
  }
  return token;
}

export function verifyArcadeChallengeToken(
  token: string,
  secretInput: ArcadeChallengeTokenSecret,
  verification: ArcadeChallengeTokenVerification,
): ArcadeChallengeTokenPayload {
  const payload = authenticateArcadeChallengeToken(token, secretInput, verification);
  const expectedChallenge = requireIdentifier(verification.challenge, 'expected challenge');
  if (payload.challenge !== expectedChallenge) {
    throw new ArcadeChallengeTokenError('WRONG_CHALLENGE', 'challenge token is for a different challenge');
  }
  if (payload.player !== requireIdentifier(verification.player, 'expected player')) {
    throw new ArcadeChallengeTokenError('WRONG_PLAYER', 'challenge token is for a different player');
  }
  return payload;
}

export function authenticateArcadeChallengeToken(
  token: string,
  secretInput: ArcadeChallengeTokenSecret,
  verification: ArcadeChallengeTokenAuthentication,
): ArcadeChallengeTokenPayload {
  const secret = secretBuffer(secretInput);
  if (typeof token !== 'string' || token.length === 0) {
    throw new ArcadeChallengeTokenError('MALFORMED_TOKEN', 'challenge token must be a non-empty string');
  }
  if (Buffer.byteLength(token, 'utf8') > ARCADE_CHALLENGE_TOKEN_MAX_BYTES) {
    throw new ArcadeChallengeTokenError('TOKEN_TOO_LARGE', 'challenge token exceeds the maximum size');
  }
  const parts = token.split('.');
  if (parts.length !== 2) throw new ArcadeChallengeTokenError('MALFORMED_TOKEN', 'challenge token is malformed');
  const payloadPart = parts[0]!;
  const suppliedSignature = decodeBase64Url(parts[1]!, 'signature');
  const expectedSignature = signature(payloadPart, secret);
  const comparable = suppliedSignature.byteLength === expectedSignature.byteLength
    ? suppliedSignature
    : Buffer.alloc(expectedSignature.byteLength);
  const validSignature = timingSafeEqual(expectedSignature, comparable)
    && suppliedSignature.byteLength === expectedSignature.byteLength;
  if (!validSignature) throw new ArcadeChallengeTokenError('INVALID_SIGNATURE', 'challenge token signature is invalid');

  const payloadBytes = decodeBase64Url(payloadPart, 'payload');
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadBytes.toString('utf8')) as unknown;
  } catch {
    throw new ArcadeChallengeTokenError('INVALID_PAYLOAD', 'challenge token payload is not valid JSON');
  }
  const payload = validatePayload(decoded);
  if (payload.audience !== requireIdentifier(verification.audience, 'expected audience')) {
    throw new ArcadeChallengeTokenError('WRONG_AUDIENCE', 'challenge token is for a different audience');
  }
  const now = verification.now instanceof Date
    ? verification.now.getTime() / 1000
    : verification.now ?? Date.now() / 1000;
  if (!Number.isFinite(now)) throw new ArcadeChallengeTokenError('INVALID_TIME', 'verification time is invalid');
  if (payload.issuedAt > now + MAX_CLOCK_SKEW_SECONDS) {
    throw new ArcadeChallengeTokenError('NOT_YET_VALID', 'challenge token was issued in the future');
  }
  if (now >= payload.expiry) throw new ArcadeChallengeTokenError('EXPIRED', 'challenge token has expired');
  return payload;
}

export const createArcadeChallengeToken = signArcadeChallengeToken;

export class ArcadeChallengeTokenService {
  private readonly secret: Buffer;

  constructor(secret: ArcadeChallengeTokenSecret, private readonly now: () => number = () => Date.now() / 1000) {
    this.secret = secretBuffer(secret);
  }

  sign(payload: ArcadeChallengeTokenPayload): string {
    return signArcadeChallengeToken(payload, this.secret);
  }

  verify(token: string, verification: Omit<ArcadeChallengeTokenVerification, 'now'>): ArcadeChallengeTokenPayload {
    return verifyArcadeChallengeToken(token, this.secret, { ...verification, now: this.now() });
  }

  authenticate(token: string, verification: Omit<ArcadeChallengeTokenAuthentication, 'now'>): ArcadeChallengeTokenPayload {
    return authenticateArcadeChallengeToken(token, this.secret, { ...verification, now: this.now() });
  }
}
