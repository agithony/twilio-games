import { describe, expect, it } from 'vitest';
import { battleControlsLegendHtml } from '../client/battle/battle-controls-legend';

describe('battleControlsLegendHtml localization', () => {
  it('preserves the English default', () => {
    expect(battleControlsLegendHtml()).toMatch(/How to battle|Fight|Guard|Potion/);
  });

  it('teaches Brazilian Portuguese voice commands', () => {
    const html = battleControlsLegendHtml('pt-BR');
    expect(html).toMatch(/Como batalhar|Lutar|Defender|Poção|Provocar/);
    expect(html).toMatch(/nome do golpe|1 a 4/);
  });
});
