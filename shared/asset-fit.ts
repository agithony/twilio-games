import { TRACK_W, LANES } from './constants';

export const CAR_TARGET = 4.0;
export const BARRIER_TARGET = TRACK_W / LANES;
export const BOOST_TARGET = 2.6;

/** Scale factor so the model's longest dimension equals targetLongest. 1 if degenerate. */
export function autoFitScale(size: [number, number, number], targetLongest: number): number {
  const longest = Math.max(size[0], size[1], size[2]);
  if (!Number.isFinite(longest) || longest <= 0) return 1;
  return targetLongest / longest;
}

export function isWheelNode(name: string): boolean {
  return /wheel|tire|rim/i.test(name);
}
