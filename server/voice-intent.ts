import type { Intent } from '../shared/types';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import { normalizeForMatching } from '../shared/i18n/translate';

// Each intent maps to the words/phrases that trigger it. Order within the scan
// is by last-occurrence in the transcript so self-corrections ("left no right")
// take the latest command.
const WORD_TO_INTENT: Record<SupportedLocale, ReadonlyMap<string, Intent>> = {
  'en-US': new Map([
    ['left', 'MOVE_LEFT'],
    ['right', 'MOVE_RIGHT'],
    ['boost', 'BOOST'],
    ['go', 'BOOST'],
    ['brake', 'BRAKE'],
    ['slow', 'BRAKE'],
    ['stop', 'BRAKE'],
    ['nitro', 'USE_POWER'],
    ['power', 'USE_POWER'],
  ]),
  'pt-BR': new Map([
    ['esquerda', 'MOVE_LEFT'],
    ['direita', 'MOVE_RIGHT'],
    ['acelerar', 'BOOST'],
    ['acelera', 'BOOST'],
    ['acelere', 'BOOST'],
    ['vai', 'BOOST'],
    ['frear', 'BRAKE'],
    ['freia', 'BRAKE'],
    ['freie', 'BRAKE'],
    ['devagar', 'BRAKE'],
    ['reduzir', 'BRAKE'],
    ['reduz', 'BRAKE'],
    ['reduza', 'BRAKE'],
    ['desacelerar', 'BRAKE'],
    ['desacelera', 'BRAKE'],
    ['desacelere', 'BRAKE'],
    ['parar', 'BRAKE'],
    ['nitro', 'USE_POWER'],
    ['turbo', 'USE_POWER'],
    ['poder', 'USE_POWER'],
  ]),
};

export function mapTranscriptToIntent(transcript: string, locale: SupportedLocale = DEFAULT_LOCALE): Intent | null {
  const norm = normalizeForMatching(transcript, locale);
  const tokens = norm.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  // scan from the end so the latest spoken command wins
  for (let i = tokens.length - 1; i >= 0; i--) {
    const hit = WORD_TO_INTENT[locale].get(tokens[i]!);
    if (hit) return hit;
  }
  return null;
}

/**
 * Extract the ordered list of command intents from a transcript, one entry per
 * matching token. e.g. "left right boost" → [MOVE_LEFT, MOVE_RIGHT, BOOST].
 * Used to handle Conversation Relay's ACCUMULATING partial transcripts: we look
 * at how many commands a growing partial contains and only act on newly-added ones.
 */
export function intentsFromTranscript(transcript: string, locale: SupportedLocale = DEFAULT_LOCALE): Intent[] {
  const norm = normalizeForMatching(transcript, locale);
  const tokens = norm.split(/\s+/).filter(Boolean);
  const out: Intent[] = [];
  for (const tok of tokens) {
    const hit = WORD_TO_INTENT[locale].get(tok);
    if (hit) out.push(hit);
  }
  return out;
}
