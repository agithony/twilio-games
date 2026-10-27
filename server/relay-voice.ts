import type { SupportedLocale } from '../shared/i18n/locales';

/** Requested English ElevenLabs voice ID for Conversation Relay calls. */
export const DEFAULT_ENGLISH_RELAY_VOICE = 'SA7eD52NRr8WAehitVt1';
/** Playful, warm ElevenLabs voice for Talking Owl's English calls. */
export const DEFAULT_OWL_ENGLISH_RELAY_VOICE = 'r1KmysJdVYZjJCm4mL3b';

// Conversation Relay defaults ElevenLabs to Flash 2.5, which does not honor
// the English phoneme tag used for "Twilio". Flash v2 does, and Twilio supports
// selecting it by appending -flash_v2 to an ElevenLabs voice ID.
const ENGLISH_PHONEME_MODEL = 'flash_v2';

function englishRelayVoice(voice: string): string {
  return /^[a-zA-Z0-9]{20}$/.test(voice) ? `${voice}-${ENGLISH_PHONEME_MODEL}` : voice;
}

/** Keep Brazilian Portuguese on its own voice; an empty value selects Twilio's pt-BR default. */
export function relayVoiceForLocale(
  locale: SupportedLocale,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (locale === 'pt-BR') return (environment.CR_TTS_VOICE_PT_BR ?? '').trim();
  const voice = (environment.CR_TTS_VOICE ?? '').trim() || DEFAULT_ENGLISH_RELAY_VOICE;
  return englishRelayVoice(voice);
}

/** Talking Owl has its own English character voice; Portuguese keeps its locale-specific voice. */
export function owlRelayVoiceForLocale(
  locale: SupportedLocale,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (locale === 'pt-BR') return relayVoiceForLocale(locale, environment);
  const voice = (environment.CR_TTS_VOICE_OWL ?? '').trim() || DEFAULT_OWL_ENGLISH_RELAY_VOICE;
  return englishRelayVoice(voice);
}
