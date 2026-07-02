// The turn-based battle engine — Voice Monsters' pure sim (like race-world.ts for the racer). Two
// combatants each pick a move; the turn resolves in SPEED order, applies typed damage, emits ordered
// events (for the renderer to animate one hit at a time), and detects faint/win. No I/O, fully TDD.
import { describe, it, expect } from 'vitest';
import { BattleWorld } from '../shared/battle-world';
import { monsterById, moveById } from '../shared/monster-roster';
import { pickAiMove } from '../shared/battle-ai';
import { Rng } from '../shared/rng';

// Deterministic combatants for tests.
const FAST = 'voltcrest';    // speed 100
const SLOW = 'shellback';    // speed 43
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
  // ── The two guardrails, pinned in BOTH directions ──────────────────────────────────────────────
  // FLOOR: no single hit is a one-shot (structural — the per-hit cap makes it impossible).
  // CEILING: battles don't drag. The tuned formula was regressed once by only pinning the floor, so
  //   a 7–10-turn "spongy" tail slipped through. These tests now pin the ceiling too, and — crucially
  //   — model the REAL asymmetry the player feels: a HUMAN taps a somewhat-random move while the AI
  //   damage-maximizes, which stretches battles more than optimal-vs-optimal ever showed.

  it('no single hit is a one-shot (each hit ≤ half the defender max HP), worst case', () => {
    // Every attacker × every one of its damaging moves × the FRAILEST target, worst-case variance.
    const frail = ROSTER_IDS.map(id => monsterById(id)!).sort((a, b) => a.maxHp - b.maxHp)[0]!;
    for (const atkId of ROSTER_IDS) {
      const atk = monsterById(atkId)!;
      if (atk.id === frail.id) continue;
      for (const mv of atk.moves) {
        if (mv.power <= 0) continue;
        for (let seed = 1; seed <= 20; seed++) {
          const w = new BattleWorld({ id: 'a', name: 'A', monsterId: atk.id }, { id: 'b', name: 'B', monsterId: frail.id }, seed);
          const maxB = w.snapshot().b.hp;
          w.chooseMove('a', mv.id);
          w.chooseMove('b', frail.moves[0]!.id);
          const dealt = maxB - w.snapshot().b.hp;
          expect(dealt).toBeLessThanOrEqual(Math.ceil(maxB * 0.5));   // hard cap: never > half a bar
        }
      }
    }
  });

  it('optimal play resolves in a tight band (median 2-3, never a one-shot, max ≤ 5)', () => {
    // Ceiling is 5 (not 4) now that moves can MISS: even optimal play occasionally whiffs a strong
    // move and needs an extra swing. That's the risk/reward mechanic working, not a grind.
    const { median, max, oneShots } = paceDistribution(/* human random? */ false);
    expect(oneShots).toBe(0);
    expect(median).toBeLessThanOrEqual(3);
    expect(median).toBeGreaterThanOrEqual(2);
    expect(max).toBeLessThanOrEqual(5);
  });

  it('a HUMAN tapping moves vs the AI does NOT grind (median ≤ 3, max ≤ 6) — the reported bug', () => {
    // This is the case the player actually experiences. The old formula let this tail reach 10 turns.
    const { median, max, oneShots } = paceDistribution(/* human random? */ true);
    expect(oneShots).toBe(0);
    expect(median).toBeLessThanOrEqual(3);
    expect(max).toBeLessThanOrEqual(6);   // pins the spongy tail shut
  });
});

describe('critical hits (rare bonus damage)', () => {
  // Crits are POSSIBLE but RARE, and a crit is flagged on the damage event so the UI can react. They
  // must never break the no-one-shot guarantee (the 0.5*maxHp cap still applies AFTER the crit boost).

  it('some hits crit and most do not — crits are flagged on the damage event, and are rare', () => {
    let hits = 0, crits = 0;
    // Many independent single-hit samples across seeds; count how many damage events are crits.
    for (let seed = 1; seed <= 400; seed++) {
      const w = newBattle('embertail', 'shellback', seed);
      w.chooseMove('a', w.snapshot().a.moves[1]!.id);
      w.chooseMove('b', w.snapshot().b.moves[0]!.id);
      for (const ev of w.drainEvents()) {
        if (ev.kind === 'damage') { hits++; if (ev.crit) crits++; }
      }
    }
    expect(crits).toBeGreaterThan(0);              // crits DO happen
    const rate = crits / hits;
    expect(rate).toBeGreaterThan(0.01);            // not vanishingly impossible
    expect(rate).toBeLessThan(0.20);               // but genuinely RARE (well under 1-in-5)
  });

  it('a crit still cannot one-shot (respects the ≤ half-HP hard cap)', () => {
    // Force the worst case many times: heaviest hitter into the frailest foe; even crits stay capped.
    const frail = ROSTER_IDS.map(id => monsterById(id)!).sort((a, b) => a.maxHp - b.maxHp)[0]!;
    for (const atkId of ROSTER_IDS) {
      const atk = monsterById(atkId)!;
      if (atk.id === frail.id) continue;
      for (let seed = 1; seed <= 60; seed++) {
        const w = new BattleWorld({ id: 'a', name: 'A', monsterId: atk.id }, { id: 'b', name: 'B', monsterId: frail.id }, seed);
        const maxB = w.snapshot().b.hp;
        w.chooseMove('a', atk.moves[0]!.id);
        w.chooseMove('b', frail.moves[0]!.id);
        for (const ev of w.drainEvents()) {
          if (ev.kind === 'damage' && ev.on === 'b') expect(ev.amount).toBeLessThanOrEqual(Math.ceil(maxB * 0.5));
        }
      }
    }
  });
});

