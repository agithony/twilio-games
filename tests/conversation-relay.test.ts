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
  it('returns unknown for unrecognized or malformed input', () => {
    expect(parseCrMessage('not json').type).toBe('unknown');
    expect(parseCrMessage(JSON.stringify({ type:'interrupt' })).type).toBe('unknown');
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
    // Greeting is sent as MULTIPLE sentences (separate utterances → natural TTS pauses).
    expect(said.length).toBeGreaterThan(1);
    expect(said.join(' ').toLowerCase()).toContain('voice racer');
    expect(said.join(' ').toLowerCase()).toMatch(/left|right|boost/);
    expect(a.boundPlayerId).toBe('p1');
  });

  it('speaks countdown + go events to the caller', () => {
    const room = fakeRoom(); const said: string[] = [];
    const a = new ConversationRelayAdapter({ findOrCreateRoom: () => room, say: (t) => said.push(t) });
    a.handleMessage(JSON.stringify({ type:'setup', callSid:'CA1', customParameters:{ roomCode:'4821' } }));
    said.length = 0;   // drop the greeting
    a.onGameEvent({ kind:'countdown', n:3 });
    a.onGameEvent({ kind:'go' });
    expect(said).toEqual(['3...', 'Go go go!']);
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
