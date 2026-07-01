import type { Rng } from './rng';
import type { Item, ItemKind } from './types';

/**
 * Procedural course generator — produces a fresh, *fair* gauntlet of barriers and
 * boost pads each race (call with a per-race seed). "Smart, not just random":
 *
 *  - SOLVABLE: every z-row leaves at least one barrier-free lane, so no wall is
 *    ever un-dodgeable.
 *  - REACTION RUNWAY: consecutive barrier rows are spaced >= MIN_BARRIER_GAP apart.
 *    The game is voice-controlled (~1s STT latency) so a player must have time to
 *    react to a hazard they see ahead. Boost rows can pack tighter (they reward,
 *    not punish).
 *  - DIFFICULTY RAMP (MODERATE, tuned for voice latency): barrier probability climbs
 *    0.35→0.65 and blocked-lane count climbs to at most ~3 of 5 (always >=2 open lanes),
 *    while barrier SPACING widens with progress. So it gets harder toward the finish but
 *    never brutal — you always have >=2 lanes to aim for and growing reaction runway.
 *  - RISK / REWARD: a guaranteed early boost teaches the mechanic; later boosts
 *    tend to sit in the riskier lanes near barriers.
 */
export interface CourseOpts {
  lanes: number;
  startZ: number;   // first row z (track is clear before this)
  endZ: number;     // exclusive upper bound on row z
}

/** Minimum z-distance between two barrier ROWS (reaction runway for voice latency). */
export const MIN_BARRIER_GAP = 22;
/** Boost-only rows can sit closer together. */
const MIN_ROW_GAP = 12;

/** Pick `n` distinct lanes uniformly at random from [0, lanes). */
function pickLanes(rng: Rng, lanes: number, n: number): number[] {
  const pool = Array.from({ length: lanes }, (_, i) => i);
  // Fisher-Yates using the seeded rng, then take the first n.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

export function generateCourse(rng: Rng, opts: CourseOpts): Item[] {
  const { lanes, startZ, endZ } = opts;
  const span = Math.max(1, endZ - startZ);
  const items: Item[] = [];
  let oid = 1;
  let lastBarrierZ = -Infinity;
  let placedEarlyBoost = false;
  const earlyCut = startZ + span * 0.2;

  let z = startZ;
  while (z < endZ) {
    // progress 0..1 along the whole course drives the difficulty ramp.
    const progress = (z - startZ) / span;

    // Barrier probability ramps 0.35 -> 0.65 with progress (MODERATE — was ->0.85, brutally dense
    // late). Boost-only rows fill the rest.
    const barrierChance = 0.35 + 0.30 * progress;
    const canPlaceBarrier = z - lastBarrierZ >= MIN_BARRIER_GAP;
    const wantBarrier = canPlaceBarrier && rng.next() < barrierChance;

    if (wantBarrier) {
      // How many lanes to block. This is the biggest fairness lever for a VOICE game: blocking N-1
      // lanes leaves a single gap the player must find under ~1s STT latency (the "hella hard" case).
      // Cap the ramp so late rows block at most ~3 of 5 lanes → ALWAYS >=2 open lanes to aim for
      // (still solvable, but with reaction slack). Early rows block just 1.
      const cap = Math.min(lanes - 2, 3);                 // never leave fewer than 2 open lanes
      const maxBlock = Math.max(1, Math.min(cap, 1 + Math.floor(progress * cap)));
      const blockCount = 1 + rng.int(maxBlock);          // 1..maxBlock
      const barrierLanes = pickLanes(rng, lanes, blockCount);
      const blocked = new Set(barrierLanes);
      for (const lane of barrierLanes) {
        items.push({ id: oid++, kind: 'barrier' as ItemKind, lane, z });
      }
      lastBarrierZ = z;
      // Often drop a reward boost in one of the still-open lanes (risk/reward beside a wall).
      const openLanes = Array.from({ length: lanes }, (_, i) => i).filter(l => !blocked.has(l));
      if (openLanes.length > 0 && rng.next() < 0.5) {
        const lane = openLanes[rng.int(openLanes.length)]!;
        items.push({ id: oid++, kind: 'boost' as ItemKind, lane, z });
        if (z < earlyCut) placedEarlyBoost = true;
      }
      // Spacing EASES with progress (extra reaction runway late, not less): base gap + a progress
      // bonus + jitter. Was a flat MIN_BARRIER_GAP+jitter, so late walls came just as fast but denser.
      z += MIN_BARRIER_GAP + Math.floor(progress * 16) + rng.int(10);
    } else {
      // Boost-only row: 1 pad in a random lane (a freebie / catch-up line).
      const lane = rng.int(lanes);
      items.push({ id: oid++, kind: 'boost' as ItemKind, lane, z });
      if (z < earlyCut) placedEarlyBoost = true;
      z += MIN_ROW_GAP + rng.int(12);
    }
  }

  // Guarantee a boost in the early stretch so players discover the mechanic even on
  // an unlucky seed that front-loaded only barriers.
  if (!placedEarlyBoost) {
    const firstBarrierZ = items.find(i => i.kind === 'barrier')?.z ?? endZ;
    // Place it just inside the start, in a lane that's clear at that z.
    const z0 = startZ;
    const blockedAtZ0 = new Set(items.filter(i => i.z === z0 && i.kind === 'barrier').map(i => i.lane));
    const free = Array.from({ length: lanes }, (_, i) => i).filter(l => !blockedAtZ0.has(l));
    const lane = free.length ? free[rng.int(free.length)]! : 0;
    if (firstBarrierZ > z0) items.unshift({ id: oid++, kind: 'boost' as ItemKind, lane, z: z0 });
  }

  return items;
}
