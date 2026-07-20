import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  ARCADE_CHALLENGE_TOKEN_MAX_BYTES,
  ARCADE_CHALLENGE_TOKEN_MAX_TTL_SECONDS,
  ArcadeChallengeTokenError,
  signArcadeChallengeToken,
  verifyArcadeChallengeToken,
  type ArcadeChallengeTokenPayload,
} from '../server/arcade-challenge-token';

const SECRET = '0123456789abcdef0123456789abcdef';
const payload: ArcadeChallengeTokenPayload = {
  v: 1,
  player: 'trusted-player-1',
  challenge: 'voice-docs',
  audience: 'ARCADE-01',
  jti: 'token-id-1',
  issuedAt: 1_700_000_000,
  expiry: 1_700_000_600,
};

describe('Arcade challenge tokens', () => {
  it('round-trips an authenticated versioned payload', () => {
    const token = signArcadeChallengeToken(payload, SECRET);
    expect(verifyArcadeChallengeToken(token, SECRET, {
      challenge: 'voice-docs', player: 'trusted-player-1', audience: 'ARCADE-01', now: 1_700_000_000,
    })).toEqual(payload);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('rejects payload and signature tampering', () => {
    const token = signArcadeChallengeToken(payload, SECRET);
    const [body, mac] = token.split('.') as [string, string];
    const changedPayload = Buffer.from(JSON.stringify({ ...payload, player: 'attacker' })).toString('base64url');
    expect(() => verifyArcadeChallengeToken(`${changedPayload}.${mac}`, SECRET, {
      challenge: payload.challenge, player: payload.player, audience: payload.audience, now: 1_700_000_000,
    })).toThrow(ArcadeChallengeTokenError);
    expect(() => verifyArcadeChallengeToken(`${body}.${mac.slice(0, -1)}A`, SECRET, {
      challenge: payload.challenge, player: payload.player, audience: payload.audience, now: 1_700_000_000,
    })).toThrow(/signature/);
  });

  it('rejects expiry, wrong challenge, and wrong player', () => {
    const token = signArcadeChallengeToken(payload, SECRET);
    expect(() => verifyArcadeChallengeToken(token, SECRET, {
      challenge: payload.challenge, player: payload.player, audience: payload.audience, now: payload.expiry,
    })).toThrow(/expired/);
    expect(() => verifyArcadeChallengeToken(token, SECRET, {
      challenge: 'another-challenge', player: payload.player, audience: payload.audience, now: 1_700_000_000,
    })).toThrow(/different challenge/);
    expect(() => verifyArcadeChallengeToken(token, SECRET, {
      challenge: payload.challenge, player: 'another-player', audience: payload.audience, now: 1_700_000_000,
    })).toThrow(/different player/);
    expect(() => verifyArcadeChallengeToken(token, SECRET, {
      challenge: payload.challenge, player: payload.player, audience: 'ARCADE-02', now: 1_700_000_000,
    })).toThrow(/different audience/);
    expect(() => verifyArcadeChallengeToken(token, SECRET, {
      challenge: payload.challenge, audience: payload.audience, now: 1_700_000_000,
    } as any)).toThrow(/expected player/);
  });

  it('requires a secret of at least 32 bytes', () => {
    expect(() => signArcadeChallengeToken(payload, 'too-short')).toThrow(/at least 32 bytes/);
  });

  it('rejects validly signed payloads with extra fields and malformed base64url', () => {
    const body = Buffer.from(JSON.stringify({ ...payload, admin: true })).toString('base64url');
    const mac = createHmac('sha256', SECRET).update(body, 'ascii').digest('base64url');
    expect(() => verifyArcadeChallengeToken(`${body}.${mac}`, SECRET, {
      challenge: payload.challenge, player: payload.player, audience: payload.audience, now: 1_700_000_000,
    })).toThrow(/unexpected fields/);
    expect(() => verifyArcadeChallengeToken('not+base64.signature', SECRET, {
      challenge: payload.challenge, player: payload.player, audience: payload.audience, now: 1_700_000_000,
    })).toThrow(/base64url/);
  });

  it('enforces maximum TTL, issuance time, and token size', () => {
    expect(() => signArcadeChallengeToken({
      ...payload,
      expiry: payload.issuedAt + ARCADE_CHALLENGE_TOKEN_MAX_TTL_SECONDS + 1,
    }, SECRET)).toThrow(/maximum TTL/);
    const future = signArcadeChallengeToken({
      ...payload, issuedAt: 1_700_001_000, expiry: 1_700_001_100,
    }, SECRET);
    expect(() => verifyArcadeChallengeToken(future, SECRET, {
      challenge: payload.challenge, player: payload.player, audience: payload.audience, now: 1_700_000_000,
    })).toThrow(/issued in the future/);
    expect(() => verifyArcadeChallengeToken('a'.repeat(ARCADE_CHALLENGE_TOKEN_MAX_BYTES + 1), SECRET, {
      challenge: payload.challenge, player: payload.player, audience: payload.audience, now: 1_700_000_000,
    })).toThrow(/maximum size/);
  });
});
