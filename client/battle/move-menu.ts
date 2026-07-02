// Pure display helpers for the Game Boy move menu (bottom command window). No canvas here so the
// power rating + name fitting are unit-testable; battle-renderer draws the pips/text.
//
// WHY PIPS: the move's raw base power (40..90) is an internal tuning number. After the damage rebalance
// (bounded ratio, coef 0.26, hard cap at half the defender's HP) a "55" move deals only ~1/6–1/3 of a
// health bar, so showing "55" next to a 70-HP bar misleads. A normalized 1–5 rating reads as "how hard
// does this hit" without implying an HP figure.

// The roster's damaging moves span these base powers; map that band onto 1..5 pips.
const MIN_POWER = 40;
const MAX_POWER = 90;

/** A move's power as 1–5 pips (0 for a status/0-power move). Normalized to the roster's power band,
 *  clamped, and monotonic so a stronger move never shows fewer pips. */
export function powerPips(power: number): number {
  if (power <= 0) return 0;
  const t = (power - MIN_POWER) / (MAX_POWER - MIN_POWER);   // 0..1 across the band
  const pips = Math.round(t * 4) + 1;                         // → 1..5
  return Math.max(1, Math.min(5, pips));
}

/** Power pips adjusted for EFFECTIVENESS vs the current foe: base power × type multiplier, mapped to
 *  1–5. So a weak super-effective move out-pips a strong resisted one, making "pick the fullest pips"
 *  genuinely correct and rewarding type play. `mult` is 0.5 / 1 / 2 from the type chart. At 1× it
 *  equals the plain powerPips. */
export function effectivePips(power: number, mult: number): number {
  if (power <= 0) return 0;
  // Effective power on the same 40..90 band the pips are calibrated to. Neutral (1x) maps identically
  // to powerPips; 2x pushes toward 5, 0.5x pulls toward 1. Clamp into the band before mapping.
  const eff = Math.max(MIN_POWER, Math.min(MAX_POWER, power * mult));
  return powerPips(eff);
}

/** Render the pip rating as a compact string of filled/empty blocks, e.g. "●●●○○" (or "" for status). */
export function pipString(power: number): string {
  const n = powerPips(power);
  if (n === 0) return '';
  return '●'.repeat(n) + '○'.repeat(5 - n);
}

/** Truncate a move name to at most `max` chars so it can't clip the fixed-width command window; a cut
 *  name ends with '.' to signal it was shortened. */
export function fitMoveName(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, Math.max(1, max - 1)) + '.';
}
