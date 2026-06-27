export const LANES = 3;
export const LAP_TARGET = 3;
export const MAX_PLAYERS = 8;
export const TRACK_W = 18;           // world units wide
export const TRACK_LEN = 320;        // z-distance per lap
export const STEP = 1 / 60;          // fixed sim timestep (seconds)
export const BASE_SPEED = 38;        // cruise speed (units/s)
export const ITEM_SPACING = 24;      // gap between obstacle rows
export const ITEM_START = 55;        // z of first obstacle row

/** Lane center x for a given lane index (0..LANES-1). */
export function laneX(lane: number): number {
  return -TRACK_W / 2 + (TRACK_W / LANES) * (lane + 0.5);
}
