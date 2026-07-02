// The 8 ORIGINAL creatures of Voice Monsters + their moves. Designs are archetype homages (an
// electric rodent, a fire drake, a water turtle, …) so the type match-ups are intuitive by ear, but
// the names, stats, and moves are all invented — NO Pokémon data is used. Pure data + lookups; the
// battle sim, AI, voice matcher, and renderer all read from here (one source of truth).
import type { MonsterType } from './monster-types';

export interface Move {
  id: string;            // globally-unique (voice/AI reference it)
  name: string;          // spoken/displayed ("Ember", "Thunder Jolt")
  type: MonsterType;
  power: number;         // 0 = status/no-damage; else base power ~35–110
}

export interface Monster {
  id: string;            // stable key ("sparkmouse")
  name: string;          // display name ("Sparkmouse")
  type: MonsterType;
  blurb: string;         // one-line flavor for the select screen
  maxHp: number;
  attack: number;
  defense: number;
  speed: number;
  moves: [Move, Move, Move, Move];   // exactly 4
}

/** Local helper: build a move, prefixing the id with the owner so it's globally unique + readable. */
const mv = (owner: string, id: string, name: string, type: MonsterType, power: number): Move =>
  ({ id: `${owner}.${id}`, name, type, power });

export const ROSTER: Monster[] = [
  {
    id: 'sparkmouse', name: 'Sparkmouse', type: 'electric',
    blurb: 'A pint-sized live wire — fast and shocking.',
    maxHp: 70, attack: 62, defense: 45, speed: 95,
    // Fair spread: weak 50, medium 65 + 78, strong 88 (its signature Thunder Jolt).
    moves: [
      mv('sparkmouse', 'jolt', 'Thunder Jolt', 'electric', 88),
      mv('sparkmouse', 'zap', 'Static Zap', 'electric', 65),
      mv('sparkmouse', 'quickbite', 'Quick Bite', 'normal', 78),
      mv('sparkmouse', 'tackle', 'Tackle', 'normal', 50),
    ],
  },
  {
    id: 'embertail', name: 'Embertail', type: 'fire',
    blurb: 'A hot-headed drakeling with a blazing temper.',
    maxHp: 78, attack: 84, defense: 58, speed: 74,
    // Fair spread: weak Scratch 50, medium Ember 65 + Rock Throw 78, strong Flame Whip 88.
    moves: [
      mv('embertail', 'ember', 'Ember', 'fire', 65),
      mv('embertail', 'flamewhip', 'Flame Whip', 'fire', 88),
      mv('embertail', 'scratch', 'Scratch', 'normal', 50),
      mv('embertail', 'rockthrow', 'Rock Throw', 'rock', 78),
    ],
  },
  {
    id: 'shellback', name: 'Shellback', type: 'water',
    blurb: 'A stout turtle-beast — soaks up hits, hits back wet.',
    maxHp: 92, attack: 60, defense: 88, speed: 43,
    // Fair spread: weak Bubble Blast 50, medium Shell Slam 65 + Aqua Pulse 78, strong Tidal Crash 88.
    // (Harden, a 0-power status move, became a damaging move so the spread holds — no status system yet.)
    moves: [
      mv('shellback', 'bubble', 'Bubble Blast', 'water', 50),
      mv('shellback', 'aquapulse', 'Aqua Pulse', 'water', 78),
      mv('shellback', 'shellslam', 'Shell Slam', 'normal', 65),
      mv('shellback', 'tidalcrash', 'Tidal Crash', 'water', 88),
    ],
  },
  {
    id: 'thornling', name: 'Thornling', type: 'grass',
    blurb: 'A vine-wrapped sprout that drains and lashes.',
    maxHp: 80, attack: 68, defense: 66, speed: 62,
    // Fair spread: weak Tackle 50, medium Sap Bite 65 + Vine Lash 78, strong Leaf Storm 88.
    moves: [
      mv('thornling', 'vinelash', 'Vine Lash', 'grass', 78),
      mv('thornling', 'leafstorm', 'Leaf Storm', 'grass', 88),
      mv('thornling', 'tackle', 'Tackle', 'normal', 50),
      mv('thornling', 'sap', 'Sap Bite', 'grass', 65),
    ],
  },
  {
    id: 'galecoil', name: 'Galecoil', type: 'water',
    blurb: 'A tempest serpent — a raging leviathan when provoked.',
    maxHp: 98, attack: 92, defense: 79, speed: 55,
    // Fair spread: weak Crunch 50, medium Thrash 65 + Aqua Tail 78, strong Hydro Blast 88.
    moves: [
      mv('galecoil', 'aquatail', 'Aqua Tail', 'water', 78),
      mv('galecoil', 'hydroblast', 'Hydro Blast', 'water', 88),
      mv('galecoil', 'thrash', 'Thrash', 'normal', 65),
      mv('galecoil', 'bite', 'Crunch', 'normal', 50),
    ],
  },
  {
    id: 'voltcrest', name: 'Voltcrest', type: 'electric',
    blurb: 'A crackling thunderbird — a storm on the wing.',
    maxHp: 74, attack: 88, defense: 58, speed: 100,
    // Fair spread: weak Gust 50, medium Drill Peck 65 + Spark Arc 78, strong Thunderbolt 88.
    moves: [
      mv('voltcrest', 'thunderbolt', 'Thunderbolt', 'electric', 88),
      mv('voltcrest', 'sparkarc', 'Spark Arc', 'electric', 78),
      mv('voltcrest', 'drillpeck', 'Drill Peck', 'flying', 65),
      mv('voltcrest', 'gust', 'Gust', 'flying', 50),
    ],
  },
  {
    id: 'dazeduck', name: 'Dazeduck', type: 'water',
    blurb: 'A migraine-prone waterfowl — dazed, but weirdly powerful.',
    maxHp: 82, attack: 76, defense: 66, speed: 60,
    // Fair spread: weak Headbutt 50, medium Water Gun 65 + Confusion 78, strong Scald 88.
    moves: [
      mv('dazeduck', 'watergun', 'Water Gun', 'water', 65),
      mv('dazeduck', 'scald', 'Scald', 'water', 88),
      mv('dazeduck', 'confusion', 'Confusion', 'psychic', 78),
      mv('dazeduck', 'headache', 'Headbutt', 'normal', 50),
    ],
  },
  {
    id: 'psyclone', name: 'Psyclone', type: 'psychic',
    blurb: 'A lab-born mind-force — engineered, immense, unblinking.',
    maxHp: 88, attack: 96, defense: 72, speed: 92,
    // Fair spread: weak Focus 50, medium Psybeam 65 + Mind Blast 78, strong Psystrike 88.
    moves: [
      mv('psyclone', 'psystrike', 'Psystrike', 'psychic', 88),
      mv('psyclone', 'psybeam', 'Psybeam', 'psychic', 65),
      mv('psyclone', 'mindblast', 'Mind Blast', 'psychic', 78),
      mv('psyclone', 'recover', 'Focus', 'normal', 50),
    ],
  },
];

const BY_ID = new Map(ROSTER.map(m => [m.id, m]));
const MOVES_BY_ID = new Map(ROSTER.flatMap(m => m.moves).map(mvv => [mvv.id, mvv]));

/** Look up a creature by id, or null. */
export function monsterById(id: string): Monster | null { return BY_ID.get(id) ?? null; }
/** Look up a move by its globally-unique id, or null. */
export function moveById(id: string): Move | null { return MOVES_BY_ID.get(id) ?? null; }

/** Flatten the roster for the wire (the monster-select screen). Plain data — no methods, JSON-safe. */
export function rosterEntries() {
  return ROSTER.map(m => ({
    id: m.id, name: m.name, type: m.type as string, blurb: m.blurb,
    maxHp: m.maxHp, attack: m.attack, defense: m.defense, speed: m.speed,
    moves: m.moves.map(mv => ({ id: mv.id, name: mv.name, type: mv.type as string, power: mv.power })),
  }));
}
