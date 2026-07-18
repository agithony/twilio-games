// Type-effectiveness chart for Voice Monsters — a Pokémon-STYLE match-up table (2x super-effective,
// 0.5x resisted, 1x neutral). All original; no Pokémon data. Pure lookup, fully testable.
import { describe, it, expect } from 'vitest';
import { effectivenessLabel, monsterTypeLabel, typeMultiplier, MONSTER_TYPES, type MonsterType } from '../shared/monster-types';

describe('typeMultiplier', () => {
  it('is 1x (neutral) for an unrelated pairing', () => {
    expect(typeMultiplier('electric', 'fire')).toBe(1);
  });

  it('is 2x for the classic super-effective triangle (fire>grass>water>fire)', () => {
    expect(typeMultiplier('fire', 'grass')).toBe(2);
    expect(typeMultiplier('grass', 'water')).toBe(2);
    expect(typeMultiplier('water', 'fire')).toBe(2);
  });

  it('is 0.5x for the resisted reverse of that triangle', () => {
    expect(typeMultiplier('grass', 'fire')).toBe(0.5);
    expect(typeMultiplier('water', 'grass')).toBe(0.5);
    expect(typeMultiplier('fire', 'water')).toBe(0.5);
  });

  it('electric zaps water + flying, but is grounded (weak vs ground defender)', () => {
    expect(typeMultiplier('electric', 'water')).toBe(2);
    expect(typeMultiplier('electric', 'flying')).toBe(2);
    expect(typeMultiplier('electric', 'ground')).toBe(0.5);
  });

  it('psychic overwhelms brute types (normal + flying) but is dulled by solid rock', () => {
    expect(typeMultiplier('psychic', 'normal')).toBe(2);
    expect(typeMultiplier('psychic', 'flying')).toBe(2);
    expect(typeMultiplier('psychic', 'rock')).toBe(0.5);
  });

  it('every attacking type has a defined multiplier vs every defending type', () => {
    for (const atk of MONSTER_TYPES) {
      for (const def of MONSTER_TYPES) {
        const m = typeMultiplier(atk as MonsterType, def as MonsterType);
        expect([0.5, 1, 2]).toContain(m);
      }
    }
  });

  it('exposes exactly 9 types', () => {
    expect(MONSTER_TYPES).toHaveLength(9);
    expect(new Set(MONSTER_TYPES).size).toBe(9);
  });
});

describe('localized type labels', () => {
  it('keeps English defaults and provides Brazilian Portuguese labels', () => {
    expect(monsterTypeLabel('water')).toBe('water');
    expect(monsterTypeLabel('water', 'pt-BR')).toBe('água');
    expect(monsterTypeLabel('psychic', 'pt-BR')).toBe('psíquico');
    expect(effectivenessLabel(2, 'pt-BR')).toMatch(/eficaz/i);
    expect(effectivenessLabel(0.5, 'pt-BR')).toMatch(/não.*eficaz/i);
  });
});
