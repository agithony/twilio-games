// Derived move stats shared by the sim (miss rolls) and the client (menu display). Kept out of the
// roster so the 32 moves stay the single source of truth — accuracy is a pure function of base power.
//
// RISK/REWARD: a move's accuracy falls as its power rises, so a big hit is a GAMBLE and a weak hit is
// a SURE THING. This is what gives a lower-power move a reason to exist next to a stronger same-type
// move (otherwise "always pick the fullest pips" is strictly correct). The weakest damaging moves
// (pow 40) always land; the strongest (pow 90) hit ~75%.

const MIN_POWER = 40;   // roster's weakest damaging move → 100% accurate
const MAX_POWER = 90;   // roster's strongest move → floor accuracy
const MIN_ACCURACY = 0.75;

/** Hit chance (0..1) for a move of the given base power. Status/0-power moves always land. Monotonic
 *  non-increasing in power; clamped to [0.7, 1.0] so nothing is hopeless or a guaranteed-nuke. */
export function moveAccuracy(power: number): number {
  if (power <= 0) return 1.0;                                   // status move — always resolves
  const t = (power - MIN_POWER) / (MAX_POWER - MIN_POWER);      // 0 at weakest … 1 at strongest
  const acc = 1.0 - t * (1.0 - MIN_ACCURACY);                   // 1.0 → 0.75 across the band
  return Math.max(0.7, Math.min(1.0, acc));
}

/** Accuracy as a whole-number percent, for the move menu ("85%"). */
export function accuracyPercent(power: number): number {
  return Math.round(moveAccuracy(power) * 100);
}
