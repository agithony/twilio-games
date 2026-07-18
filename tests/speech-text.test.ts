import { describe, expect, it } from 'vitest';
import { speechSafeText } from '../shared/speech-text';

describe('speechSafeText', () => {
  it('turns file-like or markup-heavy text into speakable words', () => {
    expect(speechSafeText('Pick `18_mclaren_senna_crxw_widebody_kit_animated.glb` <b>now</b>'))
      .toBe('Pick 18 mclaren senna crxw widebody kit animated now');
  });

  it('makes punctuation safer for TTS without dropping the message', () => {
    expect(speechSafeText('Beetle / Fusca — say “NITRO”…'))
      .toBe('Beetle or Fusca, say "NITRO".');
  });

  it('uses Portuguese conjunctions for Portuguese speech', () => {
    expect(speechSafeText('esquerda / direita', 500, 'pt-BR')).toBe('esquerda ou direita');
  });

  it('drops empty/control-only speech', () => {
    expect(speechSafeText('\u0000\u200b\n')).toBe('');
  });
});
