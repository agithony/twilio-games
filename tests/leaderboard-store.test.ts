import { describe, it, expect } from 'vitest';
import { appendResults, topEntries, parseLeaderboard, type LeaderboardEntry } from '../shared/leaderboard-store';
import type { RaceResult } from '../shared/types';

const results = (rs: Partial<RaceResult>[]): RaceResult[] =>
  rs.map((r, i) => ({ playerId: r.playerId ?? `p${i}`, name: r.name ?? `P${i}`,
    carIndex: r.carIndex ?? 0, place: r.place ?? i + 1, finishT: r.finishT ?? 10 + i,
    finished: r.finished ?? true }));

describe('appendResults', () => {
  it('starts from empty and records finished racers with map + timestamp', () => {
    const out = appendResults('', { map: 'Silver Lake', results: results([{ name: 'Ada', finishT: 42.5 }]), at: 1000 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({ name: 'Ada', map: 'Silver Lake', finishT: 42.5, at: 1000 });
  });

  it('skips DNF (unfinished) racers — only real times go on the board', () => {
    const out = appendResults('', { map: 'Silver Lake', at: 1,
      results: results([{ name: 'Ada', finished: true, finishT: 30 }, { name: 'Rex', finished: false, finishT: 0 }]) });
    expect(out.ok && out.entries.map(e => e.name)).toEqual(['Ada']);
  });

  it('appends onto an existing board (newest plus old)', () => {
    const first = appendResults('', { map: 'M', results: results([{ name: 'A', finishT: 10 }]), at: 1 });
    if (!first.ok) throw new Error();
    const second = appendResults(JSON.stringify(first.entries), { map: 'M', results: results([{ name: 'B', finishT: 9 }]), at: 2 });
    expect(second.ok && second.entries.map(e => e.name).sort()).toEqual(['A', 'B']);
  });

  it('refuses to proceed (and does not wipe) if the existing file is corrupt', () => {
    const out = appendResults('{ this is : not json', { map: 'M', results: results([{ name: 'A' }]), at: 1 });
    expect(out.ok).toBe(false);
  });

  it('caps the stored history so the file cannot grow without bound', () => {
    let json = '';
    for (let i = 0; i < 1200; i++) {
      const out = appendResults(json, { map: 'M', results: results([{ name: 'P' + i, finishT: i + 1 }]), at: i });
      if (!out.ok) throw new Error('append failed');
      json = JSON.stringify(out.entries);
    }
    expect(parseLeaderboard(json).length).toBeLessThanOrEqual(1000);
  });

  it('ignores unsafe/garbage entries in the existing file', () => {
    const out = appendResults(JSON.stringify([{ junk: true }, { name: 'Real', map: 'M', finishT: 5, at: 1, carIndex: 0 }]),
      { map: 'M', results: results([{ name: 'New', finishT: 6 }]), at: 2 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entries.map(e => e.name).sort()).toEqual(['New', 'Real']);
  });
});

describe('topEntries', () => {
  const board: LeaderboardEntry[] = [
    { name: 'A', map: 'Silver Lake', carIndex: 0, finishT: 50, at: 1 },
    { name: 'B', map: 'Silver Lake', carIndex: 1, finishT: 40, at: 2 },
    { name: 'C', map: 'Neon City',  carIndex: 2, finishT: 30, at: 3 },
    { name: 'D', map: 'Silver Lake', carIndex: 3, finishT: 45, at: 4 },
  ];

  it('returns global best times ascending, limited', () => {
    const top = topEntries(board, { limit: 2 });
    expect(top.map(e => e.name)).toEqual(['C', 'B']);   // 30, 40
  });

  it('filters by map when asked', () => {
    const top = topEntries(board, { map: 'Silver Lake', limit: 10 });
    expect(top.map(e => e.name)).toEqual(['B', 'D', 'A']);   // 40, 45, 50
  });
});
