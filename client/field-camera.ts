// Pure field-camera framing math (no three.js / DOM, so it's unit-testable). The race is shown on
// ONE shared display for up to 4 players, so the spectator camera must frame the WHOLE field — not
// chase the leader (which pushes the back of the pack off-screen). Given the cars' sim positions
// (z = distance along track, x = lateral lane offset) and the level's base chase offsets, this
// returns an eye + look target in SIM space; the renderer maps that onto the straight track or the
// curve. As the field spreads out, the camera pulls back + rises so everyone stays in frame.

export interface FieldCameraBase {
  behind: number; height: number; lookAhead: number; lookHeight: number; lateral: number;
}
export interface FieldCameraPose {
  eyeZ: number; eyeY: number; eyeX: number;     // sim-space eye
  lookZ: number; lookY: number; lookX: number;  // sim-space look target
}

// Don't frame stragglers more than this far behind the leader — beyond it the leaders would shrink
// to pinheads. A normal pack fits well within this; only a blown-out gap clips the trailing car.
export const MAX_FIELD_SPREAD = 160;
// How much the camera pulls back / rises per unit of field spread (eased so it grows gently).
const PULL_BACK_PER_SPREAD = 0.5;
const RISE_PER_SPREAD = 0.5;

/**
 * Frame the whole field. cars give sim {x, z}. With an empty field, behaves like the classic
 * single-car chase cam at z=0. With a bunched pack (spread≈0), it's identical to the old chase cam
 * (so per-level camera tuning still reads the same); as the field spreads, eye pulls back + up.
 */
export function frameField(cars: { x: number; z: number }[], base: FieldCameraBase): FieldCameraPose {
  if (cars.length === 0) {
    return { eyeZ: -base.behind, eyeY: base.height, eyeX: base.lateral,
             lookZ: base.lookAhead, lookY: base.lookHeight, lookX: 0 };
  }
  let front = -Infinity, rawBack = Infinity, sumX = 0;
  for (const c of cars) {
    if (c.z > front) front = c.z;
    if (c.z < rawBack) rawBack = c.z;
    sumX += c.x;
  }
  // Ignore stragglers more than MAX_FIELD_SPREAD behind the leader when sizing the shot.
  const back = Math.max(rawBack, front - MAX_FIELD_SPREAD);
  const spread = Math.max(0, front - back);
  const avgX = sumX / cars.length;
  const center = (back + front) / 2;

  return {
    // Eye sits behind the BACK of the (clamped) pack, pulled further back + higher as it spreads,
    // so the trailing car is on-screen and the leader still fits.
    eyeZ: back - base.behind - spread * PULL_BACK_PER_SPREAD,
    eyeY: base.height + spread * RISE_PER_SPREAD,
    eyeX: avgX * 0.3 + base.lateral,
    // Look toward the field's center, biased a touch ahead so the leader + upcoming track are framed.
    lookZ: center + base.lookAhead,
    lookY: base.lookHeight,
    lookX: avgX * 0.4,
  };
}
