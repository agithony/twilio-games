import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { HttpServer } from '../server/http-server';

let server: HttpServer | undefined;
let live = '', previews = '';
afterEach(async () => { await server?.stop(); server = undefined; if (live) await rm(live, { force: true }); if (previews) await rm(previews, { recursive: true, force: true }); });

async function start() {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  live = `assets/_test-fighter-maps-${id}.json`; previews = `assets/_test-fighter-previews-${id}`;
  server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
    fighterMapsPath: live, bundledFighterMapsPath: 'assets/fighters/maps/maps.json', fighterPreviewDir: previews });
  return server.start();
}

describe('fighter map API', () => {
  it('seeds the live catalog and rejects malformed replacement data', async () => {
    const port = await start(), base = `http://127.0.0.1:${port}`;
    const before = await (await fetch(`${base}/api/fighter-maps`)).json() as unknown[];
    expect(before.length).toBeGreaterThan(1);
    const bad = await fetch(`${base}/api/fighter-maps`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: '<script>', name: 'Bad', blurb: 'Bad', color: '#ffffff', bounds: [9, -9] }]) });
    expect(bad.status).toBe(400);
    expect((await (await fetch(`${base}/api/fighter-maps`)).json() as unknown[]).length).toBe(before.length);
  });

  it('validates preview uploads and serves persistent PNG files', async () => {
    const port = await start(), base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/api/fighter-map-preview?id=test`, { method: 'POST', body: 'not png' })).status).toBe(400);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    expect((await fetch(`${base}/api/fighter-map-preview?id=test`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).status).toBe(200);
    expect((await fetch(`${base}/fighter-previews/test.png`)).status).toBe(200);
  });
});
