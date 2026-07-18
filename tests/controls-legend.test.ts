// The controls legend is the players' one clear explanation of how to drive — shown in the lobby.
// This game is VOICE-first (Twilio Conversation Relay), so the legend must teach SPOKEN commands and
// must NOT show any keyboard keys. It also must explain POWER/NITRO + how to refill (the missed move).
import { describe, it, expect } from 'vitest';
import { controlsLegendHtml } from '../client/controls-legend';

describe('controlsLegendHtml', () => {
  it('teaches the SPOKEN commands (lane / boost / brake)', () => {
    const h = controlsLegendHtml();
    expect(h).toContain('Left');
    expect(h).toContain('Right');
    expect(h).toContain('Boost');
    expect(h).toContain('Brake');
  });

  it('teaches the NITRO dash: the trigger word + what it does + how to refill', () => {
    const h = controlsLegendHtml().toLowerCase();
    expect(h).toContain('nitro');          // the word players say (renamed from "power")
    expect(h).not.toContain('“power”');    // the old trigger word is gone from the legend
    expect(h).toContain('orb');
    expect(h).toMatch(/one charge|refill/);
  });

  it('shows the boost-orb IMAGE on the nitro row when a thumbnail is provided', () => {
    const withOrb = controlsLegendHtml('data:image/png;base64,ABC');
    expect(withOrb).toContain('cl-orb');
    expect(withOrb).toContain('data:image/png;base64,ABC');
    // ...and no broken <img> when there's no thumbnail yet
    expect(controlsLegendHtml()).not.toContain('cl-orb');
  });

  it('shows NO keyboard keys and NO emoji (voice-first, real-model icon)', () => {
    const h = controlsLegendHtml();
    expect(h).not.toContain('←');
    expect(h).not.toContain('→');
    expect(h).not.toContain('↑');
    expect(h).not.toContain('↓');
    expect(h).not.toMatch(/\bSpace\b/);
    expect(h).not.toContain('cl-key');
    expect(h).not.toContain('⚡');   // the emoji is gone; the orb model is the icon
  });

  it('frames it as talking, not typing', () => {
    expect(controlsLegendHtml().toLowerCase()).toMatch(/talk|shout|say/);
  });

  it.each(['Esquerda', 'Direita', 'Acelerar', 'Frear', 'Nitro'])('shows Portuguese command %s', (command) => {
    expect(controlsLegendHtml('', 'pt-BR')).toContain(command);
  });

  it('localizes Portuguese instructions and orb accessibility text', () => {
    const html = controlsLegendHtml('orb.png', 'pt-BR');
    expect(html).toContain('Como jogar');
    expect(html).toContain('grite seus comandos');
    expect(html).toContain('alt="esfera de nitro"');
  });
});
