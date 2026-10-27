import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwlServer, type OwlServerOptions } from '../server/owl-server';
import { OwlVoiceSession, interpretOwlSpeech,
  type OwlVoiceDeps, type OwlVoiceEndHandoff } from '../server/owl-voice';
import type { OwlAction, OwlEvent } from '../shared/owl-protocol';
import type { LlmClient, LlmReply, LlmTurn } from '../server/llm';

let server: OwlServer | null = null;

afterEach(() => {
  server?.stopLoopOnly();
  server = null;
  vi.useRealTimers();
});

function fixture(options: OwlServerOptions = {}, llm?: LlmClient) {
  server = new OwlServer(options);
  const heard: string[] = [];
  const events: OwlEvent[] = [];
  const ends: OwlVoiceEndHandoff[] = [];
  let session!: OwlVoiceSession;
  session = new OwlVoiceSession({
    llm,
    bind: (code, name, sid, locale, station, confirmed) =>
      server!.voiceJoin(code, name, sid, locale, station, confirmed),
    confirmName: (code, sid, name) => server!.voiceConfirmName(code, sid, name),
    action: (code, sid, action, line, reagents) => server!.voiceAction(code, sid, action, line, reagents),
    snapshot: code => server!.snapshot(code),
    disconnect: (code, sid) => server!.voiceDisconnect(code, sid),
    leave: (code, sid, reason) => server!.voiceLeave(code, sid, reason),
    say: text => { heard.push(text); return Promise.resolve('played'); },
    requestEnd: handoff => ends.push(handoff),
  });
  server.setOnRoomEvents((_code, emitted) => events.push(...emitted));
  server.setOnRoomState(() => session.onStateChanged());
  const send = (message: Record<string, unknown>) => session.handleMessage(JSON.stringify(message));
  const setup = (roomCode = 'HOOT', callSid = 'CA-owl', commandLocale = 'en-US') => send({
    type: 'setup', callSid, customParameters: { game: 'owl', roomCode, commandLocale },
  });
  const prompt = (voicePrompt: string, last = true) => send({ type: 'prompt', voicePrompt, last });
  return { server, session, heard, events, ends, send, setup, prompt };
}

function actions(events: OwlEvent[]): OwlAction[] {
  return events.filter((event): event is Extract<OwlEvent, { type: 'action' }> => event.type === 'action')
    .map(event => event.action);
}

