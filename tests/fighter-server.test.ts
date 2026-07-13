import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import { FighterServer } from '../server/fighter-server';

type Message = Record<string, unknown>;
interface Client { ws: WebSocket; messages: Message[]; }

let http: Server | undefined;
let fighter: FighterServer | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  fighter?.stopLoopOnly(); fighter = undefined;
  if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
  http = undefined;
});

async function start(displayToken?: string): Promise<number> {
  http = createServer(); fighter = new FighterServer({ server: http, displayToken });
  http.on('upgrade', (request, socket, head) => fighter!.handleUpgrade(request, socket, head));
  await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  return address.port;
}

async function connect(port: number): Promise<Client> {
  const client: Client = { ws: new WebSocket(`ws://127.0.0.1:${port}/fighter`), messages: [] };
  client.ws.on('message', data => client.messages.push(JSON.parse(data.toString()) as Message));
  clients.push(client);
  await new Promise<void>((resolve, reject) => { client.ws.once('open', resolve); client.ws.once('error', reject); });
  return client;
}

const send = (client: Client, message: unknown) => client.ws.send(JSON.stringify(message));
async function waitFor(client: Client, predicate: (message: Message) => boolean): Promise<Message> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    for (let index = client.messages.length - 1; index >= 0; index--) {
      const message = client.messages[index]!; if (predicate(message)) return message;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`message not received: ${JSON.stringify(client.messages)}`);
}
function latestState(client: Client): Message | undefined {
  for (let index = client.messages.length - 1; index >= 0; index--) if (client.messages[index]!.type === 'fighter_state') return client.messages[index];
  return undefined;
}

