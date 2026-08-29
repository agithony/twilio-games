import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpServer } from '../server/http-server';
import { KARAOKE_RUNTIME_SONGS } from '../shared/karaoke-songs';

let directory = '';
let timingsPath = '';
let server: HttpServer | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'karaoke-timings-'));
  await mkdir(join(directory, 'data'), { recursive: true });
  timingsPath = join(directory, 'data', 'karaoke-timings.json');
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function start(editorToken?: string): Promise<string> {
  server = new HttpServer({
    port: 0,
    publicBaseUrl: 'http://localhost',
    validateSignatures: false,
    karaokeTimingsPath: timingsPath,
    editorToken,
  });
  return `http://127.0.0.1:${await server.start()}`;
}

function changedConfig() {
  const song = KARAOKE_RUNTIME_SONGS[0]!;
  const word = song.chart.words[0]!;
  return {
    version: 1,
    songs: [{ songId: song.id, words: [{
      wordId: word.id, startMs: word.startMs + 20, endMs: word.endMs,
    }] }],
  };
}

describe('Karaoke timing API', () => {
  it('loads an empty fallback and persists an authenticated ETag-protected update', async () => {
    const base = await start('timing-secret');
    const initial = await fetch(`${base}/api/karaoke-timings`);
    const etag = initial.headers.get('etag');
    expect(initial.status).toBe(200);
    expect(initial.headers.get('cache-control')).toBe('no-store');
    expect(etag).toMatch(/^"karaoke-timings-/);
    expect(await initial.json()).toEqual({ version: 1, songs: [] });

    expect((await fetch(`${base}/api/karaoke-timings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': etag! },
      body: JSON.stringify(changedConfig()),
    })).status).toBe(401);
    expect((await fetch(`${base}/api/karaoke-timings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-editor-token': 'timing-secret' },
      body: JSON.stringify(changedConfig()),
    })).status).toBe(428);

    const saved = await fetch(`${base}/api/karaoke-timings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-editor-token': 'timing-secret', 'If-Match': etag!,
      },
      body: JSON.stringify(changedConfig()),
    });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('etag')).not.toBe(etag);
    expect(await saved.json()).toEqual(changedConfig());
    expect(JSON.parse(await readFile(timingsPath, 'utf8'))).toEqual(changedConfig());
  });

  it('rejects stale and invalid updates without altering persisted timings', async () => {
    const base = await start();
    const initial = await fetch(`${base}/api/karaoke-timings`);
    const etag = initial.headers.get('etag')!;
    const save = () => fetch(`${base}/api/karaoke-timings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': etag },
      body: JSON.stringify(changedConfig()),
    });
    expect((await save()).status).toBe(200);
    expect((await save()).status).toBe(412);
    const before = await readFile(timingsPath, 'utf8');
    const bad = changedConfig();
    bad.songs[0]!.words[0]!.endMs = KARAOKE_RUNTIME_SONGS[0]!.chart.words[1]!.startMs + 1;
    const currentEtag = (await fetch(`${base}/api/karaoke-timings`)).headers.get('etag')!;
    expect((await fetch(`${base}/api/karaoke-timings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': currentEtag },
      body: JSON.stringify(bad),
    })).status).toBe(400);
    expect(await readFile(timingsPath, 'utf8')).toBe(before);
  });

  it('reloads persisted timing overrides on restart', async () => {
    let base = await start();
    const etag = (await fetch(`${base}/api/karaoke-timings`)).headers.get('etag')!;
    await fetch(`${base}/api/karaoke-timings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': etag },
      body: JSON.stringify(changedConfig()),
    });
    await server!.stop();
    server = undefined;
    base = await start();
    expect(await (await fetch(`${base}/api/karaoke-timings`)).json()).toEqual(changedConfig());
  });
});