describe('Talking Owl ConversationRelay session', () => {
  it('asks a standalone caller for their first name and starts only after confirmation', () => {
    const { server: owl, session, heard, events, setup, prompt } = fixture();
    setup();
    expect(session.boundRoomCode).toBe('HOOT');
    expect(session.boundPlayerId).toBe('o1');
    expect(heard.at(-1)).toMatch(/first name/i);
    expect(owl.snapshot('HOOT')?.phase).toBe('waiting');
    prompt('dance');
    expect(owl.snapshot('HOOT')?.phase).toBe('waiting');
    expect(heard.at(-1)).toMatch(/first name/i);
    prompt('My name is Ada');
    expect(owl.snapshot('HOOT')).toMatchObject({ phase: 'playing',
      caller: { name: 'Ada', nameConfirmed: true } });
    expect(actions(events)).toEqual(['call', 'listen']);
    prompt('Can you dance?');
    expect(actions(events).at(-1)).toBe('dance');
    expect(heard.at(-1)).toMatch(/rhythm|flap/i);
  });

  it('skips the name prompt for a station identity and handles reactions and lab mixtures', () => {
    const { server: owl, session, heard, events, setup, prompt } = fixture();
    session.setStationManaged(true);
    session.setAuthoritativeName('Mira');
    setup('NEST', 'CA-mira');
    expect(owl.snapshot('NEST')).toMatchObject({ phase: 'playing', stationManaged: true,
      caller: { name: 'Mira', nameConfirmed: true }, endsAtMs: expect.any(Number) });
    expect(heard.some(line => /first name/i.test(line))).toBe(false);
    prompt('repeat after me: good morning, owl');
    expect(actions(events).at(-1)).toBe('talk');
    expect(heard.at(-1)).toBe('good morning, owl');
    prompt('mix amber and mint');
    expect(actions(events).slice(-2)).toEqual(['lab', 'mix']);
    expect([...events].reverse().find(event => event.type === 'action' && event.action === 'mix'))
      .toMatchObject({ reagents: ['amber', 'mint'] });
    expect(owl.snapshot('NEST')).toMatchObject({ roomMode: 'lab', interactionCount: 3 });
    prompt('return to the study');
    expect(actions(events).at(-1)).toBe('study');
  });

  it('ignores partial, duplicate, and malformed frames and maps keypad input without inventing actions', () => {
    const { server: owl, events, heard, send, setup, prompt } = fixture();
    setup();
    prompt('Ada');
    const count = events.length;
    send({ type: 'prompt', voicePrompt: 'please laugh', last: false });
    send({ type: 'interrupt', utteranceUntilInterrupt: 'Heh', durationUntilInterruptMs: 100 });
    send({ type: 'bogus', action: 'dance' });
    send({ type: 'prompt', voicePrompt: 42, last: true });
    expect(events).toHaveLength(count);
    prompt('laugh');
    prompt('laugh'); // duplicate ASR final within 300 ms
    expect(actions(events).filter(action => action === 'laugh')).toHaveLength(1);
    send({ type: 'dtmf', digit: '2' });
    expect(actions(events).at(-1)).toBe('no');
    send({ type: 'dtmf', digit: '9' });
    expect(heard.at(-1)).toMatch(/press 1 for yes/i);
    expect(owl.snapshot('HOOT')?.phase).toBe('playing');
  });

  it('preserves room identity through Relay transport replacement and closes on confirmed call end', () => {
    const { server: owl, session, setup, prompt } = fixture();
    setup();
    prompt('Ada');
    session.handleClose();
    expect(owl.snapshot('HOOT')?.caller?.connected).toBe(false);
    expect(owl.hasVoiceBinding('HOOT', 'CA-owl')).toBe(true);

    const heard: string[] = [];
    const resumed = new OwlVoiceSession({
      bind: (code, name, sid, locale, station, confirmed) =>
        owl.voiceJoin(code, name, sid, locale, station, confirmed),
      confirmName: (code, sid, name) => owl.voiceConfirmName(code, sid, name),
      action: (code, sid, action, line, reagents) => owl.voiceAction(code, sid, action, line, reagents),
      snapshot: code => owl.snapshot(code),
      disconnect: (code, sid) => owl.voiceDisconnect(code, sid),
      leave: (code, sid, reason) => owl.voiceLeave(code, sid, reason),
      say: text => { heard.push(text); },
    });
    resumed.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-owl',
      customParameters: { roomCode: 'HOOT', game: 'owl' } }));
    expect(resumed.boundPlayerId).toBe('o1');
    expect(owl.snapshot('HOOT')?.caller?.connected).toBe(true);
    expect(heard.at(-1)).toMatch(/welcome back/i);
    resumed.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'wave', last: true }));
    expect(owl.snapshot('HOOT')?.interactionCount).toBe(1);
    resumed.handleCallEnded();
    expect(owl.snapshot('HOOT')).toMatchObject({ phase: 'finished', result: { reason: 'hangup' } });
  });

  it('returns an end-session handoff only after the spoken standalone farewell settles', async () => {
    const { server: owl, events, ends, setup, prompt, session } = fixture();
    setup();
    prompt('Ada');
    prompt('goodbye');
    expect(owl.snapshot('HOOT')).toMatchObject({ phase: 'finished', result: { reason: 'goodbye' } });
    expect(actions(events).at(-1)).toBe('hangup');
    await session.whenSpeechSettled();
    await vi.waitFor(() => expect(ends).toEqual([{ type: 'end',
      handoffData: JSON.stringify({ reasonCode: 'owl-goodbye' }) }]));
  });

  it('gives a brief spoken exit when a room is occupied or its code is invalid', async () => {
    const heard: string[] = [];
    const ends: OwlVoiceEndHandoff[] = [];
    const deps: OwlVoiceDeps = {
      bind: () => null, confirmName: () => false, action: () => null,
      snapshot: () => null, disconnect: () => {}, leave: () => {},
      say: text => { heard.push(text); return Promise.resolve('played'); },
      requestEnd: handoff => { ends.push(handoff); },
    };
    const occupied = new OwlVoiceSession(deps);
    occupied.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-occupied',
      customParameters: { roomCode: 'HOOT', commandLocale: 'en-US' } }));
    expect(heard.at(-1)).toMatch(/already talking/i);
    await vi.waitFor(() => expect(ends.at(-1)?.handoffData).toContain('owl-occupied'));

    const invalid = new OwlVoiceSession(deps);
    invalid.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-invalid',
      customParameters: { roomCode: 'invalid room', commandLocale: 'pt-BR' } }));
    expect(heard.at(-1)).toMatch(/Não encontrei essa sala/i);
    await vi.waitFor(() => expect(ends.at(-1)?.handoffData).toContain('owl-bad-room'));
  });

  it('announces station timeout once while preserving the completed result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
    const { server: owl, session, heard, setup } = fixture({ now: Date.now, stationDurationMs: 1_000 });
    session.setStationManaged(true);
    session.setAuthoritativeName('Mira');
    setup('NEST', 'CA-mira');
    vi.advanceTimersByTime(1_000);
    expect(owl.snapshot('NEST')).toMatchObject({ phase: 'finished', result: { reason: 'timeout' } });
    expect(heard.filter(line => /time is up/i.test(line))).toHaveLength(1);
    session.onStateChanged();
    expect(heard.filter(line => /time is up/i.test(line))).toHaveLength(1);
    await session.whenSpeechSettled();
  });

  it('asks for a Portuguese first name and keeps the phone conversation in Portuguese', () => {
    const { server: owl, heard, events, setup, prompt } = fixture();
    setup('CORUJA', 'CA-pt', 'pt-BR');
    expect(heard.at(-1)).toMatch(/primeiro nome/i);
    prompt('dance');
    expect(owl.snapshot('CORUJA')?.phase).toBe('waiting');
    prompt('Meu nome é João');
    expect(owl.snapshot('CORUJA')).toMatchObject({ phase: 'playing',
      caller: { name: 'João', nameConfirmed: true } });
    expect(heard.at(-1)).toMatch(/Prazer em conhecer você, João/i);
    prompt('acene');
    expect(actions(events).at(-1)).toBe('wave');
    expect(heard.at(-1)).toMatch(/aceno/i);
    prompt('misture hortelã e âmbar');
    expect(actions(events).slice(-2)).toEqual(['lab', 'mix']);
    expect([...events].reverse().find(event => event.type === 'action' && event.action === 'mix'))
      .toMatchObject({ reagents: ['mint', 'amber'] });
    expect(heard.at(-1)).toMatch(/hortelã.*âmbar/i);
    prompt('tchau');
    expect(owl.snapshot('CORUJA')).toMatchObject({ phase: 'finished', result: { reason: 'goodbye' } });
    expect(heard.at(-1)).toMatch(/Até logo/i);
  });

  it('uses the station-provided Portuguese name without asking again', () => {
    const { server: owl, session, heard, events, setup, prompt } = fixture();
    session.setStationManaged(true);
    session.setAuthoritativeName('Lia');
    setup('NINHO', 'CA-lia', 'pt-BR');
    expect(heard.at(-1)).toMatch(/Olá, Lia/i);
    expect(heard.some(line => /primeiro nome/i.test(line))).toBe(false);
    prompt('sim');
    prompt('não');
    expect(actions(events).slice(-2)).toEqual(['yes', 'no']);
    expect(heard.slice(-2)).toEqual(['Sim.', 'Não.']);
    expect(owl.snapshot('NINHO')?.phase).toBe('playing');
  });

  it('answers ordinary speech with the model and gives it bounded follow-up context', async () => {
    const requests: { system: string; history: LlmTurn[]; tools: unknown[];
      timeoutMs: number | undefined; signal: AbortSignal | undefined }[] = [];
    const replies = [
      'Mostly mice and insects. My favorite imaginary snack is a moonberry biscuit.',
      'In winter, many owls hunt the same small animals, even under snow.',
    ];
    const llm: LlmClient = { enabled: true, respond: async (system, history, tools, options) => {
      requests.push({ system, history, tools, timeoutMs: options?.timeoutMs, signal: options?.signal });
      return { say: replies[requests.length - 1] ?? '', toolCalls: [] };
    } };
    const { heard, events, setup, prompt } = fixture({}, llm);
    setup();
    prompt('Ada');
    prompt('What do owls eat?');
    await vi.waitFor(() => expect(heard.at(-1)).toBe(replies[0]));
    expect(actions(events).at(-1)).toBe('talk');
    prompt('What about in winter?');
    await vi.waitFor(() => expect(heard.at(-1)).toBe(replies[1]));
    expect(requests).toHaveLength(2);
    expect(requests[0]?.system).toContain('Ada');
    expect(requests[0]?.system).toContain('study');
    expect(requests[0]?.history).toEqual([{ role: 'user', content: 'What do owls eat?' }]);
    expect(requests[1]?.history).toEqual([
      { role: 'user', content: 'What do owls eat?' },
      { role: 'assistant', content: replies[0] },
      { role: 'user', content: 'What about in winter?' },
    ]);
    expect(requests[0]?.tools).toEqual([]);
    expect(requests[0]?.timeoutMs).toBeGreaterThanOrEqual(4_000);
    expect(requests[0]?.timeoutMs).toBeLessThanOrEqual(6_000);
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('forgets older dialogue after several exchanges', async () => {
    const histories: LlmTurn[][] = [];
    const llm: LlmClient = { enabled: true, respond: async (_system, history) => {
      histories.push(history);
      return { say: `Answer ${histories.length}.`, toolCalls: [] };
    } };
    const { heard, setup, prompt } = fixture({}, llm);
    setup();
    prompt('Ada');
    for (let turn = 1; turn <= 6; turn++) {
      prompt(`Question ${turn}?`);
      await vi.waitFor(() => expect(heard.at(-1)).toBe(`Answer ${turn}.`));
    }
    expect(histories[5]?.length).toBeLessThanOrEqual(9);
    expect(histories[5]).not.toContainEqual({ role: 'user', content: 'Question 1?' });
    expect(histories[5]?.at(-1)).toEqual({ role: 'user', content: 'Question 6?' });
  });

  it('keeps explicit repeat-after-me literal without consulting the model', async () => {
    const respond = vi.fn(async (): Promise<LlmReply> => ({ say: 'not used', toolCalls: [] }));
    const { heard, events, setup, prompt } = fixture({}, { enabled: true, respond });
    setup();
    prompt('Ada');
    prompt('repeat after me: good morning, owl');
    expect(heard.at(-1)).toBe('good morning, owl');
    expect(actions(events).at(-1)).toBe('talk');
    expect(respond).not.toHaveBeenCalled();
  });

  it('uses an in-character retry when the model has no answer instead of echoing the caller', async () => {
    const llm: LlmClient = { enabled: true,
      respond: async () => ({ say: '', toolCalls: [] }) };
    const { heard, events, setup, prompt } = fixture({}, llm);
    setup();
    prompt('Ada');
    prompt('Tell me why the sky is blue');
    await vi.waitFor(() => expect(actions(events).at(-1)).toBe('talk'));
    expect(heard.at(-1)).toMatch(/feathers|thoughts|ask me again/i);
    expect(heard.at(-1)).not.toMatch(/sky is blue/i);
  });

  it('does not speak a model reply that only parrots the caller', async () => {
    const llm: LlmClient = { enabled: true, respond: async () => ({
      say: 'The purple moon is beautiful.', toolCalls: [],
    }) };
    const { heard, setup, prompt } = fixture({}, llm);
    setup();
    prompt('Ada');
    prompt('The purple moon is beautiful.');
    await vi.waitFor(() => expect(heard.at(-1)).toMatch(/feathers|ask me again/i));
    expect(heard.at(-1)).not.toBe('The purple moon is beautiful.');
  });

  it('rejects a model echo of a short freeform utterance', async () => {
    const llm: LlmClient = { enabled: true, respond: async () => ({
      say: 'Moon flowers.', toolCalls: [],
    }) };
    const { heard, setup, prompt } = fixture({}, llm);
    setup();
    prompt('Ada');
    prompt('Moon flowers');
    await vi.waitFor(() => expect(heard.at(-1)).not.toMatch(/Nice to meet/i));
    expect(heard.at(-1)).toMatch(/feathers|ask me again/i);
    expect(heard.at(-1)).not.toBe('Moon flowers.');
  });

  it('treats bare yes and no as answers when the Owl just asked a question', async () => {
    const histories: LlmTurn[][] = [];
    const replies = [
      'Would you like to hear a tiny owl story?',
      'Shall I start with the moonlit forest?',
      'Then I will tell you about the old lamp instead.',
    ];
    const llm: LlmClient = { enabled: true, respond: async (_system, history) => {
      histories.push(history);
      return { say: replies[histories.length - 1] ?? '', toolCalls: [] };
    } };
    const { heard, events, setup, prompt } = fixture({}, llm);
    setup();
    prompt('Ada');
    prompt('Tell me a story');
    await vi.waitFor(() => expect(heard.at(-1)).toBe(replies[0]));
    prompt('yes');
    await vi.waitFor(() => expect(heard.at(-1)).toBe(replies[1]));
    prompt('no');
    await vi.waitFor(() => expect(heard.at(-1)).toBe(replies[2]));
    expect(actions(events).slice(-3)).toEqual(['talk', 'talk', 'talk']);
    expect(histories[1]?.slice(-3)).toEqual([
      { role: 'user', content: 'Tell me a story' },
      { role: 'assistant', content: replies[0] },
      { role: 'user', content: 'yes' },
    ]);
    expect(histories[2]?.at(-1)).toEqual({ role: 'user', content: 'no' });
  });

  it('keeps explicit yes and no gestures and keypad commands after an Owl question', async () => {
    let modelCalls = 0;
    const llm: LlmClient = { enabled: true, respond: async () => {
      modelCalls++;
      return { say: 'Would you like another story?', toolCalls: [] };
    } };
    const { events, setup, prompt, send } = fixture({}, llm);
    setup();
    prompt('Ada');
    prompt('Tell me a story');
    await vi.waitFor(() => expect(actions(events).at(-1)).toBe('talk'));
    prompt('say yes');
    expect(actions(events).at(-1)).toBe('yes');
    send({ type: 'dtmf', digit: '2' });
    expect(actions(events).at(-1)).toBe('no');
    expect(modelCalls).toBe(1);
    prompt('yes');
    expect(actions(events).at(-1)).toBe('yes');
  });

  it('keeps a complete sentence when a model reply is too long for the spoken action', async () => {
    const llm: LlmClient = { enabled: true, respond: async () => ({
      say: 'Owls fly almost silently. ' + 'Their specialized feathers soften the rush of air. '.repeat(5),
      toolCalls: [],
    }) };
    const { heard, setup, prompt } = fixture({}, llm);
    setup();
    prompt('Ada');
    prompt('How do owls fly?');
    await vi.waitFor(() => expect(heard.at(-1)).toMatch(/Owls fly/));
    expect(heard.at(-1)).toBe('Owls fly almost silently.');
  });

  it('ends a stalled model turn within five seconds and gives a spoken retry', async () => {
    vi.useFakeTimers();
    let requestedSignal: AbortSignal | undefined;
    const llm: LlmClient = { enabled: true, respond: async (_system, _history, _tools, options) => {
      requestedSignal = options?.signal;
      return new Promise<LlmReply>(() => {});
    } };
    const { heard, events, setup, prompt } = fixture({}, llm);
    setup();
    prompt('Ada');
    prompt('Why is the moon so bright?');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestedSignal?.aborted).toBe(true);
    expect(actions(events).at(-1)).toBe('talk');
    expect(heard.at(-1)).toMatch(/feathers|ask me again/i);
  });

  it('drops a stale model answer after a new action and aborts its request', async () => {
    let resolveModel!: (reply: LlmReply) => void;
    let requestedSignal: AbortSignal | undefined;
    const llm: LlmClient = { enabled: true, respond: async (_system, _history, _tools, options) => {
      requestedSignal = options?.signal;
      return new Promise<LlmReply>(resolve => { resolveModel = resolve; });
    } };
    const { heard, events, setup, prompt } = fixture({}, llm);
    setup();
    prompt('Ada');
    prompt('How do owls fly so quietly?');
    expect(requestedSignal?.aborted).toBe(false);
    prompt('tickle');
    expect(requestedSignal?.aborted).toBe(true);
    expect(actions(events).at(-1)).toBe('tickle');
    resolveModel({ say: 'This answer arrived too late.', toolCalls: [] });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(heard).not.toContain('This answer arrived too late.');
    expect(actions(events)).not.toContain('talk');
  });

  it('drops a model answer when the phone socket closes', async () => {
    let resolveModel!: (reply: LlmReply) => void;
    let requestedSignal: AbortSignal | undefined;
    const llm: LlmClient = { enabled: true, respond: async (_system, _history, _tools, options) => {
      requestedSignal = options?.signal;
      return new Promise<LlmReply>(resolve => { resolveModel = resolve; });
    } };
    const { heard, events, session, setup, prompt } = fixture({}, llm);
    setup();
    prompt('Ada');
    prompt('Tell me about stars');
    session.handleClose();
    expect(requestedSignal?.aborted).toBe(true);
    resolveModel({ say: 'The stars are bright.', toolCalls: [] });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(heard).not.toContain('The stars are bright.');
    expect(actions(events)).not.toContain('talk');
  });

  it('answers Portuguese conversation in Portuguese while preserving deterministic reactions', async () => {
    let systemPrompt = '';
    const llm: LlmClient = { enabled: true, respond: async (system) => {
      systemPrompt = system;
      return { say: 'Minhas penas me ajudam a voar em silêncio.', toolCalls: [] };
    } };
    const { heard, events, setup, prompt } = fixture({}, llm);
    setup('CORUJA', 'CA-pt', 'pt-BR');
    prompt('Meu nome é Lia');
    prompt('Como você voa tão silenciosamente?');
    await vi.waitFor(() => expect(heard.at(-1)).toBe('Minhas penas me ajudam a voar em silêncio.'));
    expect(systemPrompt).toMatch(/portugu[eê]s|Portuguese|pt-BR/i);
    prompt('faça cócegas');
    expect(actions(events).at(-1)).toBe('tickle');
  });
});

