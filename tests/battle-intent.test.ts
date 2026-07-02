// Map a caller's spoken utterance to one of the 4 moves the active monster knows. Players SHOUT the
// move name ("Ember!", "Thunder Jolt"), with a number fallback ("two", "move 3"). Reuses the same
// number/fuzzy matching family as the racer's game-host. Pure + testable.
import { describe, it, expect } from 'vitest';
import { matchMove } from '../shared/battle-intent';
import { monsterById } from '../shared/monster-roster';

const moves = monsterById('sparkmouse')!.moves;
// sparkmouse moves: 0 Thunder Jolt, 1 Static Zap, 2 Quick Bite, 3 Tackle
const names = moves.map(m => m.name);

describe('matchMove', () => {
  it('matches a full move name', () => {
    expect(matchMove('Thunder Jolt', names)).toBe(0);
    expect(matchMove('quick bite', names)).toBe(2);
  });

  it('matches a distinctive partial / single keyword', () => {
    expect(matchMove('jolt', names)).toBe(0);
    expect(matchMove('use tackle!', names)).toBe(3);
    expect(matchMove('zap them', names)).toBe(1);
  });

  it('matches by NUMBER (digit + word + ordinal)', () => {
    expect(matchMove('one', names)).toBe(0);
    expect(matchMove('move 3', names)).toBe(2);
    expect(matchMove('the second one', names)).toBe(1);
    expect(matchMove('4', names)).toBe(3);
  });

  it('returns -1 when nothing plausibly matches', () => {
    expect(matchMove('banana', names)).toBe(-1);
    expect(matchMove('', names)).toBe(-1);
  });

  it('out-of-range numbers do not match', () => {
    expect(matchMove('move 9', names)).toBe(-1);
  });

  it('prefers an explicit number over an incidental name word', () => {
    // "give me two" → index 1 by number, even though no name says "two"
    expect(matchMove('give me two', names)).toBe(1);
  });
});
