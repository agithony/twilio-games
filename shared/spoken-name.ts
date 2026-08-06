import { DEFAULT_LOCALE, type SupportedLocale } from './i18n/locales';
import { normalizeForMatching } from './i18n/translate';

const PORTUGUESE_LEAD_IN = /^(?:(?:oi|ol[aá])[,! ]+)?(?:o meu nome (?:é|e)|meu primeiro nome (?:é|e)|meu nome (?:é|e)|eu sou|sou|eu me chamo(?: de)?|me chamo(?: de)?|me chamam de|cham[ae][ -]?me de|me chama de|pode me chamar de|pode chamar de|aqui (?:é|e)|(?:é|e) (?:a|o))\s+/iu;
const ENGLISH_LEAD_IN = /^(?:(?:hi|hello)[,! ]+)?(?:my first name is|my name is|i am|i'm|im|this is|it's|its|call me|the name's|name's)\s+/i;
const PORTUGUESE_NON_NAME = /\b(?:acelerar|afastar|afaste|agora|ajuda|alo|aproximar|aproxime|ataca|atacar|ataque|avancar|avance|batalhar|bloquear|cancelar|chute|chutar|comecar|combater|comandos|corrigir|cura|curar|defender|desacelera|direita|escolher|esquerda|estou pronta|estou pronto|frear|frente|golpe|golpear|iniciar|ir|item|jogar|luta|lute|lutador|lutadores|lutar|monstro|monstros|nao entendi|nitro|o que|pista|pocao|proteger|provocar|pular|pule|qual|quais|que|quem|como|onde|quando|por que|porque|proximo|pronta|pronto|recuar|recue|reduz|revanche|saltar|sim|nao|soco|socar|tudo bem|voltar|zombar)\b/;
const ENGLISH_NON_NAME = /\b(?:all good|attack|away|back|backward|block|boost|brake|cancel|choose|closer|commands|correct|defend|fight|fights|five|flight|forward|game|go|guard|heal|hello|help|hop|how|item|jab|jump|kick|leap|left|monster|move|next|nitro|no|not understand|okay|play|potion|power|punch|ready|rematch|return|right|roundhouse|slow|star|start|stop|strike|taunt|track|what|when|where|which|who|why|yes)\b/;
const NON_NAME_SENTENCE = /\b(?:last name|full name|sobrenome|nome completo)\b/;
const PORTUGUESE_PARTICLES = new Set(['da','das','de','do','dos','e']);

export function isExplicitSpokenName(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): boolean {
  return (locale === 'pt-BR' ? PORTUGUESE_LEAD_IN : ENGLISH_LEAD_IN).test(spoken.normalize('NFC').trim());
}

export function parseFirstName(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): string | null {
  return parseName(spoken, locale, true, 2);
}

export function parseTypedFirstName(input: string, locale: SupportedLocale = DEFAULT_LOCALE): string | null {
  return parseName(input, locale, false, 1);
}

function parseName(input: string, locale: SupportedLocale, rejectCommands: boolean, minimumLength: number): string | null {
  let value = input.normalize('NFC').trim().replace(/[.!?,;:]+$/u, '').trim();
  if (!value) return null;
  const explicit = isExplicitSpokenName(value, locale);
  value = value.replace(locale === 'pt-BR' ? PORTUGUESE_LEAD_IN : ENGLISH_LEAD_IN, '').trim();
  if (locale === 'pt-BR' && explicit) value = value.replace(/^(?:a|o)\s+/iu, '');
  value = value.replace(locale === 'pt-BR' ? /(?:,?\s+(?:por favor|aqui))$/iu : /(?:,?\s+please)$/iu, '').trim();
  if (!/^[\p{L}'’ -]+$/u.test(value)) return null;
  const normalized = normalizeForMatching(value, locale);
  if (!normalized || NON_NAME_SENTENCE.test(normalized)
    || rejectCommands && (locale === 'pt-BR' ? PORTUGUESE_NON_NAME : ENGLISH_NON_NAME).test(normalized)) return null;

  const words = value.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
  if (words.length === 0 || words.length > 3) return null;
  if (words.length === 3 && !PORTUGUESE_PARTICLES.has(words[1]!.toLocaleLowerCase(locale))) return null;
  const name = words.map((word, index) => {
    const lower = word.toLocaleLowerCase(locale);
    if (locale === 'pt-BR' && index > 0 && PORTUGUESE_PARTICLES.has(lower)) return lower;
    if (locale === 'en-US' && (/^[A-Z]{2,3}$/.test(word) || /\p{Lu}/u.test(word.slice(1)))) return word;
    return lower.replace(/(^|['’-])(\p{L})/gu, (_match, prefix: string, letter: string) =>
      prefix + letter.toLocaleUpperCase(locale));
  }).join(' ');
  return name.length >= minimumLength && name.length <= 40 ? name : null;
}
