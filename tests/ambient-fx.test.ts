// The pure color helper behind the outer background flash (AmbientFx). The canvas/loop itself is DOM
// and not unit-tested, but the hex→rgba conversion + alpha clamp is pure, so we pin it.
import { describe, it, expect } from 'vitest';
import { hexA } from '../client/battle/ambient-fx';

describe('hexA', () => {
  it('converts a #rrggbb hex + alpha to rgba()', () => {
    expect(hexA('#ff6b3d', 0.5)).toBe('rgba(255,107,61,0.500)');
    expect(hexA('#3f9be0', 1)).toBe('rgba(63,155,224,1.000)');
  });

  it('clamps alpha into [0,1]', () => {
    expect(hexA('#ffffff', 2)).toBe('rgba(255,255,255,1.000)');
    expect(hexA('#000000', -1)).toBe('rgba(0,0,0,0.000)');
  });
});
