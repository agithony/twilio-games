import { describe, it, expect } from 'vitest';
import { commentaryFor } from '../client/commentary';
import type { GameEvent } from '../shared/types';

describe('commentaryFor', () => {
  it('go is an energetic non-empty line', () => {
    const s = commentaryFor({ kind: 'go' }, 0);
    expect(s).toBeTruthy();
    expect(typeof s).toBe('string');
  });
  it('lead_change names the new leader', () => {
    const s = commentaryFor({ kind: 'lead_change', playerId: 'p2', name: 'Ada' }, 0)!;
    expect(s).toContain('Ada');
  });
  it('finish includes name and place', () => {
    const s = commentaryFor({ kind: 'finish', playerId: 'p1', name: 'Rex', place: 1 }, 0)!;
    expect(s).toContain('Rex');
    expect(s).toMatch(/1|first|1st/i);
  });
  it('hit produces a reaction line', () => {
    expect(commentaryFor({ kind: 'hit', playerId: 'p3' }, 0)).toBeTruthy();
  });
  it('race_over produces a wrap-up line', () => {
    expect(commentaryFor({ kind: 'race_over' }, 0)).toBeTruthy();
  });
  it('varies phrasing by seq for the same kind', () => {
    const a = commentaryFor({ kind: 'go' }, 0);
    const b = commentaryFor({ kind: 'go' }, 1);
    const c = commentaryFor({ kind: 'go' }, 2);
    // at least two of three differ (phrase bank has variety)
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });
  it('per-countdown-tick returns null (big-text already shows the number)', () => {
    expect(commentaryFor({ kind: 'countdown', n: 3 }, 0)).toBeNull();
  });
  it('hit_streak names the player + is a barrier-magnet callout', () => {
    const s = commentaryFor({ kind: 'hit_streak', playerId: 'p1', name: 'Ada', count: 3 }, 0)!;
    expect(s).toContain('Ada');
    expect(s).toMatch(/barrier|wall|gap|aiming/i);
  });
  it('fell_to_last names the player + is an encouraging setback line', () => {
    const s = commentaryFor({ kind: 'fell_to_last', playerId: 'p1', name: 'Rex' }, 0)!;
    expect(s).toContain('Rex');
    expect(s).toMatch(/last|back|climb|rear/i);
  });
  it('narrates the pre-race menu phases (car/map select prompts)', () => {
    expect(commentaryFor({ kind: 'enter_car_select' }, 0)).toMatch(/car|ride|machine/i);
    expect(commentaryFor({ kind: 'enter_map_select' }, 0)).toMatch(/track|course|battleground/i);
  });
  it('reacts playfully to a car pick (names the picker + car) and a map pick', () => {
    const c = commentaryFor({ kind: 'car_picked', playerId: 'p1', name: 'Ada', car: 'McLaren Senna' }, 0)!;
    expect(c).toContain('Ada');
    expect(c).toContain('McLaren Senna');
    const m = commentaryFor({ kind: 'map_picked', map: 'Silver Lake' }, 0)!;
    expect(m).toContain('Silver Lake');
  });
});
