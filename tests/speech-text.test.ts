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

  it('uses one consistent phonetic pronunciation for Twilio in every locale', () => {
    expect(speechSafeText('Welcome to Twilio Voice Racer.')).toBe('Welcome to Twill-ee-oh Voice Racer.');
    expect(speechSafeText('Tecnologia Twilio Conversation Relay.',500,'pt-BR'))
      .toBe('Tecnologia Twill-ee-oh Conversation Relay.');
  });

  it('drops empty/control-only speech', () => {
    expect(speechSafeText('\u0000\u200b\n')).toBe('');
  });
});
