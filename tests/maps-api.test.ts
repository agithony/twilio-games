import { describe, it, expect, afterEach } from 'vitest';
import { HttpServer } from '../server/http-server';
import { unlink, writeFile, readFile } from 'node:fs/promises';

// Temp maps path so tests never touch the real assets/maps/maps.json.
const TEST_MAPS = 'assets/_test-maps-api.json';
let srv: HttpServer;
afterEach(async () => { await srv?.stop(); try { await unlink(TEST_MAPS); } catch {} });

const VALID = { map: 'silver_lake', file: 'silver_lake.glb',
  model: { pos: [0, 0, 1050], rotDeg: [0, 0, 0], scale: 200 },
  track: { pos: [0, 0, 1050], rotDeg: [0, 0, 0], scale: 1 } };

function makeServer(extra: Record<string, unknown> = {}) {
  return new HttpServer({ port: 0, publicBaseUrl: 'http://localhost',
    validateSignatures: false, mapsPath: TEST_MAPS, ...extra });
}

describe('maps API', () => {
  it('POST then GET round-trips a level', async () => {
    srv = makeServer(); const port = await srv.start();
    const post = await fetch(`http://127.0.0.1:${port}/api/maps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(VALID) });
    expect(post.status).toBe(200);
    const get = await (await fetch(`http://127.0.0.1:${port}/api/maps`)).json();
    expect(get.silver_lake.map).toBe('silver_lake');
    expect(get.silver_lake.model.scale).toBe(200);
  });

  it('saving one level does NOT drop the others', async () => {
    await writeFile(TEST_MAPS, JSON.stringify({ desert: { map: 'desert', file: 'desert.glb' } }));
    srv = makeServer(); const port = await srv.start();
    await fetch(`http://127.0.0.1:${port}/api/maps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(VALID) });
    const get = await (await fetch(`http://127.0.0.1:${port}/api/maps`)).json();
    expect(Object.keys(get).sort()).toEqual(['desert', 'silver_lake']);
  });

  it('CRITICAL: a corrupt existing maps file is NOT overwritten (400, file preserved)', async () => {
    await writeFile(TEST_MAPS, 'corrupt {{{ not json');
    srv = makeServer(); const port = await srv.start();
    const post = await fetch(`http://127.0.0.1:${port}/api/maps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(VALID) });
    expect(post.status).toBe(400);
    // the corrupt file is left untouched rather than wiped to a single-level file
    expect(await readFile(TEST_MAPS, 'utf8')).toBe('corrupt {{{ not json');
  });

  it('rejects a config with no map name (400)', async () => {
    srv = makeServer(); const port = await srv.start();
    const post = await fetch(`http://127.0.0.1:${port}/api/maps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'x.glb' }) });
    expect(post.status).toBe(400);
  });

  it('with EDITOR_TOKEN set, writes require the token', async () => {
    srv = makeServer({ editorToken: 'secret123' }); const port = await srv.start();
    const noTok = await fetch(`http://127.0.0.1:${port}/api/maps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(VALID) });
    expect(noTok.status).toBe(401);
    const withTok = await fetch(`http://127.0.0.1:${port}/api/maps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-editor-token': 'secret123' }, body: JSON.stringify(VALID) });
    expect(withTok.status).toBe(200);
  });

  it('without EDITOR_TOKEN, writes are open (local dev)', async () => {
    srv = makeServer(); const port = await srv.start();
    const post = await fetch(`http://127.0.0.1:${port}/api/maps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(VALID) });
    expect(post.status).toBe(200);
  });
});
