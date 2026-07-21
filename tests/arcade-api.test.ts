import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ARCADE_CONFIG, type ArcadeConfigSettings } from '../shared/arcade-config';
import { ArcadeApi } from '../server/arcade-api';
import { ArcadeConfigStore } from '../server/arcade-config-store';
import { ArcadeEventHub } from '../server/arcade-events';
import { HttpServer } from '../server/http-server';
import { ArcadePlayerRuntime } from '../server/arcade-player-runtime';

const ADMIN_HEADER = { 'x-test-arcade-admin': 'admin@twilio.com' };
let server: HttpServer | undefined;
let directory: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function settings(mode: 'off' | 'coin_only' | 'lead_capture' = 'off'): ArcadeConfigSettings {
  const copy = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
  delete copy.schemaVersion;
  delete copy.version;
  delete copy.updatedAt;
  delete copy.updatedBy;
  copy.arcade.mode = mode;
  copy.earning.challenges = [{
    id: 'voice-docs',
    title: 'Read the Voice docs',
    url: 'https://www.twilio.com/docs/voice',
    rewardCoins: 1,
    enabled: true,
    maxClaimsPerPlayer: 1,
    displayOrder: 0,
    startsAt: null,
    endsAt: null,
  }];
  return copy as ArcadeConfigSettings;
}

async function harness(options: {
  maxEventStreams?: number;
  playerMode?: 'coin_only' | 'lead_capture';
  signingSecret?: string | null;
} = {}): Promise<{
  baseUrl: string;
  store: ArcadeConfigStore;
  playerRuntime: ArcadePlayerRuntime;
}> {
  directory = await mkdtemp(path.join(tmpdir(), 'arcade-api-'));
  const events = new ArcadeEventHub();
  const store = new ArcadeConfigStore({ directory: path.join(directory, 'arcade'), events });
  await store.load();
  if (options.playerMode) {
    await store.update({
      expectedVersion: 1,
      idempotencyKey: 'test-enable-player-mode',
      updatedBy: 'test@twilio.com',
      settings: settings(options.playerMode),
    });
  }
  const playerRuntime = new ArcadePlayerRuntime({
    configStore: store,
    events,
    stateFile: path.join(directory, 'arcade-state.json'),
    publicBaseUrl: 'http://localhost',
    signingSecret: () => options.signingSecret === null
      ? undefined
      : options.signingSecret ?? '0123456789abcdef'.repeat(4),
  });
  const api = new ArcadeApi({
    configStore: store,
    events,
    publicBaseUrl: 'http://localhost',
    heartbeatMs: 20,
    maxEventStreams: options.maxEventStreams,
    playerRuntime,
    authorizeAdmin: request => {
      const header = request.headers['x-test-arcade-admin'];
      const email = Array.isArray(header) ? header[0] : header;
      return email ? { email } : null;
    },
  });
  server = new HttpServer({
    port: 0,
    publicBaseUrl: 'http://localhost',
    validateSignatures: false,
    arcadeApi: api,
    analyticsPath: path.join(directory, 'analytics.json'),
    manifestPath: path.join(directory, 'manifest.json'),
    mapsPath: path.join(directory, 'maps.json'),
    arenaPath: path.join(directory, 'arena.json'),
    leaderboardPath: path.join(directory, 'leaderboard.json'),
    fighterMapsPath: path.join(directory, 'fighter-maps.json'),
    fighterPreviewDir: path.join(directory, 'fighter-previews'),
    clientDir: path.join(directory, 'client'),
  });
  const port = await server.start();
  return { baseUrl: `http://127.0.0.1:${port}`, store, playerRuntime };
}

