import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpServer } from '../server/http-server';
import { cloneKaraokeVenueConfig } from '../shared/karaoke-venue';

let directory = '';
let live = '';
let bundled = '';
let assets = '';
let server: HttpServer | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'karaoke-venue-'));
  live = join(directory, 'data', 'karaoke-venue.json');
  bundled = join(directory, 'assets', 'venue.json');
  assets = join(directory, 'assets', 'karaoke');
  await mkdir(join(directory, 'data'), { recursive: true });
  await mkdir(assets, { recursive: true });
  await writeFile(bundled, JSON.stringify(cloneKaraokeVenueConfig()));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(directory, { recursive: true, force: true });
});

function makeServer(options: { editorToken?: string; seed?: boolean } = {}): HttpServer {
  return new HttpServer({
    port: 0,
    publicBaseUrl: 'http://localhost',
    validateSignatures: false,
    karaokeVenuePath: live,
    bundledKaraokeVenuePath: options.seed === false ? undefined : bundled,
    karaokeAssetDirectory: assets,
    editorToken: options.editorToken,
  });
}

async function start(options?: Parameters<typeof makeServer>[0]) {
  server = makeServer(options);
  const port = await server.start();
  return `http://127.0.0.1:${port}`;
}

describe('Karaoke venue API', () => {
  it('seeds a missing live file from the strict image fallback', async () => {
    const seeded = cloneKaraokeVenueConfig();
    seeded.cameras.landscape.fov = 51;
    await writeFile(bundled, JSON.stringify(seeded));
    const base = await start();
    const response = await fetch(`${base}/api/karaoke-venue`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).cameras.landscape.fov).toBe(51);
    expect(JSON.parse(await readFile(live, 'utf8')).cameras.landscape.fov).toBe(51);
  });

  it('preserves valid live authoring instead of replacing it from the image', async () => {
    const authored = cloneKaraokeVenueConfig();
    authored.models[0]!.transform.position[0] = 7;
    await writeFile(live, JSON.stringify(authored));
    const bundledConfig = cloneKaraokeVenueConfig();
    bundledConfig.models[0]!.transform.position[0] = -7;
    await writeFile(bundled, JSON.stringify(bundledConfig));
    const base = await start();
    expect((await (await fetch(`${base}/api/karaoke-venue`)).json()).models[0].transform.position[0]).toBe(7);
  });

  it('repairs a corrupt live copy from a valid bundled fallback', async () => {
    await writeFile(live, '{corrupt');
    const fallback = cloneKaraokeVenueConfig();
    fallback.drumAnchor.mode = 'manual';
    await writeFile(bundled, JSON.stringify(fallback));
    const base = await start();
    expect((await (await fetch(`${base}/api/karaoke-venue`)).json()).drumAnchor.mode).toBe('manual');
    expect(JSON.parse(await readFile(live, 'utf8')).drumAnchor.mode).toBe('manual');
  });

  it('falls back to the compiled strict default when both files are unavailable', async () => {
    await rm(bundled, { force: true });
    const base = await start({ seed: false });
    const venue = await (await fetch(`${base}/api/karaoke-venue`)).json();
    expect(venue.version).toBe(1);
    expect(venue.models).toHaveLength(5);
  });

  it('round-trips a strict authenticated update atomically', async () => {
    const base = await start({ editorToken: 'venue-secret' });
    const venue = cloneKaraokeVenueConfig();
    venue.cameras.portrait.position = [2, 8, 20];
    expect((await fetch(`${base}/api/karaoke-venue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(venue),
    })).status).toBe(401);
    const saved = await fetch(`${base}/api/karaoke-venue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-editor-token': 'venue-secret' },
      body: JSON.stringify(venue),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).cameras.portrait.position).toEqual([2, 8, 20]);
    expect((await (await fetch(`${base}/api/karaoke-venue`)).json()).cameras.portrait.position).toEqual([2, 8, 20]);
  });

  it('never alters valid live data for malformed JSON or malformed config', async () => {
    const initial = cloneKaraokeVenueConfig();
    initial.models[1]!.transform.position[0] = -4;
    await writeFile(live, `${JSON.stringify(initial)}\n`);
    const base = await start();
    const before = await readFile(live, 'utf8');
    const badJson = await fetch(`${base}/api/karaoke-venue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
    });
    expect(badJson.status).toBe(400);
    expect(await readFile(live, 'utf8')).toBe(before);
    const malformed = { ...initial, surprise: true };
    const badConfig = await fetch(`${base}/api/karaoke-venue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(malformed),
    });
    expect(badConfig.status).toBe(400);
    expect(await readFile(live, 'utf8')).toBe(before);
  });

  it('lists only direct safe release GLB basenames', async () => {
    await Promise.all([
      writeFile(join(assets, 'stage.glb'), 'glb'),
      writeFile(join(assets, 'Singer-2.GLB'), 'glb'),
      writeFile(join(assets, '.hidden.glb'), 'glb'),
      writeFile(join(assets, 'notes.txt'), 'text'),
      mkdir(join(assets, '_raw'), { recursive: true }),
      mkdir(join(assets, 'directory.glb'), { recursive: true }),
    ]);
    await writeFile(join(assets, '_raw', 'secret.glb'), 'raw');
    const base = await start();
    const response = await fetch(`${base}/api/karaoke-asset-files`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(['Singer-2.GLB', 'stage.glb']);
  });
});
