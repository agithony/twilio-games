// The move-menu display helpers for the Game Boy command window. Pure (no canvas), so the power
// indicator + text fitting are unit-testable. Fixes two reported bugs: (1) the raw base-power number
// ("55") is meaningless to a player — it maps to neither the HP bars nor the ~1/6-bar damage the
// tuned formula actually deals — so we show a normalized 1–5 "power" rating instead; (2) long move
// names / labels clipped off the 160px window, so names are truncated to a safe width.
import { describe, it, expect } from 'vitest';
import { powerPips, fitMoveName } from '../client/battle/move-menu';

describe('powerPips', () => {
  it('a status/0-power move has no pips', () => {
    expect(powerPips(0)).toBe(0);
  });

  it('maps the roster power range (40..90) onto 1..5 pips', () => {
    // weakest damaging moves → 1 pip; strongest → 5 pips; never 0 for a damaging move
    expect(powerPips(40)).toBe(1);
    expect(powerPips(90)).toBe(5);
    for (const p of [40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]) {
      const pips = powerPips(p);
      expect(pips).toBeGreaterThanOrEqual(1);
      expect(pips).toBeLessThanOrEqual(5);
    }
  });

  it('is monotonic — a stronger move never shows fewer pips', () => {
    let prev = 0;
    for (const p of [40, 50, 60, 70, 80, 90]) {
      const pips = powerPips(p);
      expect(pips).toBeGreaterThanOrEqual(prev);
      prev = pips;
    }
  });

  it('clamps out-of-range power into 1..5', () => {
    expect(powerPips(200)).toBe(5);
    expect(powerPips(1)).toBe(1);
  });
});

describe('fitMoveName', () => {
  it('leaves a short name unchanged', () => {
    expect(fitMoveName('Ember', 10)).toBe('Ember');
  });

  it('truncates an over-long name so it fits (with an ellipsis marker)', () => {
    const out = fitMoveName('Thunderbolt Cannon', 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('.')).toBe(true);   // shows it was cut
  });
});
