// Type-effectiveness for Voice Monsters — a Pokémon-STYLE match-up chart, but wholly original data
// (no Pokémon tables copied). 8 elemental types; each attacking type is 2x (super-effective) against
// some, 0.5x (resisted) against others, and 1x otherwise. Pure lookup so the battle sim + UI share
// ONE source of truth and it's fully unit-testable.

export const MONSTER_TYPES = [
  'normal', 'fire', 'water', 'grass', 'electric', 'rock', 'ground', 'flying', 'psychic',
] as const;
export type MonsterType = (typeof MONSTER_TYPES)[number];

// For each attacking type: which defending types it hits hard (2x) and which resist it (0.5x).
// Everything unlisted is neutral (1x). Kept deliberately small + intuitive so it's learnable by ear.
const STRONG: Record<MonsterType, MonsterType[]> = {
  normal:   [],
  fire:     ['grass', 'flying'],           // scorches leaves + wings
  water:    ['fire', 'rock', 'ground'],    // douses fire, erodes stone/earth
  grass:    ['water', 'rock', 'ground'],   // roots crack rock, drink water
  electric: ['water', 'flying'],           // conducts through water, zaps fliers
  rock:     ['fire', 'flying', 'psychic'], // stones knock fliers down; blunt force cuts through focus
  ground:   ['fire', 'electric', 'rock'],  // smothers fire, grounds electric, buries rock
  flying:   ['grass'],                     // gusts shred foliage
  psychic:  ['normal', 'flying'],          // bends brute + bird minds
};
const WEAK: Record<MonsterType, MonsterType[]> = {
  normal:   ['psychic'],                   // a plain bruiser's hits glance off a psychic's guard
  fire:     ['water', 'rock'],             // put out / smothered
  water:    ['grass'],                     // absorbed by plants
  grass:    ['fire', 'flying'],            // burned / shredded
  electric: ['ground'],                    // earthed out
  rock:     ['water', 'grass', 'ground'],  // eroded / overgrown / buried
  ground:   ['grass'],                     // rooted through
  flying:   ['electric', 'rock'],          // zapped / stoned out of the sky
  psychic:  ['rock'],                      // raw stone resists mind force
};

/** Damage multiplier when `atk`-type hits a `def`-type defender: 2 (super-effective), 0.5 (resisted),
 *  or 1 (neutral). */
export function typeMultiplier(atk: MonsterType, def: MonsterType): number {
  if (STRONG[atk].includes(def)) return 2;
  if (WEAK[atk].includes(def)) return 0.5;
  return 1;
}

/** Spoken label for effectiveness (announcer/UI). null = neutral (say nothing special). */
export function effectivenessLabel(mult: number): string | null {
  if (mult >= 2) return "It's super effective!";
  if (mult <= 0.5) return "It's not very effective…";
  return null;
}
