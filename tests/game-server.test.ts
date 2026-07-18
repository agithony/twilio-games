import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { GameServer } from '../server/game-server';
import { HttpServer } from '../server/http-server';
import type { ServerMessage } from '../shared/types';
import { mkdir, unlink, writeFile } from 'node:fs/promises';

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

  it('a spectator occupies no roster slot (shared screen is not a phantom player)', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const screen = connect(port); await screen.open();
    screen.ws.send(JSON.stringify({ type: 'spectate', roomCode: '6100' }));
    await wait(150);
    const lob = [...screen.inbox].reverse().find((m: any) => m.type === 'lobby') as any;
    expect(lob).toBeDefined();
    expect(lob.players).toEqual([]);   // spectating display adds NO player
  });

  it('leave drops the player slot but keeps the connection (play-toggle off)', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const c = connect(port); await c.open();
    c.ws.send(JSON.stringify({ type: 'join', roomCode: '6200', name: 'Tester' }));
    await wait(120);
    let lob = [...c.inbox].reverse().find((m: any) => m.type === 'lobby') as any;
    expect(lob.players.map((p: any) => p.name)).toEqual(['Tester']);
    c.inbox.length = 0;
    c.ws.send(JSON.stringify({ type: 'leave' }));
    await wait(120);
    lob = [...c.inbox].reverse().find((m: any) => m.type === 'lobby') as any;
    expect(lob).toBeDefined();           // still connected → still receives lobby broadcasts
    expect(lob.players).toEqual([]);     // but no longer a player
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

  it('voiceLeave reaps a voice-only room (a phone caller never hits the WS reap path)', async () => {
    // A caller who joined ONLY by voice (no /game WS conn) must still reap on hangup, or the room leaks.
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const room = server.getOrCreateRoom('9090');
    const res = room.addPlayer('Caller') as { playerId: string };
    expect(server.roomCount).toBe(1);
    server.voiceLeave('9090', res.playerId);   // caller hangs up
    expect(server.roomCount).toBe(0);          // reaped, no leak
  });

  it('restart rebuilds a fresh race with a NEW procedural course (per-race variety)', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const c = connect(port); await c.open();
    c.ws.send(JSON.stringify({ type: 'join', roomCode: '3131', name: 'You' }));
    await wait(50);
    c.ws.send(JSON.stringify({ type: 'ready' }));
    await wait(150);
    const first = [...c.inbox].reverse().find(m => m.type === 'items') as any;
    const firstSig = JSON.stringify(first.items);
    // Host hits restart (the 'r' key) — must reroll to a different course, not replay the same one.
    c.ws.send(JSON.stringify({ type: 'restart' }));
    await wait(150);
    const items2 = [...c.inbox].filter(m => m.type === 'items') as any[];
    const secondSig = JSON.stringify(items2[items2.length - 1].items);
    expect(items2.length).toBeGreaterThanOrEqual(2);   // restart sent a fresh items message
    expect(secondSig).not.toEqual(firstSig);            // and the course actually changed
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

  it('drives the Smash-style flow over the wire: select car → map → race with chosen model', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    server.setRoomConfigProvider(() => ({ carCount: 19, maps: ['Silver Lake', 'Neon City'] }));
    const port = await server.start();
    const host = connect(port); await host.open();
    host.ws.send(JSON.stringify({ type: 'join', roomCode: 'SMASH', name: 'Ada' }));
    await wait(60);
    host.ws.send(JSON.stringify({ type: 'advance' }));                  // → car_select
    await wait(60);
    const sel = [...host.inbox].reverse().find((m: any) => m.type === 'select_state') as any;
    expect(sel).toBeDefined();
    expect(sel.phase).toBe('car_select');
    expect(sel.maps).toEqual(['Silver Lake', 'Neon City']);
    host.ws.send(JSON.stringify({ type: 'select_car', carIndex: 12 }));
    await wait(60);
    host.ws.send(JSON.stringify({ type: 'advance' }));                  // → map_select
    await wait(60);
    host.ws.send(JSON.stringify({ type: 'select_map', map: 'Neon City' }));
    await wait(60);
    host.ws.send(JSON.stringify({ type: 'advance' }));                  // → race
    await wait(200);
    const snap = [...host.inbox].reverse().find((m: any) => m.type === 'snapshot') as any;
    expect(snap).toBeDefined();
    expect(snap.snapshot.cars[0].carIndex).toBe(12);                    // raced the chosen model
  });

  it('fires onRaceFinished EXACTLY ONCE when a race reaches results (leaderboard persistence)', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    server.setRoomConfigProvider(() => ({ carCount: 19, maps: ['Silver Lake'] }));
    let fired = 0; let reportedMap: string | null = null; let reportedResults: any[] = [];
    server.setOnRaceFinished((room) => { fired++; reportedMap = room.selectedMap; reportedResults = room.results(); });
    const port = await server.start();
    // Build a solo race directly on the room (fast — sync), then drive stepRoom to completion.
    const room = server.getOrCreateRoom('FINISH');
    room.addPlayer('Solo');
    room.advance(); room.selectCar(room.lobbyPlayers()[0]!.playerId, 4);
    room.advance(); room.selectMap('Silver Lake'); room.advance();
    // Pump the sim via the SAME stepRoom path the loop uses, in big dt slices, until results.
    for (let i = 0; i < 2000 && room.phase !== 'results'; i++) server.stepRoomForTest(room, 0.1);
    expect(room.phase).toBe('results');
    // a few more steps in results must NOT re-fire the report
    for (let i = 0; i < 5; i++) server.stepRoomForTest(room, 0.1);
    expect(fired).toBe(1);
    expect(reportedMap).toBe('Silver Lake');
    expect(reportedResults[0]).toMatchObject({ name: 'Solo', place: 1, carIndex: 4, finished: true });
  });

  it('reports authoritative race starts and abandonment once', async () => {
    server = new GameServer({ port: 0 });
    server.setRoomConfigProvider(() => ({ carCount: 2, maps: ['Silver Lake'] }));
    let starts = 0, abandoned = 0;
    server.setOnRaceStarted(() => starts++); server.setOnRaceAbandoned(() => abandoned++);
    await server.start();
    const room = server.getOrCreateRoom('DROP'); const joined = room.addPlayer('Solo') as { playerId: string };
    room.advance(); room.selectCar(joined.playerId, 0); room.advance(); room.selectMap('Silver Lake'); room.advance();
    server.stepRoomForTest(room, 0.1); expect(starts).toBe(1);
    room.removePlayer(joined.playerId); server.stepRoomForTest(room, 0.1); server.stepRoomForTest(room, 0.1);
    expect(abandoned).toBe(1);
  });

  it('flushes final finish/race_over events when a race enters results', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    server.setRoomConfigProvider(() => ({ carCount: 19, maps: ['Silver Lake'] }));
    const heard: string[] = [];
    server.setOnRoomEvents((_code, events) => heard.push(...events.map(e => e.kind)));
    await server.start();

    const room = server.getOrCreateRoom('VOICEEND');
    room.addPlayer('Solo');
    room.advance(); room.selectCar(room.lobbyPlayers()[0]!.playerId, 4);
    room.advance(); room.selectMap('Silver Lake'); room.advance();
    for (let i = 0; i < 2000 && room.phase !== 'results'; i++) server.stepRoomForTest(room, 0.1);

    expect(room.phase).toBe('results');
    expect(heard).toContain('finish');
    expect(heard).toContain('race_over');
  });
});

