import { describe, it, expect } from 'vitest';
import { InterpolationBuffer } from '../client/interpolation';
import type { WorldSnapshot } from '../shared/types';

function snap(tick: number, z: number): WorldSnapshot {
  return { tick, t: tick / 60, phase: 'racing', countdown: 0,
    cars: [{ id: 'p1', name: 'You', color: '#fff', lane: 0, targetLane: 0, x: 0, z,
      speed: 38, boost: 0, power: 1, powerActive: 0, stunned: 0, lap: 1,
      finished: false, finishT: 0, place: 1 }], items: [] };
}

describe('InterpolationBuffer', () => {
  it('returns null before any snapshot', () => {
    expect(new InterpolationBuffer().sample(1000)).toBeNull();
  });
  it('interpolates car z between two snapshots', () => {
    const b = new InterpolationBuffer(100); // 100ms delay
    b.push(snap(1, 0),   1000);
    b.push(snap(2, 100), 1100);
    // render at 1200ms -> target time 1100ms -> exactly the second snapshot
    const s = b.sample(1200)!;
    expect(s.cars[0]!.z).toBeCloseTo(100, 1);
  });
  it('interpolates to the midpoint', () => {
    const b = new InterpolationBuffer(100);
    b.push(snap(1, 0),   1000);
    b.push(snap(2, 100), 1100);
    // render at 1150ms -> target 1050ms -> halfway between the two
    const s = b.sample(1150)!;
    expect(s.cars[0]!.z).toBeCloseTo(50, 0);
  });
});
