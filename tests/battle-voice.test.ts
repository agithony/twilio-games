// The Voice Monsters CALL session — binds a Conversation Relay caller to a battle room, routes their
// spoken turns (via the voice matcher + LLM host) into battle actions, and speaks commentary from
// battle events. Tested against a fake battle backend + fake LLM (no WS/Twilio).
import { describe, it, expect } from 'vitest';
import { BattleVoiceSession, parseSpokenName, isAdvanceWord, type BattleVoiceDeps } from '../server/battle-voice';
import type { BattleEvent } from '../shared/battle-world';

describe('parseSpokenName', () => {
  it('extracts a name from common phrasings', () => {
    expect(parseSpokenName("I'm Ada")).toBe('Ada');
    expect(parseSpokenName('my name is rex')).toBe('Rex');
    expect(parseSpokenName('this is Bo')).toBe('Bo');
    expect(parseSpokenName('Ada')).toBe('Ada');
    expect(parseSpokenName('call me Max')).toBe('Max');
  });
  it('rejects questions + game commands (so they are not taken as a name)', () => {
    expect(parseSpokenName('start')).toBeNull();
    expect(parseSpokenName('which monster is best?')).toBeNull();
    expect(parseSpokenName('what do I do?')).toBeNull();
    expect(parseSpokenName('')).toBeNull();
  });
});

describe('isAdvanceWord', () => {
  it('recognizes the ways a caller says "move forward"', () => {
    for (const w of ['start', 'go', 'begin', 'battle', "let's go", 'ready', 'next', 'rematch', 'again', 'run it back']) {
      expect(isAdvanceWord(w)).toBe(true);
    }
  });
  it('does not fire on unrelated speech', () => {
    expect(isAdvanceWord('Sparkmouse')).toBe(false);
    expect(isAdvanceWord('what is this?')).toBe(false);
  });
});

// A fake battle backend capturing the actions the session drives.
function fakeDeps(over: Partial<BattleVoiceDeps> = {}): { deps: BattleVoiceDeps; log: string[]; said: string[] } {
  const log: string[] = [];
  const said: string[] = [];
  const deps: BattleVoiceDeps = {
    join: (code, name) => { log.push(`join ${code} ${name}`); return 'p1'; },
    leave: (code, id) => log.push(`leave ${code} ${id}`),
    setName: (_c, _id, n) => log.push(`name ${n}`),
    selectMonster: (_c, _id, m) => log.push(`monster ${m}`),
    chooseAction: (_c, _id, a) => log.push(`action ${JSON.stringify(a)}`),
    advance: (_c) => log.push('advance'),
    say: (t) => said.push(t),
    snapshot: () => ({
      phase: 'monster_select',
      mySide: 'a',
      monsterNames: ['Sparkmouse', 'Embertail', 'Shellback'],
      myName: null, myMonsterId: null, myMonsterName: null,
      foeMonsterName: null, myHp: null, myMaxHp: null, foeHp: null, foeMaxHp: null,
      myPotions: 2, whoseTurn: null, myMoves: [], winnerName: null,
    }),
    converse: async () => null,   // LLM off by default → scripted/deterministic paths
    ...over,
  };
  return { deps, log, said };
}

const setup = (code = '4821') => JSON.stringify({ type: 'setup', callSid: 'CA1', customParameters: { roomCode: code } });
const prompt = (text: string, last = true) => JSON.stringify({ type: 'prompt', voicePrompt: text, last });

