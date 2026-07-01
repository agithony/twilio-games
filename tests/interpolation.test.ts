import { describe, it, expect } from 'vitest';
import { InterpolationBuffer } from '../client/interpolation';
import type { WorldSnapshot } from '../shared/types';

function snap(tick: number, z: number): WorldSnapshot {
  return { tick, t: tick / 60, phase: 'racing', countdown: 0,
    cars: [{ id: 'p1', name: 'You', color: '#fff', carIndex: 0, lane: 0, targetLane: 0, x: 0, z,
      speed: 38, boost: 0, power: 1, powerActive: 0, stunned: 0, lap: 1,
      finished: false, finishT: 0, place: 1 }], items: [], consumedItems: [] };
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
  it('EXTRAPOLATES forward when render runs past the newest snapshot (hides a late packet)', () => {
    const b = new InterpolationBuffer(0);   // 0 delay so target == renderT for clarity
    b.push(snap(1, 0),   1000);
    b.push(snap(2, 100), 1100);   // speed = 100 units / 100ms
    // render at 1150ms → 50ms past the last snapshot → project half a span forward → z≈150
    const s = b.sample(1150)!;
    expect(s.cars[0]!.z).toBeCloseTo(150, 0);
  });
  it('caps extrapolation at one snapshot span (no fling on a long gap)', () => {
    const b = new InterpolationBuffer(0);
    b.push(snap(1, 0),   1000);
    b.push(snap(2, 100), 1100);
    // render 500ms past last → capped at one span (100ms) → z at most ≈200, not 600
    const s = b.sample(1600)!;
    expect(s.cars[0]!.z).toBeCloseTo(200, 0);
  });
});
