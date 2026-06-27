import { describe, it, expect, afterEach } from 'vitest';
import { HttpServer } from '../server/http-server';
import { unlink } from 'node:fs/promises';

// Use a temp manifest path so tests never touch the real assets/manifest.json.
const TEST_MANIFEST = 'assets/_test-manifest-api.json';
let srv: HttpServer;
afterEach(async () => { await srv?.stop(); try { await unlink(TEST_MANIFEST); } catch {} });

describe('manifest API', () => {
  it('POST then GET round-trips a manifest', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, manifestPath: TEST_MANIFEST });
    const port = await srv.start();
    const payload = { cars: [{ file: 'a.glb', scale: 1.5 }], barrier: null, boostPad: null, props: [] };
    const post = await fetch(`http://127.0.0.1:${port}/api/manifest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(post.status).toBe(200);
    const get = await fetch(`http://127.0.0.1:${port}/api/manifest`);
    const m = await get.json();
    expect(m.cars[0].file).toBe('a.glb');
    expect(m.cars[0].scale).toBe(1.5);
  });
  it('POST with malformed JSON stores an empty manifest (tolerant, no crash)', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, manifestPath: TEST_MANIFEST });
    const port = await srv.start();
    const post = await fetch(`http://127.0.0.1:${port}/api/manifest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
    expect(post.status).toBe(200);
    const m = await post.json();
    expect(m).toEqual({ cars: [], barrier: null, boostPad: null, props: [] });
  });
});
