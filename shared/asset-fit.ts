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

/**
 * Many free Sketchfab vehicles ship sitting on a SHOWROOM display prop — a base,
 * floor, turntable disc, plinth, or photo backdrop — which we must hide so the car
 * (not the prop) fills the frame and auto-fit measures the car alone. Matches the
 * common naming for these props. Word-ish boundaries avoid false hits like "embase".
 */
export function isDisplayBaseNode(name: string): boolean {
  // Showroom-prop keywords. Most match anywhere (handles "pPlane18", "PlaneShape",
  // "Circle.001_56"); "base" is gated to a word-start (^/_/-/space or a capital B, as in
  // "CarBase") so it doesn't false-hit parts like "embase". Real car parts
  // (body/door/wheel/seat/...) contain none of these tokens.
  if (/(turntable|cyclorama|vignetting|bokeh|plinth|pedestal|podium)/i.test(name)) return true;
  // Geometry-primitive display props (Maya/Blender names like "pPlane18", "PlaneShape",
  // "Circle.001"). Match plane/circle/disc as a substring — these tokens don't appear in
  // real car-part names.
  if (/(plane|circle|disc|disk)/i.test(name)) return true;
  // "floor/ground/backdrop/platform/stand/riser/dais/stage" as a word (NOT inside another
  // word like "License Plate Background" — a real part). Anchored to separators.
  if (/(^|[_\-. :])(floor|ground|backdrop|platform|stand|riser|dais|stage)([_\-. :0-9]|$)/i.test(name)) return true;
  // Reflection/sky domes used as showroom environments (e.g. "Sphere_1"). Anchored so it
  // won't hit car parts; NOTE we deliberately do NOT match "mirror" (real wing-mirrors) or
  // "ball" (could be a joint) without a clearer base context.
  if (/^sphere([._]\d+)?$|sky.?dome|reflection.?(sphere|dome)|env.?(sphere|dome|map)/i.test(name)) return true;
  // "Base" as a showroom plinth: it must be a whole word / trailing noun ("CarBase", "Base_01",
  // "Base"), NOT a prefix of a bigger word. A trailing letter means it's part of a real name like
  // "BaseCar"/"Basecolor" (the climber's body parts are "..._BaseCar_0") — those must survive.
  const baseEnd = '([^a-zA-Z]|$)';   // Base not followed by ANY letter (so "BaseCar"/"Basecolor" survive)
  if (new RegExp(`(^|[_\\- ]|[a-z])Base${baseEnd}`).test(name)) return true;
  return new RegExp(`^base${baseEnd}`, 'i').test(name);
}
