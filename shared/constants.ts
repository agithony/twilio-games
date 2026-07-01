export const LANES = 3;
export const LAP_TARGET = 3;
export const MAX_PLAYERS = 8;
// The single shared game room. Callers bind here directly on connect (no room-code entry — fewest
// taps), and the shared display + web players default to it too, so everyone lands in the SAME game.
// One display / one game at a time; multi-room was removed in favor of instant join.
export const DEFAULT_ROOM = '4821';
export const TRACK_W = 24;           // world units wide (3 roomy lanes)
export const TRACK_LEN = 700;        // z-distance per lap
export const RACE_LEN = TRACK_LEN * LAP_TARGET;   // full distance cars actually drive (no looping)
export const STEP = 1 / 60;          // fixed sim timestep (seconds)
export const BASE_SPEED = 38;        // cruise speed (units/s)
// Throttle modifier bounds: each BOOST tap adds toward BOOST_MAX, each BRAKE tap toward BOOST_MIN.
// The sim clamps `boost` to [BOOST_MIN, BOOST_MAX]; the HUD boost bar maps the same range so the bar
// fills exactly when the sim caps out. ONE source of truth (race-world.ts + the client gauge).
export const BOOST_MAX = 2.2;
export const BOOST_MIN = -1.4;
// Speed added per unit of `boost` (speed = BASE_SPEED + boost*BOOST_SPEED_PER + power/stun mods).
export const BOOST_SPEED_PER = 12;
// The NITRO power-up: firing USE_POWER gives POWER_ACTIVE_SECS of +POWER_BOOST speed; a boost pad
// pickup grabs POWER_PAD_SECS of it. Players START each race with POWER_START charges.
export const POWER_BOOST = 16;
export const POWER_ACTIVE_SECS = 2.2;
export const POWER_START = 1;
// Collecting an orb BANKS a dash charge (does not auto-fire); the player spends one by saying
// "power". Charges are capped so you can't hoard invincibility across a whole race.
export const POWER_MAX = 3;
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
