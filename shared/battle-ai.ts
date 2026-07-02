// Single-player AI: choose the CPU's move each turn. Type-aware — it scores each move by expected
// damage (move power × STAB × type-multiplier vs the opponent) and picks the best, with a little rng
// jitter so it isn't perfectly deterministic-looking across battles. Pure; the server calls this for
// the CPU combatant. Deterministic given the rng passed in (server-authoritative).
import type { Monster } from './monster-roster';
import { typeMultiplier } from './monster-types';
import { moveAccuracy } from './move-stats';
import type { Rng } from './rng';

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
