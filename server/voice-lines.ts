// Pure, testable text lines the game SPEAKS TO A CALLER over their Conversation Relay call (Relay
// TTS-synthesizes each returned string). Scope = key moments only (greeting on connect, the 3-2-1-GO
// countdown, and that caller's own finish) — NO mid-race chatter, so spoken audio never steps on the
// caller's own "left/right/boost" commands. No I/O here; the adapter decides WHEN to send these.
import type { GameEvent } from '../shared/types';

/** The one-time greeting when a caller is bound to a room + car. */
export function greetingLine(): string {
  return "You're in, racer! Shout left, right, or boost to drive. Watch the big screen — race starting soon.";
}

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
