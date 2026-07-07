import { describe, it, expect } from 'vitest';
import { parseCrMessage } from '../server/conversation-relay';
import { ConversationRelayAdapter } from '../server/conversation-relay';
import type { Intent } from '../shared/types';

function fakeRoom() {
  const applied: { id:string; intent:Intent }[] = [];
  let n = 0;
  return {
    applied,
    addPlayer: (_name:string) => ({ playerId:`p${++n}`, lane:n-1 }),
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

  it('ignores prompts before setup (no room bound)', () => {
    const room = fakeRoom();
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:true }));
    expect(room.applied).toHaveLength(0);
  });

  it('debounces repeated interim frames of the same command, resetting on last:true', () => {
    const room = fakeRoom();
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    // three interim frames of the same word -> fires once
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'le',   last:false }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:false }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:false }));
    expect(room.applied).toEqual([{ id:'p1', intent:'MOVE_LEFT' }]);
    // last:true resets; the same word in a NEW utterance fires again
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:true }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left', last:false }));
    expect(room.applied).toEqual([
      { id:'p1', intent:'MOVE_LEFT' },
      { id:'p1', intent:'MOVE_LEFT' },
    ]);
  });

  it('fires the CORRECTED command when ASR revises a partial (left → right)', () => {
    // The real dropped-command bug: Deepgram hears "left", then corrects the SAME utterance to
    // "right". Position-slicing dropped the correction; content dedup must fire RIGHT.
    const room = fakeRoom();
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'left',  last:false }));  // fires LEFT
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'right', last:true }));   // corrected → RIGHT
    expect(room.applied).toEqual([
      { id:'p1', intent:'MOVE_LEFT' },
      { id:'p1', intent:'MOVE_RIGHT' },
    ]);
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

  it('removes the player on close', () => {
    let removed: string | null = null;
    const room = { addPlayer: () => ({ playerId:'p1', lane:0 }),
      applyIntent: () => {}, removePlayer: (id:string) => { removed = id; } };
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleClose();
    expect(removed).toBe('p1');
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

  it('speaks countdown + short go events to the caller', () => {
    const room = fakeRoom(); const said: string[] = [];
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room, say: (t) => said.push(t) });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;   // drop the greeting
    a.onGameEvent({ kind:'countdown', n:3 });
    a.onGameEvent({ kind:'go' });
    expect(said).toHaveLength(2);
    expect(said[0]).toBe('3');
    expect(said[1]).toBe('Go!');
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
    await new Promise(r => setTimeout(r, 0));

    expect(said.join(' ').toLowerCase()).toMatch(/first place|congrat|won/);
    expect(said.join(' ').toLowerCase()).toContain('leaderboard');
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

  it('allows the same menu prompt again after a later phase cycle', () => {
    const room = fakeRoom(); const said: string[] = [];
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room, say: (t) => said.push(t) });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;

    a.onGameEvent({ kind:'enter_car_select' });
    for (let i = 0; i < 25; i++) a.onGameEvent({ kind:'countdown', n:3 });
    a.onGameEvent({ kind:'enter_car_select' });

    expect(said.filter(s => /car|ride|machine/i.test(s))).toHaveLength(2);
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

  // ── Conversational routing (menus → LLM host; race → fast commands) ─────────────────────────────
  it('routes a MENU utterance to converse() and speaks the reply (not the command path)', async () => {
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
    expect(conversed).toBe('which car is fastest?');
    expect(said).toContain('The McLaren is fastest!');
    expect(room.applied).toHaveLength(0);        // menu chat must NOT drive the car
  });

  it('DROPS an in-flight LLM reply if the caller barges in (interrupt) before it resolves', async () => {
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
    expect(said).toHaveLength(0);   // the stale reply was dropped
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

  it('only converses on the FINAL transcript, not interim partials', async () => {
    const room = fakeRoom(); let calls = 0;
    const a = new ConversationRelayAdapter({
      findOrCreateRoom: () => room, phaseOf: () => 'lobby',
      converse: async () => { calls++; return null; },
    });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'start the', last:false }));
    a.handleMessage(JSON.stringify({ type:'prompt', voicePrompt:'start the race', last:true }));
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toBe(1);
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
