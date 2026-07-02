// Single-player AI: choose the CPU's move each turn. Type-aware — it scores each move by expected
// damage (move power × STAB × type-multiplier vs the opponent) and picks the best, with a little rng
// jitter so it isn't perfectly deterministic-looking across battles. Pure; the server calls this for
// the CPU combatant. Deterministic given the rng passed in (server-authoritative).
import type { Monster } from './monster-roster';
import type { BattleAction } from './battle-world';
import { typeMultiplier } from './monster-types';
import { moveAccuracy } from './move-stats';
import type { Rng } from './rng';

// Non-FIGHT decision thresholds — deliberately kept a MINORITY so attacking stays the default and the
// battle-world pacing tests (median ≤ 3, max ≤ 6) don't blow their turn ceilings on wasted turns.
const LOW_HP_FRAC = 0.30;         // "in trouble" — below this it considers ITEM/GUARD
const HEALTHY_HP_FRAC = 0.60;     // "comfortable" — at/above this it may opportunistically TAUNT
const POTION_WHEN_LOW = 0.75;     // low + has a potion → usually drinks it (strong comeback)
const GUARD_WHEN_CORNERED = 0.30; // low + out of potions → sometimes brace (heal a little); still a minority
const TAUNT_WHEN_HEALTHY = 0.12;  // healthy → modest chance to rattle the foe (its next hit likelier to whiff)

/** Pick a move id for `self` attacking `opponent`. Higher expected damage = more likely; a 0-power
 *  status move scores low so the AI only uses it when it has nothing better. */
export function pickAiMove(self: Monster, opponent: Monster, rng: Rng): string {
  let bestId = self.moves[0]!.id;
  let bestScore = -Infinity;
  for (const move of self.moves) {
    const stab = move.type === self.type ? 1.5 : 1;
    const mult = typeMultiplier(move.type, opponent.type);
    // EXPECTED damage proxy: power × STAB × effectiveness × ACCURACY. Weighting by hit chance means the
    // AI won't blindly spam a whiffy nuke when a reliable move has better expected value — it plays the
    // same risk/reward the player weighs. Status (power 0) → ~0. Small rng jitter (±10%) breaks ties.
    const jitter = 0.9 + rng.next() * 0.2;
    const score = move.power * stab * mult * moveAccuracy(move.power) * jitter;
    if (score > bestScore) { bestScore = score; bestId = move.id; }
  }
  return bestId;
}

/** Pick a FULL turn action for the CPU (`self`) against `opponent`. Mostly FIGHT (the default), but:
 *   - low HP WITH a potion → usually ITEM (a strong comeback heal),
 *   - low HP OUT of potions → sometimes GUARD (brace + small heal — kept a minority so no stalling),
 *   - healthy → sometimes TAUNT (rattle the foe so its next attack is likelier to whiff).
 *  Non-FIGHT branches stay a MINORITY so battles resolve in-band (see pacing tests). Deterministic
 *  given the rng passed in: one roll picks the branch, then the FIGHT branch reuses pickAiMove (which
 *  draws its own jitter) — so it's server-authoritative + reproducible. `potionsLeft` gates ITEM so we
 *  never return an action the sim would reject. */
export function pickAiAction(
  self: Monster, selfHp: number, selfMaxHp: number,
  opponent: Monster, potionsLeft: number, rng: Rng,
): BattleAction {
  const hpFrac = selfHp / selfMaxHp;
  const roll = rng.next();   // one branch roll; the FIGHT fallthrough then draws pickAiMove's own jitter

  if (hpFrac < LOW_HP_FRAC) {
    // In trouble. Heal if we can (best play); else brace occasionally. Otherwise fight back.
    if (potionsLeft > 0 && roll < POTION_WHEN_LOW) return { kind: 'item', item: 'potion' };
    if (potionsLeft === 0 && roll < GUARD_WHEN_CORNERED) return { kind: 'guard' };
  } else if (hpFrac >= HEALTHY_HP_FRAC && roll < TAUNT_WHEN_HEALTHY) {
    // Comfortable → an opportunistic taunt to make the foe's next swing whiff.
    return { kind: 'taunt' };
  }

  return { kind: 'fight', moveId: pickAiMove(self, opponent, rng) };
}
