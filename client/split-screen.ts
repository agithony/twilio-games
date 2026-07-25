import type { CarState } from '../shared/types';

export type SplitScreenCar = Pick<CarState, 'id' | 'name' | 'color' | 'x' | 'z' | 'invulnerable'>;

export interface SplitScreenViewport {
  car: SplitScreenCar;
  x: number;
  glY: number;
  cssTop: number;
  width: number;
  height: number;
}

/** Top/bottom viewports for a two-player race. WebGL and CSS use opposite Y origins. */
export function splitScreenViewports(
  cars: readonly SplitScreenCar[],
  width: number,
  height: number,
): SplitScreenViewport[] {
  if (cars.length !== 2 || width < 1 || height < 2) return [];
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(2, Math.floor(height));
  const topHeight = Math.ceil(safeHeight / 2);
  const bottomHeight = safeHeight - topHeight;
  return [
    { car: cars[0]!, x: 0, glY: bottomHeight, cssTop: 0, width: safeWidth, height: topHeight },
    { car: cars[1]!, x: 0, glY: 0, cssTop: topHeight, width: safeWidth, height: bottomHeight },
  ];
}
