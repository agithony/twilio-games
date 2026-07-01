// Pure, testable text lines the game SPEAKS TO A CALLER over their Conversation Relay call (Relay
// TTS-synthesizes each returned string). Scope = key moments only (greeting on connect, the 3-2-1-GO
// countdown, and that caller's own finish) — NO mid-race chatter, so spoken audio never steps on the
// caller's own "left/right/boost" commands. No I/O here; the adapter decides WHEN to send these.
import type { GameEvent } from '../shared/types';

/** The one-time greeting when a caller is bound to a room + car. */
export function greetingLine(): string {
  return "You're in, racer! Shout left, right, or boost to drive. Watch the big screen — race starting soon.";
}

/** What to SAY (if anything) for a game event, from THIS caller's perspective. Returns null when the
 *  event shouldn't be spoken to the caller (mid-race cues stay on the shared screen only).
 *  `myPlayerId` is the caller's bound player id, so we only voice THEIR finish, not everyone's. */
export function lineForEvent(ev: GameEvent, myPlayerId: string | null): string | null {
  switch (ev.kind) {
    case 'countdown':
      return ev.n > 0 ? `${ev.n}...` : null;
    case 'go':
      return 'Go go go!';
    case 'finish':
      // Only announce it to the caller whose car finished.
      return myPlayerId && ev.playerId === myPlayerId ? placeLine(ev.place) : null;
    // lead_change / hit / boost_taken / race_over → not spoken to the caller (screen announcer covers them).
    default:
      return null;
  }
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
