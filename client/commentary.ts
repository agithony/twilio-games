import type { GameEvent } from '../shared/types';

const pick = (arr: string[], seq: number): string => arr[Math.abs(seq) % arr.length]!;

const GO = ['Greeen light — GO GO GO!', 'And they\'re off!', 'Hammer down — GO!', 'Here we go, racers!'];
const HIT = ['Ooh, that\'s gotta hurt!', 'Into the barrier!', 'Crunch! Someone\'s feeling that.',
  'Bumper cars out there!', 'That\'s a costly tap!'];
const LEAD = ['takes the lead!', 'surges to the front!', 'is out in front now!', 'grabs P1!'];
const OVER = ['That\'s the checkered flag!', 'Race over — what a finish!', 'And that\'s a wrap, folks!'];

function ordinal(n: number): string {
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

export function commentaryFor(event: GameEvent, seq: number): string | null {
  switch (event.kind) {
    case 'go':          return pick(GO, seq);
    case 'hit':         return pick(HIT, seq);
    case 'lead_change': return `${event.name} ${pick(LEAD, seq)}`;
    case 'finish':      return event.place === 1
      ? `${event.name} wins it — first place! 🏁`
      : `${event.name} finishes ${ordinal(event.place)}.`;
    case 'race_over':   return pick(OVER, seq);
    case 'countdown':   return null;   // the big-text overlay already shows the number
    default:            return null;
  }
}
