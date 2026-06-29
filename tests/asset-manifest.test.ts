import { describe, it, expect } from 'vitest';
import { parseManifest, serializeManifest, EMPTY_MANIFEST } from '../shared/asset-manifest';

describe('parseManifest', () => {
  it('parses a full valid manifest', () => {
    const m = parseManifest(JSON.stringify({
      cars: [{ file: 'a.glb', scale: 1.2, rotation: [0,90,0], offset: [0,0,0] }],
      barrier: { file: 'b.glb' }, boostPad: { file: 'c.glb' },
      props: [{ file: 'tree.glb' }],
    }));
    expect(m.cars[0]!.file).toBe('a.glb');
    expect(m.cars[0]!.scale).toBe(1.2);
    expect(m.barrier!.file).toBe('b.glb');
    expect(m.props).toHaveLength(1);
  });
  it('returns EMPTY_MANIFEST for malformed JSON', () => {
    expect(parseManifest('{not json')).toEqual(EMPTY_MANIFEST);
  });
  it('drops AssetRefs missing a file string', () => {
    const m = parseManifest(JSON.stringify({ cars: [{ scale: 1 }, { file: 'ok.glb' }] }));
    expect(m.cars).toHaveLength(1);
    expect(m.cars[0]!.file).toBe('ok.glb');
  });
  it('coerces missing role arrays/objects to defaults', () => {
    const m = parseManifest(JSON.stringify({ cars: [{ file: 'a.glb' }] }));
    expect(m.barrier).toBeNull();
    expect(m.boostPad).toBeNull();
    expect(m.props).toEqual([]);
  });
  it('ignores bad-typed optional fields (rotation not a triple)', () => {
    const m = parseManifest(JSON.stringify({ cars: [{ file: 'a.glb', rotation: 'nope', scale: 'x' }] }));
    expect(m.cars[0]!.rotation).toBeUndefined();
    expect(m.cars[0]!.scale).toBeUndefined();
  });
  it('round-trips through serialize', () => {
    const m = parseManifest(JSON.stringify({ cars: [{ file: 'a.glb', scale: 2 }], barrier: null, boostPad: null, props: [] }));
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });
  it('parses the per-model animate flag (opt-in; absent/false => undefined)', () => {
    const m = parseManifest(JSON.stringify({ cars: [
      { file: 'on.glb', animate: true },
      { file: 'off.glb', animate: false },
      { file: 'absent.glb' },
    ] }));
    expect(m.cars[0]!.animate).toBe(true);
    expect(m.cars[1]!.animate).toBeUndefined();   // false is not persisted (default)
    expect(m.cars[2]!.animate).toBeUndefined();
    expect(parseManifest(serializeManifest(m))).toEqual(m);   // round-trips
  });
});
