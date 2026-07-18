// The battle COMMENTATOR's scripted line bank — pure text for each battle event, spoken to a caller
// (Conversation Relay TTS) and usable on-screen. Goal: lively + INFORMATIVE without rambling — it
// explains WHY a hit was super-effective, calls out crits/misses, and narrates guard/item/taunt, but
// stays quiet on ordinary chip damage + every turn tick so it never becomes a spammy stream.
//
// This is the SCRIPTED fallback (used when the LLM host is off, and as the on-screen ticker). The
// live LLM commentator (battle-host.ts) gets its own richer, context-aware prompt; both read the same
// events. No I/O here — the caller decides when to speak a returned line.
import type { BattleEvent, Side } from './battle-world';
import { DEFAULT_LOCALE, type SupportedLocale } from './i18n/locales';
import { MONSTERS_MESSAGES, type MonstersMessageKey } from './i18n/monsters';
import { createTranslator, type MessageValues } from './i18n/translate';
import { monsterName, moveName } from './i18n/content';

/** What the commentator knows about the two fighters (for naming sides in a line). */
export interface CommentaryCtx {
  aName: string;   // side 'a' monster display name
  bName: string;   // side 'b' monster display name
  locale?: SupportedLocale;
}

/** A dramatic "it's X versus Y!" scene-setter spoken when a battle kicks off. `mine`/`foe` are the two
 *  monster display names. Varied + hype, one punchy line. */
export function battleIntro(mine: string, foe: string, seq = 0, locale: SupportedLocale = DEFAULT_LOCALE): string {
  return render(INTROS, seq, locale, { me: mine, foe });
}
const INTROS = [
  'commentary.intro0', 'commentary.intro1', 'commentary.intro2', 'commentary.intro3',
] as const satisfies readonly MonstersMessageKey[];

/** A spoken/shown line for a battle event (or null when this event shouldn't be narrated). `seq` picks
 *  a phrase-bank variant so repeated events don't read identically — pass a per-battle counter. */
export function commentaryForBattleEvent(
  ev: BattleEvent,
  ctx: CommentaryCtx,
  seq = 0,
  locale: SupportedLocale = ctx.locale ?? DEFAULT_LOCALE,
): string | null {
  const name = (s: Side) => (s === 'a' ? ctx.aName : ctx.bName);
  const line = (keys: readonly MonstersMessageKey[], values: MessageValues) => render(keys, seq, locale, values);
  switch (ev.kind) {
    case 'turn_start':
      return null;   // the on-screen banner shows "Turn N"; no need to speak every turn

    case 'move_used':
      return line(MOVE_USED, { who: name(ev.by), move: localizedMove(locale, ev.moveId, ev.moveName) });

    case 'miss':
      return line(MISS, { who: name(ev.by), move: moveName(locale, ev.moveName) });

    case 'damage':
      // Only the DRAMATIC hits get a line — a crit. Ordinary chip damage stays quiet (the HP bar +
      // the move callout already told the story) so we don't narrate every single swing.
      return ev.crit ? line(CRIT, { who: name(ev.on) }) : null;

    case 'effectiveness':
      if (ev.multiplier >= 2) return line(SUPER, { who: name(ev.on) });
      if (ev.multiplier <= 0.5) return line(RESIST, { who: name(ev.on) });
      return null;

    case 'guard':
      return line(GUARD, { who: monsterName(locale, ev.monsterName) });

    case 'item':
      return line(ITEM, {
        who: name(ev.by),
        item: ev.item === 'potion' ? createTranslator(locale, MONSTERS_MESSAGES)('content.potion') : ev.itemName,
      });

    case 'taunt':
      return line(TAUNT, { who: monsterName(locale, ev.monsterName), foe: monsterName(locale, ev.targetName) });

    case 'faint':
      return line(FAINT, { who: monsterName(locale, ev.monsterName) });

    case 'battle_over':
      return line(WIN, { who: ev.winnerName });

    default:
      return null;
  }
}

function localizedMove(locale: SupportedLocale, id: string, fallback: string): string {
  const localized = moveName(locale, id);
  return localized === id ? moveName(locale, fallback) : localized;
}

// ── phrase banks (each line uses {who}/{move}/{item}/{foe} placeholders) ──────────────────────────
const MOVE_USED = ['commentary.move0', 'commentary.move1', 'commentary.move2', 'commentary.move3'] as const;
const MISS = ['commentary.miss0', 'commentary.miss1', 'commentary.miss2'] as const;
const CRIT = ['commentary.crit0', 'commentary.crit1', 'commentary.crit2'] as const;
const SUPER = ['commentary.super0', 'commentary.super1', 'commentary.super2'] as const;
const RESIST = ['commentary.resist0', 'commentary.resist1', 'commentary.resist2'] as const;
const GUARD = ['commentary.guard0', 'commentary.guard1', 'commentary.guard2'] as const;
const ITEM = ['commentary.item0', 'commentary.item1', 'commentary.item2'] as const;
const TAUNT = ['commentary.taunt0', 'commentary.taunt1', 'commentary.taunt2'] as const;
const FAINT = ['commentary.faint0', 'commentary.faint1', 'commentary.faint2'] as const;
const WIN = ['commentary.win0', 'commentary.win1', 'commentary.win2'] as const;

/** Deterministic phrase-bank pick by seq (mirrors voice-lines' pick). */
function render(keys: readonly MonstersMessageKey[], seq: number, locale: SupportedLocale, values: MessageValues): string {
  const key = keys[Math.abs(seq) % keys.length]!;
  return createTranslator(locale, MONSTERS_MESSAGES)(key, values);
}
