import { describe, it, expect } from 'vitest';
import { frameField, MAX_FIELD_SPREAD, type FieldCameraBase } from '../client/field-camera';

const BASE: FieldCameraBase = { behind: 24, height: 9, lookAhead: 45, lookHeight: 2.2, lateral: 10 };

describe('frameField', () => {
  it('a bunched pack frames like the classic chase cam (no extra pull-back)', () => {
    // All cars at the same z → spread 0 → eye = back - behind, height unchanged.
    const cars = [{ x: 0, z: 100 }, { x: 4, z: 100 }, { x: -4, z: 100 }];
    const p = frameField(cars, BASE);
    expect(p.eyeZ).toBeCloseTo(100 - 24);   // back(100) - behind(24)
    expect(p.eyeY).toBeCloseTo(9);          // no spread → base height
  });

  it('keeps the WHOLE field on-screen: eye is behind the trailing car, look ahead of the leader', () => {
    const cars = [{ x: 0, z: 50 }, { x: 0, z: 90 }, { x: 0, z: 130 }];  // back 50, front 130
    const p = frameField(cars, BASE);
    expect(p.eyeZ).toBeLessThan(50);                 // behind the trailing car
    expect(p.lookZ).toBeGreaterThan(130);            // looking past the leader
  });

  it('pulls back AND rises as the field spreads', () => {
    const tight = frameField([{ x: 0, z: 100 }, { x: 0, z: 110 }], BASE);
    const wide = frameField([{ x: 0, z: 100 }, { x: 0, z: 200 }], BASE);
    // Wider spread → eye further back (smaller eyeZ relative to its own back) and higher.
    expect(wide.eyeY).toBeGreaterThan(tight.eyeY);
    // distance from eye to the trailing car grows with spread
    const tightGap = 100 - tight.eyeZ, wideGap = 100 - wide.eyeZ;
    expect(wideGap).toBeGreaterThan(tightGap);
  });

  it('does NOT chase the leader: moving only the leader forward keeps the trailing car framed', () => {
    const a = frameField([{ x: 0, z: 100 }, { x: 0, z: 120 }], BASE);
    const b = frameField([{ x: 0, z: 100 }, { x: 0, z: 300 }], BASE);  // leader sprints away
    // The trailing car at z=100 must remain visible: eye stays behind z=100 in both.
    expect(a.eyeZ).toBeLessThan(100);
    expect(b.eyeZ).toBeLessThan(100);
  });

  it('clamps an extreme straggler so the shot never blows out past MAX_FIELD_SPREAD', () => {
    const cars = [{ x: 0, z: 0 }, { x: 0, z: 1000 }];  // 1000 apart — absurd
    const p = frameField(cars, BASE);
    // Effective back is clamped to front - MAX_FIELD_SPREAD = 840, not 0.
    const effectiveBack = 1000 - MAX_FIELD_SPREAD;
    expect(p.eyeZ).toBeGreaterThan(effectiveBack - BASE.behind - MAX_FIELD_SPREAD - 1);
    expect(p.eyeZ).toBeLessThan(effectiveBack);   // still behind the clamped back
  });

  it('centers laterally on the field average', () => {
    const p = frameField([{ x: 8, z: 100 }, { x: -8, z: 100 }], BASE);
    expect(p.lookX).toBeCloseTo(0);   // avg x = 0
  });

  it('handles an empty field without throwing (classic chase from z=0)', () => {
    const p = frameField([], BASE);
    expect(p.eyeZ).toBeCloseTo(-24);
    expect(p.lookZ).toBeCloseTo(45);
  });
});
