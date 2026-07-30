import { describe, it, expect, vi } from 'vitest';
import { parseCrMessage } from '../server/conversation-relay';
import { ConversationRelayAdapter } from '../server/conversation-relay';
import type { Intent } from '../shared/types';

function fakeRoom() {
  const applied: { id:string; intent:Intent }[] = [];
  const assignments: Array<number | undefined> = [];
  const expectedPlayers: number[] = [];
  const nameConfirmations: Array<boolean | undefined> = [];
  let n = 0;
  return {
    applied,
    assignments,
    expectedPlayers,
    nameConfirmations,
    addPlayer: (_name:string, _color?: string, preferredIndex?: number, nameConfirmed?: boolean) => {
      assignments.push(preferredIndex);
      nameConfirmations.push(nameConfirmed);
      return { playerId:`p${++n}`, lane:preferredIndex ?? n-1 };
    },
    expectHumanPlayers: (count: number) => { expectedPlayers.push(count); },
    applyIntent: (id:string, intent:Intent) => { applied.push({ id, intent }); },
    removePlayer: (_id:string) => {},
  };
}

describe('parseCrMessage', () => {
  it('parses setup with customParameters', () => {
    const m = parseCrMessage(JSON.stringify({
      type:'setup', callSid:'CA1', from:'+15551234567',
      customParameters:{ roomCode:'4821' } }));
    expect(m).toEqual({ type:'setup', callSid:'CA1', from:'+15551234567',
      customParameters:{ roomCode:'4821' } });
  });
  it('parses a final prompt', () => {
    const m = parseCrMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:true }));
    expect(m).toEqual({ type:'prompt', voicePrompt:'left', last:true });
  });
  it('parses an interim prompt (last:false)', () => {
    const m = parseCrMessage(JSON.stringify({ type:'prompt', voicePrompt:'le', last:false }));
    expect(m).toEqual({ type:'prompt', voicePrompt:'le', last:false });
  });
  it('parses dtmf and error', () => {
    expect(parseCrMessage(JSON.stringify({ type:'dtmf', digit:'1' })))
      .toEqual({ type:'dtmf', digit:'1' });
    expect(parseCrMessage(JSON.stringify({ type:'error', description:'bad' })))
      .toEqual({ type:'error', description:'bad' });
  });
  it('parses an interrupt (barge-in) with the played-so-far utterance', () => {
    const m = parseCrMessage(JSON.stringify({
      type:'interrupt', utteranceUntilInterrupt:'The McLaren is', durationUntilInterruptMs:'900' }));
    expect(m).toEqual({ type:'interrupt', utteranceUntilInterrupt:'The McLaren is', durationUntilInterruptMs:900 });
  });
  it('returns unknown for unrecognized or malformed input', () => {
    expect(parseCrMessage('not json').type).toBe('unknown');
    expect(parseCrMessage(JSON.stringify({ type:'wat' })).type).toBe('unknown');
  });
});

