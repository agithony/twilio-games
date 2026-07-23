// The four turn actions beyond attacking: GUARD blocks at least half, Potion restores full health,
// and TAUNT makes the foe's next attack almost always miss. Pure sim, fully testable.
import { describe, it, expect } from 'vitest';
import { BattleWorld } from '../shared/battle-world';

function newBattle(aMon: string, bMon: string, seed = 123) {
  return new BattleWorld({ id: 'a', name: 'Ada', monsterId: aMon }, { id: 'b', name: 'Bo', monsterId: bMon }, seed);
}
/** A fights (move idx), B chooses some action; A commits FIRST so A's attack resolves first with a
 *  stable rng draw regardless of B's choice (lets us isolate GUARD's effect on the damage A deals). */
function aFightsBActs(w: BattleWorld, aMoveIdx: number, bAction: () => void) {
  const s = w.snapshot();
  w.chooseAction('a', { kind: 'fight', moveId: s.a.moves[aMoveIdx]!.id });   // A commits first
  bAction();
}

describe('turn actions: FIGHT / GUARD / ITEM / TAUNT', () => {
  it('chooseMove still works as a FIGHT shim (back-compat)', () => {
    const w = newBattle('embertail', 'shellback', 5);
    const before = w.snapshot().b.hp;
    w.chooseMove('a', w.snapshot().a.moves[0]!.id);
    w.chooseMove('b', w.snapshot().b.moves[0]!.id);
    expect(w.snapshot().b.hp).toBeLessThan(before);   // damage dealt → turn resolved
  });

  it('GUARD halves the damage the guarding side takes that turn', () => {
    // Same seed + same attacker-first order → A's hit rolls are identical; only B's choice differs.
    const guarded = newBattle('embertail', 'shellback', 7);
    aFightsBActs(guarded, 1, () => guarded.chooseAction('b', { kind: 'guard' }));
    const dmgGuarded = guarded.snapshot().b.maxHp - guarded.snapshot().b.hp;

    const plain = newBattle('embertail', 'shellback', 7);
    aFightsBActs(plain, 1, () => plain.chooseAction('b', { kind: 'fight', moveId: plain.snapshot().b.moves[0]!.id }));
    // In `plain`, B also took damage from A's SAME first hit (A goes first). Compare that hit only.
    const hitOnB = (w: BattleWorld): number => {
      for (const e of w.drainEvents()) if (e.kind === 'damage' && e.on === 'b') return e.amount;
      return 0;
    };
    const aHit = hitOnB(plain);
    const guardHit = hitOnB(guarded);
    expect(guardHit).toBeLessThan(aHit);
    expect(guardHit).toBeLessThanOrEqual(Math.floor(aHit / 2));
    expect(dmgGuarded).toBeGreaterThanOrEqual(0);
  });

  it('GUARD sometimes blocks the entire landed attack', () => {
    let landed = 0, fullBlocks = 0, partialBlocks = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const guarded = newBattle('embertail', 'shellback', seed);
      aFightsBActs(guarded, 2, () => guarded.chooseAction('b', { kind: 'guard' }));
      const events = guarded.drainEvents();
      const blocked = events.some(event => event.kind === 'block' && event.on === 'b');
      const damage = events.find(event => event.kind === 'damage' && event.on === 'b');
      if (!blocked && (!damage || damage.kind !== 'damage')) continue;
      landed++;
      if (blocked) fullBlocks++;
      else partialBlocks++;
    }
    expect(landed).toBeGreaterThan(250);
    expect(fullBlocks).toBeGreaterThan(40);
    expect(partialBlocks).toBeGreaterThan(100);
  });

  it('GUARD also heals a little (so bracing is not a wasted turn)', () => {
    // B is hurt first, then guards next turn while A uses a weak move → net HP should not only drop.
    const w = newBattle('embertail', 'shellback', 3);
    // Turn 1: both fight, B takes damage.
    w.chooseMove('a', w.snapshot().a.moves[1]!.id);
    w.chooseMove('b', w.snapshot().b.moves[0]!.id);
    const hurtHp = w.snapshot().b.hp;
    w.drainEvents();
    // Turn 2: A guards? no — A fights weakest; B GUARDS. Expect a heal event for B.
    w.chooseAction('a', { kind: 'fight', moveId: w.snapshot().a.moves[2]!.id });
    w.chooseAction('b', { kind: 'guard' });
    const evs = w.drainEvents();
    expect(evs.some(e => e.kind === 'guard' && e.by === 'b')).toBe(true);
    expect(evs.some(e => e.kind === 'heal' && e.on === 'b')).toBe(true);
    void hurtHp;
  });

  it('ITEM (Potion) heals and is limited per battle; unusable once out', () => {
    // shellback (92hp/88def, bulky) takes A's WEAKEST move once so it's hurt but far from fainting.
    const w = newBattle('embertail', 'shellback', 9);
    w.chooseMove('a', w.snapshot().a.moves[2]!.id);   // Scratch (weak)
    w.chooseMove('b', w.snapshot().b.moves[0]!.id);
    w.drainEvents();
    const before = w.snapshot();
    expect(before.phase).toBe('choosing');            // battle still going
    expect(before.potions.b).toBe(2);
    const lowHp = before.b.hp;
    expect(lowHp).toBeLessThan(before.b.maxHp);        // B IS hurt (so a heal will register)
    // B uses a Potion (A fights weak again)
    w.chooseAction('a', { kind: 'fight', moveId: w.snapshot().a.moves[2]!.id });
    w.chooseAction('b', { kind: 'item', item: 'potion' });
    const evs = w.drainEvents();
    expect(evs.some(e => e.kind === 'item' && e.by === 'b')).toBe(true);
    const heal = evs.find(e => e.kind === 'heal' && e.on === 'b');
    expect(heal?.kind === 'heal' ? heal.amount : 0)
      .toBe(before.b.maxHp - lowHp);
    expect(w.snapshot().potions.b).toBe(1);            // consumed one
  });

  it('TAUNT emits an event and makes the taunted foe almost always miss', () => {
    const missRate = (bTaunts: boolean) => {
      let swings = 0, misses = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const w = newBattle('shellback', 'psyclone', seed);   // A = shellback attacks; B taunts or not
        w.chooseAction('a', { kind: 'fight', moveId: w.snapshot().a.moves[3]!.id });   // A's strong move
        if (bTaunts) w.chooseAction('b', { kind: 'taunt' });
        else w.chooseAction('b', { kind: 'fight', moveId: w.snapshot().b.moves[0]!.id });
        for (const e of w.drainEvents()) {
          if (e.kind === 'move_used' && e.by === 'a') swings++;
          if (e.kind === 'miss' && e.by === 'a') misses++;
        }
      }
      return misses / swings;
    };
    const w0 = newBattle('shellback', 'psyclone', 1);
    w0.chooseAction('a', { kind: 'fight', moveId: w0.snapshot().a.moves[0]!.id });
    w0.chooseAction('b', { kind: 'taunt' });
    expect(w0.drainEvents().some(e => e.kind === 'taunt' && e.by === 'b')).toBe(true);
    expect(missRate(true)).toBeGreaterThan(0.9);
    expect(missRate(true)).toBeLessThan(0.99);
    expect(missRate(false)).toBeLessThan(0.35);
  });

  it('TAUNT persists until the next attack in the live sequential flow', () => {
    let misses = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const w = newBattle('shellback', 'psyclone', seed);
      expect(w.takeAction('b', { kind: 'taunt' })).toBe(true);
      w.drainEvents();
      expect(w.takeAction('a', { kind: 'fight', moveId: w.snapshot().a.moves[3]!.id })).toBe(true);
      if (w.drainEvents().some(event => event.kind === 'miss' && event.by === 'a')) misses++;
    }
    expect(misses).toBeGreaterThan(180);
  });

  it('paired GUARD and TAUNT remain active until an attack consumes them', () => {
    const guarded = newBattle('embertail', 'shellback', 77);
    guarded.chooseAction('a', { kind: 'item', item: 'potion' });
    guarded.chooseAction('b', { kind: 'guard' });
    expect(guarded.snapshot().b.guarding).toBe(true);
    guarded.chooseAction('a', { kind: 'fight', moveId: guarded.snapshot().a.moves[2]!.id });
    guarded.chooseAction('b', { kind: 'item', item: 'potion' });
    expect(guarded.snapshot().b.guarding).toBe(false);

    const taunted = newBattle('shellback', 'psyclone', 78);
    taunted.chooseAction('a', { kind: 'guard' });
    taunted.chooseAction('b', { kind: 'taunt' });
    expect(taunted.snapshot().a.taunted).toBe(true);
    taunted.chooseAction('a', { kind: 'fight', moveId: taunted.snapshot().a.moves[3]!.id });
    taunted.chooseAction('b', { kind: 'guard' });
    expect(taunted.snapshot().a.taunted).toBe(false);
  });
});
