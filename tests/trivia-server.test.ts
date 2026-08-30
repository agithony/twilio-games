import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { TriviaRoom } from '../server/trivia-room';
import { TriviaServer, TRIVIA_RECONNECT_GRACE_MS } from '../server/trivia-server';
import { parseTriviaQuestionBankJson, type TriviaQuestionBank } from '../shared/trivia';

type Message = Record<string, unknown>;
interface Client { ws: WebSocket; messages: Message[]; }

const bank: TriviaQuestionBank = parseTriviaQuestionBankJson(
  readFileSync(new URL('../content/trivia/questions.json', import.meta.url), 'utf8'),
);
let http: Server | undefined;
let trivia: TriviaServer | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  trivia?.stopLoopOnly();
  trivia = undefined;
  if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
  http = undefined;
});

async function start(options: ConstructorParameters<typeof TriviaServer>[0] = {}): Promise<number> {
  http = createServer();
  trivia = new TriviaServer({ server: http, bank, ...options });
  http.on('upgrade', (request, socket, head) => trivia!.handleUpgrade(request, socket, head));
  await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return address.port;
}

async function connect(port: number): Promise<Client> {
  const client: Client = { ws: new WebSocket(`ws://127.0.0.1:${port}/trivia`), messages: [] };
  client.ws.on('message', data => client.messages.push(JSON.parse(data.toString()) as Message));
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.ws.once('open', resolve);
    client.ws.once('error', reject);
  });
  return client;
}

function send(client: Client, message: unknown): void {
  client.ws.send(JSON.stringify(message));
}

async function waitFor(client: Client, predicate: (message: Message) => boolean, timeoutMs = 1_500): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = client.messages.length - 1; index >= 0; index--) {
      const message = client.messages[index]!;
      if (predicate(message)) return message;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`message not received: ${JSON.stringify(client.messages)}`);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

function trackedKeyboardPlayers(code: string): Set<string> | undefined {
  return (trivia as unknown as { localKeyboardPlayerIds: Map<string, Set<string>> })
    .localKeyboardPlayerIds.get(code);
}

