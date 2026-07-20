import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ARCADE_CONFIG, type ArcadeConfigSettings } from '../shared/arcade-config';
import { ArcadeApi } from '../server/arcade-api';
import { ArcadeConfigStore } from '../server/arcade-config-store';
import { ArcadeEventHub } from '../server/arcade-events';
import { HttpServer } from '../server/http-server';

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

async function harness(options: { maxEventStreams?: number } = {}): Promise<{
  baseUrl: string;
  store: ArcadeConfigStore;
}> {
  directory = await mkdtemp(path.join(tmpdir(), 'arcade-api-'));
  const events = new ArcadeEventHub();
  const store = new ArcadeConfigStore({ directory: path.join(directory, 'arcade'), events });
  const api = new ArcadeApi({
    configStore: store,
    events,
    publicBaseUrl: 'http://localhost',
    heartbeatMs: 20,
    maxEventStreams: options.maxEventStreams,
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
  return { baseUrl: `http://127.0.0.1:${port}`, store };
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
      ...(options.origin ? { Origin: options.origin } : {}),
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
      headers: { ...ADMIN_HEADER, 'Content-Type': 'text/plain' },
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
});