describe('ConversationRelayAdapter', () => {
  it('binds to a room on setup and applies a mapped intent on a final prompt', () => {
    const room = fakeRoom();
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:true }));
    expect(room.applied).toEqual([{ id:'p1', intent:'MOVE_LEFT' }]);
  });

  it('applies the station Racer order and expected player count before joining', () => {
    const room = fakeRoom();
    const adapter = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    adapter.setStationManaged(true);
    adapter.setStationAssignment(1, 2);
    adapter.handleMessage(JSON.stringify({ type:'setup', callSid:'CA2', customParameters:{ roomCode:'4821' } }));

    expect(room.expectedPlayers).toEqual([2]);
    expect(room.assignments).toEqual([1]);
    expect(room.nameConfirmations).toEqual([false]);
  });

  it('ignores prompts before setup (no room bound)', () => {
    const room = fakeRoom();
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:true }));
    expect(room.applied).toHaveLength(0);
  });

  it('ignores repeated interim commands and applies the finalized command once', () => {
    const room = fakeRoom();
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    // Interim hypotheses never mutate authoritative state.
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'le',   last:false }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:false }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:false }));
    expect(room.applied).toEqual([]);
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:true }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:false }));
    expect(room.applied).toEqual([{ id:'p1', intent:'MOVE_LEFT' }]);
  });

  it('fires the CORRECTED command when ASR revises a partial (left → right)', () => {
    // The real dropped-command bug: Deepgram hears "left", then corrects the SAME utterance to
    // "right". Position-slicing dropped the correction; content dedup must fire RIGHT.
    const room = fakeRoom();
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left',  last:false }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'right', last:true }));
    expect(room.applied).toEqual([{ id:'p1', intent:'MOVE_RIGHT' }]);
  });

  it('fires an appended second command in the same utterance ("left" then "left right")', () => {
    const room = fakeRoom();
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left',       last:false }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left right',  last:true }));
    expect(room.applied).toEqual([
      { id:'p1', intent:'MOVE_LEFT' },
      { id:'p1', intent:'MOVE_RIGHT' },
    ]);
  });

  it('maps dtmf digits to intents as a fallback (1=left,2=boost,3=right)', () => {
    const room = fakeRoom();
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleMessage(JSON.stringify({ type:'dtmf', digit:'1' }));
    a.handleMessage(JSON.stringify({ type:'dtmf', digit:'3' }));
    expect(room.applied).toEqual([
      { id:'p1', intent:'MOVE_LEFT' },
      { id:'p1', intent:'MOVE_RIGHT' },
    ]);
  });

  it('routes menu DTMF through the deterministic setup selection path', async () => {
    const room = fakeRoom(); const utterances: string[] = [];
    const adapter = new ConversationRelayAdapter({
      findOrCreateRoom: () => room,
      phaseOf: () => 'car_select',
      handleSetupUtterance:(_code,_id,utterance)=>{utterances.push(utterance);return 'Selected.';},
    });
    adapter.handleMessage(JSON.stringify({ type:'setup', callSid:'CA-menu-dtmf', customParameters:{ roomCode:'4821' } }));
    adapter.handleMessage(JSON.stringify({ type:'dtmf', digit:'2' }));
    await Promise.resolve();

    expect(utterances).toEqual(['2']);
    expect(room.applied).toEqual([]);
  });

  it('removes the player on close', () => {
    let removed: string | null = null;
    const room = { addPlayer: () => ({ playerId:'p1', lane:0 }),
      applyIntent: () => {}, removePlayer: (id:string) => { removed = id; } };
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleClose();
    expect(removed).toBe('p1');
  });

  it('preserves and resumes the same Racer player across a Relay transport reconnect', () => {
    let removed: string | null = null;
    let added = 0;
    const room = { addPlayer: () => { added++; return { playerId:'new-player', lane:1 }; },
      applyIntent: () => {}, removePlayer: (id:string) => { removed = id; } };
    const first = new ConversationRelayAdapter({ findOrCreateRoom: () => room,
      resumePlayer: () => ({ playerId:'p1', lane:0,resumed:true,name:'Racer X' }),hasPlayerName:()=>true });
    first.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    expect(first.boundPlayerId).toBe('p1');
    first.handleClose(true);
    expect(removed).toBeNull();
    expect(added).toBe(0);

    const said:string[]=[];const resumed = new ConversationRelayAdapter({ findOrCreateRoom: () => room,
      resumePlayer: () => ({ playerId:'p1', lane:0,resumed:true,name:'Racer X' }),hasPlayerName:()=>true,
      say:text=>said.push(text),phaseOf:()=> 'lobby' });
    resumed.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    expect(resumed.boundPlayerId).toBe('p1');
    expect(added).toBe(0);
    expect(said.join(' ')).toMatch(/Welcome back.*Racer X/i);
    expect(said.join(' ').toLowerCase()).not.toContain('what\'s your name');
  });

  it('does nothing if the room is full (addPlayer returns error)', () => {
    const room = { addPlayer: () => ({ error:'room_full' as const }),
      applyIntent: () => { throw new Error('should not apply'); }, removePlayer: () => {} };
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:true }));
    // no throw, no binding
  });

  // ── Talk-back (greeting / countdown / result spoken to the caller) ──────────────────────────────
  it('greets the caller + registers on bind', () => {
    const room = fakeRoom(); const said: string[] = []; let registered = '';
    const a = new ConversationRelayAdapter({
      findOrCreateRoom: () => room, say: (t) => said.push(t),
      register: (code) => { registered = code; }, unregister: () => {} });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    expect(registered).toBe('4821');
    // Greeting is sent as MULTIPLE sentences (separate utterances → natural TTS pauses) and asks the
    // caller's name (voice onboarding starts on connect).
    expect(said.length).toBeGreaterThan(1);
    expect(said.join(' ').toLowerCase()).toContain('voice racer');
    expect(said.join(' ').toLowerCase()).toMatch(/name/);
    expect(a.boundPlayerId).toBe('p1');
  });

  it('uses an authoritative station name without asking for it again', () => {
    const said: string[] = [];const names: string[] = [];
    const room = {
      addPlayer: (name:string) => { names.push(name);return { playerId:'p1',lane:0 }; },
      applyIntent: () => undefined,removePlayer: () => undefined,
    };
    const adapter = new ConversationRelayAdapter({ findOrCreateRoom: () => room,say:text=>said.push(text),phaseOf:()=> 'lobby' });
    adapter.setAuthoritativeName('Ada');
    adapter.handleMessage(JSON.stringify({ type:'setup',callSid:'CA-known',from:'+15551234567',customParameters:{roomCode:'4821'} }));
    expect(names).toEqual(['Ada']);
    const arrival=said.join(' ').toLowerCase();
    expect(arrival).toContain('ada');
    expect(arrival).toContain('voice racer');
    expect(arrival).toContain('conversation relay');
    expect(arrival).toMatch(/left|right/);
    expect(arrival).toMatch(/either racer.*say start/i);
    expect(arrival).not.toContain('your name');
    said.length=0;
    adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'help',last:true}));
    expect(said.join(' ').toLowerCase()).not.toContain('your name');
    adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'call me Mallory',last:true}));
    expect(names).toEqual(['Ada']);
  });

  it('guides a named first-time caller who joins during car selection',()=>{
    const said:string[]=[];const room=fakeRoom();
    const adapter=new ConversationRelayAdapter({findOrCreateRoom:()=>room,say:text=>said.push(text),phaseOf:()=> 'car_select'});
    adapter.setAuthoritativeName('Ada');adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-car',customParameters:{roomCode:'4821'}}));
    expect(said.join(' ')).toMatch(/Ada/);
    expect(said.at(-1)?.toLowerCase()).toMatch(/choose your own car.*every racer chooses/);
  });

  it('speaks only numeric countdown + short go events to the caller', () => {
    const room = fakeRoom(); const said: string[] = [];
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room, say: (t) => said.push(t) });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;   // drop the greeting
    a.onGameEvent({ kind:'countdown', n:6 });
    a.onGameEvent({ kind:'countdown', n:5 });
    a.onGameEvent({ kind:'countdown', n:4 });
    a.onGameEvent({ kind:'countdown', n:3 });
    a.onGameEvent({ kind:'go' });
    expect(said).toEqual(['3', 'Go!']);
  });

  it('speaks a race-over recap fallback when the LLM host returns nothing', async () => {
    const room = fakeRoom(); const said: string[] = [];
    const a = new ConversationRelayAdapter({
      findOrCreateRoom: () => room,
      say: (t) => said.push(t),
      converse: async () => null,
    });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;

    a.onGameEvent({ kind:'finish', playerId:'p1', name:'Me', place:1 });
    a.onGameEvent({ kind:'race_over' });
    await a.whenSpeechSettled();

    expect(said.join(' ').toLowerCase()).toMatch(/first place|congrat|won/);
    expect(said.join(' ').toLowerCase()).toContain('leaderboard');
  });

  it('waits for an in-flight race-over recap before reporting speech settled', async () => {
    const room = fakeRoom(); const said: string[] = [];
    let resolveRecap!: (value: string) => void;
    const recap = new Promise<string>(resolve => { resolveRecap = resolve; });
    const a = new ConversationRelayAdapter({
      findOrCreateRoom: () => room,
      say: text => said.push(text),
      converse: async () => recap,
    });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;
    a.onGameEvent({ kind:'race_over' });

    let settled = false;
    const waiting = a.whenSpeechSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveRecap('Photo finish. What a race!');
    await waiting;

    expect(said).toEqual(['Photo finish.', 'What a race!']);
  });

  it('uses requeue guidance instead of replay copy when a station recap falls back', async () => {
    const room=fakeRoom();const said:string[]=[];
    const adapter=new ConversationRelayAdapter({findOrCreateRoom:()=>room,say:text=>said.push(text),converse:async()=>null});
    adapter.setStationManaged(true);
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-station',customParameters:{roomCode:'4821'}}));
    said.length=0;adapter.onGameEvent({kind:'race_over'});await adapter.whenSpeechSettled();
    expect(said.join(' ')).toMatch(/results.*display.*thanks for playing.*check your messages/i);
    expect(said.join(' ')).not.toMatch(/rematch|try again|run it back/i);
  });

  it('replays mandatory station results after an interruption', async () => {
    const room=fakeRoom();const said:string[]=[];let recaps=0;
    const adapter=new ConversationRelayAdapter({
      findOrCreateRoom:()=>room,phaseOf:()=> 'results',say:text=>said.push(text),
      converse:async()=>{recaps++;return 'You finished second. Ada leads Silver Lake. Thanks for playing!';},
    });
    adapter.setStationManaged(true);
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-station',customParameters:{roomCode:'4821'}}));
    adapter.onGameEvent({kind:'race_over'});
    await adapter.whenSpeechSettled();
    adapter.handleMessage(JSON.stringify({type:'interrupt',utteranceUntilInterrupt:'You finished',durationUntilInterruptMs:100}));
    await adapter.whenSpeechSettled();
    expect(recaps).toBe(2);
    expect(said.filter(line=>/finished second/i.test(line))).toHaveLength(2);
  });

  it('does not speak repeated menu-entry prompts back to back', () => {
    const room = fakeRoom(); const said: string[] = [];
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room, say: (t) => said.push(t) });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;

    a.onGameEvent({ kind:'enter_car_select' });
    a.onGameEvent({ kind:'enter_car_select' });
    a.onGameEvent({ kind:'enter_map_select' });
    a.onGameEvent({ kind:'enter_map_select' });

    expect(said).toHaveLength(2);
    expect(said[0]!.toLowerCase()).toMatch(/car|ride|machine/);
    expect(said[1]!.toLowerCase()).toMatch(/track|course/);
  });

  it('tells a waiting station caller when their personal setup turn opens',()=>{
    const room=fakeRoom(),said:string[]=[];let turn:'active'|'waiting'='waiting';
    const adapter=new ConversationRelayAdapter({
      findOrCreateRoom:()=>room,phaseOf:()=> 'car_select',say:text=>said.push(text),setupTurnFor:()=>turn,
    });
    adapter.setStationManaged(true);
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-turn',customParameters:{roomCode:'4821'}}));
    said.length=0;adapter.onGameEvent({kind:'enter_car_select'});
    expect(said.join(' ')).toMatch(/waiting for the other/i);
    turn='active';adapter.onGameEvent({kind:'car_picked',playerId:'p2',name:'Ada',car:'Roadster'});
    expect(said.at(-1)).toMatch(/choose your own car/i);
  });

  it('uses immediate setup guidance and never starts a delayed host turn', async () => {
    const room=fakeRoom();const said:string[]=[];let phase='car_select';let release!:(value:string)=>void;
    const delayed=new Promise<string>(resolve=>{release=resolve;});
    const adapter=new ConversationRelayAdapter({
      findOrCreateRoom:()=>room,phaseOf:()=>phase,
      say:(text,isCurrent)=>{if(!isCurrent||isCurrent())said.push(text);},
      converse:async()=>delayed,
    });
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-phase',customParameters:{roomCode:'4821'}}));
    said.length=0;
    adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'which car should I choose?',last:true}));
    phase='countdown';
    adapter.onGameEvent({kind:'enter_car_select'});
    release('Choose a car by name or number.');
    await Promise.resolve();await Promise.resolve();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/choose your own car/i);
  });

  it('does not start a host turn that could outlive a replaced setup adapter', async () => {
    const room=fakeRoom();const said:string[]=[];let release!:(value:string)=>void;
    const delayed=new Promise<string>(resolve=>{release=resolve;});
    const adapter=new ConversationRelayAdapter({findOrCreateRoom:()=>room,phaseOf:()=> 'car_select',say:text=>said.push(text),converse:async()=>delayed});
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-old',customParameters:{roomCode:'4821'}}));
    said.length=0;adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'which car is fastest?',last:true}));adapter.handleClose(true);
    release('Choose a car by name or number.');await Promise.resolve();await Promise.resolve();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/choose your own car/i);
  });

  it('does not repeat the menu or car response already spoken to the initiating caller', () => {
    const room = fakeRoom(); const said: string[] = [];
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room, say: (t) => said.push(t) });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;

    a.onGameEvent({ kind:'enter_car_select', spokenReplyPlayerId:'p1' });
    a.onGameEvent({ kind:'car_picked', playerId:'p1', name:'Me', car:'Roadster', spokenReplyPlayerId:'p1' });
    a.onGameEvent({ kind:'enter_map_select', spokenReplyPlayerId:'someone-else' });

    expect(said).toHaveLength(1);
    expect(said[0]!.toLowerCase()).toMatch(/track|course/);
  });

  it('allows the same menu prompt again after a later phase cycle', () => {
    vi.useFakeTimers();
    const room = fakeRoom(); const said: string[] = [];
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room, say: (t) => said.push(t) });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;

    a.onGameEvent({ kind:'enter_car_select' });
    vi.advanceTimersByTime(1001);
    a.onGameEvent({ kind:'enter_car_select' });

    expect(said.filter(s => /car|ride|machine/i.test(s))).toHaveLength(2);
    vi.useRealTimers();
  });

  it('announces the caller\'s OWN finish only, not other players\'', () => {
    const room = fakeRoom(); const said: string[] = [];
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room, say: (t) => said.push(t) });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;
    a.onGameEvent({ kind:'finish', playerId:'p2', name:'Other', place:1 });   // someone else → silent
    expect(said).toHaveLength(0);
    a.onGameEvent({ kind:'finish', playerId:'p1', name:'Me', place:2 });       // the caller → spoken
    expect(said).toHaveLength(1);
    expect(said[0]!.toLowerCase()).toContain('second');
  });

  // ── Setup stays deterministic; race questions may use the conversational host ──────────────────
  it('keeps unknown menu speech contextual and out of the conversational host', async () => {
    const room = fakeRoom(); const said: string[] = []; let conversed = '';
    const a = new ConversationRelayAdapter({
      findOrCreateRoom: () => room, say: (t) => said.push(t),
      phaseOf: () => 'car_select',
      converse: async (_r, _p, utterance) => { conversed = utterance; return 'The McLaren is fastest!'; },
    });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'which car is fastest?', last:true }));
    await new Promise(r => setTimeout(r, 0));   // let the converse promise resolve
    expect(conversed).toBe('');
    expect(said.join(' ')).toMatch(/choose your own car/i);
    expect(room.applied).toHaveLength(0);        // menu chat must NOT drive the car
  });

  it('does not create an in-flight setup LLM reply when the caller barges in', async () => {
    // Barge-in: the caller asks something, then interrupts while the host is "thinking". The late
    // reply must NOT be spoken over the caller's new speech — that's the whole point of interruption.
    const room = fakeRoom(); const said: string[] = [];
    let resolveConverse: (s: string) => void = () => {};
    const a = new ConversationRelayAdapter({
      findOrCreateRoom: () => room, say: (t) => said.push(t),
      phaseOf: () => 'car_select',
      converse: () => new Promise<string>(res => { resolveConverse = res; }),
    });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'tell me about the cars', last:true }));
    // Caller barges in before the LLM answered:
    a.handleMessage(JSON.stringify({ type:'interrupt', utteranceUntilInterrupt:'', durationUntilInterruptMs:100 }));
    resolveConverse('Here is a long-winded answer nobody asked to finish');
    await new Promise(r => setTimeout(r, 0));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/choose your own car/i);
  });

  it('does not create an older setup host turn when a newer interim arrives', async () => {
    const room=fakeRoom();const said:string[]=[];let release!:(value:string)=>void;
    const delayed=new Promise<string>(resolve=>{release=resolve;});
    const adapter=new ConversationRelayAdapter({findOrCreateRoom:()=>room,phaseOf:()=> 'car_select',say:text=>said.push(text),converse:async()=>delayed});
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-new-partial',customParameters:{roomCode:'4821'}}));
    said.length=0;
    adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'which car is fastest?',last:true}));
    adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'actually the',last:false}));
    release('Choose the second car.');await Promise.resolve();await Promise.resolve();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/choose your own car/i);
  });

  it.each([
    ['en-US','car_select',/choose your own car.*name or number/i],
    ['pt-BR','map_select',/vote na sua própria pista.*nome ou número/i],
  ] as const)('uses scripted %s menu guidance when the host returns nothing', async (locale,phase,expected) => {
    const room=fakeRoom();const said:string[]=[];
    const adapter=new ConversationRelayAdapter({findOrCreateRoom:()=>room,phaseOf:()=>phase,say:text=>said.push(text),converse:async()=>null});
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-fallback',customParameters:{roomCode:'4821',commandLocale:locale}}));
    said.length=0;adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'not a valid choice',last:true}));
    await Promise.resolve();await Promise.resolve();
    expect(said.join(' ')).toMatch(expected);
  });

  it('uses named lobby guidance after deterministic name capture updates the room', async () => {
    const room=fakeRoom();const said:string[]=[];
    const adapter=new ConversationRelayAdapter({
      findOrCreateRoom:()=>room,phaseOf:()=> 'lobby',hasPlayerName:()=>true,
      say:text=>said.push(text),converse:async()=>null,
    });
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-named-fallback',customParameters:{roomCode:'4821'}}));
    said.length=0;adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'what now exactly?',last:true}));
    await Promise.resolve();await Promise.resolve();
    expect(said.join(' ')).toMatch(/either racer.*say start/i);
    expect(said.join(' ')).not.toMatch(/say your name/i);
  });

  it('does not reinterpret a delayed setup final after the room changes phase',()=>{
    const room=fakeRoom(),said:string[]=[],handled:string[]=[];let phase='car_select';
    const adapter=new ConversationRelayAdapter({
      findOrCreateRoom:()=>room,phaseOf:()=>phase,say:text=>said.push(text),
      handleSetupUtterance:(_room,_player,utterance)=>{handled.push(utterance);return'Selected.';},
    });
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-stale-setup',customParameters:{roomCode:'4821'}}));
    said.length=0;
    adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'one',last:false}));
    phase='map_select';
    adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'one',last:true}));
    expect(handled).toEqual([]);
    expect(said.join(' ')).toMatch(/track/i);
  });

  it('does not reinterpret a duplicate final-only setup choice in the next phase',()=>{
    const room=fakeRoom(),handled:string[]=[];let phase='car_select';
    const adapter=new ConversationRelayAdapter({
      findOrCreateRoom:()=>room,phaseOf:()=>phase,
      handleSetupUtterance:(_room,_player,utterance)=>{handled.push(`${phase}:${utterance}`);return'Selected.';},
    });
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-final-only',customParameters:{roomCode:'4821'}}));
    adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'one',last:true}));
    phase='map_select';
    adapter.onGameEvent({kind:'enter_map_select'});
    adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'one',last:true}));
    expect(handled).toEqual(['car_select:one']);
  });

  it('deduplicates an identical final command repeated by Relay',()=>{
    const room=fakeRoom();
    const adapter=new ConversationRelayAdapter({findOrCreateRoom:()=>room,phaseOf:()=> 'racing'});
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-duplicate-final',customParameters:{roomCode:'4821'}}));
    const final=JSON.stringify({type:'prompt',voicePrompt:'right',last:true});
    adapter.handleMessage(final);adapter.handleMessage(final);
    expect(room.applied.map(item=>item.intent)).toEqual(['MOVE_RIGHT']);
  });

  it('throttles commentary by elapsed time rather than number of events', () => {
    vi.useFakeTimers();
    try {
      const room=fakeRoom();const said:string[]=[];
      const adapter=new ConversationRelayAdapter({findOrCreateRoom:()=>room,say:text=>said.push(text)});
      adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-throttle',customParameters:{roomCode:'4821'}}));
      said.length=0;vi.setSystemTime(1_000);
      adapter.onGameEvent({kind:'hit_streak',playerId:'p1',name:'Ada',count:3});
      vi.advanceTimersByTime(2_001);
      adapter.onGameEvent({kind:'fell_to_last',playerId:'p1',name:'Ada'});
      expect(said).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('during a RACE, uses the fast command path (does NOT call converse)', async () => {
    const room = fakeRoom(); let conversed = false;
    const a = new ConversationRelayAdapter({
      findOrCreateRoom: () => room,
      phaseOf: () => 'racing',
      converse: async () => { conversed = true; return 'chat'; },
    });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:true }));
    await new Promise(r => setTimeout(r, 0));
    expect(conversed).toBe(false);
    expect(room.applied).toEqual([{ id:'p1', intent:'MOVE_LEFT' }]);
  });

  it('answers a concise mid-race question when no driving intent is present', async () => {
    const room=fakeRoom();const said:string[]=[];const utterances:string[]=[];
    const adapter=new ConversationRelayAdapter({
      findOrCreateRoom:()=>room,phaseOf:()=> 'racing',say:text=>said.push(text),
      converse:async(_code,_id,utterance)=>{utterances.push(utterance);return 'You are in first place.';},
    });
    adapter.handleMessage(JSON.stringify({type:'setup',callSid:'CA-race-question',customParameters:{roomCode:'4821'}}));
    said.length=0;adapter.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'what place am I?',last:true}));
    await Promise.resolve();await Promise.resolve();
    expect(utterances).toEqual(['what place am I?']);
    expect(said).toEqual(['You are in first place.']);
    expect(room.applied).toEqual([]);
  });

  it('during a RACE, handles a burst of spoken commands in one utterance', () => {
    const room = fakeRoom();
    const a = new ConversationRelayAdapter({
      findOrCreateRoom: () => room,
      phaseOf: () => 'racing',
      converse: async () => 'should not be called',
    });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left right boost nitro brake', last:true }));

    expect(room.applied).toEqual([
      { id:'p1', intent:'MOVE_LEFT' },
      { id:'p1', intent:'MOVE_RIGHT' },
      { id:'p1', intent:'BOOST' },
      { id:'p1', intent:'USE_POWER' },
      { id:'p1', intent:'BRAKE' },
    ]);
  });

  it('resolves commandLocale and localizes Portuguese commands, greeting, and event lines', () => {
    const room = fakeRoom(); const said: string[] = [];
    const a = new ConversationRelayAdapter({
      findOrCreateRoom: () => room,
      say: text => said.push(text),
      phaseOf: () => 'racing',
    });
    a.handleMessage(JSON.stringify({
      type: 'setup', callSid: 'CA1',
      customParameters: { roomCode: '4821', commandLocale: 'pt_BR' },
    }));
    expect(a.locale).toBe('pt-BR');
    expect(said.join(' ')).toMatch(/voz|nome/i);

    said.length = 0;
    a.handleMessage(JSON.stringify({
      type: 'prompt', voicePrompt: 'esquerda direita acelerar nitro frear', last: true,
    }));
    a.onGameEvent({ kind: 'go' });

    expect(room.applied.map(entry => entry.intent)).toEqual([
      'MOVE_LEFT', 'MOVE_RIGHT', 'BOOST', 'USE_POWER', 'BRAKE',
    ]);
    expect(said).toEqual(['Vai!']);
    said.length = 0;
    a.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'ajuda', last: true }));
    expect(said.join(' ')).toMatch(/esquerda.*direita.*acelerar.*frear.*nitro/i);
  });

  it('never converses on setup transcripts, including final speech', async () => {
    const room = fakeRoom(); let calls = 0;
    const a = new ConversationRelayAdapter({
      findOrCreateRoom: () => room, phaseOf: () => 'lobby',
      converse: async () => { calls++; return null; },
    });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'start the', last:false }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'start the race', last:true }));
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toBe(0);
  });

  it('unregisters on close', () => {
    const room = fakeRoom(); let unreg = false;
    const a = new ConversationRelayAdapter({
      findOrCreateRoom: () => room, register: () => {}, unregister: () => { unreg = true; } });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleClose();
    expect(unreg).toBe(true);
  });
});
