// The Voice Monsters CALL session — binds a Conversation Relay caller to a battle room, routes their
// spoken turns (via the voice matcher + LLM host) into battle actions, and speaks commentary from
// battle events. Tested against a fake battle backend + fake LLM (no WS/Twilio).
import { describe, it, expect } from 'vitest';
import { BattleVoiceSession, parseSpokenName, isAdvanceWord, type BattleVoiceDeps, type BattleVoiceSnapshot } from '../server/battle-voice';
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
    for (const w of ['start', 'go', 'begin', 'battle', 'fight', "let's go", 'ready', 'next', 'rematch', 'again', 'run it back']) {
      expect(isAdvanceWord(w)).toBe(true);
    }
  });
  it('does not fire on unrelated speech', () => {
    expect(isAdvanceWord('Sparkmouse')).toBe(false);
    expect(isAdvanceWord('what is this?')).toBe(false);
  });
});

// A fake battle backend capturing the actions the session drives.
function battleSnap(over: Partial<BattleVoiceSnapshot> = {}): BattleVoiceSnapshot {
  return {
    phase: 'monster_select',
    mySide: 'a',
    monsterNames: ['Sparkmouse', 'Embertail', 'Shellback'],
    myName: null,
    myMonsterId: null,
    myMonsterName: null,
    myMonsterType: null,
    canStartBattle: false,
    foeName: null,
    foeMonsterName: null,
    foeMonsterType: null,
    myHp: null,
    myMaxHp: null,
    foeHp: null,
    foeMaxHp: null,
    myPotions: 2,
    turn: null,
    activeSide: null,
    activeMenu: 'root',
    whoseTurn: null,
    myMoves: [],
    winnerName: null,
    ...over,
  };
}

