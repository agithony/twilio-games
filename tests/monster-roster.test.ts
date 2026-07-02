// The 8 original Voice Monsters creatures + their moves. All original designs/names (archetype
// homages: an electric rodent, a fire drake, etc.) — no Pokémon data. This pins the roster's shape
// + balance invariants so future tweaks can't silently break the game.
import { describe, it, expect } from 'vitest';
import { ROSTER, moveById, monsterById } from '../shared/monster-roster';
import { MONSTER_TYPES } from '../shared/monster-types';

describe('monster roster', () => {
  it('has 8 creatures with unique ids + display names', () => {
    expect(ROSTER).toHaveLength(8);
    expect(new Set(ROSTER.map(m => m.id)).size).toBe(8);
    expect(new Set(ROSTER.map(m => m.name)).size).toBe(8);
  });

  it('every creature has a valid type + sane base stats', () => {
    for (const m of ROSTER) {
      expect(MONSTER_TYPES).toContain(m.type);
      expect(m.maxHp).toBeGreaterThanOrEqual(40);
      expect(m.maxHp).toBeLessThanOrEqual(120);
      for (const s of [m.attack, m.defense, m.speed]) {
        expect(s).toBeGreaterThanOrEqual(20);
        expect(s).toBeLessThanOrEqual(120);
      }
    }
  });

  it('every creature has exactly 4 moves', () => {
    for (const m of ROSTER) expect(m.moves).toHaveLength(4);
  });

  it('every move has a valid type + non-negative power (0 = status move) + unique id', () => {
    const seen = new Set<string>();
    for (const m of ROSTER) {
      for (const mv of m.moves) {
        expect(MONSTER_TYPES).toContain(mv.type);
        expect(mv.power).toBeGreaterThanOrEqual(0);
        expect(mv.power).toBeLessThanOrEqual(120);
        expect(mv.name.length).toBeGreaterThan(0);
        seen.add(mv.id);
      }
    }
    // move ids are globally unique so voice/AI can reference them unambiguously
    const total = ROSTER.reduce((n, m) => n + m.moves.length, 0);
    expect(seen.size).toBe(total);
  });

  it('every creature knows at least one move of its OWN type (STAB is possible)', () => {
    for (const m of ROSTER) {
      expect(m.moves.some(mv => mv.type === m.type)).toBe(true);
    }
  });

  it('the roster spans several distinct types (variety, not all one element)', () => {
    expect(new Set(ROSTER.map(m => m.type)).size).toBeGreaterThanOrEqual(5);
  });

  it('monsterById / moveById look things up (and return null for unknown)', () => {
    const first = ROSTER[0]!;
    expect(monsterById(first.id)?.name).toBe(first.name);
    expect(monsterById('nope')).toBeNull();
    const mv = first.moves[0]!;
    expect(moveById(mv.id)?.name).toBe(mv.name);
    expect(moveById('nope')).toBeNull();
  });
});
