import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwlServer, type OwlServerOptions } from '../server/owl-server';
import { OwlVoiceSession, interpretOwlSpeech,
  type OwlVoiceDeps, type OwlVoiceEndHandoff } from '../server/owl-voice';
import type { OwlAction, OwlEvent } from '../shared/owl-protocol';

let server: OwlServer | null = null;

afterEach(() => {
  server?.stopLoopOnly();
  server = null;
  vi.useRealTimers();
});

function fixture(options: OwlServerOptions = {}) {
  server = new OwlServer(options);
  const heard: string[] = [];
  const events: OwlEvent[] = [];
  const ends: OwlVoiceEndHandoff[] = [];
  let session!: OwlVoiceSession;
  session = new OwlVoiceSession({
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

  it('skips the name prompt for a station identity and handles reactions, lab mixtures, and natural questions', () => {
    const { server: owl, session, heard, events, setup, prompt } = fixture();
    session.setStationManaged(true);
    session.setAuthoritativeName('Mira');
    setup('NEST', 'CA-mira');
    expect(owl.snapshot('NEST')).toMatchObject({ phase: 'playing', stationManaged: true,
      caller: { name: 'Mira', nameConfirmed: true }, endsAtMs: expect.any(Number) });
    expect(heard.some(line => /first name/i.test(line))).toBe(false);
    prompt('Do you like the moon?');
    expect(['yes', 'no', 'ponder']).toContain(actions(events).at(-1));
    prompt('repeat after me: good morning, owl');
    expect(actions(events).at(-1)).toBe('talk');
    expect(heard.at(-1)).toBe('good morning, owl');
    prompt('mix amber and mint');
    expect(actions(events).slice(-2)).toEqual(['lab', 'mix']);
    expect([...events].reverse().find(event => event.type === 'action' && event.action === 'mix'))
      .toMatchObject({ reagents: ['amber', 'mint'] });
    expect(owl.snapshot('NEST')).toMatchObject({ roomMode: 'lab', interactionCount: 4 });
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

  it('handles negation and echoes unmatched speech instead of executing a guessed gesture', () => {
    expect(interpretOwlSpeech("Don't dance")).toMatchObject({ action: 'talk' });
    expect(interpretOwlSpeech("Don't hang up").kind).not.toBe('goodbye');
    expect(interpretOwlSpeech('the purple moon is beautiful')).toMatchObject({ action: 'talk' });
    expect(interpretOwlSpeech('What is your name?')).toMatchObject({ action: 'talk', line: expect.stringContaining('Talking Owl') });
    expect(interpretOwlSpeech('Do you like cookies?')).not.toMatchObject({ kind: 'action', action: 'eat' });
    expect(interpretOwlSpeech('Who are you?')).toMatchObject({ action: 'talk', line: expect.stringContaining('Talking Owl') });
    expect(interpretOwlSpeech('repeat after me: goodbye')).toMatchObject({ kind: 'action', action: 'talk', line: 'goodbye' });
    expect(interpretOwlSpeech('What does goodbye mean?').kind).not.toBe('goodbye');
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
    expect(interpretOwlSpeech('não dance', 0, 'pt-BR')).toMatchObject({ action: 'talk' });
    expect(interpretOwlSpeech('Quem é você?', 0, 'pt-BR'))
      .toMatchObject({ action: 'talk', line: expect.stringContaining('Coruja Falante') });
    expect(interpretOwlSpeech('repita depois de mim: tchau', 0, 'pt-BR'))
      .toMatchObject({ kind: 'action', action: 'talk', line: 'tchau' });
    expect(interpretOwlSpeech('O que significa tchau?', 0, 'pt-BR').kind).not.toBe('goodbye');
  });
});