async function updateConfig(
  baseUrl: string,
  body: ArcadeConfigSettings,
  options: { etag?: string; key?: string; origin?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/admin/arcade/config`, {
    method: 'PATCH',
    headers: {
      ...ADMIN_HEADER,
      'Content-Type': 'application/json',
      'If-Match': options.etag ?? '"arcade-config-1"',
      'Idempotency-Key': options.key ?? 'arcade-config-update-1',
      Origin: options.origin ?? 'http://localhost',
    },
    body: JSON.stringify(body),
  });
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let received = '';
  for (let reads = 0; reads < 20 && !received.includes(expected); reads++) {
    const result = await reader.read();
    if (result.done) break;
    received += decoder.decode(result.value, { stream: true });
  }
  return received;
}

async function createPlayerSession(baseUrl: string, key: string): Promise<Response> {
  const sessionKey = Buffer.from(`arcade-session:${key}`, 'utf8').toString('base64url');
  return fetch(`${baseUrl}/api/arcade/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': sessionKey,
      Origin: 'http://localhost',
    },
    body: JSON.stringify({ cabinetId: 'ARCADE-01' }),
  });
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('response did not issue a cookie');
  return cookie.split(';', 1)[0]!;
}

const REGISTRATION = {
  lead: {
    firstName: 'Ada',
    lastName: 'Lovelace',
    workEmail: 'ada@example.com',
    companyName: 'Analytical Engines',
    phoneNumber: '+14155550199',
    countryCode: 'US',
  },
  termsAccepted: true,
  marketingConsent: false,
};

