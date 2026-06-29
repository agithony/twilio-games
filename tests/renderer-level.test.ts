// tests/renderer-level.test.ts
// Renderer needs a DOM/WebGL context; in the node test env we only verify the PURE gate logic
// that decides whether zones cycle. Extract that decision into a tiny pure helper and test it.
import { describe, it, expect } from 'vitest';
import { shouldCycleZones } from '../client/zone-gate';
import { levelDefaults, resolveCarScale } from '../shared/level';

describe('shouldCycleZones', () => {
  it('cycles when no per-level lighting is locked', () => {
    expect(shouldCycleZones(false)).toBe(true);
  });
  it('does NOT cycle when a level locked its own lighting', () => {
    expect(shouldCycleZones(true)).toBe(false);
  });
});

describe('renderer car scale (per-model contract)', () => {
  // The game's setCarScale callback is (i) => resolveCarScale(level, assets.carFile(i)); car
  // overrides are keyed by the car MODEL FILENAME, the SAME key the editor's Cars panel writes —
  // so each model can be sized per level. Final size = master × that model's override.
  it('keys car overrides by model filename', () => {
    const l = levelDefaults('m', 'm.glb');
    l.cars.masterScale = 1.5;
    l.cars.overrides['monster_truck.glb'] = 2;
    expect(resolveCarScale(l, 'monster_truck.glb')).toBe(3);   // master 1.5 × override 2
    expect(resolveCarScale(l, 'lotus_elise.glb')).toBe(1.5);   // master only (no override)
  });
});
