// Single-player AI: pick a move for the CPU each turn. Type-aware — it favors the move that will do
// the most damage against the current opponent (super-effective when available), with a little rng so
// it's not perfectly predictable. Pure + testable.
import { describe, it, expect } from 'vitest';
import { pickAiMove } from '../shared/battle-ai';
import { monsterById } from '../shared/monster-roster';
import { Rng } from '../shared/rng';

describe('pickAiMove', () => {
  it('returns a move id the AI monster actually knows', () => {
    const embertail = monsterById('embertail')!;
    const shellback = monsterById('shellback')!;
    const id = pickAiMove(embertail, shellback, new Rng(1));
    expect(embertail.moves.some(m => m.id === id)).toBe(true);
  });

  it('prefers a super-effective move when one exists (fire drake vs grass sprout)', () => {
    const embertail = monsterById('embertail')!;   // has Ember/Flame Whip (fire) — 2x vs grass
    const thornling = monsterById('thornling')!;    // grass
    // Across many rng seeds it should overwhelmingly pick a FIRE move (super-effective), not Scratch.
    let firePicks = 0;
    for (let s = 0; s < 40; s++) {
      const id = pickAiMove(embertail, thornling, new Rng(s * 7 + 1));
      if (embertail.moves.find(m => m.id === id)!.type === 'fire') firePicks++;
    }
    expect(firePicks).toBeGreaterThan(30);   // strong preference for the effective element
  });

  it('is deterministic for a given rng seed', () => {
    const a = monsterById('voltcrest')!, b = monsterById('dazeduck')!;
    expect(pickAiMove(a, b, new Rng(42))).toBe(pickAiMove(a, b, new Rng(42)));
  });
});
