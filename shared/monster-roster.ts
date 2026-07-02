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
    moves: [
      mv('sparkmouse', 'jolt', 'Thunder Jolt', 'electric', 55),
      mv('sparkmouse', 'zap', 'Static Zap', 'electric', 40),
      mv('sparkmouse', 'tackle', 'Tackle', 'normal', 40),
      mv('sparkmouse', 'quickbite', 'Quick Bite', 'normal', 45),
    ],
  },
  {
    id: 'embertail', name: 'Embertail', type: 'fire',
    blurb: 'A hot-headed drakeling with a blazing temper.',
    maxHp: 78, attack: 84, defense: 58, speed: 74,
    moves: [
      mv('embertail', 'ember', 'Ember', 'fire', 50),
      mv('embertail', 'flamewhip', 'Flame Whip', 'fire', 75),
      mv('embertail', 'scratch', 'Scratch', 'normal', 40),
      mv('embertail', 'rockthrow', 'Rock Throw', 'rock', 50),
    ],
  },
  {
    id: 'shellback', name: 'Shellback', type: 'water',
    blurb: 'A stout turtle-beast — soaks up hits, hits back wet.',
    maxHp: 92, attack: 60, defense: 88, speed: 43,
    moves: [
      mv('shellback', 'bubble', 'Bubble Blast', 'water', 50),
      mv('shellback', 'aquapulse', 'Aqua Pulse', 'water', 70),
      mv('shellback', 'shellslam', 'Shell Slam', 'normal', 60),
      mv('shellback', 'harden', 'Harden', 'normal', 0),
    ],
  },
  {
    id: 'thornling', name: 'Thornling', type: 'grass',
    blurb: 'A vine-wrapped sprout that drains and lashes.',
    maxHp: 80, attack: 68, defense: 66, speed: 62,
    moves: [
      mv('thornling', 'vinelash', 'Vine Lash', 'grass', 55),
      mv('thornling', 'leafstorm', 'Leaf Storm', 'grass', 80),
      mv('thornling', 'tackle', 'Tackle', 'normal', 40),
      mv('thornling', 'sap', 'Sap Bite', 'grass', 45),
    ],
  },
  {
    id: 'pebblefist', name: 'Pebblefist', type: 'rock',
    blurb: 'A boulder with knuckles. Slow, but it hurts.',
    maxHp: 100, attack: 90, defense: 95, speed: 30,
    moves: [
      mv('pebblefist', 'rockslide', 'Rock Slide', 'rock', 75),
      mv('pebblefist', 'boulder', 'Boulder Bash', 'rock', 90),
      mv('pebblefist', 'slam', 'Body Slam', 'normal', 65),
      mv('pebblefist', 'quake', 'Tremor', 'ground', 60),
    ],
  },
  {
    id: 'gustwing', name: 'Gustwing', type: 'flying',
    blurb: 'A darting sky-hunter — blink-fast, glass-boned.',
    maxHp: 66, attack: 70, defense: 48, speed: 105,
    moves: [
      mv('gustwing', 'gust', 'Gust', 'flying', 50),
      mv('gustwing', 'divebomb', 'Dive Bomb', 'flying', 80),
      mv('gustwing', 'peck', 'Peck', 'normal', 40),
      mv('gustwing', 'gale', 'Gale Cutter', 'flying', 60),
    ],
  },
  {
    id: 'mudpup', name: 'Mudpup', type: 'ground',
    blurb: 'A burrowing scrapper that kicks up dirt.',
    maxHp: 84, attack: 78, defense: 70, speed: 58,
    moves: [
      mv('mudpup', 'digstrike', 'Dig Strike', 'ground', 70),
      mv('mudpup', 'mudshot', 'Mud Shot', 'ground', 50),
      mv('mudpup', 'bite', 'Bite', 'normal', 45),
      mv('mudpup', 'rockthrow', 'Rock Throw', 'rock', 50),
    ],
  },
  {
    id: 'tuskox', name: 'Tuskox', type: 'normal',
    blurb: 'A shaggy bruiser — all muscle, no subtlety.',
    maxHp: 110, attack: 88, defense: 74, speed: 40,
    moves: [
      mv('tuskox', 'stomp', 'Stomp', 'normal', 65),
      mv('tuskox', 'charge', 'Wild Charge', 'normal', 85),
      mv('tuskox', 'gore', 'Tusk Gore', 'normal', 70),
      mv('tuskox', 'quake', 'Tremor', 'ground', 60),
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
