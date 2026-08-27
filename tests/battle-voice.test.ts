// The Voice Monsters CALL session — binds a Conversation Relay caller to a battle room, routes their
// spoken turns (via the voice matcher + LLM host) into battle actions, and speaks commentary from
// battle events. Tested against a fake battle backend + fake LLM (no WS/Twilio).
import { describe, it, expect, vi } from 'vitest';
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
    canAdvanceLobby: true,
    canStartBattle: false,
    canRematch: true,
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
    participating: true,
    activeMenu: 'root',
    whoseTurn: null,
    myMoves: [],
    winnerName: null,
    ...over,
  };
}

function activeBattle(over: Partial<BattleVoiceSnapshot> = {}): BattleVoiceSnapshot {
  return battleSnap({
    phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
    foeName: 'Bo', foeMonsterName: 'Shellback', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 82, foeMaxHp: 82,
    turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
    myMoves: [
      { id: 'sparkmouse.jolt', name: 'Thunder Jolt' },
      { id: 'sparkmouse.zap', name: 'Static Zap' },
      { id: 'sparkmouse.bite', name: 'Quick Bite' },
      { id: 'sparkmouse.tackle', name: 'Tackle' },
    ],
    ...over,
  });
}

function fakeDeps(over: Partial<BattleVoiceDeps> = {}): { deps: BattleVoiceDeps; log: string[]; said: string[] } {
  const log: string[] = [];
  const said: string[] = [];
  const deps: BattleVoiceDeps = {
    join: (code, name) => { log.push(`join ${code} ${name}`); return { playerId: 'p1', resumed: false }; },
    leave: (code, id) => log.push(`leave ${code} ${id}`),
    setName: (_c, _id, n) => log.push(`name ${n}`),
    selectMonster: (_c, _id, m) => log.push(`monster ${m}`),
    openFight: (_c, _id) => log.push('openFight'),
    backMenu: (_c, _id) => log.push('backMenu'),
    chooseAction: (_c, _id, a) => log.push(`action ${JSON.stringify(a)}`),
    advance: (_c, _id) => { log.push('advance'); return true; },
    setTimer: (fn: () => void) => { fn(); },   // synchronous in tests → paced commentary drains at once
    say: (t) => said.push(t),
    snapshot: () => battleSnap(),
    converse: async () => null,   // LLM off by default → scripted/deterministic paths
    ...over,
  };
  return { deps, log, said };
}

const setup = (code = '4821', commandLocale?: string) => JSON.stringify({
  type: 'setup', callSid: 'CA1',
  customParameters: { roomCode: code, ...(commandLocale ? { commandLocale } : {}) },
});
const prompt = (text: string, last = true) => JSON.stringify({ type: 'prompt', voicePrompt: text, last });
const dtmf = (digit: string) => JSON.stringify({ type: 'dtmf', digit });

