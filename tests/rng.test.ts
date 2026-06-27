import { describe, it, expect } from 'vitest';
import { Rng } from '../shared/rng';

describe('Rng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Rng(42), b = new Rng(42);
    const seqA = [a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next()];
    expect(seqA).toEqual(seqB);
  });
  it('produces values in [0,1)', () => {
    const r = new Rng(1);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('int(n) returns integers in [0,n)', () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(3);
    }
  });
  it('different seeds differ', () => {
    expect(new Rng(1).next()).not.toEqual(new Rng(2).next());
  });
});
