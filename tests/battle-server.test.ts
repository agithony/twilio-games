// Integration: the /battle WebSocket server. Turn-based + event-driven — it pushes battle_state on
// every change (no continuous loop), sends the roster on connect, and routes join/select/move/advance.
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { BattleServer } from '../server/battle-server';

let server: BattleServer;
afterEach(async () => { await server?.stop(); });

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
// Attach the message collector at CREATION (before 'open') so the roster the server sends the instant
// it accepts the connection isn't missed by a listener attached too late.
function connectCollect(port: number): Promise<{ ws: WebSocket; msgs: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: Record<string, unknown>[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  return new Promise((res) => ws.on('open', () => res({ ws, msgs })));
}
const send = (ws: WebSocket, m: unknown) => ws.send(JSON.stringify(m));

describe('BattleServer', () => {
  it('sends the roster on connect', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const { ws, msgs } = await connectCollect(port);
    await wait(60);
    const roster = msgs.find(m => m.type === 'roster');
    expect(roster).toBeDefined();
    expect((roster!.monsters as unknown[]).length).toBe(8);
    ws.close();
  });

  it('a player joins and gets a joined ack + lobby state', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const { ws, msgs } = await connectCollect(port);
    send(ws, { type: 'join', roomCode: '4821', name: 'Ada' });
    await wait(60);
    expect(msgs.find(m => m.type === 'joined')).toBeDefined();
    const state = msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect(state.phase).toBe('lobby');
    expect((state.players as unknown[]).length).toBe(1);
    ws.close();
  });

  it('single-player: join → advance → pick monster → advance → choose move resolves a turn', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const { ws, msgs } = await connectCollect(port);
    send(ws, { type: 'join', roomCode: '4821', name: 'Ada' });
    await wait(40);
    send(ws, { type: 'advance' });                                  // → monster_select
    await wait(40);
    send(ws, { type: 'select_monster', monsterId: 'sparkmouse' });
    await wait(40);
    send(ws, { type: 'advance' });                                  // → battle (vs AI)
    await wait(40);
    let state = msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect(state.phase).toBe('battle');
    const snap = state.snapshot as { a: { moves: { id: string }[] }, turn: number };
    const before = snap.turn;
    send(ws, { type: 'choose_move', moveId: snap.a.moves[0]!.id });
    // The human's commit locks their move but does NOT resolve yet — the AI takes a separate beat
    // (~700ms server-side). Wait past that, then the turn should have advanced.
    await wait(60);
    let mid = msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect((mid.snapshot as { turn: number, chosen: { a: boolean } }).turn).toBe(before);   // not yet
    expect((mid.snapshot as { chosen: { a: boolean } }).chosen.a).toBe(true);               // but locked
    await wait(800);                                                     // AI beat fires
    state = msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect((state.snapshot as { turn: number }).turn).toBe(before + 1);   // AI took its turn → resolved
    expect(msgs.some(m => m.type === 'battle_events')).toBe(true);
    ws.close();
  });

  it('heartbeat: an idle joined player survives many ping cycles (stays in the room)', async () => {
    // Reproduces the "select screen reverts to play-here" bug: on an idle socket the heartbeat must
    // keep the connection alive AND the player in their slot. A responsive ws client auto-pongs, so
    // across several fast sweeps it should never be terminated or dropped. (heartbeatMs tiny for speed.)
    server = new BattleServer({ port: 0, heartbeatMs: 20 });
    const port = await server.start();
    const { ws, msgs } = await connectCollect(port);
    send(ws, { type: 'join', roomCode: '4821', name: 'Ada' });
    await wait(40);
    send(ws, { type: 'advance' });   // → monster_select, then sit idle
    await wait(300);                 // ~15 heartbeat sweeps with no app traffic
    expect(ws.readyState).toBe(WebSocket.OPEN);                         // socket stayed up
    const state = msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect(state.phase).toBe('monster_select');                        // did NOT revert to lobby
    expect((state.players as unknown[]).length).toBe(1);               // still in their slot
    ws.close();
  });

  it('two players in the same room both appear in the roster state', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const { ws: a, msgs: am } = await connectCollect(port);
    const { ws: b } = await connectCollect(port);
    send(a, { type: 'join', roomCode: '4821', name: 'Ada' });
    send(b, { type: 'join', roomCode: '4821', name: 'Bo' });
    await wait(80);
    const state = am.filter(m => m.type === 'battle_state').at(-1)!;
    expect((state.players as unknown[]).length).toBe(2);
    a.close(); b.close();
  });
});
