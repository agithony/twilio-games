// GET/POST /api/arena — the Voice Monsters battle-arena config (transform / camera / spin), authored
// in the multi-game editor. Deploy-safe like maps: lives on the persistent mount, seeded once from
// the bundled default. Round-trips + tolerates a missing/corrupt file.
import { describe, it, expect, afterEach } from 'vitest';
import { HttpServer } from '../server/http-server';
import { unlink, writeFile } from 'node:fs/promises';

let TEST_ARENA = '';
let srv: HttpServer;
let n = 0;
afterEach(async () => { await srv?.stop(); try { await unlink(TEST_ARENA); } catch {} });

function makeServer() {
  TEST_ARENA = `assets/_test-arena-${process.pid}-${n++}.json`;
  return new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, arenaPath: TEST_ARENA });
}
const VALID = { file: 'arena.glb', pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1, spinSpeed: 0.2 };

describe('arena API', () => {
  it('POST then GET round-trips the arena config', async () => {
    srv = makeServer(); const port = await srv.start();
    const post = await fetch(`http://127.0.0.1:${port}/api/arena`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(VALID) });
    expect(post.status).toBe(200);
    const got = await (await fetch(`http://127.0.0.1:${port}/api/arena`)).json();
    expect(got.file).toBe('arena.glb');
    expect(got.spinSpeed).toBe(0.2);
  });

  it('GET returns a default when no config exists yet (never 500s)', async () => {
    srv = makeServer(); const port = await srv.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/arena`);
    expect(res.status).toBe(200);
    const got = await res.json();
    expect(typeof got.file).toBe('string');   // a usable default
  });

  it('rejects a non-object body (400)', async () => {
    srv = makeServer(); const port = await srv.start();
    const post = await fetch(`http://127.0.0.1:${port}/api/arena`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '"nope"' });
    expect(post.status).toBe(400);
  });

  it('honors the editor token when set', async () => {
    TEST_ARENA = `assets/_test-arena-${process.pid}-${n++}.json`;
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      arenaPath: TEST_ARENA, editorToken: 'sek' });
    const port = await srv.start();
    const noTok = await fetch(`http://127.0.0.1:${port}/api/arena`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(VALID) });
    expect(noTok.status).toBe(401);
    const withTok = await fetch(`http://127.0.0.1:${port}/api/arena`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-editor-token': 'sek' }, body: JSON.stringify(VALID) });
    expect(withTok.status).toBe(200);
  });
});
