import { describe, expect, it } from 'vitest';
import {
  ARCADE_PLAYER_SESSION_COOKIE,
  ARCADE_PLAYER_SESSION_TTL_SECONDS,
  ArcadePlayerSessionService,
} from '../server/arcade-player-session';

const SECRET = '0123456789abcdef0123456789abcdef';
const NOW = 1_784_577_600;

function service(now = NOW, secureCookies = true): ArcadePlayerSessionService {
  return new ArcadePlayerSessionService(SECRET, {
    now: () => now,
    idGenerator: () => 'session-1',
    secureCookies,
  });
}

describe('ArcadePlayerSessionService', () => {
  it('issues a cabinet-bound signed session with hardened cookie attributes', () => {
    const issued = service().issue('player:one', 'ARCADE-01');
    expect(issued.payload).toMatchObject({
      player: 'player:one', audience: 'ARCADE-01', jti: 'session-1', issuedAt: NOW,
      expiry: NOW + ARCADE_PLAYER_SESSION_TTL_SECONDS,
    });
    expect(issued.cookie).toContain(`${ARCADE_PLAYER_SESSION_COOKIE}=`);
    expect(issued.cookie).toContain('HttpOnly');
    expect(issued.cookie).toContain('SameSite=Lax');
    expect(issued.cookie).toContain('Secure');
    expect(service().verify(issued.token, 'ARCADE-01')).toEqual(issued.payload);
  });

  it('rejects tampering, expiry, wrong cabinets, and duplicate cookies', () => {
    const issued = service().issue('player:one', 'ARCADE-01');
    expect(() => service().verify(`${issued.token}x`, 'ARCADE-01')).toThrow(/signature|malformed/);
    expect(() => service(NOW + ARCADE_PLAYER_SESSION_TTL_SECONDS).verify(issued.token, 'ARCADE-01'))
      .toThrow(/expired/);
    expect(() => service().verify(issued.token, 'ARCADE-02')).toThrow(/another station/);
    expect(() => service().readCookie(
      `${ARCADE_PLAYER_SESSION_COOKIE}=${issued.token}; ${ARCADE_PLAYER_SESSION_COOKIE}=${issued.token}`,
      'ARCADE-01',
    )).toThrow(/multiple/);
  });

  it('reads one cookie, returns null when absent, and emits a clearing cookie', () => {
    const sessions = service(NOW, false);
    const issued = sessions.issue('player:one', 'ARCADE-01');
    expect(sessions.readCookie(`other=x; ${ARCADE_PLAYER_SESSION_COOKIE}=${issued.token}`, 'ARCADE-01'))
      .toEqual(issued.payload);
    expect(sessions.readCookie('other=x', 'ARCADE-01')).toBeNull();
    expect(sessions.clearCookie()).toBe(
      `${ARCADE_PLAYER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  });

  it('fails closed for weak secrets and invalid issuance dependencies', () => {
    expect(() => new ArcadePlayerSessionService('short', { secureCookies: true })).toThrow(/at least 32 bytes/);
    expect(() => new ArcadePlayerSessionService(SECRET, {
      secureCookies: true, now: () => NaN, idGenerator: () => 'session',
    }).issue('player:one', 'ARCADE-01')).toThrow(/timestamp/);
  });
});
