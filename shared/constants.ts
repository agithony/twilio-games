export const LANES = 3;
export const LAP_TARGET = 3;
export const MAX_PLAYERS = 8;
export const TRACK_W = 24;           // world units wide (3 roomy lanes)
export const TRACK_LEN = 700;        // z-distance per lap
export const RACE_LEN = TRACK_LEN * LAP_TARGET;   // full distance cars actually drive (no looping)
export const STEP = 1 / 60;          // fixed sim timestep (seconds)
export const BASE_SPEED = 38;        // cruise speed (units/s)
export const ITEM_START = 55;        // z of first obstacle row (course-gen.ts owns spacing/ramp)

/**
 * Lane center x for a given lane index (0..LANES-1).
 * The spectator camera looks DOWN +Z (the direction of travel), which mirrors
 * the horizontal axis on screen — so a higher lane must map to a more-NEGATIVE
 * world X to appear on the screen's right. This keeps MOVE_RIGHT (lane+1) moving
 * the car rightward on screen for BOTH keyboard and voice. laneX(0) is the
 * screen-leftmost lane.
 */
export function laneX(lane: number): number {
  return TRACK_W / 2 - (TRACK_W / LANES) * (lane + 0.5);
}
