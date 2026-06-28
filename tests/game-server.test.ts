import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { GameServer } from '../server/game-server';
import type { ServerMessage } from '../shared/types';

let server: GameServer;
afterEach(async () => { await server?.stop(); });

function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: ServerMessage[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  return { ws, inbox, open: () => new Promise<void>(r => ws.on('open', () => r())) };
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('GameServer integration', () => {
  it('a client can join and receive a joined ack with a lane', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const c = connect(port); await c.open();
    c.ws.send(JSON.stringify({ type: 'join', roomCode: '4821', name: 'You' }));
    await wait(100);
    const joined = c.inbox.find(m => m.type === 'joined') as any;
    expect(joined).toBeDefined();
    expect(joined.lane).toBe(0);
    expect(joined.roomCode).toBe('4821');
  });

  it('after ready, the client receives items then snapshots', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const c = connect(port); await c.open();
    c.ws.send(JSON.stringify({ type: 'join', roomCode: '5000', name: 'You' }));
    await wait(50);
    c.ws.send(JSON.stringify({ type: 'ready' }));
    await wait(200);
    expect(c.inbox.some(m => m.type === 'items')).toBe(true);
    expect(c.inbox.some(m => m.type === 'snapshot')).toBe(true);
  });

  it('two clients in the same room both appear in the snapshot', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const a = connect(port); await a.open();
    const b = connect(port); await b.open();
    a.ws.send(JSON.stringify({ type: 'join', roomCode: '7777', name: 'You' }));
    b.ws.send(JSON.stringify({ type: 'join', roomCode: '7777', name: 'Ada' }));
    await wait(50);
    a.ws.send(JSON.stringify({ type: 'ready' }));
    await wait(200);
    const snap = [...a.inbox].reverse().find(m => m.type === 'snapshot') as any;
    expect(snap.snapshot.cars).toHaveLength(2);
  });

  it('events reach all clients in a room, not just the first', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const a = connect(port); await a.open();
    const b = connect(port); await b.open();
    a.ws.send(JSON.stringify({ type: 'join', roomCode: '9090', name: 'You' }));
    b.ws.send(JSON.stringify({ type: 'join', roomCode: '9090', name: 'Ada' }));
    await wait(50);
    a.ws.send(JSON.stringify({ type: 'ready' }));
    await wait(700);
    expect(a.inbox.some(m => m.type === 'event')).toBe(true);
    expect(b.inbox.some(m => m.type === 'event')).toBe(true);
  });

  it('two players in lobby both receive a lobby roster with both names', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const a = connect(port); await a.open();
    const b = connect(port); await b.open();
    a.ws.send(JSON.stringify({ type: 'join', roomCode: '8200', name: 'Ada' }));
    b.ws.send(JSON.stringify({ type: 'join', roomCode: '8200', name: 'Rex' }));
    await wait(250);
    const lob = [...b.inbox].reverse().find((m: any) => m.type === 'lobby') as any;
    expect(lob).toBeDefined();
    const names = lob.players.map((p: any) => p.name).sort();
    expect(names).toEqual(['Ada', 'Rex']);
    expect(lob.phase).toBe('lobby');
  });

  it('reclaims a room once its last player disconnects (no leak)', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const c = connect(port); await c.open();
    c.ws.send(JSON.stringify({ type: 'join', roomCode: '3030', name: 'You' }));
    await wait(80);
    expect(server.roomCount).toBe(1);
    c.ws.close();
    await wait(120);
    expect(server.roomCount).toBe(0);
  });

  it('restart is ignored while a race is in progress (no griefing)', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const c = connect(port); await c.open();
    c.ws.send(JSON.stringify({ type: 'join', roomCode: '3131', name: 'You' }));
    await wait(50);
    c.ws.send(JSON.stringify({ type: 'ready' }));
    await wait(3800);   // past the ~3.2s countdown, into racing + advancing
    const before = [...c.inbox].reverse().find(m => m.type === 'snapshot') as any;
    expect(before.snapshot.phase).toBe('racing');
    const tBefore = before.snapshot.t;
    c.ws.send(JSON.stringify({ type: 'restart' }));
    await wait(150);
    const after = [...c.inbox].reverse().find(m => m.type === 'snapshot') as any;
    // Restart was blocked: still racing, and sim time kept advancing (a reset would drop to
    // countdown with t≈0).
    expect(after.snapshot.phase).toBe('racing');
    expect(after.snapshot.t).toBeGreaterThan(tBefore);
  });

  it('a spectator receives snapshots without occupying a player slot', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const player = connect(port); await player.open();
    const spec = connect(port); await spec.open();
    player.ws.send(JSON.stringify({ type:'join', roomCode:'8800', name:'P1' }));
    spec.ws.send(JSON.stringify({ type:'spectate', roomCode:'8800' }));
    await wait(50);
    player.ws.send(JSON.stringify({ type:'ready' }));
    await wait(200);
    const snap = [...spec.inbox].reverse().find(m => m.type === 'snapshot') as any;
    expect(snap).toBeDefined();
    expect(snap.snapshot.cars).toHaveLength(1);  // spectator added no car
  });
});
