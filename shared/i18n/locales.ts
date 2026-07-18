export const SUPPORTED_LOCALES = ['en-US', 'pt-BR'] as const;
export type SupportedLocale = typeof SUPPORTED_LOCALES[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en-US';

export interface LocaleProfile {
  locale: SupportedLocale;
  label: string;
  shortLabel: string;
  direction: 'ltr' | 'rtl';
  transcriptionLanguage: string;
  ttsLanguage: string;
}

export const LOCALE_PROFILES: Record<SupportedLocale, LocaleProfile> = {
  'en-US': {
    locale: 'en-US',
    label: 'English',
    shortLabel: 'EN',
    direction: 'ltr',
    transcriptionLanguage: 'en-US',
    ttsLanguage: 'en-US',
  },
  'pt-BR': {
    locale: 'pt-BR',
    label: 'Português (Brasil)',
    shortLabel: 'PT',
    direction: 'ltr',
    transcriptionLanguage: 'pt-BR',
    ttsLanguage: 'pt-BR',
  },
};

export function resolveLocale(value: unknown, fallback: SupportedLocale = DEFAULT_LOCALE): SupportedLocale {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().replace('_', '-').toLowerCase();
  const exact = SUPPORTED_LOCALES.find(locale => locale.toLowerCase() === normalized);
  if (exact) return exact;
  const language = normalized.split('-')[0];
  return SUPPORTED_LOCALES.find(locale => locale.toLowerCase().split('-')[0] === language) ?? fallback;
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && SUPPORTED_LOCALES.includes(value as SupportedLocale);
}
