// Map a caller's spoken utterance to a battle command. Two matchers live here, both PURE + shared by
// the (future) CR voice adapter and the client:
//   • matchMove       — an utterance → one of the active monster's 4 move slots (name or number).
//   • matchBattleAction — an utterance → a TWO-LEVEL menu action (FIGHT/GUARD/ITEM/TAUNT at the root;
//                         the 4 moves once FIGHT is open) given the caller's current menu context.
// Priority within a move match: explicit NUMBER → name match. (Mirrors the racer's number/fuzzy
// approach but self-contained in shared/ so both layers use it.)
import type { BattleAction } from './battle-world';
import { DEFAULT_LOCALE, type SupportedLocale } from './i18n/locales';
import { normalizeForMatching } from './i18n/translate';
import { localizedMoveAliases } from './i18n/content';

const NUM_WORDS: Record<SupportedLocale, Record<string, number>> = {
  'en-US': { one: 1, two: 2, three: 3, four: 4 },
  'pt-BR': { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4 },
};
const ORDINAL_WORDS: Record<SupportedLocale, Record<string, number>> = {
  'en-US': { first: 1, second: 2, third: 3, fourth: 4 },
  'pt-BR': {
    primeiro: 1, primeira: 1, segundo: 2, segunda: 2,
    terceiro: 3, terceira: 3, quarto: 4, quarta: 4,
  },
};

/** Parse a 1-based move NUMBER (1–4) from a phrase, or null. Digits (+ "3rd") → ordinal words →
 *  cardinal words. Ordinals beat cardinals so "the second one" is 2, not the trailing "one". */
export function parseMoveNumber(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): number | null {
  const q = normalizeForMatching(spoken, locale);
  const digit = q.match(/\b([1-9])(?:st|nd|rd|th)?\b/);
  if (digit) return parseInt(digit[1]!, 10);
  for (const [w, n] of Object.entries(ORDINAL_WORDS[locale])) if (new RegExp(`\\b${w}\\b`).test(q)) return n;
  for (const [w, n] of Object.entries(NUM_WORDS[locale])) if (new RegExp(`\\b${w}\\b`).test(q)) return n;
  return null;
}

/** Fuzzy-match a spoken phrase to a move NAME: exact → substring (either way) → shared significant
 *  word. Returns the index or -1. */
function fuzzyName(spoken: string, names: string[], locale: SupportedLocale): number {
  const q = normalizeForMatching(spoken, locale);
  if (!q) return -1;
  const normalizedNames = names.map(name => normalizeForMatching(name, locale));
  let idx = normalizedNames.findIndex(name => name === q);
  if (idx >= 0) return idx;
  idx = normalizedNames.findIndex(name => name.includes(q) || q.includes(name));
  if (idx >= 0) return idx;
  // shared significant word (>2 chars) — e.g. "jolt" → "Thunder Jolt", "zap them" → "Static Zap"
  const qWords = new Set(q.split(/\s+/).filter(w => w.length > 2));
  return normalizedNames.findIndex(name => name.split(/\s+/).some(w => qWords.has(w)));
}

/** Match a spoken utterance to a move index (0-based) among `names` (the active monster's 4 move
 *  names, in slot order), or -1 if nothing matches. NUMBER wins over an incidental name word. */
export function matchMove(spoken: string, names: string[], locale: SupportedLocale = DEFAULT_LOCALE): number {
  const num = parseMoveNumber(spoken, locale);
  if (num !== null) return (num >= 1 && num <= names.length) ? num - 1 : -1;
  return fuzzyName(spoken, names, locale);
}

// ── the two-level command menu, by voice ───────────────────────────────────────────────────────────
// ROOT keyword → action synonyms. A word-boundary match anywhere in the utterance fires it, so
// "let me fight", "brace for it", "use a potion" all work. Ordered most-specific first isn't needed —
// each set is disjoint. FIGHT is handled at root as "open the moves"; a move NAME said at root jumps
// straight into that move (below), so callers don't have to say "fight" first.
const COMMAND_WORDS: Record<SupportedLocale, {
  guard: string[]; item: string[]; taunt: string[]; fight: string[]; back: string[];
}> = {
  'en-US': {
    guard: ['guard', 'block', 'brace', 'defend', 'shield'],
    item: ['item', 'potion', 'heal', 'bag', 'medicine'],
    taunt: ['taunt', 'mock', 'provoke', 'jeer', 'insult'],
    fight: ['fight', 'attack'],
    back: ['back', 'cancel', 'return', 'never mind', 'undo'],
  },
  'pt-BR': {
    fight: ['lutar', 'lute', 'atacar', 'ataque', 'ataca'],
    guard: ['defender', 'defende', 'defenda-se', 'bloquear', 'bloqueia', 'bloqueie', 'proteger', 'proteja-se'],
    item: ['item', 'poção', 'curar', 'cura'],
    taunt: ['provocar', 'provoque', 'zombar', 'zombe'],
    back: ['voltar', 'volta', 'volte', 'cancelar'],
  },
};