describe('TriviaServer authority and lifecycle', () => {
  it('provides clock sync and bounds connections, rooms, payload, and compression', async () => {
    const port = await start({ now: () => 30_100, maxConnections: 2, maxRooms: 1 });
    const first = await connect(port);
    const second = await connect(port);
    expect(first.ws.extensions).toBe('');
    send(first, { type: 'clock_sync', clientSentAtMs: 20_000 });
    await expect(waitFor(first, message => message.type === 'clock_sync')).resolves.toEqual({
      type: 'clock_sync', clientSentAtMs: 20_000, serverNowMs: 30_100,
    });
    send(first, { type: 'spectate', roomCode: 'ONLY' });
    await waitFor(first, message => message.type === 'trivia_state' && message.roomCode === 'ONLY');
    send(second, { type: 'spectate', roomCode: 'OVERFLOW' });
    await waitFor(second, message => message.type === 'error' && message.code === 'room_capacity');

    const rejected = new WebSocket(`ws://127.0.0.1:${port}/trivia`);
    await expect(new Promise<void>((resolve, reject) => {
      rejected.once('open', resolve);
      rejected.once('error', reject);
    })).rejects.toThrow();
    const payloadClosed = new Promise<number>(resolve => first.ws.once('close', code => resolve(code)));
    first.ws.send('x'.repeat(20_000));
    expect(await payloadClosed).toBe(1009);
  });

  it('separates browser-player admission from station display authentication', async () => {
    const port = await start({ displayToken: 'secret' });
    trivia!.setBrowserPlayerAdmission(code => code !== 'PAID');
    trivia!.setDisplayAuthenticationRequirement(code => code === 'PAID');
    const player = trivia!.voiceJoin('PAID', 'Caller', 1, false)!;
    const display = await connect(port);
    await waitFor(display, message => message.type === 'trivia_capabilities' && message.displayAuth === true);
    send(display, { type: 'join', roomCode: 'PAID', name: 'Browser' });
    await waitFor(display, message => message.type === 'error' && message.code === 'station_voice_only');
    send(display, { type: 'spectate', roomCode: 'PAID' });
    await waitFor(display, message => message.type === 'error' && message.code === 'bad_display_auth');
    send(display, { type: 'display_auth', roomCode: 'PAID', token: 'wrong' });
    await waitFor(display, message => message.type === 'error' && message.code === 'bad_display_auth');
    send(display, { type: 'display_auth', roomCode: 'PAID', token: 'secret' });
    send(display, { type: 'spectate', roomCode: 'PAID', locale: 'pt-BR' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === true);
    const state = await waitFor(display, message => message.type === 'trivia_state' && message.roomCode === 'PAID');
    expect(state).toMatchObject({ preferredLocale: 'pt-BR', players: [expect.objectContaining({ playerId: player })] });
  });

  it('keeps reverse-arriving station participants in assigned order and rejects duplicate slots', async () => {
    await start();
    const joined = [3, 2, 1, 0].map(participantIndex => trivia!.voiceJoin(
      'ORDERED', `Player ${participantIndex}`, 4, true, 'en-US',
      { stationFixed: true, allowReplay: false, participantIndex },
    ));
    expect(joined.every(Boolean)).toBe(true);
    expect(trivia!.findRoom('ORDERED')!.state().players.map(player => [player.name, player.playerOrder])).toEqual([
      ['Player 0', 0], ['Player 1', 1], ['Player 2', 2], ['Player 3', 3],
    ]);
    expect(trivia!.voiceJoin(
      'ORDERED', 'Duplicate', 4, true, 'en-US',
      { stationFixed: true, allowReplay: false, participantIndex: 2 },
    )).toBeNull();
    expect(trivia!.voiceJoin(
      'INVALID-ORDER', 'Invalid', 1, true, 'en-US',
      { stationFixed: true, allowReplay: false, participantIndex: 4 },
    )).toBeNull();
  });

  it('reconciles station setup through the dedicated pregame server path', async () => {
    await start();
    const first = trivia!.voiceJoin(
      'RECONCILE', 'Ada', 2, true, 'en-US',
      { stationFixed: true, allowReplay: false, participantIndex: 0 },
    )!;
    const dropped = trivia!.voiceJoin(
      'RECONCILE', 'Grace', 2, true, 'en-US',
      { stationFixed: true, allowReplay: false, participantIndex: 1 },
    )!;
    trivia!.voiceAdvance('RECONCILE', first);
    trivia!.voiceVoteCategory('RECONCILE', first, 'science');
    trivia!.voiceVoteCategory('RECONCILE', dropped, 'history');

    expect(trivia!.voiceReconcilePregameRoster('RECONCILE', 2, [first], [first, null])).toBe(true);
    expect(trivia!.voiceSnapshot('RECONCILE', dropped)).toBeNull();
    expect(trivia!.findRoom('RECONCILE')!.state()).toMatchObject({
      phase: 'lobby', expectedPlayerCount: 2, hasExpectedPlayers: false,
      players: [{ playerId: first, name: 'Ada', playerOrder: 0 }],
      categoryVoteCounts: { science: 0, history: 0 },
    });
    const replacement = trivia!.voiceJoin(
      'RECONCILE', 'Linus', 2, true, 'en-US',
      { stationFixed: true, allowReplay: false, participantIndex: 1 },
    );
    expect(replacement).not.toBeNull();
    expect(trivia!.findRoom('RECONCILE')!.state().players.map(player => player.name)).toEqual(['Ada', 'Linus']);
  });

  it('allows player-owned category votes but rejects generic browser answer/score attempts', async () => {
    let now = 0;
    const port = await start({
      now: () => now,
      tickMs: 5,
      roomFactory: (code, options) => new TriviaRoom(code, { ...options, countdownMs: 20 }),
    });
    const host = await connect(port);
    send(host, { type: 'spectate', roomCode: 'PLAY' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(host, { type: 'join', roomCode: 'PLAY', name: 'Ada' });
    const joined = await waitFor(host, message => message.type === 'joined');
    send(host, { type: 'advance' });
    await waitFor(host, message => message.type === 'trivia_state' && message.phase === 'category_select');
    send(host, { type: 'select_category', category: 'science' });
    await waitFor(host, message => message.type === 'trivia_state'
      && (message.categoryVoteCounts as Record<string, number>).science === 1);
    send(host, { type: 'advance' });
    const loading = await waitFor(host, message => message.type === 'trivia_state' && message.phase === 'loading');
    send(host, { type: 'ready', loadingGeneration: loading.loadingGeneration });
    const countdown = await waitFor(host, message => message.type === 'trivia_state' && message.phase === 'countdown');
    now = countdown.countdownEndsAtMs as number;
    const question = await waitFor(host, message => message.type === 'trivia_state' && message.phase === 'question');
    expect(JSON.stringify(question)).not.toContain('correctChoiceId');
    send(host, { type: 'answer', choiceId: 'a' });
    await waitFor(host, message => message.type === 'error' && message.code === 'unknown_type');
    send(host, { type: 'score', score: 99_999 });
    await waitFor(host, message => message.type === 'error' && message.code === 'unknown_type');
    expect(trivia!.findRoom('PLAY')!.state().players[0]).toMatchObject({
      playerId: joined.playerId, answered: false, rawScore: 0,
    });
  });

  it('runs a local host through category, immediate answering, keyboard answer, and reveal', async () => {
    let now = 0;
    const port = await start({
      now: () => now, tickMs: 5,
      roomFactory: (code, options) => new TriviaRoom(code, { ...options, countdownMs: 20, revealMs: 10 }),
    });
    const host = await connect(port);
    send(host, { type: 'spectate', roomCode: 'LOCAL' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(host, { type: 'join', roomCode: 'LOCAL', name: 'Local Player', sessionId: 'local-session' });
    const joined = await waitFor(host, message => message.type === 'joined');
    expect(trackedKeyboardPlayers('LOCAL')).toEqual(new Set([joined.playerId as string]));

    send(host, { type: 'advance' });
    await waitFor(host, message => message.phase === 'category_select');
    send(host, { type: 'select_category', category: 'science' });
    await waitFor(host, message => message.phase === 'category_select'
      && (message.categoryVoteCounts as Record<string, number>).science === 1);
    send(host, { type: 'advance' });
    const loading = await waitFor(host, message => message.phase === 'loading');
    send(host, { type: 'ready', loadingGeneration: loading.loadingGeneration });
    const countdown = await waitFor(host, message => message.phase === 'countdown');
    now = countdown.countdownEndsAtMs as number;
    const question = await waitFor(host, message => message.phase === 'question');
    expect(JSON.stringify(question)).not.toContain('correctChoiceId');
    expect(trivia!.voiceSnapshot('LOCAL', joined.playerId as string)).toMatchObject({
      phase: 'question', myPromptReady: false, myAnswerCueReady: false,
    });
    const eventTypes = host.messages.flatMap(message => (
      Array.isArray(message.events) ? message.events as { type: string }[] : []
    )).map(event => event.type);
    expect(eventTypes).toEqual(expect.arrayContaining([
      'question_started', 'answering_started',
    ]));
    expect(eventTypes).not.toContain('answer_cue_started');

    const questionId = (question.question as { id: string }).id;
    const correctChoiceId = bank.questions.find(item => item.id === questionId)!.correctChoiceId;
    now = question.answeringStartsAtMs as number;
    send(host, { type: 'keyboard_answer', choiceId: correctChoiceId });
    const reveal = await waitFor(host, message => message.phase === 'reveal');
    expect(reveal.reveal).toMatchObject({ questionId, correctChoiceId });
    expect(trivia!.findRoom('LOCAL')!.state().players[0]).toMatchObject({ answered: true, rawScore: 1_300 });
  });

  it('opens a mixed local and phone question without either prompt-readiness barrier', async () => {
    let now = 0;
    const port = await start({
      now: () => now, tickMs: 5,
      roomFactory: (code, options) => new TriviaRoom(code, { ...options, countdownMs: 20 }),
    });
    const host = await connect(port);
    send(host, { type: 'spectate', roomCode: 'MIXED' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(host, { type: 'join', roomCode: 'MIXED', name: 'Local Player', sessionId: 'mixed-local' });
    const local = (await waitFor(host, message => message.type === 'joined')).playerId as string;
    const caller = trivia!.voiceJoin('MIXED', 'Caller', 2, true)!;
    send(host, { type: 'advance' });
    await waitFor(host, message => message.phase === 'category_select');
    send(host, { type: 'select_category', category: 'mixed' });
    send(host, { type: 'advance' });
    const loading = await waitFor(host, message => message.phase === 'loading');
    send(host, { type: 'ready', loadingGeneration: loading.loadingGeneration });
    const countdown = await waitFor(host, message => message.phase === 'countdown');
    now = countdown.countdownEndsAtMs as number;
    const question = await waitFor(host, message => message.phase === 'question');
    const questionId = (question.question as { id: string }).id;
    expect(trivia!.voiceSnapshot('MIXED', local)).toMatchObject({
      phase: 'question', myPromptReady: false, myAnswerCueReady: false,
    });
    expect(trivia!.voiceSnapshot('MIXED', caller)).toMatchObject({
      phase: 'question', myPromptReady: false, myAnswerCueReady: false,
    });
    expect(trivia!.voiceQuestionPromptReady('MIXED', caller, questionId)).toBe(false);
    expect(trivia!.voiceQuestionAnswerCueReady('MIXED', caller, questionId)).toBe(false);
  });

  it('rejects forged and joined nonhost keyboard answers', async () => {
    let now = 0;
    const port = await start({
      now: () => now, tickMs: 5,
      roomFactory: (code, options) => new TriviaRoom(code, { ...options, countdownMs: 20 }),
    });
    const host = await connect(port);
    const nonhost = await connect(port);
    send(host, { type: 'spectate', roomCode: 'AUTHORITY' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(nonhost, { type: 'spectate', roomCode: 'AUTHORITY' });
    await waitFor(nonhost, message => message.type === 'host_identity' && message.isHost === false);
    send(nonhost, { type: 'keyboard_answer', choiceId: 'a' });
    await waitFor(nonhost, message => message.type === 'error' && message.code === 'forbidden');

    send(host, { type: 'join', roomCode: 'AUTHORITY', name: 'Local Player' });
    const hostId = (await waitFor(host, message => message.type === 'joined')).playerId as string;
    send(nonhost, { type: 'join', roomCode: 'AUTHORITY', name: 'Other Browser' });
    const nonhostId = (await waitFor(nonhost, message => message.type === 'joined')).playerId as string;
    expect(trackedKeyboardPlayers('AUTHORITY')).toEqual(new Set([hostId]));
    send(host, { type: 'advance' });
    await waitFor(host, message => message.phase === 'category_select');
    send(host, { type: 'select_category', category: 'science' });
    send(host, { type: 'advance' });
    const loading = await waitFor(host, message => message.phase === 'loading');
    send(host, { type: 'ready', loadingGeneration: loading.loadingGeneration });
    const countdown = await waitFor(host, message => message.phase === 'countdown');
    now = countdown.countdownEndsAtMs as number;
    const question = await waitFor(host, message => message.phase === 'question');
    now = question.answeringStartsAtMs as number;
    const forbiddenBefore = nonhost.messages.filter(message => message.code === 'forbidden').length;
    send(nonhost, { type: 'keyboard_answer', choiceId: 'a' });
    await waitUntil(() => nonhost.messages.filter(message => message.code === 'forbidden').length > forbiddenBefore);
    expect(trivia!.findRoom('AUTHORITY')!.state().players.find(player => player.playerId === nonhostId))
      .toMatchObject({ answered: false, rawScore: 0 });
  });

  it('drops tester tracking on disconnect/expiry and restores the host-owned session on reconnect', async () => {
    const port = await start({ reconnectGraceMs: 200 });
    const first = await connect(port);
    send(first, { type: 'spectate', roomCode: 'RESUME' });
    await waitFor(first, message => message.type === 'host_identity' && message.isHost === true);
    send(first, { type: 'join', roomCode: 'RESUME', name: 'Local Player', sessionId: 'resume-local' });
    const playerId = (await waitFor(first, message => message.type === 'joined')).playerId as string;
    expect(trackedKeyboardPlayers('RESUME')).toEqual(new Set([playerId]));
    const firstClosed = new Promise<void>(resolve => first.ws.once('close', () => resolve()));
    first.ws.close();
    await firstClosed;
    await waitUntil(() => trackedKeyboardPlayers('RESUME') === undefined);
    expect(trivia!.findRoom('RESUME')!.state().players).toEqual([
      expect.objectContaining({ playerId, connected: false }),
    ]);

    const resumed = await connect(port);
    send(resumed, { type: 'join', roomCode: 'RESUME', name: 'ignored', sessionId: 'resume-local' });
    expect((await waitFor(resumed, message => message.type === 'joined')).playerId).toBe(playerId);
    await waitFor(resumed, message => message.type === 'host_identity' && message.isHost === true);
    expect(trackedKeyboardPlayers('RESUME')).toEqual(new Set([playerId]));
    const resumedClosed = new Promise<void>(resolve => resumed.ws.once('close', () => resolve()));
    resumed.ws.close();
    await resumedClosed;
    expect(trivia!.findRoom('RESUME')!.hasPlayer(playerId)).toBe(true);
    await waitUntil(() => trivia!.findRoom('RESUME') === undefined);
    expect(trackedKeyboardPlayers('RESUME')).toBeUndefined();
  });

  it('holds a locked score across the 30-second session grace without pausing deadlines', async () => {
    expect(TRIVIA_RECONNECT_GRACE_MS).toBe(30_000);
    let now = 0;
    const port = await start({
      now: () => now,
      reconnectGraceMs: 250,
      tickMs: 5,
      roomFactory: (code, options) => new TriviaRoom(code, { ...options, countdownMs: 20 }),
    });
    const host = await connect(port);
    send(host, { type: 'spectate', roomCode: 'STABLE' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(host, { type: 'join', roomCode: 'STABLE', name: 'Ada', sessionId: 'stable-session' });
    const firstJoined = await waitFor(host, message => message.type === 'joined');
    const second = await connect(port);
    send(second, { type: 'join', roomCode: 'STABLE', name: 'Grace', sessionId: 'second-session' });
    const secondJoined = await waitFor(second, message => message.type === 'joined');
    send(host, { type: 'advance' });
    await waitFor(host, message => message.phase === 'category_select');
    send(host, { type: 'advance' });
    const loading = await waitFor(host, message => message.phase === 'loading');
    send(host, { type: 'ready', loadingGeneration: loading.loadingGeneration });
    const countdown = await waitFor(host, message => message.phase === 'countdown');
    now = countdown.countdownEndsAtMs as number;
    const question = await waitFor(host, message => message.phase === 'question');
    const definition = bank.questions.find(item => item.id === (question.question as { id: string }).id)!;
    now = question.answeringStartsAtMs as number;
    expect(trivia!.voiceAnswerAt(
      'STABLE', firstJoined.playerId as string, definition.correctChoiceId, true,
      question.answeringStartsAtMs as number,
    )).toBe(true);
    const scoreBeforeReveal = trivia!.findRoom('STABLE')!.state().players.find(
      player => player.playerId === firstJoined.playerId,
    )!.rawScore;
    expect(scoreBeforeReveal).toBe(0);
    const questionEnds = trivia!.findRoom('STABLE')!.state().questionEndsAtMs!;
    const closed = new Promise<void>(resolve => host.ws.once('close', () => resolve()));
    host.ws.close();
    await closed;
    await waitFor(second, message => message.type === 'trivia_state'
      && (message.players as { playerId: string; connected: boolean }[]).some(
        candidate => candidate.playerId === firstJoined.playerId && !candidate.connected,
      ));
    expect(trivia!.findRoom('STABLE')!.state().players.find(
      player => player.playerId === firstJoined.playerId,
    )).toMatchObject({ connected: false, rawScore: 0, answered: true });

    now = questionEnds + 1_500;
    await waitFor(second, message => message.type === 'trivia_state' && message.phase === 'reveal');
    const resumed = await connect(port);
    send(resumed, { type: 'join', roomCode: 'STABLE', name: 'ignored', sessionId: 'stable-session' });
    expect((await waitFor(resumed, message => message.type === 'joined')).playerId).toBe(firstJoined.playerId);
    const resumedState = await waitFor(resumed, message => message.type === 'trivia_state' && message.phase === 'reveal');
    expect((resumedState.players as { playerId: string; connected: boolean; rawScore: number }[]).find(
      player => player.playerId === firstJoined.playerId,
    )).toMatchObject({ connected: true, rawScore: 1_300 });
    expect(secondJoined.playerId).not.toBe(firstJoined.playerId);
  });

  it('requires a reconnecting station display to reauthenticate and invalidates only loading readiness', async () => {
    const port = await start({ displayToken: 'secret' });
    trivia!.setBrowserPlayerAdmission(() => false);
    trivia!.setDisplayAuthenticationRequirement(() => true);
    const player = trivia!.voiceJoin('DISPLAY', 'Ada')!;
    trivia!.voiceAdvance('DISPLAY', player);
    trivia!.voiceAdvance('DISPLAY', player);
    const first = await connect(port);
    send(first, { type: 'display_auth', roomCode: 'DISPLAY', token: 'secret' });
    send(first, { type: 'spectate', roomCode: 'DISPLAY' });
    await waitFor(first, message => message.type === 'host_identity' && message.isHost === true);
    const generation = trivia!.findRoom('DISPLAY')!.state().loadingGeneration;
    send(first, { type: 'ready', loadingGeneration: generation });
    await waitFor(first, message => message.type === 'trivia_state' && message.phase === 'countdown');
    const stableGeneration = trivia!.findRoom('DISPLAY')!.state().loadingGeneration;
    const closed = new Promise<void>(resolve => first.ws.once('close', () => resolve()));
    first.ws.close();
    await closed;
    expect(trivia!.findRoom('DISPLAY')!.state()).toMatchObject({
      phase: 'countdown', loadingGeneration: stableGeneration, displayReady: true,
    });

    const replacement = await connect(port);
    send(replacement, { type: 'spectate', roomCode: 'DISPLAY' });
    await waitFor(replacement, message => message.type === 'error' && message.code === 'bad_display_auth');
    send(replacement, { type: 'display_auth', roomCode: 'DISPLAY', token: 'secret' });
    send(replacement, { type: 'spectate', roomCode: 'DISPLAY' });
    await waitFor(replacement, message => message.type === 'host_identity' && message.isHost === true);
    await waitFor(replacement, message => message.type === 'trivia_state' && message.phase === 'countdown');
  });

  it('rejects loading readiness with a missing fixed-roster player until reconciliation restores the seat', async () => {
    const port = await start();
    const display = await connect(port);
    send(display, { type: 'spectate', roomCode: 'READY-ROSTER' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === true);
    const first = trivia!.voiceJoin(
      'READY-ROSTER', 'Ada', 2, true, 'en-US',
      { stationFixed: true, allowReplay: false, participantIndex: 0 },
    )!;
    const removed = trivia!.voiceJoin(
      'READY-ROSTER', 'Grace', 2, true, 'en-US',
      { stationFixed: true, allowReplay: false, participantIndex: 1 },
    )!;
    trivia!.voiceAdvance('READY-ROSTER', first);
    trivia!.voiceAdvance('READY-ROSTER', first);
    const room = trivia!.findRoom('READY-ROSTER')!;
    const staleGeneration = room.state().loadingGeneration;
    trivia!.voiceLeave('READY-ROSTER', removed);
    expect(room.state()).toMatchObject({
      phase: 'loading', expectedPlayerCount: 2, hasExpectedPlayers: false, displayReady: false,
    });

    const priorRejections = display.messages.filter(message => message.code === 'not_ready').length;
    send(display, { type: 'ready', loadingGeneration: staleGeneration });
    await waitUntil(() => display.messages.filter(message => message.code === 'not_ready').length > priorRejections);
    expect(room.state()).toMatchObject({ phase: 'loading', displayReady: false });
    expect(display.messages.flatMap(message => Array.isArray(message.events) ? message.events : [])
      .some((event: { type?: string }) => event.type === 'countdown')).toBe(false);

    expect(trivia!.voiceReconcilePregameRoster(
      'READY-ROSTER', 2, [first], [first, null],
    )).toBe(true);
    const replacement = trivia!.voiceJoin(
      'READY-ROSTER', 'Linus', 2, true, 'en-US',
      { stationFixed: true, allowReplay: false, participantIndex: 1 },
    )!;
    trivia!.voiceAdvance('READY-ROSTER', first);
    trivia!.voiceAdvance('READY-ROSTER', replacement);
    const restoredGeneration = room.state().loadingGeneration;
    expect(restoredGeneration).toBeGreaterThan(staleGeneration);
    send(display, { type: 'ready', loadingGeneration: restoredGeneration });
    await waitFor(display, message => message.type === 'trivia_state' && message.phase === 'countdown');
    expect(room.state()).toMatchObject({ phase: 'countdown', hasExpectedPlayers: true, displayReady: true });
  });

  it('publishes terminal result callbacks and enforces station requeue', async () => {
    const now = { value: 0 };
    const port = await start({
      displayToken: 'secret', now: () => now.value, tickMs: 5, seed: 44,
      roomFactory: (code, options) => new TriviaRoom(code, { ...options, countdownMs: 20, revealMs: 10 }),
    });
    trivia!.setBrowserPlayerAdmission(() => false);
    trivia!.setDisplayAuthenticationRequirement(code => code === 'RESULT');
    const eventBatches: { type: string }[][] = [];
    trivia!.setOnRoomEvents((_code, events) => eventBatches.push(events));
    const player = trivia!.voiceJoin('RESULT', 'Ada')!;
    trivia!.voiceAdvance('RESULT', player);
    trivia!.voiceAdvance('RESULT', player);
    const display = await connect(port);
    send(display, { type: 'display_auth', roomCode: 'RESULT', token: 'secret' });
    send(display, { type: 'spectate', roomCode: 'RESULT' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === true);
    const room = trivia!.findRoom('RESULT')!;
    send(display, { type: 'ready', loadingGeneration: room.state().loadingGeneration });
    const countdown = await waitFor(display, message => message.phase === 'countdown');
    now.value = countdown.countdownEndsAtMs as number;
    for (let index = 0; index < 8; index++) {
      const questionState = await waitFor(display, message => message.type === 'trivia_state'
        && message.phase === 'question' && message.questionIndex === index);
      now.value = questionState.answeringStartsAtMs as number;
      const questionId = (questionState.question as { id: string }).id;
      trivia!.voiceAnswer(
        'RESULT', player, bank.questions.find(question => question.id === questionId)!.correctChoiceId,
      );
      now.value = room.state().revealEndsAtMs!;
    }
    const resultState = await waitFor(display, message => message.type === 'trivia_state' && message.phase === 'results');
    const result = resultState.result;
    expect(result).toMatchObject({ generation: 1, players: [expect.objectContaining({ correctCount: 8 })] });
    expect(eventBatches.flat().at(-1)).toMatchObject({ type: 'round_finished', result });
    expect(trivia!.voiceAdvance('RESULT', player)).toBe(false);
    send(display, { type: 'advance' });
    await waitFor(display, message => message.type === 'error' && message.code === 'station_requeue_required');

    const standalone = trivia!.voiceJoin('SOLO-REPLAY', 'Grace', 1)!;
    expect(trivia!.findRoom('SOLO-REPLAY')!.stationFixed).toBe(false);
    expect(trivia!.findRoom('SOLO-REPLAY')!.allowReplay).toBe(true);
    trivia!.voiceAdvance('SOLO-REPLAY', standalone);
    trivia!.voiceAdvance('SOLO-REPLAY', standalone);
    const standaloneRoom = trivia!.findRoom('SOLO-REPLAY')!;
    standaloneRoom.ready(standaloneRoom.state().loadingGeneration);
    now.value = standaloneRoom.state().countdownEndsAtMs!;
    standaloneRoom.tick();
    for (let index = 0; index < 8; index++) {
      const question = standaloneRoom.state().question!;
      now.value = standaloneRoom.state().answeringStartsAtMs!;
      trivia!.voiceAnswer('SOLO-REPLAY', standalone,
        bank.questions.find(candidate => candidate.id === question.id)!.correctChoiceId);
      now.value = standaloneRoom.state().revealEndsAtMs!;
      standaloneRoom.tick();
    }
    expect(standaloneRoom.phase).toBe('results');
    expect(trivia!.voiceAdvance('SOLO-REPLAY', standalone)).toBe(true);
    expect(standaloneRoom.phase).toBe('category_select');
    expect(port).toBeGreaterThan(0);
  });
});
