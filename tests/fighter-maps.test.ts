import { describe, expect, it } from 'vitest';
import { parseFighterMaps } from '../shared/fighter-maps';

const valid = () => ({ id: 'arena-one', name: 'Arena One', blurb: 'A safe arena.', color: '#ef223a', bounds: [-9, 9],
  file: 'arena.glb', pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1,
  fightPlane: { origin: [0, 0, 0], rotationY: 0 }, camera: { pos: [0, 2, 10], lookAt: [0, 1, 0], fov: 36 } });

describe('fighter map catalog validation', () => {
  it('accepts and normalizes a valid catalog', () => {
    expect(parseFighterMaps([valid()])[0]).toMatchObject({ id: 'arena-one', bounds: [-9, 9], file: 'arena.glb' });
  });
  it.each([
    [{ ...valid(), id: '<script>' }],
    [{ ...valid(), bounds: [4, -4] }],
    [{ ...valid(), bounds: [0, 1] }],
    [{ ...valid(), file: '../secret.glb' }],
    [{ ...valid(), preview: 'javascript:alert(1)' }],
    [{ ...valid(), scale: Number.POSITIVE_INFINITY }],
    [valid(), valid()],
  ])('rejects unsafe or malformed catalogs', (...maps) => {
    expect(() => parseFighterMaps(maps)).toThrow();
  });
});
