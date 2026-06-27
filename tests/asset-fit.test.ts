import { describe, it, expect } from 'vitest';
import { autoFitScale, isWheelNode, CAR_TARGET } from '../shared/asset-fit';

describe('autoFitScale', () => {
  it('scales the longest dimension to the target', () => {
    // longest dim is 8 (z); target 4 => scale 0.5
    expect(autoFitScale([2, 1, 8], 4)).toBeCloseTo(0.5, 5);
  });
  it('scales tiny models up', () => {
    // longest dim 0.1; target 4 => scale 40
    expect(autoFitScale([0.05, 0.1, 0.02], 4)).toBeCloseTo(40, 5);
  });
  it('returns 1 for a degenerate (zero) size', () => {
    expect(autoFitScale([0, 0, 0], 4)).toBe(1);
  });
  it('CAR_TARGET is 4.0', () => { expect(CAR_TARGET).toBe(4.0); });
});

describe('isWheelNode', () => {
  it('matches wheel/tire/rim case-insensitively', () => {
    for (const n of ['wheel_FL','Wheel.001','front_tire','RIM_2','car_wheel_rear'])
      expect(isWheelNode(n)).toBe(true);
  });
  it('rejects non-wheel names', () => {
    for (const n of ['body','chassis','window','Car','seat'])
      expect(isWheelNode(n)).toBe(false);
  });
});
