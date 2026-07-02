// The battle COMMENTATOR's scripted line bank — pure text for each battle event, spoken to a caller
// (Conversation Relay TTS) and usable on-screen. Goal: lively + INFORMATIVE without rambling — it
// explains WHY a hit was super-effective, calls out crits/misses, and narrates guard/item/taunt, but
// stays quiet on ordinary chip damage + every turn tick so it never becomes a spammy stream.
//
// This is the SCRIPTED fallback (used when the LLM host is off, and as the on-screen ticker). The
// live LLM commentator (battle-host.ts) gets its own richer, context-aware prompt; both read the same
// events. No I/O here — the caller decides when to speak a returned line.
import type { BattleEvent, Side } from './battle-world';

/** What the commentator knows about the two fighters (for naming sides in a line). */
export interface CommentaryCtx {
  aName: string;   // side 'a' monster display name
  bName: string;   // side 'b' monster display name
}

/** A spoken/shown line for a battle event (or null when this event shouldn't be narrated). `seq` picks
 *  a phrase-bank variant so repeated events don't read identically — pass a per-battle counter. */
export function commentaryForBattleEvent(ev: BattleEvent, ctx: CommentaryCtx, seq = 0): string | null {
  const name = (s: Side) => (s === 'a' ? ctx.aName : ctx.bName);
  switch (ev.kind) {
    case 'turn_start':
      return null;   // the on-screen banner shows "Turn N"; no need to speak every turn

    case 'move_used':
      return pick(MOVE_USED, seq).replace('{who}', name(ev.by)).replace('{move}', ev.moveName);

    case 'miss':
      return pick(MISS, seq).replace('{who}', name(ev.by)).replace('{move}', ev.moveName);

    case 'damage':
      // Only the DRAMATIC hits get a line — a crit. Ordinary chip damage stays quiet (the HP bar +
      // the move callout already told the story) so we don't narrate every single swing.
      return ev.crit ? pick(CRIT, seq).replace('{who}', name(ev.on)) : null;

    case 'effectiveness':
      if (ev.multiplier >= 2) return pick(SUPER, seq).replace('{who}', name(ev.on));
      if (ev.multiplier <= 0.5) return pick(RESIST, seq).replace('{who}', name(ev.on));
      return null;

    case 'guard':
      return pick(GUARD, seq).replace('{who}', ev.monsterName);

    case 'item':
      return pick(ITEM, seq).replace('{who}', name(ev.by)).replace('{item}', ev.itemName);

    case 'taunt':
      return pick(TAUNT, seq).replace('{who}', ev.monsterName).replace('{foe}', ev.targetName);

    case 'faint':
      return pick(FAINT, seq).replace('{who}', ev.monsterName);

    case 'battle_over':
      return pick(WIN, seq).replace('{who}', ev.winnerName);

    default:
      return null;
  }
}

// ── phrase banks (each line uses {who}/{move}/{item}/{foe} placeholders) ──────────────────────────
const MOVE_USED = [
  '{who} lets loose {move}!',
  "{who} goes for {move}!",
  '{who} unleashes {move}!',
  'Here comes {move} from {who}!',
];
const MISS = [
  'But {move} whiffs — {who} missed!',
  '{who} swung big and MISSED!',
  'Dodged it! {move} sails wide.',
];
const CRIT = [
  'CRITICAL HIT! {who} takes a monster of a blow!',
  "A CRITICAL HIT — that one really stung {who}!",
  'CRITICAL! {who} reels from the impact!',
];
const SUPER = [
  "It's super effective! {who}'s type is weak to that!",
  'Super effective — {who} is taking heavy damage from that matchup!',
  "Ouch — that's a type it's weak against, huge hit on {who}!",
];
const RESIST = [
  "Barely a scratch — {who} resists that type.",
  '{who} shrugs most of it off — not very effective.',
  'Not much there — {who}\'s type resists it.',
];
const GUARD = [
  '{who} braces — the next hit will land soft.',
  '{who} throws up a guard and steadies itself.',
  '{who} defends, halving the incoming blow.',
];
const ITEM = [
  '{who} downs a {item} and patches up!',
  '{who} uses a {item} — health restored!',
  'A {item} for {who} — back in the fight!',
];
const TAUNT = [
  '{who} taunts {foe} — rattled, its aim will slip!',
  '{who} gets in {foe}\'s head — {foe} is shaken!',
  '{who} jeers at {foe}, throwing off its next move!',
];
const FAINT = [
  '{who} is down! It can\'t battle on!',
  'And {who} faints — out of the fight!',
  '{who} hits the dirt — that\'s all for it!',
];
const WIN = [
  '{who} takes the win — what a battle!',
  'Victory for {who}! Incredible!',
  "{who} stands tall — {who} WINS!",
];

/** Deterministic phrase-bank pick by seq (mirrors voice-lines' pick). */
function pick(arr: string[], seq: number): string { return arr[Math.abs(seq) % arr.length]!; }
