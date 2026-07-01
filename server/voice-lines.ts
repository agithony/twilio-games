// Pure, testable text lines the game SPEAKS TO A CALLER over their Conversation Relay call (Relay
// TTS-synthesizes each returned string). The AI host talks throughout — greeting, the menu phases
// (pick your car / track), reactions to the caller's own picks, the 3-2-1-GO countdown, mid-race
// arcade quips (throttled), and their finish. No I/O here; the adapter decides WHEN to send these.
import type { GameEvent } from '../shared/types';

/** The connect greeting, as SEPARATE sentences. Sending each as its own TTS utterance gives natural
 *  pauses between them — one long run-on string was read without breaths (the "no pause" issue). */
export function greetingLines(): string[] {
  return [
    'Welcome to Voice Racer!',
    "You're in the race.",
    'Shout left, right, or boost to drive — and watch the big screen!',
  ];
}
/** Back-compat single-line greeting (kept for any caller that wants one string). */
export function greetingLine(): string { return greetingLines().join(' '); }

const CAR_SELECT = ['Pick your ride! Text the car number on screen.', 'Choose your machine — text its number!'];
const MAP_SELECT = ['Now pick the track — text the number!', 'Choose your course!'];
const CAR_PICKED = ['Nice choice!', 'Great pick!', 'Ooh, bold choice!', 'Solid ride!'];

const STREAK = ['Those barriers are magnetic! Find the gaps!', 'Ouch — watch the walls!',
  'The barriers keep finding you!'];
const LAST = ['You slipped to last — floor it and climb back!', "Don't give up — you can catch them!",
  'Last place, but plenty of race left!'];
const LEAD = ['You\'ve got the lead! Hold it!', 'Out in front — go go go!', 'First place is yours — keep it!'];

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
      return ev.n > 0 ? `${ev.n}...` : null;
    case 'go':
      return 'Go go go!';
    case 'finish':
      return mine(ev.playerId) ? placeLine(ev.place) : null;
    case 'hit_streak':
      return mine(ev.playerId) ? pick(STREAK, seq) : null;
    case 'fell_to_last':
      return mine(ev.playerId) ? pick(LAST, seq) : null;
    case 'lead_change':
      return mine(ev.playerId) ? pick(LEAD, seq) : null;
    // hit / boost_taken / race_over → not spoken to the caller (screen announcer covers them).
    default:
      return null;
  }
}

const pick = (arr: string[], seq: number): string => arr[Math.abs(seq) % arr.length]!;

/** Which event kinds are the mid-race "arcade" lines — the adapter throttles these so spoken audio
 *  doesn't step on the caller's own commands. Countdown/go/finish are key moments, always spoken. */
export function isChattyEvent(kind: GameEvent['kind']): boolean {
  return kind === 'hit_streak' || kind === 'fell_to_last' || kind === 'lead_change';
}

/** A short, punchy result callout by finishing place. */
export function placeLine(place: number): string {
  switch (place) {
    case 1: return 'First place! You win! Incredible driving!';
    case 2: return 'Second place — so close! Great race!';
    case 3: return 'Third place — on the podium! Nice one!';
    default: return `You finished ${ordinal(place)}. Good race — go again!`;
  }
}

/** 1→"1st", 2→"2nd", 3→"3rd", 4→"4th", … (spoken form). */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
