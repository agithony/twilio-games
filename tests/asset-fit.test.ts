import { describe, it, expect } from 'vitest';
import { autoFitScale, isWheelNode, CAR_TARGET, groundPlaneIndices } from '../shared/asset-fit';

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

describe('groundPlaneIndices', () => {
  it('strips a small car sitting on huge flat stadium slabs (the Lambo case)', () => {
    // 6 small car parts (~6 footprint) + 2 giant flat slabs (~350 wide, 6 tall).
    const sizes = [
      { w: 6, h: 2, d: 4 }, { w: 5, h: 2, d: 3 }, { w: 4, h: 1, d: 2 },
      { w: 6, h: 2, d: 4 }, { w: 3, h: 1, d: 2 }, { w: 5, h: 2, d: 3 },
      { w: 350, h: 6, d: 350 }, { w: 357, h: 6, d: 357 },
    ];
    expect(groundPlaneIndices(sizes)).toEqual([6, 7]);
  });
  it('leaves a normal car alone (no giant flat outlier)', () => {
    const sizes = [
      { w: 4, h: 1.5, d: 2 }, { w: 3.8, h: 1.4, d: 1.9 }, { w: 1, h: 1, d: 1 },
      { w: 0.8, h: 0.8, d: 0.8 }, { w: 4, h: 1.2, d: 2 },
    ];
    expect(groundPlaneIndices(sizes)).toEqual([]);
  });
  it('does NOT strip a tall large mesh (a big car body, not a flat ground)', () => {
    const sizes = [
      { w: 4, h: 1, d: 2 }, { w: 3, h: 1, d: 2 }, { w: 5, h: 1, d: 2 },
      { w: 40, h: 30, d: 40 },   // big but TALL → a chunky vehicle/structure, not a floor
    ];
    expect(groundPlaneIndices(sizes)).toEqual([]);   // not flat → kept
  });
  it('refuses to strip when outliers would be the majority (bad car guess)', () => {
    const sizes = [
      { w: 4, h: 1, d: 2 }, { w: 200, h: 4, d: 200 }, { w: 220, h: 4, d: 220 }, { w: 210, h: 4, d: 210 },
    ];
    expect(groundPlaneIndices(sizes)).toEqual([]);   // 3 of 4 flat-huge → don't trust it
  });
  it('returns [] for too-few meshes', () => {
    expect(groundPlaneIndices([{ w: 300, h: 4, d: 300 }, { w: 4, h: 2, d: 2 }])).toEqual([]);
  });
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

import { isDisplayBaseNode } from '../shared/asset-fit';

describe('isDisplayBaseNode', () => {
  it('flags real showroom-base node names from our models', () => {
    for (const n of [
      'LamborghiniHuracanGT3_CarBase_11', 'Circle_25', 'Plane_26', 'Circle.001_56',
      'JP1930_ParkRover:Floor', 'pPlane18', 'PlaneShape', 'Base_Lowpoly',
      'Camera_Bokeh_Plane_Plane.008_11', 'Camera_Optical_Vignetting_Plane.007_12',
      'Sphere_1',   // chrome reflection dome on the Squadra Lamborghini
      'SOL01_SOL_0', 'SOL_ground',         // Lotus showroom ground disc ("sol" = floor in French)
      'MountainpaintedGroup15820_Mountainpaintedl',   // Jurassic environment terrain
      'Terrain_01', 'Environment_bg',
    ]) expect(isDisplayBaseNode(n)).toBe(true);
  });
  it('does NOT flag real car parts (incl. wing mirrors + license plate background)', () => {
    for (const n of [
      'body', 'chassis', 'wheel_FL', 'door_left', 'Windshield', 'Bumper',
      'Seat', 'Engine', 'Headlight', 'Mirror', 'embase_mesh',
      'LamborghiniHuracanGT3_WingMirrors_19',
      'License Plate_License Plate Background_0_167_55',
      'JP1930_ParkRover:Mirrors',
      // The climber's body parts use "BaseCar" as a material/part suffix — "Base" PREFIXES "Car"
      // (a real part), it is NOT a standalone base prop. Must NOT be stripped (was eating the body).
      'A_Old_BaseCar_0', 'Door_L_BaseCar_0', 'Fender_Front_L_BaseCar_0', 'RamaFrontUp_R_BaseCar_0',
      'Rul_BaseCar_0', 'Tiaga_Back_L_D001_BaseCar_0',
      // "sol" must NOT match inside real part words (console/solenoid/solid):
      'console_trim', 'solenoid_valve', 'solid_axle',
    ]) expect(isDisplayBaseNode(n)).toBe(false);
  });
});
