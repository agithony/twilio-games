import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { HttpServer } from '../server/http-server';
import { unlink, writeFile, mkdir } from 'node:fs/promises';

// Unique temp leaderboard path per test (concurrent files / leftover .tmp can't race).
let LB = 'data/_test-lb.json';
let n = 0;
beforeEach(async () => { await mkdir('data', { recursive: true }); LB = `data/_test-lb-${process.pid}-${n++}.json`; });
let srv: HttpServer;
afterEach(async () => { await srv?.stop(); try { await unlink(LB); } catch {} });

function makeServer() {
  return new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, leaderboardPath: LB });
}

const seed = [
  { name: 'A', map: 'Silver Lake', carIndex: 0, finishT: 50, at: 1, enginePlayerId: 'ROOM:p1' },
  { name: 'B', map: 'Silver Lake', carIndex: 1, finishT: 40, at: 2 },
  { name: 'C', map: 'Neon City',  carIndex: 2, finishT: 30, at: 3 },
];

describe('leaderboard API', () => {
  it('GET returns global best times ascending', async () => {
    await writeFile(LB, JSON.stringify(seed));
    srv = makeServer(); const port = await srv.start();
    const data = await (await fetch(`http://127.0.0.1:${port}/api/leaderboard`)).json();
    expect(data.entries.map((e: any) => e.name)).toEqual(['C', 'B', 'A']);   // 30, 40, 50
    expect(JSON.stringify(data)).not.toContain('enginePlayerId');
  });

  it('GET ?map= filters to one track', async () => {
    await writeFile(LB, JSON.stringify(seed));
    srv = makeServer(); const port = await srv.start();
    const data = await (await fetch(`http://127.0.0.1:${port}/api/leaderboard?map=Silver%20Lake`)).json();
    expect(data.entries.map((e: any) => e.name)).toEqual(['B', 'A']);
  });

  it('GET ?limit= caps the rows', async () => {
    await writeFile(LB, JSON.stringify(seed));
    srv = makeServer(); const port = await srv.start();
    const data = await (await fetch(`http://127.0.0.1:${port}/api/leaderboard?limit=1`)).json();
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].name).toBe('C');
  });

  it('GET with no file yet returns an empty board (not an error)', async () => {
    srv = makeServer(); const port = await srv.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/leaderboard`);
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toEqual([]);
  });
});
