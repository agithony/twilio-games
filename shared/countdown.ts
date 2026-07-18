import { DEFAULT_LOCALE, type SupportedLocale } from './i18n/locales';
import { RACER_MESSAGES, type RacerMessageKey } from './i18n/racer';
import { createTranslator } from './i18n/translate';

const COUNTDOWN_CUES: Record<number, RacerMessageKey | '3' | '2' | '1'> = {
  6: 'countdown.onYourMark',
  5: 'countdown.getReady',
  4: 'countdown.getSet',
  3: '3',
  2: '2',
  1: '1',
};

export function countdownCue(n: number, locale: SupportedLocale = DEFAULT_LOCALE): string | null {
  const cue = COUNTDOWN_CUES[n];
  if (!cue) return null;
  return cue === '1' || cue === '2' || cue === '3'
    ? cue : createTranslator(locale, RACER_MESSAGES)(cue);
}

export function countdownDisplay(seconds: number, locale: SupportedLocale = DEFAULT_LOCALE): string {
  if (seconds <= 0) return '';
  return countdownCue(Math.min(6, Math.ceil(seconds)), locale) ?? '';
}

export function isCountdownSoundCue(n: number): boolean {
  return n === 3;
}
