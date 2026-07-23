import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BattleWorld } from '../shared/battle-world';
import {
  BATTLE_COMMAND_RECT,
  BATTLE_HUD_RECTS,
  BATTLE_OUTCOME_RECTS,
  BATTLE_SCREEN_RECT,
  BATTLE_SPRITE_RECTS,
  outcomeBadgePresentation,
  outcomesBySide,
  type HudRect,
} from '../client/battle/battle-hud-layout';

const overlaps = (a: HudRect, b: HudRect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

const isWithin = (inner: HudRect, outer: HudRect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.width <= outer.x + outer.width
  && inner.y + inner.height <= outer.y + outer.height;

describe('Voice Monsters battle HUD outcomes', () => {
  it('maps global A/B outcomes without a local-player perspective', () => {
    expect(outcomesBySide('a', 'b')).toEqual({ a: 'winner', b: 'fainted' });
    expect(outcomesBySide('b', 'a')).toEqual({ a: 'fainted', b: 'winner' });
    expect(outcomesBySide(null, 'b')).toEqual({ a: null, b: 'fainted' });
    expect(outcomesBySide(null, null)).toEqual({ a: null, b: null });
  });

  it('keeps both badges in bounds, near their own HUD, and out of other UI', () => {
    expect(overlaps(BATTLE_OUTCOME_RECTS.a, BATTLE_OUTCOME_RECTS.b)).toBe(false);
    for (const side of ['a', 'b'] as const) {
      const badge = BATTLE_OUTCOME_RECTS[side];
      const opponent = side === 'a' ? 'b' : 'a';
      expect(isWithin(badge, BATTLE_SCREEN_RECT)).toBe(true);
      expect(overlaps(badge, BATTLE_COMMAND_RECT)).toBe(false);
      expect(overlaps(badge, BATTLE_SPRITE_RECTS[side])).toBe(false);
      expect(overlaps(badge, BATTLE_HUD_RECTS[opponent])).toBe(false);
      const ownHud = BATTLE_HUD_RECTS[side];
      expect(isWithin(badge, ownHud)).toBe(true);
    }
  });

  it('localizes visible and live-region labels with the monster name', () => {
    expect(outcomeBadgePresentation('winner', 'Sparkmouse', 'en-US')).toEqual({
      label: 'WIN', accessibleLabel: 'Sparkmouse: winner, WIN',
    });
    expect(outcomeBadgePresentation('fainted', 'Embertail', 'en-US')).toEqual({
      label: 'K.O.', accessibleLabel: 'Embertail: fainted, K.O.',
    });
    expect(outcomeBadgePresentation('winner', 'Faísca', 'pt-BR')).toEqual({
      label: 'VENCEU', accessibleLabel: 'Faísca: vencedor, VENCEU',
    });
    expect(outcomeBadgePresentation('fainted', 'Brasa', 'pt-BR')).toEqual({
      label: 'NOCAUTE', accessibleLabel: 'Brasa: nocauteado, NOCAUTE',
    });
  });

  it('emits faint before battle_over so KO and winner reveals retain their pacing', () => {
    const world = new BattleWorld(
      { id: 'a', name: 'Ada', monsterId: 'embertail' },
      { id: 'b', name: 'Bo', monsterId: 'thornling' },
      3,
    );
    const terminal = [];
    while (world.snapshot().phase === 'choosing') {
      const snapshot = world.snapshot();
      world.chooseMove('a', snapshot.a.moves[1]!.id);
      world.chooseMove('b', snapshot.b.moves[0]!.id);
      terminal.push(...world.drainEvents().filter(event => event.kind === 'faint' || event.kind === 'battle_over'));
    }
    expect(terminal.map(event => event.kind)).toEqual(['faint', 'battle_over']);
    expect(terminal[0]).toMatchObject({ kind: 'faint', side: 'b' });
    expect(terminal[1]).toMatchObject({ kind: 'battle_over', winner: 'a' });
  });

  it('uses an accessible DOM layer above sprites and no canvas KO/trophy methods', () => {
    const renderer = readFileSync(new URL('../client/battle/battle-renderer.ts', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../client/monsters.css', import.meta.url), 'utf8');
    expect(renderer).toContain("className = 'battle-outcome-layer'");
    expect(renderer).toContain("this.outcomeAnnouncer.setAttribute('role', 'status')");
    expect(renderer).toContain("this.outcomeAnnouncer.setAttribute('aria-live', 'polite')");
    expect(renderer).toContain('new ResizeObserver(() => this.resize())');
    expect(renderer).toContain("this.outcomeAnnouncer.textContent = announcements.join('. ')");
    expect(renderer).not.toContain('drawTrophy');
    expect(renderer).not.toContain('drawKO');
    expect(css).toMatch(/\.battle-outcome-layer\s*\{[^}]*z-index:\s*4[^}]*pointer-events:\s*none/);
    expect(css).toContain('.battle-outcome-badge[hidden] { display: none; }');
    expect(css).toContain('.battle-outcome-announcer { position:absolute;width:1px');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
