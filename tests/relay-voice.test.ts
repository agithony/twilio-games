import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENGLISH_RELAY_VOICE,
  DEFAULT_OWL_ENGLISH_RELAY_VOICE,
  owlRelayVoiceForLocale,
  relayVoiceForLocale,
} from '../server/relay-voice';

describe('Conversation Relay voice selection', () => {
  it('uses the shared voice for English games other than Talking Owl', () => {
    expect(DEFAULT_ENGLISH_RELAY_VOICE).toBe('SA7eD52NRr8WAehitVt1');
    expect(relayVoiceForLocale('en-US', {})).toBe(`${DEFAULT_ENGLISH_RELAY_VOICE}-flash_v2`);
    expect(relayVoiceForLocale('en-US', { CR_TTS_VOICE: DEFAULT_ENGLISH_RELAY_VOICE }))
      .toBe(`${DEFAULT_ENGLISH_RELAY_VOICE}-flash_v2`);
  });

  it('preserves an explicit English override', () => {
    expect(relayVoiceForLocale('en-US', { CR_TTS_VOICE: 'custom-id' })).toBe('custom-id');
    expect(relayVoiceForLocale('en-US', { CR_TTS_VOICE: 'NYC9WEgkq1u4jiqBseQ9' }))
      .toBe('NYC9WEgkq1u4jiqBseQ9-flash_v2');
    expect(relayVoiceForLocale('en-US', { CR_TTS_VOICE: 'NYC9WEgkq1u4jiqBseQ9-flash_v2' }))
      .toBe('NYC9WEgkq1u4jiqBseQ9-flash_v2');
  });

  it('keeps Portuguese on its own configured voice or Twilio default', () => {
    expect(relayVoiceForLocale('pt-BR', {})).toBe('');
    expect(relayVoiceForLocale('pt-BR', { CR_TTS_VOICE_PT_BR: 'br-id' })).toBe('br-id');
  });

  it('gives Talking Owl its own English voice without changing other games', () => {
    expect(DEFAULT_OWL_ENGLISH_RELAY_VOICE).toBe('r1KmysJdVYZjJCm4mL3b');
    expect(owlRelayVoiceForLocale('en-US', {})).toBe(`${DEFAULT_OWL_ENGLISH_RELAY_VOICE}-flash_v2`);
    expect(relayVoiceForLocale('en-US', {})).toBe(`${DEFAULT_ENGLISH_RELAY_VOICE}-flash_v2`);
  });

  it('accepts an Owl-only voice override and keeps Portuguese on its own voice', () => {
    expect(owlRelayVoiceForLocale('en-US', { CR_TTS_VOICE_OWL: 'NYC9WEgkq1u4jiqBseQ9' }))
      .toBe('NYC9WEgkq1u4jiqBseQ9-flash_v2');
    expect(owlRelayVoiceForLocale('en-US', { CR_TTS_VOICE_OWL: 'custom-id-flash_v2' }))
      .toBe('custom-id-flash_v2');
    expect(owlRelayVoiceForLocale('pt-BR', {
      CR_TTS_VOICE_OWL: 'owl-id', CR_TTS_VOICE_PT_BR: 'br-id',
    })).toBe('br-id');
  });
});