describe('move accuracy (risk/reward)', () => {
  // A high-power move can MISS (emitting a miss event + dealing no damage); a low-power move is
  // reliable. This is what makes a weaker move worth picking.

  // Helper: miss RATE for a given move index of `attacker` across many seeds.
  function missRate(attacker: string, moveIdx: number, samples = 400): number {
    let swings = 0, misses = 0;
    for (let seed = 1; seed <= samples; seed++) {
      const w = newBattle(attacker, 'shellback', seed);
      w.chooseMove('a', w.snapshot().a.moves[moveIdx]!.id);
      w.chooseMove('b', w.snapshot().b.moves[0]!.id);
      for (const ev of w.drainEvents()) {
        if (ev.kind === 'move_used' && ev.by === 'a') swings++;
        if (ev.kind === 'miss' && ev.by === 'a') misses++;
      }
    }
    return misses / swings;
  }

  it('a strong move sometimes misses — emitting a miss event and dealing no damage that swing', () => {
    // psyclone Psystrike is the strong move (pow 88, ~76% acc) → whiffs a meaningful minority.
    const rate = missRate('psyclone', 0);
    expect(rate).toBeGreaterThan(0.05);   // it DOES miss sometimes
    expect(rate).toBeLessThan(0.45);      // but mostly lands
  });

  it('a WEAKER move is more reliable than a STRONGER one (the risk/reward)', () => {
    // psyclone: Focus (idx 3, weak pow 50) should miss LESS often than Psystrike (idx 0, strong 88).
    const weakMiss = missRate('psyclone', 3);
    const strongMiss = missRate('psyclone', 0);
    expect(weakMiss).toBeLessThan(strongMiss);
  });
});

const ROSTER_IDS = ['sparkmouse', 'embertail', 'shellback', 'thornling', 'galecoil', 'voltcrest', 'dazeduck', 'psyclone'] as const;

/** Play every roster matchup, many seeds, via the REAL BattleWorld. When `humanRandom`, side 'a' taps
 *  a pseudo-random move (a real player) while side 'b' uses the damage-maximizing AI; otherwise BOTH
 *  use the AI. Returns the turn-count distribution — the ground truth the formula is tuned against. */
function paceDistribution(humanRandom: boolean): { median: number; max: number; oneShots: number } {
  const turns: number[] = [];
  let oneShots = 0;
  for (const aId of ROSTER_IDS) for (const bId of ROSTER_IDS) {
    if (aId === bId) continue;
    for (let seed = 1; seed <= 6; seed++) {
      const w = new BattleWorld({ id: 'a', name: 'A', monsterId: aId }, { id: 'b', name: 'B', monsterId: bId }, seed * 7 + 3);
      const A = monsterById(aId)!, B = monsterById(bId)!;
      const aiRng = new Rng((seed * 7 + 3) ^ 0x5bd1e995);
      const humanRng = new Rng((seed * 7 + 3) ^ 0x1234567);
      for (let t = 0; t < 100 && w.snapshot().phase !== 'finished'; t++) {
        const aMove = humanRandom ? A.moves[humanRng.int(A.moves.length)]!.id : pickAiMove(A, B, aiRng);
        w.chooseMove('a', aMove);
        w.chooseMove('b', pickAiMove(B, A, aiRng));
      }
      const tt = w.snapshot().turn;
      turns.push(tt);
      if (tt <= 1) oneShots++;
    }
  }
  turns.sort((x, y) => x - y);
  return { median: turns[Math.floor((turns.length - 1) * 0.5)]!, max: turns[turns.length - 1]!, oneShots };
}

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
    const w = newBattle('shellback', 'galecoil');   // 92hp/88def vs 98hp/79def — both bulky
    const before = w.snapshot();
    bothPickFirstMove(w);
    const after = w.snapshot();
    expect(after.turn).toBe(before.turn + 1);
    // both dealt damage (neither first move is a 0-power status move here)
    expect(after.a.hp).toBeLessThan(before.a.hp);
    expect(after.b.hp).toBeLessThan(before.b.hp);
    expect(after.phase).toBe('choosing');   // back to choosing for the next turn
  });

  it('whoever COMMITS their move first strikes first within a turn (order = commit order, not speed)', () => {
    // Even though SLOW would win on the speed stat, if it commits FIRST it acts first. Turn order is
    // driven by who attacks first — this makes single-player "you go first" and multiplayer
    // "whoever taps first goes first" fall out naturally.
    const w = newBattle(FAST, SLOW);
    w.chooseMove('b', w.snapshot().b.moves[0]!.id);   // b (SLOW) commits FIRST
    w.chooseMove('a', w.snapshot().a.moves[0]!.id);   // a (FAST) commits second
    const attacks = w.drainEvents().filter(e => e.kind === 'move_used');
    expect(attacks[0]!.by).toBe('b');   // b committed first → b strikes first, despite lower speed
  });

  it('the other commit order flips who strikes first (a commits first → a acts first)', () => {
    const w = newBattle(FAST, SLOW);
    w.chooseMove('a', w.snapshot().a.moves[0]!.id);   // a commits FIRST
    w.chooseMove('b', w.snapshot().b.moves[0]!.id);
    const attacks = w.drainEvents().filter(e => e.kind === 'move_used');
    expect(attacks[0]!.by).toBe('a');
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
