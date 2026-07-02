// Pure HP-bar helpers for the Game Boy battle UI — no DOM, so they're unit-testable. The bar fills
// by HP fraction and shifts color at the classic thresholds (green > ~50%, amber > ~20%, red below),
// mirroring the original hardware's feel with our own palette.

/** Clamp an HP fraction to [0, 1] from raw hp/maxHp (guards divide-by-zero + overshoot). */
export function hpFraction(hp: number, maxHp: number): number {
  if (maxHp <= 0) return 0;
  return Math.max(0, Math.min(1, hp / maxHp));
}

export type HpZone = 'high' | 'mid' | 'low';

/** Which color zone an HP fraction is in (green / amber / red), at the classic 50% + 20% breakpoints. */
export function hpZone(fraction: number): HpZone {
  if (fraction > 0.5) return 'high';
  if (fraction > 0.2) return 'mid';
  return 'low';
}

/** The bar fill color for a zone (GB-ish greens/amber/red, but on our palette). */
export function hpColor(zone: HpZone): string {
  switch (zone) {
    case 'high': return '#5ac54f';   // healthy green
    case 'mid':  return '#f2c14e';   // caution amber
    case 'low':  return '#e5533c';   // danger red
  }
}
