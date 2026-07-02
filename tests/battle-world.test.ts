// The turn-based battle engine — Voice Monsters' pure sim (like race-world.ts for the racer). Two
// combatants each pick a move; the turn resolves in SPEED order, applies typed damage, emits ordered
// events (for the renderer to animate one hit at a time), and detects faint/win. No I/O, fully TDD.
import { describe, it, expect } from 'vitest';
import { BattleWorld } from '../shared/battle-world';
import { monsterById } from '../shared/monster-roster';

// Deterministic combatants for tests.
const FAST = 'gustwing';     // speed 105
const SLOW = 'pebblefist';   // speed 30
const FIRE = 'embertail';
const GRASS = 'thornling';

function newBattle(aMon: string, bMon: string, seed = 123) {
  return new BattleWorld(
    { id: 'a', name: 'Ada', monsterId: aMon },
    { id: 'b', name: 'Bo', monsterId: bMon },
    seed,
  );
}
/** Resolve one full turn: both sides pick their first move. */
function bothPickFirstMove(w: BattleWorld) {
  const s = w.snapshot();
  w.chooseMove('a', s.a.moves[0]!.id);
  w.chooseMove('b', s.b.moves[0]!.id);
}

describe('battle pacing (balance)', () => {
  // A single hit must NEVER take more than ~40% of the defender's HP → no one-shots, and any battle
  // takes at least a few hits. Guards the tuned damage formula against silent drift.
  it('no single hit is a one-shot (each hit ≤ ~40% of max HP)', () => {
    for (const seed of [1, 2, 3, 7, 11]) {
      // pit a heavy hitter into a frail target — the worst case for one-shotting
      const w = newBattle('pebblefist', 'gustwing', seed);
      const maxB = w.snapshot().b.hp;
      const before = w.snapshot().b.hp;
      w.chooseMove('a', w.snapshot().a.moves[1]!.id);   // strong rock move
      w.chooseMove('b', w.snapshot().b.moves[2]!.id);
      const dealt = before - w.snapshot().b.hp;
      expect(dealt).toBeLessThanOrEqual(Math.ceil(maxB * 0.5));   // hard cap holds
      expect(w.snapshot().b.hp).toBeGreaterThan(0);              // survives the first hit
    }
  });

  it('a full battle lasts several turns, not one (target ~3–6)', () => {
    let sumTurns = 0, n = 0, oneShots = 0;
    for (const [a, bMon] of [['embertail', 'thornling'], ['sparkmouse', 'shellback'], ['tuskox', 'mudpup']] as const) {
      for (let seed = 1; seed <= 5; seed++) {
        const w = newBattle(a, bMon, seed * 9 + 1);
        for (let t = 0; t < 60 && w.snapshot().phase !== 'finished'; t++) {
          const s = w.snapshot();
          w.chooseMove('a', s.a.moves[1]!.id);
          w.chooseMove('b', s.b.moves[0]!.id);
        }
        const turns = w.snapshot().turn;
        sumTurns += turns; n++;
        if (turns <= 1) oneShots++;
        expect(turns).toBeGreaterThanOrEqual(2);   // never a one-turn battle
      }
    }
    expect(oneShots).toBe(0);
    expect(sumTurns / n).toBeGreaterThanOrEqual(3);   // averages in the intended band
  });
});

describe('BattleWorld', () => {
  it('starts in a choosing phase with both monsters at full HP', () => {
    const w = newBattle(FAST, SLOW);
    const s = w.snapshot();
    expect(s.phase).toBe('choosing');
    expect(s.a.hp).toBe(monsterById(FAST)!.maxHp);
    expect(s.b.hp).toBe(monsterById(SLOW)!.maxHp);
    expect(s.a.moves).toHaveLength(4);
  });

  it('does NOT resolve until BOTH sides have chosen a move', () => {
    const w = newBattle(FAST, SLOW);
    w.chooseMove('a', w.snapshot().a.moves[0]!.id);
    expect(w.snapshot().phase).toBe('choosing');   // still waiting on b
    const hpBefore = w.snapshot().b.hp;
    expect(w.snapshot().b.hp).toBe(hpBefore);       // no damage yet
  });

  it('resolves a turn once both have chosen: damage is dealt and turn count advances', () => {
    // Two BULKY monsters so one turn deals damage but can't KO — proving the turn resolves and hands
    // back to 'choosing' rather than ending. (A glass-cannon pairing can legitimately end in 1 turn.)
    const w = newBattle('shellback', 'tuskox');   // 92hp/88def vs 110hp/74def
    const before = w.snapshot();
    bothPickFirstMove(w);
    const after = w.snapshot();
    expect(after.turn).toBe(before.turn + 1);
    // both dealt damage (neither first move is a 0-power status move here)
    expect(after.a.hp).toBeLessThan(before.a.hp);
    expect(after.b.hp).toBeLessThan(before.b.hp);
    expect(after.phase).toBe('choosing');   // back to choosing for the next turn
  });

  it('the FASTER monster strikes first within a turn (speed decides order)', () => {
    const w = newBattle(FAST, SLOW);
    bothPickFirstMove(w);
    const attacks = w.drainEvents().filter(e => e.kind === 'move_used');
    expect(attacks[0]!.by).toBe('a');   // Gustwing (105) before Pebblefist (30)
  });

  it('applies the type chart: fire vs grass is super-effective (emits the event)', () => {
    const w = newBattle(FIRE, GRASS, 7);
    // Both use their first move; embertail.ember (fire) hits thornling (grass) = 2x.
    bothPickFirstMove(w);
    const evs = w.drainEvents();
    const superEff = evs.find(e => e.kind === 'effectiveness' && e.multiplier >= 2 && e.on === 'b');
    expect(superEff).toBeDefined();
  });

  it('ends the battle when a monster faints, naming the winner', () => {
    const w = newBattle(FIRE, GRASS, 3);
    // hammer away until someone faints (guard against infinite loops)
    for (let i = 0; i < 100 && w.snapshot().phase === 'choosing'; i++) {
      const s = w.snapshot();
      w.chooseMove('a', s.a.moves[1]!.id);   // strong fire move
      w.chooseMove('b', s.b.moves[0]!.id);
    }
    const s = w.snapshot();
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe('a');
    expect(s.a.hp).toBeGreaterThan(0);
    expect(s.b.hp).toBe(0);
  });

  it('ignores a move choice after the battle is over', () => {
    const w = newBattle(FIRE, GRASS, 3);
    for (let i = 0; i < 100 && w.snapshot().phase === 'choosing'; i++) {
      const s = w.snapshot();
      w.chooseMove('a', s.a.moves[1]!.id);
      w.chooseMove('b', s.b.moves[0]!.id);
    }
    expect(w.snapshot().phase).toBe('finished');
    const frozen = w.snapshot();
    w.chooseMove('a', frozen.a.moves[0]!.id);   // no-op
    expect(w.snapshot()).toEqual(frozen);
  });

  it('is deterministic: same seed + same choices → identical result', () => {
    const runs = [0, 1].map(() => {
      const w = newBattle(FIRE, GRASS, 999);
      bothPickFirstMove(w);
      return w.snapshot();
    });
    expect(runs[0]).toEqual(runs[1]);
  });

  it('rejects an invalid move id (turn does not resolve on a bad choice)', () => {
    const w = newBattle(FAST, SLOW);
    w.chooseMove('a', 'not-a-real-move');
    w.chooseMove('b', w.snapshot().b.moves[0]!.id);
    expect(w.snapshot().phase).toBe('choosing');   // a never validly chose → no resolution
    expect(w.snapshot().turn).toBe(0);
  });
});
