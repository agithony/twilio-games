import { describe, expect, it } from 'vitest';
import { battleControlsLegendHtml } from '../client/battle/battle-controls-legend';
import { MONSTERS_MESSAGES } from '../shared/i18n/monsters';
import { createTranslator } from '../shared/i18n/translate';

describe('battleControlsLegendHtml localization', () => {
  it('preserves the English default', () => {
    expect(battleControlsLegendHtml()).toMatch(/How to battle|Attack|Guard|Potion/);
    expect(createTranslator('en-US',MONSTERS_MESSAGES)('renderer.fight')).toBe('ATTACK');
  });

  it('teaches Brazilian Portuguese voice commands', () => {
    const html = battleControlsLegendHtml('pt-BR');
    expect(html).toMatch(/Como batalhar|Atacar|Defender|Poção|Provocar/);
    expect(html).toMatch(/nome do golpe|1 a 4/);
    expect(createTranslator('pt-BR',MONSTERS_MESSAGES)('renderer.fight')).toBe('ATACAR');
  });
});