describe('FighterServer WebSocket authority and lifecycle', () => {
  it('requires the configured display token before granting host authority', async () => {
    const port = await start('secret'); const display = await connect(port);
    await waitFor(display, message => message.type === 'fighter_capabilities' && message.displayAuth === true);
    send(display, { type: 'spectate', roomCode: 'SECURE' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === false);
    send(display, { type: 'display_auth', roomCode: 'SECURE', token: 'wrong' });
    await waitFor(display, message => message.type === 'error' && message.code === 'bad_display_auth');
    send(display, { type: 'display_auth', roomCode: 'SECURE', token: 'secret' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === true);
  });
  it('canonicalizes room codes and prevents a joined connection taking over another room', async () => {
    const port = await start(); const host = await connect(port); const player = await connect(port);
    send(host, { type: 'spectate', roomCode: ' abcd ' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(player, { type: 'join', roomCode: 'ABCD', name: 'Ada' });
    const joined = await waitFor(player, message => message.type === 'joined');
    expect(joined.roomCode).toBe('ABCD');
    send(player, { type: 'spectate', roomCode: 'WXYZ' });
    await waitFor(player, message => message.type === 'error' && message.code === 'already_joined');
    expect(fighter!.findRoom(' abcd ')?.hasPlayer(joined.playerId as string)).toBe(true);
    expect(fighter!.findRoom('WXYZ')).toBeUndefined();
  });

  it('makes plain spectators read-only while the designated host drives shared selection', async () => {
    const port = await start(); const host = await connect(port); const spectator = await connect(port);
    const a = await connect(port); const b = await connect(port);
    send(host, { type: 'spectate', roomCode: '4821' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(spectator, { type: 'spectate', roomCode: '4821' });
    await waitFor(spectator, message => message.type === 'host_identity' && message.isHost === false);
    send(a, { type: 'join', roomCode: '4821', name: 'A' }); send(b, { type: 'join', roomCode: '4821', name: 'B' });
    await waitFor(a, message => message.type === 'joined'); await waitFor(b, message => message.type === 'joined');
    send(spectator, { type: 'advance' });
    await waitFor(spectator, message => message.type === 'error' && message.code === 'forbidden');
    expect(fighter!.findRoom('4821')?.phase).toBe('lobby');
    send(host, { type: 'advance' }); await waitFor(host, message => message.type === 'fighter_state' && message.phase === 'fighter_select');
    send(a, { type: 'select_fighter', fighterId: 'nyx' });
    await waitFor(host, message => message.type === 'fighter_state' && (message.players as { fighterId: string | null }[]).some(player => player.fighterId === 'nyx'));
    send(host, { type: 'select_fighter', fighterId: 'wraith' });
    await waitFor(host, message => message.type === 'fighter_state' && (message.players as { fighterId: string | null }[]).every(player => player.fighterId));
    send(host, { type: 'advance' }); await waitFor(host, message => message.type === 'fighter_state' && message.phase === 'map_select');
    send(spectator, { type: 'select_map', mapId: 'void' });
    await waitFor(spectator, message => message.type === 'error' && message.code === 'forbidden');
    expect(latestState(host)?.selectedMap).toBeNull();
    send(host, { type: 'select_map', mapId: 'void' });
    await waitFor(host, message => message.type === 'fighter_state' && message.selectedMap === 'void');
  });

  it('replaces a reconnect session, scopes the same id by room, and ignores forged leave', async () => {
    const port = await start(); const first = await connect(port); const attacker = await connect(port);
    send(first, { type: 'join', roomCode: 'ROOM-A', name: 'A', sessionId: 'shared-session' });
    const original = await waitFor(first, message => message.type === 'joined');
    send(attacker, { type: 'spectate', roomCode: 'ROOM-A' }); await waitFor(attacker, message => message.type === 'fighter_state');
    send(attacker, { type: 'leave', sessionId: 'shared-session' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fighter!.findRoom('ROOM-A')?.hasPlayer(original.playerId as string)).toBe(true);

    const replacement = await connect(port); const closed = new Promise<number>(resolve => first.ws.once('close', resolve));
    send(replacement, { type: 'join', roomCode: 'ROOM-A', name: 'ignored', sessionId: 'shared-session' });
    expect((await waitFor(replacement, message => message.type === 'joined')).playerId).toBe(original.playerId);
    expect(await closed).toBe(4001);

    const otherRoom = await connect(port);
    send(otherRoom, { type: 'join', roomCode: 'ROOM-B', name: 'B', sessionId: 'shared-session' });
    const other = await waitFor(otherRoom, message => message.type === 'joined');
    expect(other.roomCode).toBe('ROOM-B');
    expect(fighter!.findRoom('ROOM-B')?.hasPlayer(other.playerId as string)).toBe(true);
    expect(fighter!.findRoom('ROOM-A')?.hasPlayer(original.playerId as string)).toBe(true);
  });

  it('accepts readiness only from the host for the current loading generation', async () => {
    const port = await start(); const host = await connect(port); const spectator = await connect(port); const player = await connect(port);
    send(host, { type: 'spectate', roomCode: '4821' }); await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(spectator, { type: 'spectate', roomCode: '4821' }); send(player, { type: 'join', roomCode: '4821', name: 'A' });
    await waitFor(player, message => message.type === 'joined');
    send(host, { type: 'advance' }); await waitFor(host, message => message.phase === 'fighter_select');
    send(player, { type: 'select_fighter', fighterId: 'nyx' }); await waitFor(host, message => message.type === 'fighter_state' && (message.players as { fighterId: string | null }[])[0]?.fighterId === 'nyx');
    send(host, { type: 'advance' }); await waitFor(host, message => message.phase === 'map_select');
    send(host, { type: 'select_map', mapId: 'void' }); await waitFor(host, message => message.selectedMap === 'void');
    send(host, { type: 'advance' });
    const loading = await waitFor(host, message => message.type === 'fighter_state' && message.phase === 'loading');
    const generation = loading.loadingGeneration as number;
    send(host, { type: 'ready', loadingGeneration: generation + 1 });
    await waitFor(host, message => message.type === 'error' && message.code === 'stale_ready');
    expect(fighter!.findRoom('4821')?.phase).toBe('loading');
    send(spectator, { type: 'ready', loadingGeneration: generation });
    await waitFor(spectator, message => message.type === 'error' && message.code === 'forbidden');
    send(host, { type: 'ready', loadingGeneration: generation });
    await waitFor(host, message => message.type === 'fighter_state' && message.phase === 'intro');
  });

  it('restores display identity when a host player reconnects', async () => {
    const port = await start(); const host = await connect(port);
    send(host, { type: 'spectate', roomCode: '4821' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(host, { type: 'join', roomCode: '4821', name: 'Display', sessionId: 'display-session' });
    const joined = await waitFor(host, message => message.type === 'joined');
    const closed = new Promise<void>(resolve => host.ws.once('close', () => resolve()));
    host.ws.close(); await closed;

    const resumed = await connect(port);
    send(resumed, { type: 'join', roomCode: '4821', name: 'Display', sessionId: 'display-session' });
    expect((await waitFor(resumed, message => message.type === 'joined')).playerId).toBe(joined.playerId);
    await waitFor(resumed, message => message.type === 'host_identity' && message.isHost === true);
  });

  it('lets a host-owned keyboard player change its selected fighter', async () => {
    const port = await start(); const host = await connect(port);
    send(host, { type: 'spectate', roomCode: 'CHANGE' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(host, { type: 'join', roomCode: 'CHANGE', name: 'Keyboard', sessionId: 'change-session' });
    await waitFor(host, message => message.type === 'joined');
    send(host, { type: 'advance' }); await waitFor(host, message => message.phase === 'fighter_select');
    send(host, { type: 'select_fighter', fighterId: 'nyx' });
    await waitFor(host, message => message.type === 'fighter_state' && (message.players as { fighterId: string }[])[0]?.fighterId === 'nyx');
    send(host, { type: 'select_fighter', fighterId: 'iron-oni' });
    const changed = await waitFor(host, message => message.type === 'fighter_state' && (message.players as { fighterId: string }[])[0]?.fighterId === 'iron-oni');
    expect((changed.players as { fighterId: string }[])[0]?.fighterId).toBe('iron-oni');
  });

  it('reaps rooms after their last player and connection leave', async () => {
    const port = await start(); const client = await connect(port);
    send(client, { type: 'spectate', roomCode: 'EMPTY' }); await waitFor(client, message => message.type === 'fighter_state');
    expect(fighter!.findRoom('EMPTY')).toBeDefined();
    client.ws.close();
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1000;
      const check = () => fighter!.findRoom('EMPTY') ? (Date.now() > deadline ? reject(new Error('room was not reaped')) : setTimeout(check, 10)) : resolve();
      check();
    });
    expect(fighter!.findRoom('EMPTY')).toBeUndefined();
  });

  it('releases an intentional browser session immediately', async () => {
    const port = await start(); const player = await connect(port);
    send(player, { type: 'join', roomCode: 'HOME', name: 'Keyboard', sessionId: 'home-session' });
    const joined = await waitFor(player, message => message.type === 'joined');
    expect(fighter!.releaseBrowserSession('HOME', 'home-session')).toBe(true);
    expect(fighter!.findRoom('HOME')?.hasPlayer(joined.playerId as string)).toBe(false);
  });

  it('gives only voice player one shared setup authority and reports command acceptance', async () => {
    await start();
    const p1 = fighter!.voiceJoin(' voice ', 'Ada')!;
    const p2 = fighter!.voiceJoin('VOICE', 'Bob')!;
    expect(fighter!.voiceAdvance('VOICE', p2)).toBe(false);
    expect(fighter!.voiceAdvance('VOICE', p1)).toBe(true);
    expect(fighter!.voiceSelectFighter('VOICE', p1, 'nyx')).toBe(true);
    expect(fighter!.voiceSelectFighter('VOICE', p2, 'wraith')).toBe(true);
    expect(fighter!.voiceAdvance('VOICE', p2)).toBe(false);
    expect(fighter!.voiceAdvance('VOICE', p1)).toBe(true);
    expect(fighter!.voiceSelectMap('VOICE', p2, 'void')).toBe(false);
    expect(fighter!.voiceSelectMap('VOICE', p1, 'void')).toBe(true);
    expect(fighter!.voiceAdvance('VOICE', p1)).toBe(true);
    const room = fighter!.findRoom('VOICE')!;
    expect(room.phase).toBe('loading');
    expect(room.ready(room.state().loadingGeneration)).toBe(true);
    room.tick(9); room.tick(6);
    expect(room.phase).toBe('fight');
    expect(fighter!.voiceCommand('VOICE', p1, 'forward')).toBe(true);
    expect(fighter!.voiceCommand('VOICE', p1, 'forward')).toBe(false);
  });
});
