// Move accuracy: the risk/reward axis that gives weaker moves a reason to exist. Derived from a
// move's base power (no roster edits) — the harder it hits, the likelier it misses. Pure + shared so
// the sim (miss roll) and the client (menu %) agree on one number.
import { describe, it, expect } from 'vitest';
import { moveAccuracy } from '../shared/move-stats';

describe('moveAccuracy', () => {
  it('the weakest damaging moves (pow 40) are dead reliable (100%)', () => {
    expect(moveAccuracy(40)).toBeCloseTo(1.0, 5);
  });

  it('the strongest moves (pow 90) are a real gamble (~75%)', () => {
    expect(moveAccuracy(90)).toBeCloseTo(0.75, 5);
  });

  it('is monotonic — a stronger move is never MORE accurate than a weaker one', () => {
    let prev = Infinity;
    for (const p of [40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]) {
      const acc = moveAccuracy(p);
      expect(acc).toBeLessThanOrEqual(prev);
      prev = acc;
    }
  });

  it('stays within [0.7, 1.0] even for out-of-range power', () => {
    expect(moveAccuracy(200)).toBeGreaterThanOrEqual(0.7);
    expect(moveAccuracy(200)).toBeLessThanOrEqual(1.0);
    expect(moveAccuracy(10)).toBeLessThanOrEqual(1.0);
  });

  it('a 0-power (status) move always lands', () => {
    expect(moveAccuracy(0)).toBe(1.0);
  });
});
