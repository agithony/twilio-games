import type { Side } from '../../shared/battle-world';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { MONSTERS_MESSAGES } from '../../shared/i18n/monsters';
import { createTranslator } from '../../shared/i18n/translate';

export interface HudRect { x: number; y: number; width: number; height: number }
export type BattleOutcome = 'winner' | 'fainted';

export const BATTLE_SCREEN_RECT: HudRect = { x: 0, y: 0, width: 160, height: 144 };
export const BATTLE_COMMAND_RECT: HudRect = { x: 4, y: 88, width: 152, height: 56 };
export const BATTLE_SPRITE_RECTS: Record<Side, HudRect> = {
  b: { x: 85, y: 0, width: 46, height: 42 },
  a: { x: 18, y: 30, width: 52, height: 52 },
};

/** Fixed global-side HUD geometry in the renderer's 160x144 logical coordinate space. */
export const BATTLE_HUD_RECTS: Record<Side, HudRect> = {
  b: { x: 4, y: 4, width: 76, height: 32 },
  a: { x: 80, y: 53, width: 76, height: 32 },
};

/** Badges occupy the result row inside their own HUD and never cover either monster sprite. */
export const BATTLE_OUTCOME_RECTS: Record<Side, HudRect> = {
  b: { x: 31, y: 26, width: 48, height: 9 },
  a: { x: 107, y: 75, width: 48, height: 9 },
};

export function outcomesBySide(
  winnerSide: Side | null,
  faintedSide: Side | null,
): Record<Side, BattleOutcome | null> {
  return {
    a: winnerSide === 'a' ? 'winner' : faintedSide === 'a' ? 'fainted' : null,
    b: winnerSide === 'b' ? 'winner' : faintedSide === 'b' ? 'fainted' : null,
  };
}

export function outcomeBadgePresentation(
  outcome: BattleOutcome,
  monsterName: string,
  locale: SupportedLocale = DEFAULT_LOCALE,
): { label: string; accessibleLabel: string } {
  const text = createTranslator(locale, MONSTERS_MESSAGES);
  return outcome === 'winner'
    ? {
        label: text('renderer.outcomeWin'),
        accessibleLabel: text('access.outcomeWinner', { monster: monsterName }),
      }
    : {
        label: text('renderer.outcomeKo'),
        accessibleLabel: text('access.outcomeFainted', { monster: monsterName }),
      };
}
