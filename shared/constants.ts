export const LANES = 3;
export const LAP_TARGET = 3;
export const MAX_PLAYERS = 8;
export const TRACK_W = 24;           // world units wide (3 roomy lanes)
export const TRACK_LEN = 700;        // z-distance per lap
export const RACE_LEN = TRACK_LEN * LAP_TARGET;   // full distance cars actually drive (no looping)
export const STEP = 1 / 60;          // fixed sim timestep (seconds)
export const BASE_SPEED = 38;        // cruise speed (units/s)
export const ITEM_START = 55;        // z of first obstacle row (course-gen.ts owns spacing/ramp)
// Hard cap on race duration (seconds from GO). A clean race is ~55s; if any car is stuck/very slow
// (repeated barriers, a wedged/disconnected racer), force-finish everyone at this point so the race
// ALWAYS ends and shows results — no "car stuck at the end, game never ends" hang.
export const MAX_RACE_SECONDS = 90;

// The rendered road ribbon sits this far above the curve centerline (so it never z-fights the map
// road beneath it). Cars are grounded at their local y=0, so they must lift by the SAME amount to
// sit ON the ribbon. ONE source of truth: track-surface.ts (Y_ROAD) and renderer.ts (car lift) both
// read this — keeping the wheels on the asphalt instead of hovering above / sinking below it.
export const TRACK_SURFACE_LIFT = 0.6;

// Hovering boost-orb animation — ONE source of truth so the game (renderer.ts) and the editor
// preview (level-scene.ts) can't drift. A real boost MODEL floats this high above the track and
// bobs/spins; the primitive cylinder fallback and barriers stay grounded.
export const HOVER_HEIGHT = 2.2;      // float height above the track surface
export const HOVER_BOB = 0.5;         // ± vertical bob amplitude
export const HOVER_BOB_SPEED = 2.0;   // bob cycles per second
export const HOVER_SPIN = 1.1;        // spin about Y, radians per second

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