describe('HttpServer voice routing seams', () => {
  let http: HttpServer;
  let LB = '';
  afterEach(async () => { await http?.stop(); if (LB) { try { await unlink(LB); } catch {} } });

  it('does not capture Portuguese advance phrases as a caller name', async () => {
    http = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    await http.start();
    const game = (http as unknown as { game: GameServer }).game;
    game.setRoomConfigProvider(() => ({ carCount: 1, carNames: ['Roadster'], maps: ['Silver Lake'] }));
    const room = game.getOrCreateRoom('PTADV');
    const result = room.addPlayer('Piloto 9999') as { playerId: string };

    const reply = http.directSelectionForTest(room, result.playerId, 'vamos começar', 'pt-BR');

    expect(room.phase).toBe('car_select');
    expect(room.lobbyPlayers()[0]?.name).toBe('Piloto 9999');
    expect(reply).toContain('Escolha seu carro');
  });

  it('does not treat internal race-over recap prompts as rematch commands', async () => {
    http = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      mapsPath: 'assets/maps/maps.json',
    });
    await http.start();
    const game = (http as unknown as { game: GameServer }).game;
    game.setRoomConfigProvider(() => ({ carCount: 19, maps: ['Silver Lake'] }));
    const room = game.getOrCreateRoom('NOAUTO');
    const res = room.addPlayer('Ada') as { playerId: string };
    room.advance(); room.selectCar(res.playerId, 0);
    room.advance(); room.selectMap('Silver Lake'); room.advance();
    for (let i = 0; i < 2000 && room.phase !== 'results'; i++) game.stepRoomForTest(room, 0.1);

    const reply = http.directSelectionForTest(room, res.playerId, '(The race is over. Invite a rematch.)');

    expect(reply).toBeNull();
    expect(room.phase).toBe('results');
  });

  it('gives the voice host a leaderboard filtered to the current track', async () => {
    await mkdir('data', { recursive: true });
    LB = `data/_test-host-lb-${process.pid}.json`;
    await writeFile(LB, JSON.stringify([
      { name: 'Wrong Track Test', map: 'Neon City', carIndex: 0, finishT: 39, at: 1 },
      { name: 'Real Leader', map: 'Silver Lake', carIndex: 0, finishT: 33, at: 2 },
      { name: 'Second Place History', map: 'Silver Lake', carIndex: 1, finishT: 36, at: 3 },
    ]));
    http = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      mapsPath: 'assets/maps/maps.json', leaderboardPath: LB,
    });
    await http.start();
    const game = (http as unknown as { game: GameServer }).game;
    const room = game.getOrCreateRoom('CTXLB');
    const res = room.addPlayer('Ada') as { playerId: string };
    room.advance(); room.selectCar(res.playerId, 0);
    room.advance(); room.selectMap('Silver Lake'); room.advance();
    for (let i = 0; i < 2000 && room.phase !== 'results'; i++) game.stepRoomForTest(room, 0.1);

    const ctx = http.hostContextForTest(room, res.playerId);

    expect(ctx.selectedMap).toBe('Silver Lake');
    expect(ctx.allTimeBest).toEqual({ name: 'Real Leader', time: 33 });
    expect(ctx.allTimeTop).toEqual(['Real Leader', 'Second Place History', 'Ada']);
    expect(ctx.leaderboardTop?.slice(0, 2)).toEqual([{ name: 'Real Leader', time: 33 }, { name: 'Second Place History', time: 36 }]);
    expect(ctx.leaderboardTop?.some(e => e.name === 'Ada' && e.time > 0)).toBe(true);
    expect(ctx.raceStandings?.[0]).toMatchObject({ name: 'Ada', place: 1, finished: true });
    expect(ctx.raceStandings?.[0]?.time).toBeGreaterThan(0);
    expect(ctx.myPlace).toBe(1);
    expect(ctx.myFinishTime).toBeGreaterThan(0);
  });
});
