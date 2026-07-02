import { describe, it, expect } from 'vitest';
import { hpFraction, hpZone, hpColor } from '../client/battle/hp-bar';

describe('hp-bar', () => {
  it('hpFraction clamps to [0,1] and guards divide-by-zero', () => {
    expect(hpFraction(50, 100)).toBe(0.5);
    expect(hpFraction(0, 100)).toBe(0);
    expect(hpFraction(200, 100)).toBe(1);      // overshoot clamped
    expect(hpFraction(-5, 100)).toBe(0);       // negative clamped
    expect(hpFraction(10, 0)).toBe(0);         // no divide-by-zero
  });

  it('hpZone shifts at the classic 50% / 20% breakpoints', () => {
    expect(hpZone(1)).toBe('high');
    expect(hpZone(0.51)).toBe('high');
    expect(hpZone(0.5)).toBe('mid');           // exactly half → caution
    expect(hpZone(0.21)).toBe('mid');
    expect(hpZone(0.2)).toBe('low');           // exactly 20% → danger
    expect(hpZone(0)).toBe('low');
  });

  it('hpColor maps each zone to a distinct color', () => {
    const colors = new Set([hpColor('high'), hpColor('mid'), hpColor('low')]);
    expect(colors.size).toBe(3);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
