// ONE source of truth for how long each battle event is held on screen before the next plays. BOTH
// the client renderer (paces its animation) and the server voice layer (paces the spoken commentary)
// read this, so the SCREEN and the VOICE stay on the SAME clock — an attack is narrated while it
// animates, not all at once (the "voice and screen are out of sync" bug).
import type { BattleEvent } from './battle-world';

/** Milliseconds to hold on `ev` before advancing to the next event. */
export function dwellForEvent(ev: BattleEvent): number {
  switch (ev.kind) {
    case 'turn_start':    return 1400;                    // "— Turn N —" title card
    case 'move_used':     return 1800;                    // announce the move, THEN it hits
    case 'miss':          return 1700;                    // "But it missed!" lands
    case 'damage':        return ev.crit ? 2200 : 1650;   // the hit + HP drop registers
    case 'effectiveness': return 2100;                    // "It's super effective!" lands
    case 'guard':         return 1600;
    case 'block':         return 1700;
    case 'item':          return 1700;
    case 'taunt':         return 1800;
    case 'heal':          return 1100;
    case 'faint':         return 2300;
    case 'battle_over':   return 2400;
    default:              return 1500;
  }
}

/** The extra pause (ms) inserted BEFORE the 2nd attacker's move_used in a turn — the "now it's their
 *  turn" handoff beat. The client shows a card during this; the voice layer just waits it out. */
export const HANDOFF_PAUSE_MS = 1900;