describe('BattleVoiceSession', () => {
  it('binds the caller to the room on setup + greets', () => {
    const { deps, log, said } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    expect(log.some(l => l.startsWith('join 4821'))).toBe(true);
    expect(said.length).toBeGreaterThan(0);   // greeting spoken
  });

  it('uses an authoritative station name without asking for it again', () => {
    const {deps,log,said}=fakeDeps({snapshot:()=>battleSnap({phase:'lobby',myName:'Ada'})});
    const session=new BattleVoiceSession(deps);session.setAuthoritativeName('Ada');session.handleMessage(setup());
    expect(log).toContain('join 4821 Ada');
    const arrival=said.join(' ').toLowerCase();
    expect(arrival).toContain('ada');
    expect(arrival).toContain('voice monsters');
    expect(arrival).toMatch(/fight|attack/);
    expect(arrival).toMatch(/say next.*choose monsters/i);
    expect(arrival).not.toContain('your name');
    session.handleMessage(prompt('call me Mallory'));
    expect(log).not.toContain('name Mallory');
  });

  it('keeps a station caller without a profile name in name capture', () => {
    let confirmedArg: boolean | undefined;
    let myName: string | null = null;
    let phase: BattleVoiceSnapshot['phase'] = 'lobby';
    const { deps, log, said } = fakeDeps({
      join: (_code, _name, _callSid, _side, _expected, confirmed) => {
        confirmedArg = confirmed;
        return { playerId: 'p1', resumed: false };
      },
      setName: (_code, _id, name) => { log.push(`name ${name}`); myName = name; },
      snapshot: () => battleSnap({ phase, myName }),
    });
    const session = new BattleVoiceSession(deps);
    session.setStationManaged(true);
    session.setStationAssignment(0, 1);
    session.handleMessage(setup());
    expect(confirmedArg).toBe(false);
    const beforeName = said.length;
    session.handleMessage(prompt('Ada'));
    expect(log).toContain('name Ada');
    expect(said.slice(beforeName).join(' ')).not.toMatch(/what'?s your name/i);
  });

  it('does not reinterpret a delayed duplicate name as a monster selection', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      let myName: string | null = null;
      let phase: BattleVoiceSnapshot['phase'] = 'lobby';
      const { deps, log } = fakeDeps({
        setName: (_code, _id, name) => { log.push(`name ${name}`); myName = name; },
        snapshot: () => battleSnap({ phase, myName }),
      });
      const session = new BattleVoiceSession(deps);
      session.handleMessage(setup());
      session.handleMessage(prompt('Sparkmouse'));
      vi.advanceTimersByTime(3_000);
      session.handleMessage(prompt('Sparkmouse'));
      expect(log).toContain('name Sparkmouse');
      expect(log.some(entry => entry.startsWith('monster '))).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('does not cancel an in-flight host response when Relay repeats the final frame', async () => {
    let resolveReply!: (value: string | null) => void;
    const { deps, said } = fakeDeps({
      snapshot: () => activeBattle(),
      converse: () => new Promise(resolve => { resolveReply = resolve; }),
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());said.length=0;
    session.handleMessage(prompt('tell me a joke'));
    session.handleMessage(prompt('tell me a joke'));
    resolveReply('Arena joke delivered.');
    await Promise.resolve();await Promise.resolve();
    expect(said).toContain('Arena joke delivered.');
  });

  it('gives lobby guidance when rematch is waiting on another caller name', () => {
    let phase:BattleVoiceSnapshot['phase']='results';
    const {deps,said}=fakeDeps({
      snapshot:()=>battleSnap({phase,myName:'Ada',winnerName:'Ada',canRematch:true}),
      advance:()=>{phase='lobby';return true;},
    });
    const session=new BattleVoiceSession(deps);session.handleMessage(setup());said.length=0;
    session.handleMessage(prompt('rematch'));
    expect(said.join(' ')).toMatch(/every player.*say next/i);
    expect(said.join(' ')).not.toMatch(/pick your monster/i);
  });

  it('accepts a repeated choice when another caller caused the phase transition', () => {
    let phase: BattleVoiceSnapshot['phase'] = 'lobby';
    const { deps, log } = fakeDeps({ snapshot: () => battleSnap({ phase, myName: 'Ada' }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    session.handleMessage(prompt('Sparkmouse'));
    phase = 'monster_select';
    session.handleMessage(prompt('Sparkmouse'));
    expect(log).toContain('monster sparkmouse');
  });

  it('ignores a repeated setup frame on the same live session', () => {
    const { deps, log, said } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    said.length = 0;

    s.handleMessage(setup('4821'));

    expect(log.filter(l => l.startsWith('join 4821'))).toHaveLength(1);
    expect(said).toHaveLength(0);
  });

  it('resumes an existing battle without repeating name or monster onboarding', () => {
    const { deps, said } = fakeDeps({
      join: () => ({ playerId: 'p1', resumed: true }),
      snapshot: () => battleSnap({
        phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Shellback', foeMonsterType: 'water', myHp: 51, myMaxHp: 70, foeHp: 62, foeMaxHp: 82,
        turn: 3, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
      }),
    });
    const s = new BattleVoiceSession(deps);

    s.handleMessage(setup('4821'));

    const speech = said.join(' ');
    expect(speech).toMatch(/back in the battle/i);
    expect(speech).toMatch(/your turn/i);
    expect(speech).not.toMatch(/what'?s your name|pick a monster/i);
  });

  it('welcomes a late result-screen caller into the next round without normal onboarding', () => {
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'results', myName: null, myMonsterId: null, myMonsterName: null, winnerName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    expect(said.join(' ')).toMatch(/battle just ended|next round/i);
    expect(said.join(' ')).toMatch(/what'?s your name/i);
    expect(said.join(' ')).not.toMatch(/pick a monster/i);
  });

  it('queues a late caller behind an active battle instead of pretending they are fighting', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'battle', participating: false, myName: null, myMonsterId: null, myMonsterName: null, whoseTurn: null }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    expect(said.join(' ')).toMatch(/battle is already in progress|next round/i);

    said.length = 0;
    s.handleMessage(prompt('Bo'));
    expect(log).toContain('name Bo');
    s.handleMessage(prompt('fight'));
    expect(log.some(l => l.startsWith('action '))).toBe(false);
    expect(said.join(' ')).toMatch(/current battle.*in progress|next round/i);
    said.length=0;
    s.onBattleEvent({kind:'move_used',by:'a',moveId:'sparkmouse.jolt',moveName:'Thunder Jolt'});
    s.onBattleStateChanged();
    expect(said).toHaveLength(0);
  });

  it('tells a caller when the battle room is full or already in progress', () => {
    const { deps, said } = fakeDeps({ join: () => null });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    expect(s.boundPlayer).toBeNull();
    expect(said.some(t => /full|in progress|next round/i.test(t))).toBe(true);
  });

  it('greets new callers with Conversation Relay and simple voice-control instructions', () => {
    const { deps, said } = fakeDeps({ snapshot: () => battleSnap({ phase: 'lobby' }) });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    expect(said).toHaveLength(3);
    expect(said[0]).toMatch(/welcome to voice monsters/i);
    expect(said[1]).toMatch(/conversation relay/i);
    expect(said[2]).toMatch(/what.*name/i);
    s.handleMessage(prompt("I'm Ada"));
    expect(said.slice(3).join(' ')).toMatch(/nice to meet.*before you start.*say fight.*say next.*choose monsters/i);
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

    expect(log).not.toContain('advance');
    expect(log.some(l => l === 'name Ready')).toBe(false);
  });

  it('a spoken monster name during select picks it (deterministic, no LLM)', () => {
    // A name is already set, so "Embertail" is treated as a monster pick, not a name.
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({ myName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('Embertail'));
    expect(log.some(l => l === 'monster embertail')).toBe(true);
    expect(said.some(line=>/Locked in.*Embertail/i.test(line))).toBe(true);
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

  it('finishes requested name capture before interpreting a matching monster name', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ myName: null }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt('Sparkmouse'));

    expect(log).not.toContain('monster sparkmouse');
    expect(log.some(l => l === 'name Sparkmouse')).toBe(true);
  });

  it('does not treat a descriptive monster phrase as option one or as the caller name', async () => {
    const { deps, log, said } = fakeDeps({ snapshot: () => battleSnap({ myName: null }) });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    said.length = 0;

    s.handleMessage(prompt('the fire one'));
    await Promise.resolve();

    expect(log.some(l => l.startsWith('monster '))).toBe(false);
    expect(log.some(l => l.startsWith('name '))).toBe(false);
    expect(said.join(' ')).toMatch(/what.*name|name.*challenger/i);
  });

  it.each([
    { label: 'English named lobby', locale: undefined, snap: battleSnap({ phase: 'lobby', myName: 'Ada' }), utterance: 'what now?', expected: /say next.*choose monsters/i },
    { label: 'Portuguese unnamed lobby', locale: 'pt-BR', snap: battleSnap({ phase: 'lobby', myName: null }), utterance: 'o que devo fazer agora?', expected: /primeiro nome.*Ana/i },
    { label: 'English monster select', locale: undefined, snap: battleSnap({ myName: 'Ada' }), utterance: 'the fiery-looking one', expected: /own monster.*name or number/i },
    { label: 'Portuguese monster select', locale: 'pt-BR', snap: battleSnap({ myName: 'Ada' }), utterance: 'quero o monstro de fogo', expected: /próprio monstro.*nome ou número/i },
    { label: 'English battle root', locale: undefined, snap: activeBattle(), utterance: 'something else', expected: /fight.*guard.*item.*taunt/i },
    { label: 'Portuguese fight menu', locale: 'pt-BR', snap: activeBattle({ activeMenu: 'fight' }), utterance: 'não sei qual', expected: /seus golpes.*Thunder Jolt.*Static Zap/i },
  ])('uses a phase-correct scripted reprompt without an LLM: $label', async ({ locale, snap, utterance, expected }) => {
    const { deps, said } = fakeDeps({ snapshot: () => snap });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup('4821', locale));
    said.length = 0;

    session.handleMessage(prompt(utterance));
    await Promise.resolve();

    expect(said.join(' ')).toMatch(expected);
  });

  it('uses the same scripted reprompt when the LLM fails', async () => {
    const { deps, said } = fakeDeps({
      snapshot: () => activeBattle(),
      converse: async () => { throw new Error('offline'); },
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    said.length = 0;

    session.handleMessage(prompt('not a command'));
    await Promise.resolve();
    await Promise.resolve();

    expect(said.join(' ')).toMatch(/fight.*guard.*item.*taunt/i);
  });

  it('never sends unknown setup speech to the conversational host',async()=>{
    let calls=0;const{deps,said}=fakeDeps({
      snapshot:()=>battleSnap({phase:'monster_select',myName:'Ada'}),
      converse:async()=>{calls++;return 'off-topic reply';},
    });
    const session=new BattleVoiceSession(deps);session.handleMessage(setup());said.length=0;
    session.handleMessage(prompt('I have two dogs'));
    await Promise.resolve();
    expect(calls).toBe(0);
    expect(said.join(' ')).toMatch(/own monster.*name or number/i);
  });

  it('does not reprompt after an LLM tool changed the battle state', async () => {
    let snap = activeBattle();
    const { deps, said } = fakeDeps({
      snapshot: () => snap,
      converse: async () => {
        snap = { ...snap, turn: 1, activeSide: 'b', whoseTurn: 'foe' };
        return null;
      },
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    said.length = 0;

    session.handleMessage(prompt('make a tactical choice'));
    await Promise.resolve();

    expect(said).toHaveLength(0);
  });

  it('uses selection DTMF digits to choose monsters in either locale', () => {
    for (const locale of [undefined, 'pt-BR']) {
      const { deps, log } = fakeDeps({ snapshot: () => battleSnap({ myName: 'Ada' }) });
      const session = new BattleVoiceSession(deps);
      session.handleMessage(setup('4821', locale));

      session.handleMessage(dtmf('2'));

      expect(log).toContain('monster embertail');
    }
  });

  it.each([
    ['1', 'openFight'],
    ['2', '"kind":"guard"'],
    ['3', '"kind":"item"'],
    ['4', '"kind":"taunt"'],
  ])('maps root DTMF %s to its battle action', (digit, expectedLog) => {
    const { deps, log } = fakeDeps({ snapshot: () => activeBattle() });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());

    session.handleMessage(dtmf(digit));

    expect(log.some(entry => entry.includes(expectedLog))).toBe(true);
  });

  it.each([
    ['1', 'sparkmouse.jolt'],
    ['2', 'sparkmouse.zap'],
    ['3', 'sparkmouse.bite'],
    ['4', 'sparkmouse.tackle'],
  ])('maps fight-menu DTMF %s to move %s', (digit, moveId) => {
    const { deps, log } = fakeDeps({ snapshot: () => activeBattle({ activeMenu: 'fight' }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());

    session.handleMessage(dtmf(digit));

    expect(log.some(entry => entry.includes(`"moveId":"${moveId}"`))).toBe(true);
  });

  it('uses DTMF 0 to back out of the fight menu', () => {
    const { deps, log } = fakeDeps({ snapshot: () => activeBattle({ activeMenu: 'fight' }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup('4821', 'pt-BR'));

    session.handleMessage(dtmf('0'));

    expect(log).toContain('backMenu');
  });

  it.each([
    { locale: undefined, item: 'potion', expected: /no potions remain/i },
    { locale: 'pt-BR', item: 'poção', expected: /não restam poções/i },
  ])('explicitly reports no remaining potions in $locale', ({ locale, item, expected }) => {
    const { deps, log, said } = fakeDeps({ snapshot: () => activeBattle({ myPotions: 0 }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup('4821', locale));
    said.length = 0;

    session.handleMessage(prompt(item));
    session.handleMessage(dtmf('3'));

    expect(log.some(entry => entry.includes('"kind":"item"'))).toBe(false);
    expect(said).toHaveLength(2);
    expect(said.join(' ')).toMatch(expected);
  });

  it('"start" explicitly advances a ready lobby', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'lobby', monsterNames: ['Sparkmouse'], myName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('start'));
    expect(log.filter(l => l === 'advance')).toHaveLength(1);
  });

  it('keeps a lobby gated while expected players are missing', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'lobby', monsterNames: ['Sparkmouse'], myName: 'Ada', canAdvanceLobby: false }),
    });
    const s = new BattleVoiceSession(deps);s.handleMessage(setup());said.length=0;
    s.handleMessage(prompt('next'));
    expect(log).not.toContain('advance');
    expect(said.join(' ')).toMatch(/every player.*say next/i);
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

  it('"battle" in monster-select advances when picks are complete', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        canStartBattle: true,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt('battle'));

    expect(log.filter(l => l === 'advance')).toHaveLength(1);
  });

  it('"fight" in monster-select advances when picks are complete', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        canStartBattle: true,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt('fight'));

    expect(log.filter(l => l === 'advance')).toHaveLength(1);
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
    expect(said.filter(t => /fight/i.test(t) && /guard|item|taunt/i.test(t))).toHaveLength(1);
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
    expect(said.filter(t => /fight/i.test(t) && /guard|item|taunt/i.test(t))).toHaveLength(0);
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

  it('deduplicates a repeated final fight frame after the menu opens', () => {
    let menu: 'root' | 'fight' = 'root';
    const moves = [
      { id: 'sparkmouse.jolt', name: 'Thunder Jolt' },
      { id: 'sparkmouse.zap', name: 'Static Zap' },
    ];
    const { deps, log, said } = fakeDeps({ snapshot: () => battleSnap({
      phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', turn: 0,
      activeSide: 'a', activeMenu: menu, whoseTurn: 'me', myMoves: moves,
    }) });
    deps.openFight = () => { log.push('openFight'); menu = 'fight'; };
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;
    session.handleMessage(prompt('fight'));
    session.handleMessage(prompt('fight'));
    expect(log.filter(entry => entry === 'openFight')).toHaveLength(1);
    expect(said.filter(text => /thunder jolt/i.test(text))).toHaveLength(1);
  });

  it('does not reinterpret a delayed numeric Fight choice as move one', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      let menu: 'root' | 'fight' = 'root';
      const moves = [{ id: 'sparkmouse.jolt', name: 'Thunder Jolt' }];
      const { deps, log } = fakeDeps({ snapshot: () => activeBattle({ activeMenu: menu, myMoves: moves }) });
      deps.openFight = () => { log.push('openFight'); menu = 'fight'; };
      const session = new BattleVoiceSession(deps);
      session.handleMessage(setup());
      session.handleMessage(prompt('one'));
      vi.advanceTimersByTime(3_000);
      session.handleMessage(prompt('one'));
      expect(log.filter(entry => entry === 'openFight')).toHaveLength(1);
      expect(log.some(entry => entry.startsWith('action '))).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('ignores interim fight guesses and applies the corrected final root action', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse',
        turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
        myMoves: [
          { id: 'sparkmouse.jolt', name: 'Thunder Jolt' },
          { id: 'sparkmouse.zap', name: 'Static Zap' },
        ],
      }),
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;

    session.handleMessage(prompt('fight', false));
    session.handleMessage(prompt('fight', false));
    session.handleMessage(prompt('two', true));

    expect(log).not.toContain('openFight');
    expect(log.some(entry => entry.includes('"kind":"guard"'))).toBe(true);
    expect(said.filter(text => /thunder jolt/i.test(text) && /static zap/i.test(text))).toHaveLength(0);
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

  it('uses the existing wait cue for out-of-turn DTMF', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => activeBattle({ mySide: 'b', myName: 'Bo', activeSide: 'a', whoseTurn: 'foe' }),
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    said.length = 0;

    session.handleMessage(dtmf('2'));

    expect(log.some(entry => entry.startsWith('action '))).toBe(false);
    expect(said.join(' ')).toMatch(/wait for shellback/i);
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

    expect(said.some(t => /shellback.*please wait|please wait.*shellback/i.test(t))).toBe(true);
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

  it('uses the existing resolving cue for DTMF during commentary', () => {
    const timers: (() => void)[] = [];
    const { deps, log, said } = fakeDeps({
      snapshot: () => activeBattle(),
      setTimer: (fn: () => void) => { timers.push(fn); },
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    said.length = 0;
    session.onBattleEvent({ kind: 'move_used', by: 'b', moveId: 'shellback.splash', moveName: 'Splash' });

    session.handleMessage(dtmf('1'));

    expect(log).not.toContain('openFight');
    expect(said.join(' ')).toMatch(/resolving the last move/i);
  });

  it('drops a superseded LLM turn when a newer interim arrives', async () => {
    let release!: () => void;
    let staleActionRan = false;
    const pending = new Promise<void>(r => { release = r; });
    const snap = battleSnap({
      phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse',
      whoseTurn: 'me', activeSide: 'a', myMoves: [{ id: 'sparkmouse.jolt', name: 'Thunder Jolt' }],
    });
    const { deps } = fakeDeps({
      snapshot: () => snap,
      converse: async (_code, _id, _text, isCurrent) => {
        await pending;
        if (isCurrent()) staleActionRan = true;
        return 'stale reply';
      },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('what should I do'));
    s.handleMessage(prompt('fight', false));
    release();
    await pending;
    await Promise.resolve();

    expect(staleActionRan).toBe(false);
  });

  it('makes a replaced voice socket inert, including any in-flight LLM turn', async () => {
    let release!: () => void;
    let staleActionRan = false;
    const pending = new Promise<void>(r => { release = r; });
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'battle', myName: 'Ada', whoseTurn: 'me', activeSide: 'a' }),
      converse: async (_code, _id, _text, isCurrent) => {
        await pending;
        if (isCurrent()) staleActionRan = true;
        return null;
      },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('what should I do'));
    s.handleReplaced();
    s.handleMessage(prompt('guard'));
    release();
    await pending; await Promise.resolve();

    expect(staleActionRan).toBe(false);
    expect(log.some(l => l.startsWith('action '))).toBe(false);
  });

  it('drops an in-flight Voice Monsters turn when the caller interrupts', async () => {
    let release!: () => void;
    let staleReplyRan = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const { deps } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'battle', myName: 'Ada', whoseTurn: 'me', activeSide: 'a' }),
      converse: async (_code, _id, _text, isCurrent) => {
        await pending;
        if (isCurrent()) staleReplyRan = true;
        return null;
      },
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    session.handleMessage(prompt('what should I do'));
    session.handleMessage(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 100 }));
    release(); await pending; await Promise.resolve();

    expect(staleReplyRan).toBe(false);
  });

  it('holds commentary for the shared handoff pause when the acting side changes', () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', myName: 'Ada', myMonsterName: 'Sparkmouse', foeMonsterName: 'Embertail',
      }),
      setTimer: (fn, ms) => { timers.push({ fn, ms }); },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.onBattleEvent({ kind: 'move_used', by: 'a', moveId: 'a', moveName: 'Thunder Jolt' });
    s.onBattleEvent({ kind: 'guard', by: 'b', monsterName: 'Embertail' });
    timers.shift()!.fn();

    expect(said.join(' ')).not.toMatch(/braces|guard/i);
    const handoff = timers.shift()!;
    expect(handoff.ms).toBeGreaterThan(1000);
    handoff.fn();
    expect(said.join(' ')).toMatch(/braces|guard/i);
  });

  it('does not start a rematch while final battle commentary is still draining', () => {
    const timers: (() => void)[] = [];
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'results', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse',
        foeName: 'Bo', foeMonsterName: 'Embertail', winnerName: 'Ada',
      }),
      setTimer: (fn: () => void) => { timers.push(fn); },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.onBattleEvent({ kind: 'battle_over', winner: 'a', winnerName: 'Ada' });

    s.handleMessage(prompt('rematch'));

    expect(log).not.toContain('advance');
    expect(said.some(t => /final result|rematch is ready/i.test(t))).toBe(true);
  });

  it('does not let an LLM tool advance results while final commentary is draining', async () => {
    const timers: (() => void)[] = [];
    let advanced = false;
    const { deps } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'results', myName: 'Ada', winnerName: 'Ada' }),
      setTimer: (fn: () => void) => { timers.push(fn); },
      converse: async (_code, _id, _text, isCurrent) => {
        if (isCurrent()) advanced = true;
        return null;
      },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.onBattleEvent({ kind: 'battle_over', winner: 'a', winnerName: 'Ada' });
    s.handleMessage(prompt('yes'));
    await Promise.resolve();

    expect(advanced).toBe(false);
  });

  it('explains a mid-battle departure and asks the survivor to choose again', () => {
    let snap = battleSnap({
      phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse',
      foeName: 'Bo', foeMonsterName: 'Embertail', whoseTurn: 'me', activeSide: 'a', turn: 2,
    });
    const { deps, said } = fakeDeps({ snapshot: () => snap });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.onBattleStateChanged(); said.length = 0;
    snap = battleSnap({
      phase: 'monster_select', myName: 'Ada', myMonsterId: null, myMonsterName: null, canStartBattle: false,
    });

    s.onBattleStateChanged();

    expect(said.join(' ')).toMatch(/other player left/i);
    expect(said.join(' ')).toMatch(/choose your own monster/i);
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

  it('sends station players back to messaging and the queue without offering a rematch', () => {
    const {deps,said}=fakeDeps({snapshot:()=>battleSnap({
      phase:'results',myName:'Ada',myMonsterName:'Sparkmouse',foeName:'Bo',foeMonsterName:'Embertail',winnerName:'Ada',
    })});
    const session=new BattleVoiceSession(deps);session.setStationManaged(true);session.handleMessage(setup());said.length=0;
    session.onBattleEvent({kind:'battle_over',winner:'a',winnerName:'Ada'});
    expect(said.join(' ')).toMatch(/results.*display.*thanks for playing.*check your messages/i);
    expect(said.join(' ')).not.toMatch(/rematch|automatically/i);
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

  it('resolves pt-BR commandLocale for deterministic commands and spoken output', () => {
    let activeMenu: BattleVoiceSnapshot['activeMenu'] = 'root';
    const snapshot = () => battleSnap({
      phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
      foeMonsterName: 'Shellback', foeMonsterType: 'water', whoseTurn: 'me', activeSide: 'a', activeMenu,
      myMoves: [{ id: 'sparkmouse.jolt', name: 'Thunder Jolt' }, { id: 'sparkmouse.zap', name: 'Static Zap' }],
    });
    const { deps, log, said } = fakeDeps({ snapshot });
    const s = new BattleVoiceSession(deps);

    s.handleMessage(setup('4821', 'pt-BR'));
    expect(said.join(' ')).toMatch(/boas-vindas|sua voz|regras rápidas/i);
    said.length = 0;

    s.handleMessage(prompt('lutar'));
    expect(log).toContain('openFight');
    expect(said.join(' ')).toMatch(/seus golpes|diga o nome/i);
    expect(said.join(' ')).toContain('Thunder Jolt');

    activeMenu = 'fight';
    s.handleMessage(prompt('Thunder Jolt'));
    expect(log.some(line => line.includes('"moveId":"sparkmouse.jolt"'))).toBe(true);
    activeMenu = 'root';
    s.handleMessage(prompt('defender'));
    expect(log.some(line => line.includes('"kind":"guard"'))).toBe(true);
    said.length = 0;
    s.handleMessage(prompt('ajuda'));
    expect(said.join(' ')).toMatch(/lutar.*defender.*item.*provocar/i);
  });

  it('understands Portuguese monster ordinals, advance words, and caller names', () => {
    const { deps, log } = fakeDeps({ snapshot: () => battleSnap({ myName: 'João' }) });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821', 'pt-BR'));
    s.handleMessage(prompt('a segunda'));
    expect(log).toContain('monster embertail');

    expect(isAdvanceWord('começar', 'pt-BR')).toBe(true);
    expect(isAdvanceWord('revanche', 'pt-BR')).toBe(true);
    expect(parseSpokenName('meu nome é joão', 'pt-BR')).toBe('João');
    expect(parseSpokenName('poção', 'pt-BR')).toBeNull();
  });
});
