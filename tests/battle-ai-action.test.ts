// Single-player AI action-chooser: pickAiAction decides the CPU's FULL turn action each turn —
// mostly FIGHT (the default), but ITEM (Potion) as a low-HP comeback, an occasional GUARD when low
// and out of potions, and an occasional opportunistic TAUNT when healthy. Pure + deterministic given
// the rng (server-authoritative). These tests pin those behaviors + the "never an invalid action"
// invariant (e.g. no ITEM when out of potions).
import { describe, it, expect } from 'vitest';
import { pickAiAction } from '../shared/battle-ai';
import type { BattleAction } from '../shared/battle-world';
import { monsterById } from '../shared/monster-roster';
import { Rng } from '../shared/rng';

const SELF = monsterById('embertail')!;    // fire drake
const FOE = monsterById('thornling')!;      // grass sprout (embertail's fire is 2x vs it)

/** Tally the action kinds pickAiAction returns across many seeds for a fixed situation. */
function kindCounts(hp: number, maxHp: number, potions: number, foe = FOE, self = SELF): Record<string, number> {
  const counts: Record<string, number> = { fight: 0, guard: 0, item: 0, taunt: 0 };
  for (let s = 0; s < 400; s++) {
    const a = pickAiAction(self, hp, maxHp, foe, potions, new Rng(s * 13 + 1));
    counts[a.kind]!++;
  }
  return counts;
}

describe('pickAiAction', () => {
  it('is deterministic for a given rng seed', () => {
    const a = () => pickAiAction(SELF, 40, SELF.maxHp, FOE, 2, new Rng(42));
    expect(a()).toEqual(a());
  });

  it('always returns a VALID action (never ITEM when out of potions, always a known move on FIGHT)', () => {
    for (let potions = 0; potions <= 2; potions++) {
      for (const hp of [SELF.maxHp, SELF.maxHp * 0.5, SELF.maxHp * 0.15]) {
        for (let s = 0; s < 200; s++) {
          const act = pickAiAction(SELF, hp, SELF.maxHp, FOE, potions, new Rng(s * 7 + 3));
          if (act.kind === 'item') expect(potions).toBeGreaterThan(0);   // never conjure a potion
          if (act.kind === 'fight') expect(SELF.moves.some(m => m.id === (act as { moveId: string }).moveId)).toBe(true);
        }
      }
    }
  });

  it('at healthy HP it MOSTLY fights (attacking stays the default)', () => {
    const c = kindCounts(SELF.maxHp, SELF.maxHp, 2);   // full HP, potions available
    expect(c.fight).toBeGreaterThan(400 * 0.7);        // fight is the clear majority
    expect(c.item).toBe(0);                            // no reason to heal at full HP
  });

  it('low HP WITH a potion → strongly favors ITEM (the comeback play)', () => {
    const c = kindCounts(SELF.maxHp * 0.2, SELF.maxHp, 2);   // ~20% HP, has potions
    expect(c.item).toBeGreaterThan(400 * 0.6);              // usually drinks the potion
  });

  it('low HP with NO potion never returns ITEM, and may GUARD to brace', () => {
    const c = kindCounts(SELF.maxHp * 0.2, SELF.maxHp, 0);   // ~20% HP, out of potions
    expect(c.item).toBe(0);                                  // can't — no potion
    expect(c.guard).toBeGreaterThan(0);                     // braces at least sometimes
    expect(c.fight).toBeGreaterThan(0);                     // but still mostly fights
  });

  it('GUARD stays a MINORITY even when low + out of potions (battles must not stall)', () => {
    const c = kindCounts(SELF.maxHp * 0.2, SELF.maxHp, 0);
    expect(c.guard).toBeLessThan(400 * 0.5);   // never the default → no stalling
  });

  it('TAUNT is only an occasional healthy-HP play, never dominant', () => {
    const c = kindCounts(SELF.maxHp, SELF.maxHp, 2);
    expect(c.taunt).toBeGreaterThan(0);            // it DOES taunt sometimes when healthy
    expect(c.taunt).toBeLessThan(400 * 0.3);       // but it's a minority (fight stays default)
  });

  it('the FIGHT branch reuses pickAiMove (super-effective preference still holds)', () => {
    // embertail (fire) vs thornling (grass): whenever it fights, it should favor a fire move.
    let fights = 0, fireFights = 0;
    for (let s = 0; s < 300; s++) {
      const act = pickAiAction(SELF, SELF.maxHp, SELF.maxHp, FOE, 0, new Rng(s * 5 + 2));
      if (act.kind === 'fight') {
        fights++;
        if (SELF.moves.find(m => m.id === (act as { moveId: string }).moveId)!.type === 'fire') fireFights++;
      }
    }
    expect(fights).toBeGreaterThan(0);
    expect(fireFights / fights).toBeGreaterThan(0.8);   // strong super-effective preference intact
  });
});

// Type sanity: pickAiAction returns a BattleAction (compile-time check).
const _typecheck: BattleAction = pickAiAction(SELF, 10, SELF.maxHp, FOE, 1, new Rng(1));
void _typecheck;
