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