describe('Arcade API', () => {
  it('serves redacted mode-off public config without changing existing endpoints', async () => {
    const { baseUrl } = await harness();
    const response = await fetch(`${baseUrl}/api/arcade/config/public`);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"arcade-config-1"');
    const config = await response.json() as Record<string, any>;
    expect(config.arcade.mode).toBe('off');
    expect(config.updatedAt).toBeUndefined();
    expect(config.updatedBy).toBeUndefined();

    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/config`)).status).toBe(200);
  });

  it('requires an authenticated admin and derives audit identity from that principal', async () => {
    const { baseUrl } = await harness();
    expect((await fetch(`${baseUrl}/api/admin/arcade/config`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/admin/arcade/status`)).status).toBe(401);

    const status = await fetch(`${baseUrl}/api/admin/arcade/status`, { headers: ADMIN_HEADER });
    expect(await status.json()).toMatchObject({ config: { initialized: true, version: 1 }, tac: null });

    const updated = await updateConfig(baseUrl, settings('coin_only'));
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).toBe('"arcade-config-2"');
    const config = await updated.json() as Record<string, any>;
    expect(config.arcade.mode).toBe('coin_only');
    expect(config.updatedBy).toBe('admin@twilio.com');

    const full = await fetch(`${baseUrl}/api/admin/arcade/config`, { headers: ADMIN_HEADER });
    expect((await full.json() as Record<string, any>).earning.challenges[0].url)
      .toBe('https://www.twilio.com/docs/voice');
    const publicConfig = await (await fetch(`${baseUrl}/api/arcade/config/public`)).json() as Record<string, any>;
    expect(publicConfig.earning.challenges[0].url).toBeUndefined();
  });

  it('enforces optimistic concurrency, idempotency, origin, media type, and body limits', async () => {
    const { baseUrl } = await harness();
    expect((await updateConfig(baseUrl, settings('coin_only'))).status).toBe(200);
    expect((await updateConfig(baseUrl, settings('coin_only'))).status).toBe(200);

    const reused = await updateConfig(baseUrl, settings('lead_capture'));
    expect(reused.status).toBe(409);
    expect((await reused.json() as Record<string, any>).error.code).toBe('IDEMPOTENCY_CONFLICT');

    const stale = await updateConfig(baseUrl, settings('lead_capture'), { key: 'stale-update' });
    expect(stale.status).toBe(412);
    expect((await stale.json() as Record<string, any>).error.details.currentVersion).toBe(2);

    const forbiddenOrigin = await updateConfig(baseUrl, settings('lead_capture'), {
      etag: '"arcade-config-2"', key: 'origin-update', origin: 'https://evil.example',
    });
    expect(forbiddenOrigin.status).toBe(403);

    const wrongType = await fetch(`${baseUrl}/api/admin/arcade/config`, {
      method: 'PATCH',
      headers: { ...ADMIN_HEADER, 'Content-Type': 'text/plain', Origin: 'http://localhost' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);

    const tooLarge = await fetch(`${baseUrl}/api/admin/arcade/config`, {
      method: 'PATCH',
      headers: {
        ...ADMIN_HEADER,
        'Content-Type': 'application/json',
        'If-Match': '"arcade-config-2"',
        'Idempotency-Key': 'large-update',
        Origin: 'http://localhost',
      },
      body: JSON.stringify({ data: 'x'.repeat(513 * 1024) }),
    });
    expect(tooLarge.status).toBe(413);

    const invalid = await fetch(`${baseUrl}/api/admin/arcade/config`, {
      method: 'PATCH',
      headers: {
        ...ADMIN_HEADER,
        'Content-Type': 'application/json',
        'If-Match': '"arcade-config-2"',
        'Idempotency-Key': 'invalid-update',
        Origin: 'http://localhost',
      },
      body: '{bad json',
    });
    expect(invalid.status).toBe(400);

    const method = await fetch(`${baseUrl}/api/arcade/config/public`, { method: 'POST' });
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET');
  });

  it('streams current and updated config versions without exposing config contents', async () => {
    const { baseUrl } = await harness();
    const response = await fetch(`${baseUrl}/api/arcade/events`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const initial = await readUntil(reader, '"version":1');
    expect(initial).toContain('event: arcade_config_updated');
    expect(initial).not.toContain('updatedBy');

    expect((await updateConfig(baseUrl, settings('coin_only'))).status).toBe(200);
    const updated = await readUntil(reader, '"version":2');
    expect(updated).toContain('data: {"type":"arcade_config_updated","version":2}');
    expect(updated).not.toContain('voice-docs');
    await reader.cancel();
  });

  it('closes active event streams during server shutdown', async () => {
    const { baseUrl } = await harness();
    const response = await fetch(`${baseUrl}/api/arcade/events`);
    expect(response.status).toBe(200);
    await expect(server!.stop()).resolves.toBeUndefined();
    server = undefined;
  });

  it('bounds concurrent event streams', async () => {
    const { baseUrl } = await harness({ maxEventStreams: 1 });
    const first = await fetch(`${baseUrl}/api/arcade/events`);
    expect(first.status).toBe(200);
    const rejected = await fetch(`${baseUrl}/api/arcade/events`);
    expect(rejected.status).toBe(503);
    expect((await rejected.json() as Record<string, any>).error.code).toBe('EVENT_STREAM_LIMIT');
    await first.body?.cancel();
  });

  it('keeps player state and signing secrets untouched while mode is off', async () => {
    const { baseUrl } = await harness({ signingSecret: null });
    const response = await createPlayerSession(baseUrl, 'off-session');
    expect(response.status).toBe(409);
    expect((await response.json() as Record<string, any>).error.code).toBe('ARCADE_MODE_DISABLED');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it('reports degraded health when enabled player state cannot initialize', async () => {
    const { baseUrl } = await harness({ playerMode: 'lead_capture', signingSecret: null });
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: 'degraded' });
    const session = await createPlayerSession(baseUrl, 'degraded-session');
    expect(session.status).toBe(503);
    expect((await session.json() as Record<string, any>).error.code).toBe('ARCADE_STATE_UNAVAILABLE');
    expect((await fetch(`${baseUrl}/api/admin/arcade/status`, { headers: ADMIN_HEADER })).status).toBe(200);
  });

  it('issues isolated sessions and exposes only authenticated self projections', async () => {
    const { baseUrl, playerRuntime } = await harness({ playerMode: 'lead_capture' });
    const session = await createPlayerSession(baseUrl, 'lead-session');
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ mode: 'lead_capture', registered: false, availableBalance: null });
    const setCookie = session.headers.get('set-cookie')!;
    const cookie = cookieFrom(session);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const replay = await createPlayerSession(baseUrl, 'lead-session');
    expect(replay.headers.get('set-cookie')).not.toBe(setCookie);
    const pending = await fetch(`${baseUrl}/api/arcade/player`, { headers: { Cookie: cookie } });
    expect(await pending.json()).toEqual({ registered: false, firstName: null, preferredLocale: null });
    expect((await fetch(`${baseUrl}/api/arcade/wallet`, { headers: { Cookie: cookie } })).status).toBe(409);

    const registration = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'register-self',
      },
      body: JSON.stringify(REGISTRATION),
    });
    expect(registration.status).toBe(200);
    expect(await registration.json()).toEqual({
      registered: true, firstName: 'Ada', preferredLocale: null, availableBalance: 1,
    });

    const player = await (await fetch(`${baseUrl}/api/arcade/player`, { headers: { Cookie: cookie } })).json();
    const wallet = await (await fetch(`${baseUrl}/api/arcade/wallet`, { headers: { Cookie: cookie } })).json();
    expect(JSON.stringify(player)).not.toMatch(/email|phone|company|lastName|destination|player:/i);
    expect(wallet).toMatchObject({ ledgerBalance: 1, reservedBalance: 0, availableBalance: 1 });
    expect(JSON.stringify(wallet)).not.toMatch(/transaction|reservation|idempotency|player:/i);

    const resources = await playerRuntime.getActive();
    const persistedPlayer = Object.values(resources.store.snapshot().players)[0]!;
    expect(persistedPlayer.lead?.phoneNumber).toBe('+14155550199');
    expect(persistedPlayer.trustedDestination).toBeNull();
  });

  it('rejects missing origins, caller-controlled identity fields, and tampered sessions', async () => {
    const { baseUrl } = await harness({ playerMode: 'lead_capture' });
    const staleQr = await fetch(`${baseUrl}/api/arcade/session`, {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cabinetId: 'ARCADE-02' }),
    });
    expect(staleQr.status).toBe(409);
    expect((await staleQr.json() as Record<string, any>).error.code).toBe('CABINET_CHANGED');
    expect(staleQr.headers.get('set-cookie')).toBeNull();
    const session = await createPlayerSession(baseUrl, 'secure-session');
    const cookie = cookieFrom(session);
    const missingOrigin = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'missing-origin' },
      body: JSON.stringify(REGISTRATION),
    });
    expect(missingOrigin.status).toBe(403);

    const injectedIdentity = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'injected-identity',
      },
      body: JSON.stringify({ ...REGISTRATION, playerId: 'player:attacker', destination: '+14155550000' }),
    });
    expect(injectedIdentity.status).toBe(400);

    const tampered = `${cookie}x`;
    const unauthorized = await fetch(`${baseUrl}/api/arcade/player`, { headers: { Cookie: tampered } });
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json() as Record<string, any>).error.code).toBe('ARCADE_SESSION_REQUIRED');
  });

  it('bootstraps coin-only wallets once', async () => {
    const { baseUrl, playerRuntime } = await harness({ playerMode: 'coin_only' });
    const first = await createPlayerSession(baseUrl, 'coin-player-one');
    const second = await createPlayerSession(baseUrl, 'coin-player-two');
    expect(await first.json()).toEqual({ mode: 'coin_only', registered: false, availableBalance: 1 });
    expect(await second.json()).toEqual({ mode: 'coin_only', registered: false, availableBalance: 1 });
    const firstCookie = cookieFrom(first);
    const refreshed = await fetch(`${baseUrl}/api/arcade/session`, {
      method: 'POST',
      headers: {
        Cookie: firstCookie, Origin: 'http://localhost',
        'Content-Type': 'application/json',
        'Idempotency-Key': Buffer.from('arcade-session:shared-external-key').toString('base64url'),
      },
      body: JSON.stringify({ cabinetId: 'ARCADE-01' }),
    });
    expect((await refreshed.json() as Record<string, any>).availableBalance).toBe(1);
    const state = (await playerRuntime.getActive()).store.snapshot();
    expect(Object.keys(state.players)).toHaveLength(2);
    expect(Object.values(state.wallets).every(wallet => (
      wallet.transactions.filter(transaction => transaction.type === 'registration_grant').length === 1
    ))).toBe(true);
  });

  it('namespaces one external idempotency key independently for each authenticated player', async () => {
    const { baseUrl, playerRuntime } = await harness({ playerMode: 'lead_capture' });
    const firstCookie = cookieFrom(await createPlayerSession(baseUrl, 'namespace-player-one'));
    const secondCookie = cookieFrom(await createPlayerSession(baseUrl, 'namespace-player-two'));
    const register = (cookie: string) => fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'same-browser-key',
      },
      body: JSON.stringify(REGISTRATION),
    });
    const [first, second] = await Promise.all([register(firstCookie), register(secondCookie)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const state = (await playerRuntime.getActive()).store.snapshot();
    expect(Object.keys(state.players)).toHaveLength(2);
    expect(Object.keys(state.idempotencyRecords)).toHaveLength(2);
  });

  it('uses the authenticated player current entry for queue actions without exposing queue IDs', async () => {
    const { baseUrl } = await harness({ playerMode: 'lead_capture' });
    const cookie = cookieFrom(await createPlayerSession(baseUrl, 'queue-player'));
    const registered = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'queue-register',
      },
      body: JSON.stringify(REGISTRATION),
    });
    expect(registered.status).toBe(200);
    const mutate = (path: string, key: string, body: unknown = {}) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });

    const joined = await mutate('/api/arcade/queue/join', 'queue-join', {
      preferredGame: 'racer', flexibleGame: false,
    });
    expect(joined.status).toBe(200);
    const joinedBody = await joined.json() as Record<string, any>;
    expect(joinedBody).toMatchObject({
      availableBalance: 1,
      queue: { status: 'WAITING', preferredGame: 'racer', position: 1, reservation: null },
    });
    expect(JSON.stringify(joinedBody)).not.toMatch(/queueEntryId|playerId|reason|event/i);
    const status = await (await fetch(`${baseUrl}/api/arcade/queue/status`, {
      headers: { Cookie: cookie },
    })).json();
    expect(status).toMatchObject({ queue: { status: 'WAITING', position: 1 } });

    const invalidConfirm = await mutate('/api/arcade/queue/confirm', 'queue-confirm');
    expect(invalidConfirm.status).toBe(409);
    const injectedId = await mutate('/api/arcade/queue/snooze', 'queue-injected', {
      queueEntryId: 'another-player-entry',
    });
    expect(injectedId.status).toBe(400);

    const snoozed = await mutate('/api/arcade/queue/snooze', 'queue-snooze');
    expect(await snoozed.json()).toMatchObject({ status: 'DEFERRED', queue: { position: null } });
    const left = await mutate('/api/arcade/queue/leave', 'queue-leave');
    expect(await left.json()).toMatchObject({ status: 'LEFT_QUEUE', queue: null });
    const checkIn = await mutate('/api/arcade/check-in', 'queue-check-in', { game: 'racer' });
    expect(checkIn.status).toBe(409);
    expect((await checkIn.json() as Record<string, any>).error.code).toBe('QUEUE_ENTRY_REQUIRED');
  });

  it('allows an authenticated player to leave an existing queue after mode switches off', async () => {
    const { baseUrl, store } = await harness({ playerMode: 'lead_capture' });
    const cookie = cookieFrom(await createPlayerSession(baseUrl, 'off-cleanup-player'));
    const mutate = (path: string, key: string, body: unknown) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    expect((await mutate('/api/arcade/register', 'off-cleanup-register', REGISTRATION)).status).toBe(200);
    expect((await mutate('/api/arcade/queue/join', 'off-cleanup-join', {
      preferredGame: 'racer', flexibleGame: false,
    })).status).toBe(200);
    await store.update({
      expectedVersion: 2,
      idempotencyKey: 'switch-off-with-queue',
      updatedBy: 'admin@twilio.com',
      settings: settings('off'),
    });

    for (const [path, key, body] of [
      ['/api/arcade/queue/confirm', 'off-cleanup-confirm', {}],
      ['/api/arcade/queue/snooze', 'off-cleanup-snooze', {}],
      ['/api/arcade/check-in', 'off-cleanup-check-in', { game: 'racer' }],
    ] as const) {
      const blocked = await mutate(path, key, body);
      expect(blocked.status).toBe(409);
      expect((await blocked.json() as Record<string, any>).error.code).toBe('ARCADE_MODE_DISABLED');
    }
    expect((await fetch(`${baseUrl}/api/arcade/queue/status`, {
      headers: { Cookie: cookie },
    })).status).toBe(409);

    const left = await mutate('/api/arcade/queue/leave', 'off-cleanup-leave', {});
    expect(left.status).toBe(200);
    expect(await left.json()).toMatchObject({ status: 'LEFT_QUEUE', queue: null });
    expect((await createPlayerSession(baseUrl, 'new-off-session')).status).toBe(409);
  });

  it('issues player-bound challenge tokens and claims rewards atomically through POST', async () => {
    const { baseUrl, store } = await harness({ playerMode: 'lead_capture' });
    const cookie = cookieFrom(await createPlayerSession(baseUrl, 'challenge-player'));
    const registration = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'challenge-register',
      },
      body: JSON.stringify(REGISTRATION),
    });
    expect(registration.status).toBe(200);

    const listed = await fetch(`${baseUrl}/api/arcade/challenges`, { headers: { Cookie: cookie } });
    const listBody = await listed.json() as Record<string, any>;
    expect(listBody.challenges).toEqual([{
      id: 'voice-docs',
      title: 'Read the Voice docs',
      rewardCoins: 1,
      displayOrder: 0,
      claimCount: 0,
      maxClaimsPerPlayer: 1,
      available: true,
      startsAt: null,
      endsAt: null,
    }]);
    expect(JSON.stringify(listBody)).not.toMatch(/twilio\.com|destination|token|player:/i);

    const tokenResponse = await fetch(`${baseUrl}/api/arcade/challenges/voice-docs/token`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = await tokenResponse.json() as Record<string, any>;
    expect(tokenBody.challengeId).toBe('voice-docs');
    expect(typeof tokenBody.token).toBe('string');

    const claim = (key: string) => fetch(`${baseUrl}/api/arcade/challenges/voice-docs/claim`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      },
      body: JSON.stringify({ token: tokenBody.token }),
    });
    const first = await claim('challenge-claim');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      challengeId: 'voice-docs',
      rewardCoins: 1,
      availableBalance: 2,
      destinationUrl: 'https://www.twilio.com/docs/voice',
    });
    expect((await claim('challenge-claim')).status).toBe(200);
    const replayedToken = await claim('challenge-token-replay');
    expect(replayedToken.status).toBe(409);
    expect((await replayedToken.json() as Record<string, any>).error.code).toBe('CHALLENGE_TOKEN_REPLAYED');

    const movedCabinet = JSON.parse(JSON.stringify(settings('lead_capture'))) as Record<string, any>;
    movedCabinet.arcade.cabinetId = 'ARCADE-02';
    await store.update({
      expectedVersion: 2,
      idempotencyKey: 'challenge-cabinet-change',
      updatedBy: 'admin@twilio.com',
      settings: movedCabinet,
    });
    expect((await claim('challenge-claim')).status).toBe(200);

    const after = await (await fetch(`${baseUrl}/api/arcade/challenges`, {
      headers: { Cookie: cookie },
    })).json() as Record<string, any>;
    expect(after.challenges[0]).toMatchObject({ claimCount: 1, available: false });
  });

  it('lets authenticated operators advance and release a player queue journey with audit reasons', async () => {
    const { baseUrl, store, playerRuntime } = await harness({ playerMode: 'lead_capture' });
    const cookie = cookieFrom(await createPlayerSession(baseUrl, 'operator-queue-player'));
    const playerMutation = (path: string, key: string, body: unknown) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    expect((await playerMutation('/api/arcade/register', 'operator-register', REGISTRATION)).status).toBe(200);
    expect((await playerMutation('/api/arcade/queue/join', 'operator-join', {
      preferredGame: 'racer', flexibleGame: false,
    })).status).toBe(200);

    expect((await fetch(`${baseUrl}/api/admin/arcade/queue`)).status).toBe(401);
    const queueResponse = await fetch(`${baseUrl}/api/admin/arcade/queue`, { headers: ADMIN_HEADER });
    const queueBody = await queueResponse.json() as Record<string, any>;
    expect(queueBody.queue).toHaveLength(1);
    expect(JSON.stringify(queueBody)).not.toMatch(/playerId|email|phone|company/i);
    const queueEntryId = queueBody.queue[0].queueEntryId as string;
    const operatorAction = (action: string, key: string, reason: string) => fetch(
      `${baseUrl}/api/admin/arcade/queue/${queueEntryId}/${action}`,
      {
        method: 'POST',
        headers: {
          ...ADMIN_HEADER,
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ reason }),
      },
    );

    expect((await operatorAction(
      'approach', 'operator-oversized-audit', '\ud800'.repeat(200),
    )).status).toBe(400);
    expect((await operatorAction('approach', 'operator-approach', 'two groups away')).status).toBe(200);
    expect((await playerMutation('/api/arcade/queue/confirm', 'operator-player-confirm', {})).status).toBe(200);
    expect((await operatorAction('call', 'operator-call', 'cabinet ready')).status).toBe(200);
    const checkedIn = await playerMutation('/api/arcade/check-in', 'operator-check-in', { game: 'racer' });
    expect(await checkedIn.json()).toMatchObject({
      status: 'CHECKED_IN', availableBalance: 0, reservation: { amount: 1, status: 'ACTIVE' },
    });
    expect((await operatorAction('activate', 'operator-activate', 'player at cabinet')).status).toBe(200);
    const state = (await playerRuntime.getActive()).store.snapshot();
    expect(state.queueEvents.find(event => event.type === 'MARKED_APPROACHING')?.reason)
      .toBe('{"operator":"admin@twilio.com","reason":"two groups away"}');
    const started = await fetch(`${baseUrl}/api/admin/arcade/matches/start`, {
      method: 'POST',
      headers: {
        ...ADMIN_HEADER, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'operator-match-start',
      },
      body: JSON.stringify({
        queueEntryIds: [queueEntryId], game: 'racer', reason: 'starting ready players',
      }),
    });
    expect(started.status).toBe(200);
    const startedBody = await started.json() as Record<string, any>;
    expect(startedBody).toMatchObject({
      entries: [{ queueEntryId, status: 'PLAYING' }],
    });

    await store.update({
      expectedVersion: 2,
      idempotencyKey: 'operator-switch-off',
      updatedBy: 'admin@twilio.com',
      settings: settings('off'),
    });
    const completed = await fetch(
      `${baseUrl}/api/admin/arcade/matches/${startedBody.matchId}/complete`,
      {
        method: 'POST',
        headers: {
          ...ADMIN_HEADER, Origin: 'http://localhost',
          'Content-Type': 'application/json', 'Idempotency-Key': 'operator-match-complete',
        },
        body: JSON.stringify({ queueEntryIds: [queueEntryId], reason: 'authoritative game result' }),
      },
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      matchId: startedBody.matchId,
      entries: [{ queueEntryId, status: 'COMPLETED' }],
    });
  });
});
