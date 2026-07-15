// The container runs ONE process: the Node server must serve the Vite-built client (HTML pages,
// /brand, /fonts, hashed JS under /assets/) AND the repo-root GLB models (also under /assets/),
// plus an unauthenticated /healthz for the deploy smoke. In dev Vite does this; these tests pin the
// production single-process behavior.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { HttpServer, contentType } from '../server/http-server';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

let srv: HttpServer;
let clientDir = '';
let n = 0;
beforeEach(async () => {
  clientDir = `tmp/_test-client-${process.pid}-${n++}`;
  await mkdir(join(clientDir, 'assets'), { recursive: true });
  await mkdir(join(clientDir, 'brand'), { recursive: true });
  await mkdir(join(clientDir, 'editor'), { recursive: true });
  await mkdir(join(clientDir, 'garage'), { recursive: true });
  await mkdir(join(clientDir, 'analytics'), { recursive: true });
  await writeFile(join(clientDir, 'index.html'), '<!doctype html><title>home</title>');
  await writeFile(join(clientDir, 'play.html'), '<!doctype html><title>play</title>');
  await writeFile(join(clientDir, 'editor', 'index.html'), '<!doctype html><title>editor</title>');
  await writeFile(join(clientDir, 'garage', 'index.html'), '<!doctype html><title>garage</title>');
  await writeFile(join(clientDir, 'analytics', 'index.html'), '<!doctype html><title>analytics</title>');
  await writeFile(join(clientDir, 'assets', 'play-ABC123.js'), 'console.log("bundle")');
  await writeFile(join(clientDir, 'brand', 'logo.svg'), '<svg/>');
});
afterEach(async () => { await srv?.stop(); try { await rm(clientDir, { recursive: true, force: true }); } catch {} });

function makeServer() {
  return new HttpServer({ port: 0, publicBaseUrl: 'http://localhost',
    validateSignatures: false, clientDir });
}
const get = async (port: number, p: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
};

describe('healthz', () => {
  it('GET /healthz returns 200 JSON without auth', async () => {
    srv = makeServer(); const port = await srv.start();
    const r = await get(port, '/healthz');
    expect(r.status).toBe(200);
    expect(r.type).toContain('application/json');
    expect(JSON.parse(r.body).status).toBe('ok');
  });
});

describe('static client serving', () => {
  it('serves the home page at /', async () => {
    srv = makeServer(); const port = await srv.start();
    const r = await get(port, '/');
    expect(r.status).toBe(200);
    expect(r.type).toContain('text/html');
    expect(r.body).toContain('home');
  });

  it('serves /play.html', async () => {
    srv = makeServer(); const port = await srv.start();
    expect((await get(port, '/play.html')).body).toContain('play');
  });

  it('serves folder-index pages at /editor, /garage, and /analytics (bare path)', async () => {
    srv = makeServer(); const port = await srv.start();
    expect((await get(port, '/editor')).body).toContain('editor');
    expect((await get(port, '/garage')).body).toContain('garage');
    expect((await get(port, '/analytics')).body).toContain('analytics');
  });

  it('serves the built JS bundle under /assets/ (with a JS content-type)', async () => {
    srv = makeServer(); const port = await srv.start();
    const r = await get(port, '/assets/play-ABC123.js');
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/javascript/);
    expect(r.body).toContain('bundle');
  });

  it('serves /brand assets', async () => {
    srv = makeServer(); const port = await srv.start();
    expect((await get(port, '/brand/logo.svg')).status).toBe(200);
  });

  it('falls back to repo-root assets/ for a GLB not in the client bundle', async () => {
    // No GLB in the fixture client dir → the server must fall back to the real assets/ dir, which
    // holds the manifest.json. We request a known repo asset (manifest.json) to prove fallback.
    srv = makeServer(); const port = await srv.start();
    const r = await get(port, '/assets/manifest.json');
    expect(r.status).toBe(200);
    expect(r.type).toContain('application/json');
    expect(JSON.parse(r.body).cars).toBeDefined();   // real repo manifest
  });

  it('maps audio extensions to decodable MIME types (shared-screen music)', () => {
    expect(contentType('assets/music/racing.mp3')).toBe('audio/mpeg');
    expect(contentType('x.ogg')).toBe('audio/ogg');
    expect(contentType('x.wav')).toBe('audio/wav');
    expect(contentType('x.m4a')).toBe('audio/mp4');
    expect(contentType('x.mp4')).toBe('video/mp4');
    // unknown stays octet-stream
    expect(contentType('x.zzz')).toBe('application/octet-stream');
  });

  it('maps .otf fonts to font/otf (else browsers reject the @font-face → wrong font in prod)', () => {
    expect(contentType('/fonts/TwilioSansDisplay-Extrabold.otf')).toBe('font/otf');
    expect(contentType('x.woff2')).toBe('font/woff2');
    expect(contentType('x.ttf')).toBe('font/ttf');
  });

  it('still 404s an unknown path', async () => {
    srv = makeServer(); const port = await srv.start();
    expect((await get(port, '/nope/missing')).status).toBe(404);
  });

  it('does not traverse outside the client dir', async () => {
    srv = makeServer(); const port = await srv.start();
    const r = await get(port, '/assets/../../etc/passwd');
    expect([403, 404]).toContain(r.status);
  });
});
