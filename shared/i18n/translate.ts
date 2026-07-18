import { DEFAULT_LOCALE, type SupportedLocale } from './locales';

export type MessageValues = Record<string, string | number>;
export type LocalizedCatalog<Key extends string = string> = Record<SupportedLocale, Record<Key, string>>;

export function createTranslator<Key extends string>(locale: SupportedLocale, catalog: LocalizedCatalog<Key>) {
  return (key: Key, values: MessageValues = {}): string => {
    const template = catalog[locale][key] ?? catalog[DEFAULT_LOCALE][key] ?? key;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
  };
}

export function formatList(locale: SupportedLocale, values: string[]): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(values);
}

export function formatNumber(locale: SupportedLocale, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function normalizeForMatching(value: string, locale: SupportedLocale, foldAccents = true): string {
  let normalized = value.normalize('NFKC').toLocaleLowerCase(locale);
  if (foldAccents) normalized = normalized.normalize('NFD').replace(/\p{M}+/gu, '');
  return normalized.replace(/[^\p{L}\p{N}\s'-]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function wordsForMatching(value: string, locale: SupportedLocale): string[] {
  const normalized = normalizeForMatching(value, locale);
  if (!normalized) return [];
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    return [...segmenter.segment(normalized)].filter(part => part.isWordLike).map(part => part.segment);
  }
  return normalized.split(/\s+/).filter(Boolean);
}