describe('BattleVoiceSession', () => {
  it('binds the caller to the room on setup + greets', () => {
    const { deps, log, said } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    expect(log.some(l => l.startsWith('join 4821'))).toBe(true);
    expect(said.length).toBeGreaterThan(0);   // greeting spoken
  });

  it('captures the caller name in the lobby BEFORE anything else (deterministic, no LLM)', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => ({
        phase: 'lobby', mySide: 'a', monsterNames: ['Sparkmouse', 'Embertail', 'Shellback'],
        myName: null, myMonsterId: null, myMonsterName: null,
        foeMonsterName: null, myHp: null, myMaxHp: null, foeHp: null, foeMaxHp: null,
        myPotions: 2, whoseTurn: null, myMoves: [], winnerName: null,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    said.length = 0;
    s.handleMessage(prompt("I'm Ada"));
    expect(log.some(l => l === 'name Ada')).toBe(true);          // name was set
    expect(said.some(t => /nice to meet you, ada/i.test(t))).toBe(true);   // confirmed + guided
  });

  it('a spoken monster name during select picks it (deterministic, no LLM)', () => {
    // A name is already set, so "Embertail" is treated as a monster pick, not a name.
    const { deps, log } = fakeDeps({
      snapshot: () => ({
        phase: 'monster_select', mySide: 'a', monsterNames: ['Sparkmouse', 'Embertail', 'Shellback'],
        myName: 'Ada', myMonsterId: null, myMonsterName: null,
        foeMonsterName: null, myHp: null, myMaxHp: null, foeHp: null, foeMaxHp: null,
        myPotions: 2, whoseTurn: null, myMoves: [], winnerName: null,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('Embertail'));
    expect(log.some(l => l === 'monster embertail')).toBe(true);
  });

  it('"start" advances the flow deterministically (no LLM) — lobby → select', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => ({
        phase: 'lobby', mySide: 'a', monsterNames: ['Sparkmouse'],
        myName: 'Ada', myMonsterId: null, myMonsterName: null,
        foeMonsterName: null, myHp: null, myMaxHp: null, foeHp: null, foeMaxHp: null,
        myPotions: 2, whoseTurn: null, myMoves: [], winnerName: null,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('start'));
    expect(log.filter(l => l === 'advance').length).toBe(1);
  });

  it('"battle" in monster-select is REFUSED until a monster is picked (no LLM)', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => ({
        phase: 'monster_select', mySide: 'a', monsterNames: ['Sparkmouse'],
        myName: 'Ada', myMonsterId: null, myMonsterName: null,
        foeMonsterName: null, myHp: null, myMaxHp: null, foeHp: null, foeMaxHp: null,
        myPotions: 2, whoseTurn: null, myMoves: [], winnerName: null,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.handleMessage(prompt('battle'));
    expect(log.some(l => l === 'advance')).toBe(false);      // did NOT advance
    expect(said.some(t => /pick a monster first/i.test(t))).toBe(true);
  });

  it('a spoken battle action during battle commits it', async () => {
    const { deps, log } = fakeDeps({
      snapshot: () => ({
        phase: 'battle', mySide: 'a', monsterNames: ['Sparkmouse'],
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse',
        foeMonsterName: 'Galecoil', myHp: 40, myMaxHp: 70, foeHp: 55, foeMaxHp: 98,
        myPotions: 2, whoseTurn: 'me',
        myMoves: [{ id: 'sparkmouse.jolt', name: 'Thunder Jolt' }, { id: 'sparkmouse.zap', name: 'Static Zap' }],
        winnerName: null,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('guard'));
    expect(log.some(l => l.includes('"kind":"guard"'))).toBe(true);
  });

  it('speaks commentary for a battle event (super-effective)', () => {
    const { deps, said } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    said.length = 0;   // clear greeting
    const ev: BattleEvent = { kind: 'effectiveness', on: 'b', multiplier: 2, label: "It's super effective!" };
    s.onBattleEvent(ev);
    expect(said.length).toBe(1);
    expect(said[0]!.toLowerCase()).toMatch(/super|effective|weak/);
  });

  it('names monsters correctly for a side-b caller (event sides are absolute)', () => {
    // A 2nd caller is side 'b': their snapshot's my/foe is relative, but events carry absolute sides.
    // A super-effective hit on side 'a' (the side-b caller's FOE) must name the FOE, not themselves.
    const { deps, said } = fakeDeps({
      snapshot: () => ({
        phase: 'battle', mySide: 'b', monsterNames: ['Sparkmouse'],
        myName: 'Bo', myMonsterId: 'galecoil', myMonsterName: 'Galecoil',
        foeMonsterName: 'Sparkmouse', myHp: 50, myMaxHp: 98, foeHp: 30, foeMaxHp: 70,
        myPotions: 2, whoseTurn: 'foe', myMoves: [], winnerName: null,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    said.length = 0;
    // move_used by side 'a' (the foe, Sparkmouse) → the line must name Sparkmouse, not Galecoil.
    s.onBattleEvent({ kind: 'move_used', by: 'a', moveId: 'sparkmouse.jolt', moveName: 'Thunder Jolt' });
    expect(said[0]).toContain('Sparkmouse');
    expect(said[0]).not.toContain('Galecoil');
  });

  it('stays silent (no crash) on an unbound event before setup', () => {
    const { deps, said } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.onBattleEvent({ kind: 'faint', side: 'b', monsterName: 'Galecoil' });
    expect(said.length).toBe(0);
  });

  it('removes the caller from the room on close', () => {
    const { deps, log } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    s.handleClose();
    expect(log.some(l => l.startsWith('leave 4821'))).toBe(true);
  });
});