/** Does the utterance contain any of `words` as a whole word? Normalizes punctuation → spaces first
 *  ("attack!" → "attack", "never mind" → "never mind" so "nevermind" also matches by de-spacing). */
function saysAny(spoken: string, words: string[], locale: SupportedLocale): boolean {
  const normalized = normalizeForMatching(spoken, locale);
  const padded = ` ${normalized} `;
  const collapsed = normalized.replace(/\s+/g, '');
  return words.some(word => {
    const normalizedWord = normalizeForMatching(word, locale);
    return padded.includes(` ${normalizedWord} `)
      || (normalizedWord.includes(' ') && collapsed.includes(normalizedWord.replace(/\s+/g, '')));
  });
}

/** The two-level menu the voice matcher drives (mirrors the client's `menuLevel`). */
export type BattleMenuLevel = 'root' | 'fight';

/** Everything the matcher needs about the caller's turn to interpret an utterance: the 4 moves (id +
 *  spoken name, in slot order), remaining potions (ITEM is refused at 0), and which menu level they're
 *  on (a bare number means a ROOT action at the root, but a MOVE in the fight submenu). Pure — the
 *  caller derives this from the live snapshot. */
export interface BattleMenuCtx {
  moves: { id: string; name: string }[];
  potions: number;
  level: BattleMenuLevel;
}

/** Navigation results that aren't a committable BattleAction: open the fight submenu, or step back. */
export type BattleNav = { kind: 'openFight' } | { kind: 'back' };

/** Map a spoken utterance to a menu action, given the caller's current menu context — or null if
 *  nothing plausibly matches (so the client can stay put / re-prompt). Recognizes, in priority order:
 *   1. BACK (fight level only): "back"/"cancel"/"return"/"never mind" → step out of the moves.
 *   2. Explicit ROOT keywords (at EITHER level, so callers needn't say "back" first):
 *        guard/block/brace/defend → guard · item/potion/heal → item (only if potions>0) ·
 *        taunt/mock/provoke → taunt · fight/attack → openFight (root only).
 *   3. A NUMBER: in the fight submenu it's a MOVE slot; at the root it's a ROOT action
 *        (1 FIGHT→openFight, 2 GUARD, 3 ITEM, 4 TAUNT — 3 refused with no potions).
 *   4. A move NAME (either level): commit that fight move — so "Ember!" works straight from the root.
 *  Keyword wins over an incidental fuzzy name hit; a NUMBER's meaning is level-dependent (see above). */
export function matchBattleAction(spoken: string, ctx: BattleMenuCtx, locale: SupportedLocale = DEFAULT_LOCALE):
  BattleAction | BattleNav | null {
  const words = COMMAND_WORDS[locale];
  const names = ctx.moves.map(move => localizedMoveAliases(move.id, move.name).join(' '));
  const asMove = (i: number): BattleAction | null =>
    (i >= 0 && i < ctx.moves.length) ? { kind: 'fight', moveId: ctx.moves[i]!.id } : null;
  // ITEM honors the potion count at BOTH the keyword and the numeric paths.
  const item = (): BattleAction | null => ctx.potions > 0 ? { kind: 'item', item: 'potion' } : null;

  // 1. BACK — only meaningful inside the fight submenu; at the root it's a no-op (null).
  if (saysAny(spoken, words.back, locale)) return ctx.level === 'fight' ? { kind: 'back' } : null;

  // 2. Explicit ROOT keywords act from either level (a clear command shouldn't need a "back" first).
  if (saysAny(spoken, words.guard, locale)) return { kind: 'guard' };
  if (saysAny(spoken, words.item, locale)) return item();          // null when out of potions
  if (saysAny(spoken, words.taunt, locale)) return { kind: 'taunt' };
  if (ctx.level === 'root' && saysAny(spoken, words.fight, locale)) {
    const directMove = fuzzyName(spoken, names, locale);
    if (directMove >= 0) return asMove(directMove);
    const directNumber = parseMoveNumber(spoken, locale);
    return directNumber !== null ? asMove(directNumber - 1) : { kind: 'openFight' };
  }

  // 3. A NUMBER — its meaning depends on the level.
  const num = parseMoveNumber(spoken, locale);
  if (num !== null) {
    if (ctx.level === 'fight') return asMove(num - 1);     // fight submenu: pick a move slot
    switch (num) {                                          // root: pick a root action
      case 1: return { kind: 'openFight' };
      case 2: return { kind: 'guard' };
      case 3: return item();                                // null when out of potions
      case 4: return { kind: 'taunt' };
      default: return null;                                 // out of range
    }
  }

  // 4. A move NAME (fuzzy) — at either level it commits that fight move ("Ember!" straight from root).
  // Content names remain their canonical English names and are valid aliases in every locale.
  return asMove(fuzzyName(spoken, names, locale));
}
