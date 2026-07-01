import type { GameEvent } from '../shared/types';

const pick = (arr: string[], seq: number): string => arr[Math.abs(seq) % arr.length]!;

// Pre-race host lines (menus) — keep the AI talking through car/map select, not just the race.
const CAR_SELECT = ['Pick your ride, racers!', 'Choose your machine!', 'Time to pick a car — text your number!'];
const MAP_SELECT = ['Now choose your track!', 'Pick the course — where are we racing?', 'Select your battleground!'];
const CAR_PICKED = ['nice choice!', 'great pick!', 'bold choice!', 'oh, a classic!', 'solid ride!'];
const MAP_PICKED = ['Great track!', 'Ooh, that\'s a fun one!', 'Locked in — this\'ll be good!'];
const GO = ['Green light — GO GO GO!', 'And they\'re off!', 'Hammer down — GO!', 'Here we go, racers!'];
const HIT = ['Ooh, that\'s gotta hurt!', 'Into the barrier!', 'Crunch! Someone\'s feeling that.',
  'Bumper cars out there!', 'That\'s a costly tap!'];
const LEAD = ['takes the lead!', 'surges to the front!', 'is out in front now!', 'grabs P1!'];
const OVER = ['That\'s the checkered flag!', 'Race over — what a finish!', 'And that\'s a wrap, folks!'];
// Arcade-style reactive banks (name is prefixed by the caller):
const STREAK = ['is a barrier magnet today!', 'again?! Are you AIMING for those?',
  'can\'t stop hitting the walls!', 'and the barriers are winning!', 'needs to find the gaps!'];
const LAST = ['drops to dead last — shake it off!', 'tumbles to the back — climb back up!',
  'is in last, but it\'s not over!', 'falls to the rear of the pack!'];

function ordinal(n: number): string {
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

export function commentaryFor(event: GameEvent, seq: number): string | null {
  switch (event.kind) {
    case 'enter_car_select': return pick(CAR_SELECT, seq);
    case 'enter_map_select': return pick(MAP_SELECT, seq);
    case 'car_picked':       return `${event.name} — ${pick(CAR_PICKED, seq)} The ${event.car}!`;
    case 'map_picked':       return `${event.map}? ${pick(MAP_PICKED, seq)}`;
    case 'go':          return pick(GO, seq);
    case 'hit':         return pick(HIT, seq);
    case 'hit_streak':  return `${event.name} ${pick(STREAK, seq)}`;
    case 'fell_to_last':return `${event.name} ${pick(LAST, seq)}`;
    case 'lead_change': return `${event.name} ${pick(LEAD, seq)}`;
    case 'finish':      return event.place === 1
      ? `${event.name} wins it — first place!`
      : `${event.name} finishes ${ordinal(event.place)}.`;
    case 'race_over':   return pick(OVER, seq);
    case 'countdown':   return null;   // the big-text overlay already shows the number
    default:            return null;
  }
}
