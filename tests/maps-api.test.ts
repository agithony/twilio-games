import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { HttpServer } from '../server/http-server';
import { unlink, writeFile, readFile } from 'node:fs/promises';

// Unique temp maps path PER TEST so concurrent test files / leftover .tmp files can't race.
let TEST_MAPS = 'assets/_test-maps-api.json';
let n = 0;
beforeEach(() => { TEST_MAPS = `assets/_test-maps-api-${process.pid}-${n++}.json`; });
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

  it('DELETE removes a level, leaving the others (for delete + rename-via-resave)', async () => {
    await writeFile(TEST_MAPS, JSON.stringify({
      silver_lake: { map: 'silver_lake', file: 's.glb' },
      desert: { map: 'desert', file: 'd.glb' },
    }));
    srv = makeServer(); const port = await srv.start();
    const del = await fetch(`http://127.0.0.1:${port}/api/maps?map=desert`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const get = await (await fetch(`http://127.0.0.1:${port}/api/maps`)).json();
    expect(Object.keys(get)).toEqual(['silver_lake']);
  });

  it('DELETE requires the editor token when one is set', async () => {
    await writeFile(TEST_MAPS, JSON.stringify({ a: { map: 'a', file: 'a.glb' } }));
    srv = makeServer({ editorToken: 'sek' }); const port = await srv.start();
    const noTok = await fetch(`http://127.0.0.1:${port}/api/maps?map=a`, { method: 'DELETE' });
    expect(noTok.status).toBe(401);
  });
});

// Deploy-safe persistence: the live maps file lives on the persistent mount (data/maps.json) and is
// seeded ONCE from the image's bundled defaults on first boot. After that, prod-authored levels in
// the live file must survive redeploys — the server must NOT overwrite them with the bundled copy.
describe('maps persistence seeding (deploy-safe)', () => {
  let BUNDLED = '';
  beforeEach(() => { BUNDLED = `assets/_test-bundled-${process.pid}-${n++}.json`; });
  afterEach(async () => { try { await unlink(BUNDLED); } catch {} });

  it('seeds the live file from the bundled defaults on FIRST boot (live file absent)', async () => {
    await writeFile(BUNDLED, JSON.stringify({ Silver_Lake: { map: 'Silver_Lake', file: 's.glb' } }));
    try { await unlink(TEST_MAPS); } catch {}   // ensure the live file does NOT exist
    srv = makeServer({ bundledMapsPath: BUNDLED }); const port = await srv.start();
    const get = await (await fetch(`http://127.0.0.1:${port}/api/maps`)).json();
    expect(Object.keys(get)).toEqual(['Silver_Lake']);
    // the live file now physically exists (persisted), so subsequent boots read IT, not the bundle
    expect(JSON.parse(await readFile(TEST_MAPS, 'utf8'))).toHaveProperty('Silver_Lake');
  });

  it('does NOT overwrite existing prod-authored levels with the bundled copy (survives deploy)', async () => {
    // Simulate a prior boot where the author created "Drift" in the editor (only in the live file).
    await writeFile(TEST_MAPS, JSON.stringify({ Drift: { map: 'Drift', file: 'd.glb' } }));
    // A new image ships with a DIFFERENT bundled default (only Silver Lake).
    await writeFile(BUNDLED, JSON.stringify({ Silver_Lake: { map: 'Silver_Lake', file: 's.glb' } }));
    srv = makeServer({ bundledMapsPath: BUNDLED }); const port = await srv.start();
    const get = await (await fetch(`http://127.0.0.1:${port}/api/maps`)).json();
    // Drift must still be there — the deploy did NOT clobber it.
    expect(Object.keys(get)).toContain('Drift');
  });
});
