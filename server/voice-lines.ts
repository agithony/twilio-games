// Pure, testable text lines the game SPEAKS TO A CALLER over their Conversation Relay call (Relay
// TTS-synthesizes each returned string). The AI host talks throughout — greeting, the menu phases
// (pick your car / track), reactions to the caller's own picks, the 3-2-1-GO countdown, mid-race
// arcade quips (throttled), and their finish. No I/O here; the adapter decides WHEN to send these.
import type { GameEvent } from '../shared/types';
import { countdownCue } from '../shared/countdown';

/** The connect greeting, as SEPARATE sentences. Sending each as its own TTS utterance gives natural
 *  pauses between them — one long run-on string was read without breaths (the "no pause" issue). */
export function greetingLines(): string[] {
  return [
    'Welcome to Twilio Voice Racer!',
    'It is powered by Twilio Conversation Relay, so you control the game with your voice.',
    "First up, what's your name?",
  ];
}
/** Back-compat single-line greeting (kept for any caller that wants one string). */
export function greetingLine(): string { return greetingLines().join(' '); }

const CAR_SELECT = ['Pick your ride! Say a car by name or number.', 'Choose your machine — just say its number!'];
const MAP_SELECT = ['Now vote for the track — say its name or number!', 'Choose your course — say the number!'];
const CAR_PICKED = ['Nice choice!', 'Great pick!', 'Ooh, bold choice!', 'Solid ride!'];

const STREAK = ['Watch the barriers — find the gaps.', 'Ouch, watch the walls.',
  'The barriers keep finding you.', 'Thread the needle and aim for the gaps.', 'Say NITRO if you need to break through a wall.'];
const LAST = ['You slipped to last — plenty of race left.', "Don't give up, you can catch them.",
  'Last place for now, but there is time.', 'Time for a comeback — keep saying boost.', 'You can still climb back.'];
const LEAD = ['You have the lead — hold it.', 'You are out in front.', 'First place is yours for now.',
  'You are leading the pack.', 'Clean driving — stay ahead.'];
// A NITRO dash blasting through a barrier — the special move paying off. Big, hype, spoken to the caller.
const SMASH = ['Nice — nitro got you through that barrier.', 'Good nitro timing, straight through.',
  'Barrier cleared with nitro.', 'You broke through cleanly.', 'Good move — right through it.'];

/** What to SAY (if anything) for a game event, from THIS caller's perspective. Returns null when the
 *  event shouldn't be spoken to THIS caller. `myPlayerId` is the caller's bound player id, so we only
 *  voice events about THEIR car. `seq` picks a phrase-bank variant (pass a per-adapter counter).
 *  Mid-race arcade lines (streak/fell-to-last/lead) are OPT-IN via `chatty` + the caller decides how
 *  often to actually speak them (the adapter throttles) so TTS never buries the caller's commands. */
export function lineForEvent(ev: GameEvent, myPlayerId: string | null, seq = 0): string | null {
  const mine = (id: string) => myPlayerId !== null && id === myPlayerId;
  switch (ev.kind) {
    case 'enter_car_select': return pick(CAR_SELECT, seq);
    case 'enter_map_select': return pick(MAP_SELECT, seq);
    case 'car_picked':       return mine(ev.playerId) ? `${pick(CAR_PICKED, seq)} The ${ev.car}!` : null;
    case 'map_picked':       return null;   // the screen host covers the map pick; don't double up
    case 'countdown':
      return countdownCue(ev.n);
    case 'go':
      return 'Go!';
    case 'finish':
      return mine(ev.playerId) ? placeLine(ev.place) : null;
    case 'hit_streak':
      return mine(ev.playerId) ? pick(STREAK, seq) : null;
    case 'fell_to_last':
      return mine(ev.playerId) ? pick(LAST, seq) : null;
    case 'lead_change':
      return mine(ev.playerId) ? pick(LEAD, seq) : null;
    case 'barrier_smashed':
      return mine(ev.playerId) ? pick(SMASH, seq) : null;   // NITRO paid off — hype it up
    // hit / boost_taken / race_over → not spoken to the caller (screen announcer covers them).
    default:
      return null;
  }
}

const pick = (arr: string[], seq: number): string => arr[Math.abs(seq) % arr.length]!;

/** Which event kinds are the mid-race "arcade" lines — the adapter throttles these so spoken audio
 *  doesn't step on the caller's own commands. Countdown/go/finish are key moments, always spoken. */
export function isChattyEvent(kind: GameEvent['kind']): boolean {
  return kind === 'hit_streak' || kind === 'fell_to_last' || kind === 'lead_change' || kind === 'barrier_smashed';
}

/** A result callout by finishing place. Scripted fallback when the LLM host is off. */
export function placeLine(place: number): string {
  switch (place) {
    case 1: return 'Nice work — first place. You won the race.';
    case 2: return 'Second place — close race. Try again and take the win.';
    case 3: return 'Third place — on the podium. Nice driving.';
    default: return `You finished ${ordinal(place)}. Try again and climb the board.`;
  }
}

export function raceOverLine(place: number | null): string {
  if (place === 1) return 'Race over. Congratulations, you won. Check the results and leaderboard on the big screen.';
  if (place && place > 1) return `Race over. You finished ${ordinal(place)}. Try again next time, and check the results and leaderboard on the big screen.`;
  return 'Race over. Check the results and leaderboard on the big screen, then run it back!';
}

/** 1→"1st", 2→"2nd", 3→"3rd", 4→"4th", … (spoken form). */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
