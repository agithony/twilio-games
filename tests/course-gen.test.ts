import { describe, it, expect } from 'vitest';
import { generateCourse, MIN_BARRIER_GAP, type CourseOpts } from '../shared/course-gen';
import { Rng } from '../shared/rng';
import type { Item } from '../shared/types';

const OPTS: CourseOpts = { lanes: 3, startZ: 55, endZ: 2100 };

/** Group items that share the same z (a "row"). */
function rows(items: Item[]): Map<number, Item[]> {
  const m = new Map<number, Item[]>();
  for (const it of items) {
    const r = m.get(it.z) ?? [];
    r.push(it);
    m.set(it.z, r);
  }
  return m;
}

describe('generateCourse', () => {
  it('is deterministic: same seed => identical course', () => {
    const a = generateCourse(new Rng(7), OPTS);
    const b = generateCourse(new Rng(7), OPTS);
    expect(a).toEqual(b);
  });

  it('produces a different course for a different seed', () => {
    const a = generateCourse(new Rng(1), OPTS);
    const b = generateCourse(new Rng(2), OPTS);
    expect(a).not.toEqual(b);
  });

  it('is always solvable: no row blocks every lane with barriers', () => {
    // Check across many seeds — every z-row must leave at least one barrier-free lane.
    for (let seed = 1; seed <= 60; seed++) {
      const items = generateCourse(new Rng(seed), OPTS);
      for (const [, row] of rows(items)) {
        const blocked = new Set(row.filter(i => i.kind === 'barrier').map(i => i.lane));
        expect(blocked.size).toBeLessThan(OPTS.lanes);
      }
    }
  });

  it('never stacks two items in the same lane at the same z', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const items = generateCourse(new Rng(seed), OPTS);
      for (const [, row] of rows(items)) {
        const lanes = row.map(i => i.lane);
        expect(new Set(lanes).size).toBe(lanes.length);
      }
    }
  });

  it('keeps consecutive barrier rows at least MIN_BARRIER_GAP apart (voice reaction runway)', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const items = generateCourse(new Rng(seed), OPTS);
      const barrierZs = [...new Set(items.filter(i => i.kind === 'barrier').map(i => i.z))].sort((a, b) => a - b);
      for (let i = 1; i < barrierZs.length; i++) {
        expect(barrierZs[i]! - barrierZs[i - 1]!).toBeGreaterThanOrEqual(MIN_BARRIER_GAP);
      }
    }
  });

  it('ramps difficulty: more barriers in the final third than the first third', () => {
    // Aggregate over many seeds so the trend is robust, not seed-luck.
    const span = OPTS.endZ - OPTS.startZ;
    const firstCut = OPTS.startZ + span / 3;
    const lastCut = OPTS.startZ + (2 * span) / 3;
    let first = 0, last = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const items = generateCourse(new Rng(seed), OPTS);
      for (const it of items) {
        if (it.kind !== 'barrier') continue;
        if (it.z < firstCut) first++;
        else if (it.z >= lastCut) last++;
      }
    }
    expect(last).toBeGreaterThan(first);
  });

  it('guarantees a boost early so players discover the mechanic', () => {
    const span = OPTS.endZ - OPTS.startZ;
    const earlyCut = OPTS.startZ + span * 0.2;
    for (let seed = 1; seed <= 60; seed++) {
      const items = generateCourse(new Rng(seed), OPTS);
      const earlyBoosts = items.filter(i => i.kind === 'boost' && i.z < earlyCut);
      expect(earlyBoosts.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('emits items in bounds with unique positive ids and valid lanes', () => {
    const items = generateCourse(new Rng(3), OPTS);
    expect(items.length).toBeGreaterThan(0);
    const ids = new Set<number>();
    for (const it of items) {
      expect(it.z).toBeGreaterThanOrEqual(OPTS.startZ);
      expect(it.z).toBeLessThan(OPTS.endZ);
      expect(it.lane).toBeGreaterThanOrEqual(0);
      expect(it.lane).toBeLessThan(OPTS.lanes);
      expect(it.id).toBeGreaterThan(0);
      expect(ids.has(it.id)).toBe(false);
      ids.add(it.id);
    }
  });

  it('keeps the very start clear (no item before startZ)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const items = generateCourse(new Rng(seed), OPTS);
      expect(items.every(i => i.z >= OPTS.startZ)).toBe(true);
    }
  });
});
