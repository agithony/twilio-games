/** Normalize text before it is handed to browser or Twilio TTS.
 *
 * Dynamic lines can include model output, filenames, markdown, or odd Unicode punctuation. Those are
 * fine on screen, but TTS engines may spell them, read tags aloud, or produce garbled audio. Keep the
 * spoken form plain and sentence-like.
 */
export function speechSafeText(input: string, maxLen = 500, locale: SupportedLocale = DEFAULT_LOCALE): string {
  const normalized = String(input)
    .normalize('NFKC')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\.(glb|gltf|png|jpe?g|webp|mp3|wav|json)\b/gi, '')
    .replace(/https?:\/\/\S+/gi, locale === 'pt-BR' ? 'link' : 'link')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s*[\u2012-\u2015-]\s*/g, ', ')
    .replace(/[\\/]/g, locale === 'pt-BR' ? ' ou ' : ' or ')
    .replace(/_/g, ' ')
    .replace(/[|~^*#=[\]{}<>]/g, ' ')
    .replace(/\(([^)]*)\)/g, ', $1, ')
    .replace(/\.{3,}/g, '. ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])(?=\S)/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length <= maxLen) return normalized;
  const clipped = normalized.slice(0, maxLen).replace(/\s+\S*$/, '').trim();
  return clipped || normalized.slice(0, maxLen).trim();
}
import { DEFAULT_LOCALE, type SupportedLocale } from './i18n/locales';