describe('deterministic Talking Owl speech map', () => {
  it('covers every call reaction, the classic props, and all three lab mixtures', () => {
    const cases: [string, OwlAction][] = [
      ['yes', 'yes'], ['no', 'no'], ['laugh', 'laugh'], ['wave', 'wave'],
      ['ponder', 'ponder'], ['gasp', 'gasp'], ['dance', 'dance'], ['snooze', 'snooze'],
      ['sing', 'sing'], ['wink', 'wink'], ['shrug', 'shrug'], ['salute', 'salute'],
      ['scratch', 'scratch'], ['yawn', 'yawn'], ['hush', 'hush'], ['cheer', 'cheer'],
      ['shiver', 'shiver'], ['bow', 'bow'], ['sneeze', 'sneeze'],
      ['newspaper', 'newspaper'], ['poke', 'poke'], ['tickle', 'tickle'],
      ['cookie', 'eat'], ['drink', 'sip'], ['burp', 'burp'], ['portrait', 'portrait'],
      ['lamp', 'lamp'], ['go to the lab', 'lab'], ['return to the study', 'study'],
    ];
    for (const [spoken, action] of cases) {
      expect(interpretOwlSpeech(spoken)).toMatchObject({ kind: 'action', action });
    }
    expect(interpretOwlSpeech('mix berry and mint')).toMatchObject({ action: 'mix', reagents: ['berry', 'mint'] });
    expect(interpretOwlSpeech('combine mint with amber')).toMatchObject({ action: 'mix', reagents: ['mint', 'amber'] });
    expect(interpretOwlSpeech('mix amber and berry')).toMatchObject({ action: 'mix', reagents: ['amber', 'berry'] });
    expect(interpretOwlSpeech('mix some potion')).toMatchObject({ action: 'talk' });
  });

  it('routes ordinary speech and broad keyword mentions to conversation, not prop actions', () => {
    expect(interpretOwlSpeech("Don't dance")).toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech("Don't hang up").kind).not.toBe('goodbye');
    expect(interpretOwlSpeech('the purple moon is beautiful')).toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('What is your name?')).toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('Do you like cookies?')).toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('Who are you?')).toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('I ate a cookie')).toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('tell me about tea')).toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('What happens if I mix berry and mint?')).toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('Tell me about the potion of life')).toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('Potion of life')).toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('eat a cookie')).toMatchObject({ kind: 'action', action: 'eat' });
    expect(interpretOwlSpeech('tickle')).toMatchObject({ kind: 'action', action: 'tickle' });
    expect(interpretOwlSpeech('tickle him')).toMatchObject({ kind: 'action', action: 'tickle' });
    expect(interpretOwlSpeech('can you dance?')).toMatchObject({ kind: 'action', action: 'dance' });
    expect(interpretOwlSpeech('repeat after me: goodbye')).toMatchObject({ kind: 'action', action: 'talk', line: 'goodbye' });
    expect(interpretOwlSpeech('What does goodbye mean?').kind).not.toBe('goodbye');
  });

  it('recognizes natural direct reaction requests without treating stories as commands', () => {
    const direct: [string, OwlAction][] = [
      ['Can you laugh for me?', 'laugh'],
      ['Can you burp for me?', 'burp'],
      ['Give me a wave', 'wave'],
      ['I want to tickle you', 'tickle'],
    ];
    for (const [spoken, action] of direct) {
      expect(interpretOwlSpeech(spoken)).toMatchObject({ kind: 'action', action });
    }
    for (const spoken of [
      'I heard an owl laugh for me',
      'Burps can be funny',
      'I want to tell you about a wave',
      'I want to tickle you with a story about feathers',
    ]) {
      expect(interpretOwlSpeech(spoken)).toMatchObject({ kind: 'conversation' });
    }
  });

  it('explains how to supply words when asked to repeat without a phrase', () => {
    expect(interpretOwlSpeech('repeat after me')).toMatchObject({
      kind: 'help', line: expect.stringContaining('repeat after me, hello little owl'),
    });
    expect(interpretOwlSpeech('repita depois de mim', 0, 'pt-BR')).toMatchObject({
      kind: 'help', line: expect.stringContaining('repita depois de mim, olá corujinha'),
    });
  });

  it('maps Portuguese reactions and instructions without using English TTS lines', () => {
    const cases: [string, OwlAction][] = [
      ['sim', 'yes'], ['não', 'no'], ['ria', 'laugh'], ['acene', 'wave'],
      ['pense', 'ponder'], ['surpresa', 'gasp'], ['dance', 'dance'], ['durma', 'snooze'],
      ['cante', 'sing'], ['pisque', 'wink'], ['encolha os ombros', 'shrug'],
      ['continência', 'salute'], ['coce', 'scratch'], ['boceje', 'yawn'],
      ['psiu', 'hush'], ['comemore', 'cheer'], ['trema', 'shiver'],
      ['reverência', 'bow'], ['espirre', 'sneeze'],
      ['jornal', 'newspaper'], ['cutuque', 'poke'], ['cócegas', 'tickle'],
      ['biscoito', 'eat'], ['beba', 'sip'], ['arroto', 'burp'],
      ['quadro', 'portrait'], ['abajur', 'lamp'],
      ['vá ao laboratório', 'lab'], ['volte para o escritório', 'study'],
    ];
    for (const [spoken, action] of cases) {
      expect(interpretOwlSpeech(spoken, 0, 'pt-BR')).toMatchObject({ kind: 'action', action });
    }
    expect(interpretOwlSpeech('misture frutas vermelhas e hortelã', 0, 'pt-BR'))
      .toMatchObject({ action: 'mix', reagents: ['berry', 'mint'] });
    expect(interpretOwlSpeech('misture hortelã e âmbar', 0, 'pt-BR'))
      .toMatchObject({ action: 'mix', reagents: ['mint', 'amber'] });
    expect(interpretOwlSpeech('misture âmbar e morango', 0, 'pt-BR'))
      .toMatchObject({ action: 'mix', reagents: ['amber', 'berry'] });
    expect(interpretOwlSpeech('não dance', 0, 'pt-BR')).toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('Quem é você?', 0, 'pt-BR'))
      .toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('Eu comi um biscoito', 0, 'pt-BR'))
      .toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('me conte sobre chá', 0, 'pt-BR'))
      .toMatchObject({ kind: 'conversation' });
    expect(interpretOwlSpeech('repita depois de mim: tchau', 0, 'pt-BR'))
      .toMatchObject({ kind: 'action', action: 'talk', line: 'tchau' });
    expect(interpretOwlSpeech('O que significa tchau?', 0, 'pt-BR').kind).not.toBe('goodbye');
  });
});
