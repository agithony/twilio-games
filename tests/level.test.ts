// tests/level.test.ts
import { describe, it, expect } from 'vitest';
import { levelDefaults, mergeLevel, resolveCarScale, resolveItemScale, addProp, duplicateProp, removeProp,
         DEFAULT_LIGHTING, DEFAULT_EFFECTS } from '../shared/level';

describe('levelDefaults', () => {
  it('produces a full, sane level', () => {
    const l = levelDefaults('silver_lake', 'silver_lake.glb');
    expect(l.map).toBe('silver_lake');
    expect(l.file).toBe('silver_lake.glb');
    expect(l.cars.masterScale).toBe(1);
    expect(l.cars.overrides).toEqual({});
    expect(l.props).toEqual([]);
    expect(l.track.scale).toBe(1);
  });
});

describe('mergeLevel (back-compat)', () => {
  it('fills missing fields from a legacy {file,model,track,path}-only config', () => {
    const legacy = { map: 'silver_lake', file: 'silver_lake.glb',
      model: { pos: [1,2,3], rotDeg: [0,0,0], scale: 200 },
      track: { pos: [0,0,1050], rotDeg: [0,0,0], scale: 1 },
      path: { points: [[0,0],[0,2100]] } };
    const l = mergeLevel(legacy);
    expect(l.model.scale).toBe(200);          // preserved
    expect(l.cars.masterScale).toBe(1);        // filled
    expect(l.props).toEqual([]);               // filled
    expect(l.lighting).toBeUndefined();        // not set → zones stay (per spec)
    expect(l.path?.points.length).toBe(2);     // preserved
  });
  it('preserves saved lighting/effects when present', () => {
    const saved = { map: 'm', file: 'm.glb', model: levelDefaults('m','m.glb').model,
      track: levelDefaults('m','m.glb').track,
      lighting: { ...DEFAULT_LIGHTING, sunIntensity: 3 },
      effects: { ...DEFAULT_EFFECTS, trackEmissive: 2 } };
    const l = mergeLevel(saved);
    expect(l.lighting!.sunIntensity).toBe(3);
    expect(l.effects!.trackEmissive).toBe(2);
  });
  it('returns defaults for junk input', () => {
    const l = mergeLevel(null);
    expect(l.cars.masterScale).toBe(1);
    expect(typeof l.file).toBe('string');
  });

  it('round-trips start/finish gantry offsets when present', () => {
    const saved = { map: 'm', file: 'm.glb',
      model: levelDefaults('m','m.glb').model, track: levelDefaults('m','m.glb').track,
      startLine: { pos: [1, 2, 3], rotDeg: [0, 90, 0], scale: 1.5 },
      finishLine: { pos: [-4, 0, 2100], rotDeg: [0, 0, 0], scale: 2 } };
    const l = mergeLevel(saved);
    expect(l.startLine).toEqual({ pos: [1, 2, 3], rotDeg: [0, 90, 0], scale: 1.5 });
    expect(l.finishLine).toEqual({ pos: [-4, 0, 2100], rotDeg: [0, 0, 0], scale: 2 });
  });

  it('leaves gantry offsets undefined when not authored (auto-placed default)', () => {
    const l = mergeLevel({ map: 'm', file: 'm.glb',
      model: levelDefaults('m','m.glb').model, track: levelDefaults('m','m.glb').track });
    expect(l.startLine).toBeUndefined();
    expect(l.finishLine).toBeUndefined();
  });

  it('round-trips per-level obstacle/boost scales when present', () => {
    const l = mergeLevel({ map: 'm', file: 'm.glb',
      model: levelDefaults('m','m.glb').model, track: levelDefaults('m','m.glb').track,
      obstacles: { barrierScale: 2.5, boostScale: 0.5 } });
    expect(l.obstacles).toEqual({ barrierScale: 2.5, boostScale: 0.5 });
  });

  it('leaves obstacles undefined when not authored', () => {
    const l = mergeLevel({ map: 'm', file: 'm.glb',
      model: levelDefaults('m','m.glb').model, track: levelDefaults('m','m.glb').track });
    expect(l.obstacles).toBeUndefined();
  });
});

describe('resolveItemScale', () => {
  it('defaults to 1 when no per-level override', () => {
    const l = levelDefaults('m', 'm.glb');
    expect(resolveItemScale(l, 'barrier')).toBe(1);
    expect(resolveItemScale(l, 'boost')).toBe(1);
  });
  it('returns the per-level multiplier for each kind', () => {
    const l = levelDefaults('m', 'm.glb');
    l.obstacles = { barrierScale: 3, boostScale: 0.4 };
    expect(resolveItemScale(l, 'barrier')).toBe(3);
    expect(resolveItemScale(l, 'boost')).toBe(0.4);
  });
  it('falls back to 1 for a kind with no value set', () => {
    const l = levelDefaults('m', 'm.glb');
    l.obstacles = { barrierScale: 3 };
    expect(resolveItemScale(l, 'boost')).toBe(1);
  });
});

describe('resolveCarScale', () => {
  it('multiplies master by per-car override', () => {
    const l = levelDefaults('m','m.glb');
    l.cars.masterScale = 2; l.cars.overrides = { 'a.glb': 1.5 };
    expect(resolveCarScale(l, 'a.glb')).toBe(3);
    expect(resolveCarScale(l, 'b.glb')).toBe(2);   // no override → master only
  });
});

describe('prop helpers (immutable)', () => {
  it('adds, duplicates, and removes props returning new objects', () => {
    const l0 = levelDefaults('m','m.glb');
    const l1 = addProp(l0, 'tree.glb', [10, 0, 20]);
    expect(l0.props.length).toBe(0);             // original untouched
    expect(l1.props.length).toBe(1);
    expect(l1.props[0]!.file).toBe('tree.glb');
    const id = l1.props[0]!.id;
    const l2 = duplicateProp(l1, id);
    expect(l2.props.length).toBe(2);
    expect(l2.props[1]!.id).not.toBe(id);
    expect(l2.props[1]!.pos).toEqual([18, 0, 28]); // offset by [8,0,8]
    const l3 = removeProp(l2, id);
    expect(l3.props.length).toBe(1);
    expect(l3.props.find(p => p.id === id)).toBeUndefined();
  });
});