function fakeDeps(over: Partial<BattleVoiceDeps> = {}): { deps: BattleVoiceDeps; log: string[]; said: string[] } {
  const log: string[] = [];
  const said: string[] = [];
  const deps: BattleVoiceDeps = {
    join: (code, name) => { log.push(`join ${code} ${name}`); return 'p1'; },
    leave: (code, id) => log.push(`leave ${code} ${id}`),
    setName: (_c, _id, n) => log.push(`name ${n}`),
    selectMonster: (_c, _id, m) => log.push(`monster ${m}`),
    openFight: (_c, _id) => log.push('openFight'),
    backMenu: (_c, _id) => log.push('backMenu'),
    chooseAction: (_c, _id, a) => log.push(`action ${JSON.stringify(a)}`),
    advance: (_c) => log.push('advance'),
    setTimer: (fn: () => void) => { fn(); },   // synchronous in tests → paced commentary drains at once
    say: (t) => said.push(t),
    snapshot: () => battleSnap(),
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

  it('tells a caller when the battle room is full or already in progress', () => {
    const { deps, said } = fakeDeps({ join: () => null });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    expect(s.boundPlayer).toBeNull();
    expect(said.some(t => /full|in progress|next round/i.test(t))).toBe(true);
  });

  it('greets new callers with Conversation Relay and simple voice-control instructions', () => {
    const { deps, said } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    const joined = said.join(' ').toLowerCase();
    expect(joined).toContain('conversation relay');
    expect(joined).toContain('voice controls');
    expect(joined).toMatch(/say start|pick a monster/);
    expect(joined).toMatch(/fight.*attack|guard.*item.*taunt/);
  });

  it('captures the caller name in the lobby BEFORE anything else (deterministic, no LLM)', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'lobby' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    said.length = 0;
    s.handleMessage(prompt("I'm Ada"));
    expect(log.some(l => l === 'name Ada')).toBe(true);          // name was set
    expect(said.some(t => /nice to meet you, ada/i.test(t))).toBe(true);   // confirmed + guided
  });

  it('does not capture a lobby advance phrase as the caller name', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'lobby', myName: null }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt("I'm ready"));

    expect(log).toContain('advance');
    expect(log.some(l => l === 'name Ready')).toBe(false);
  });

  it('a spoken monster name during select picks it (deterministic, no LLM)', () => {
    // A name is already set, so "Embertail" is treated as a monster pick, not a name.
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ myName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('Embertail'));
    expect(log.some(l => l === 'monster embertail')).toBe(true);
  });

  it('understands ordinal monster picks before cardinal words', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ myName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt('the second one'));

    expect(log).toContain('monster embertail');
  });

  it('does not mistake a spoken monster name for the caller name on monster select', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ myName: null }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt('Sparkmouse'));

    expect(log).toContain('monster sparkmouse');
    expect(log.some(l => l === 'name Sparkmouse')).toBe(false);
  });

  it('"start" advances the flow deterministically (no LLM) — lobby → select', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'lobby', monsterNames: ['Sparkmouse'], myName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('start'));
    expect(log.filter(l => l === 'advance').length).toBe(1);
  });

  it('"battle" in monster-select is REFUSED until a monster is picked (no LLM)', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({ monsterNames: ['Sparkmouse'], myName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.handleMessage(prompt('battle'));
    expect(log.some(l => l === 'advance')).toBe(false);      // did NOT advance
    expect(said.some(t => /pick a monster first/i.test(t))).toBe(true);
  });

  it('"battle" in monster-select waits when this caller picked but the other player has not', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        canStartBattle: false,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.handleMessage(prompt('battle'));

    expect(log.some(l => l === 'advance')).toBe(false);
    expect(said.some(t => /waiting for the other player/i.test(t))).toBe(true);
  });

  it('"battle" in monster-select advances when required monster picks are complete', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        canStartBattle: true,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt('battle'));

    expect(log.some(l => l === 'advance')).toBe(true);
  });

  it('"fight" in monster-select also starts when required monster picks are complete', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        canStartBattle: true,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt('fight'));

    expect(log.some(l => l === 'advance')).toBe(true);
  });

  it('a spoken battle action during battle commits it', async () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', monsterNames: ['Sparkmouse'],
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Galecoil', foeMonsterType: 'water', myHp: 40, myMaxHp: 70, foeHp: 55, foeMaxHp: 98,
        myPotions: 2, turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
        myMoves: [{ id: 'sparkmouse.jolt', name: 'Thunder Jolt' }, { id: 'sparkmouse.zap', name: 'Static Zap' }],
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('guard'));
    expect(log.some(l => l.includes('"kind":"guard"'))).toBe(true);
  });

  it('on the first turn, speaks a dramatic X-vs-Y intro + how-to-act recap', () => {
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', monsterNames: ['Sparkmouse'],
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Galecoil', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 98, foeMaxHp: 98,
        myPotions: 2, turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.onBattleEvent({ kind: 'turn_start', turn: 1 });
    expect(said.some(t => t.includes('Sparkmouse') && t.includes('Galecoil'))).toBe(true);   // X vs Y
    expect(said.some(t => /fight/i.test(t) && /guard|item|taunt/i.test(t))).toBe(true);        // how-to recap
  });

  it('on battle state start, tells the active caller they go first and includes the type matchup', () => {
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Shellback', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 82, foeMaxHp: 82,
        turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.onBattleStateChanged();

    expect(said.some(t => /sparkmouse.*shellback/i.test(t) && /electric.*water/i.test(t))).toBe(true);
    expect(said.some(t => /you go first|your turn/i.test(t))).toBe(true);
  });

  it('on battle state start, tells the waiting caller the other monster goes first', () => {
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', mySide: 'b', myName: 'Bo', myMonsterId: 'shellback', myMonsterName: 'Shellback', myMonsterType: 'water',
        foeMonsterName: 'Sparkmouse', foeMonsterType: 'electric', myHp: 82, myMaxHp: 82, foeHp: 70, foeMaxHp: 70,
        turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'foe',
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.onBattleStateChanged();

    expect(said.some(t => /sparkmouse goes first|wait for sparkmouse/i.test(t))).toBe(true);
  });

  it('saying FIGHT on your turn opens the server-synced fight menu and reads the four moves', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Shellback', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 82, foeMaxHp: 82,
        turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
        myMoves: [
          { id: 'sparkmouse.jolt', name: 'Thunder Jolt' },
          { id: 'sparkmouse.zap', name: 'Static Zap' },
          { id: 'sparkmouse.bite', name: 'Quick Bite' },
          { id: 'sparkmouse.tackle', name: 'Tackle' },
        ],
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.handleMessage(prompt('fight'));

    expect(log).toContain('openFight');
    expect(said.some(t => /thunder jolt/i.test(t) && /static zap/i.test(t))).toBe(true);
  });

  it('refuses an out-of-turn battle command with a wait cue instead of committing it', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', mySide: 'b', myName: 'Bo', myMonsterId: 'shellback', myMonsterName: 'Shellback', myMonsterType: 'water',
        foeMonsterName: 'Sparkmouse', foeMonsterType: 'electric', myHp: 82, myMaxHp: 82, foeHp: 70, foeMaxHp: 70,
        turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'foe',
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.handleMessage(prompt('guard'));

    expect(log.some(l => l.startsWith('action '))).toBe(false);
    expect(said.some(t => /wait for sparkmouse/i.test(t))).toBe(true);
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

  it('narrates a full turn\'s events IN ORDER on the paced clock (screen-sync)', () => {
    // The server hands the whole turn at once; the session must narrate move → super-effective in the
    // order they occurred (paced via setTimer), not scrambled or all-at-once with the wrong sequence.
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', monsterNames: ['Sparkmouse'],
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Galecoil', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 40, foeMaxHp: 98,
        myPotions: 2, turn: 0, activeSide: 'b', activeMenu: 'root', whoseTurn: 'foe',
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.onBattleEvent({ kind: 'move_used', by: 'a', moveId: 'x', moveName: 'Vine Lash' });
    s.onBattleEvent({ kind: 'effectiveness', on: 'b', multiplier: 2, label: "It's super effective!" });
    const moveIdx = said.findIndex(t => /vine lash/i.test(t));
    const effIdx = said.findIndex(t => /super|effective/i.test(t));
    expect(moveIdx).toBeGreaterThanOrEqual(0);
    expect(effIdx).toBeGreaterThan(moveIdx);   // effectiveness narrated AFTER the move that caused it
  });

  it('queues the next-turn cue until current attack commentary has finished', () => {
    let snap = battleSnap({
      phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
      foeMonsterName: 'Shellback', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 82, foeMaxHp: 82,
      turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
    });
    const timers: (() => void)[] = [];
    const { deps, said } = fakeDeps({
      snapshot: () => snap,
      setTimer: (fn: () => void) => { timers.push(fn); },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.onBattleEvent({ kind: 'move_used', by: 'a', moveId: 'sparkmouse.jolt', moveName: 'Thunder Jolt' });
    snap = { ...snap, turn: 1, activeSide: 'b', activeMenu: 'root', whoseTurn: 'foe' };
    s.onBattleStateChanged();

    expect(said.some(t => /thunder jolt/i.test(t))).toBe(true);
    expect(said.some(t => /wait for shellback/i.test(t))).toBe(false);

    timers.shift()?.();

    expect(said.some(t => /wait for shellback/i.test(t))).toBe(true);
  });

  it('does not accept the next battle command while attack commentary is still resolving', () => {
    let snap = battleSnap({
      phase: 'battle', myName: 'Bo', mySide: 'b', myMonsterId: 'shellback', myMonsterName: 'Shellback', myMonsterType: 'water',
      foeName: 'Ada', foeMonsterName: 'Sparkmouse', foeMonsterType: 'electric', myHp: 82, myMaxHp: 82, foeHp: 70, foeMaxHp: 70,
      turn: 1, activeSide: 'b', activeMenu: 'root', whoseTurn: 'me',
    });
    const timers: (() => void)[] = [];
    const { deps, log, said } = fakeDeps({
      snapshot: () => snap,
      setTimer: (fn: () => void) => { timers.push(fn); },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.onBattleEvent({ kind: 'move_used', by: 'a', moveId: 'sparkmouse.jolt', moveName: 'Thunder Jolt' });
    s.handleMessage(prompt('guard'));

    expect(log.some(l => l.startsWith('action '))).toBe(false);
    expect(said.some(t => /resolving the last move/i.test(t))).toBe(true);

    timers.shift()?.();
    snap = { ...snap, activeSide: 'b', whoseTurn: 'me' };
    s.handleMessage(prompt('guard'));
    expect(log.some(l => l.includes('"kind":"guard"'))).toBe(true);
  });

  it('announces the winner and loser when the battle ends', () => {
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'results', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeName: 'Bo', foeMonsterName: 'Embertail', foeMonsterType: 'fire', winnerName: 'Ada',
        turn: 3, activeSide: null, activeMenu: 'root', whoseTurn: null,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.onBattleEvent({ kind: 'battle_over', winner: 'a', winnerName: 'Ada' });

    const line = said.join(' ');
    expect(line).toMatch(/Ada wins/i);
    expect(line).toMatch(/Bo loses/i);
    expect(line).toMatch(/Sparkmouse/i);
    expect(line).toMatch(/Embertail/i);
    expect(line).toMatch(/rematch/i);
  });

  it('names monsters correctly for a side-b caller (event sides are absolute)', () => {
    // A 2nd caller is side 'b': their snapshot's my/foe is relative, but events carry absolute sides.
    // A super-effective hit on side 'a' (the side-b caller's FOE) must name the FOE, not themselves.
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', mySide: 'b', monsterNames: ['Sparkmouse'],
        myName: 'Bo', myMonsterId: 'galecoil', myMonsterName: 'Galecoil', myMonsterType: 'water',
        foeMonsterName: 'Sparkmouse', foeMonsterType: 'electric', myHp: 50, myMaxHp: 98, foeHp: 30, foeMaxHp: 70,
        myPotions: 2, turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'foe',
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
