import type { GameEvent } from '../shared/types';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import { RACER_MESSAGES, type RacerMessageKey } from '../shared/i18n/racer';
import { createTranslator } from '../shared/i18n/translate';
import { carName, trackName } from '../shared/i18n/content';

type Text = ReturnType<typeof createTranslator<RacerMessageKey>>;
const pick = (arr: readonly RacerMessageKey[], seq: number, text: Text): string => text(arr[Math.abs(seq) % arr.length]!);

// Pre-race host lines (menus) — keep the AI talking through car/map select, not just the race.
const CAR_SELECT = ['commentary.carSelect.0', 'commentary.carSelect.1', 'commentary.carSelect.2'] as const;
const MAP_SELECT = ['commentary.mapSelect.0', 'commentary.mapSelect.1', 'commentary.mapSelect.2'] as const;
const CAR_PICKED = ['commentary.carPicked.0', 'commentary.carPicked.1', 'commentary.carPicked.2', 'commentary.carPicked.3', 'commentary.carPicked.4'] as const;
const MAP_PICKED = ['commentary.mapPicked.0', 'commentary.mapPicked.1', 'commentary.mapPicked.2'] as const;
const GO = ['commentary.go.0', 'commentary.go.1', 'commentary.go.2', 'commentary.go.3'] as const;
const HIT = ['commentary.hit.0', 'commentary.hit.1', 'commentary.hit.2', 'commentary.hit.3', 'commentary.hit.4'] as const;
const LEAD = ['commentary.lead.0', 'commentary.lead.1', 'commentary.lead.2', 'commentary.lead.3'] as const;
const OVER = ['commentary.over.0', 'commentary.over.1', 'commentary.over.2'] as const;
// Arcade-style reactive banks (name is prefixed by the caller):
const STREAK = ['commentary.streak.0', 'commentary.streak.1', 'commentary.streak.2', 'commentary.streak.3', 'commentary.streak.4'] as const;
const LAST = ['commentary.last.0', 'commentary.last.1', 'commentary.last.2', 'commentary.last.3'] as const;

function ordinal(n: number, locale: SupportedLocale): string {
  if (locale === 'pt-BR') return `${n}º`;
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

export function commentaryFor(event: GameEvent, seq: number, locale: SupportedLocale = DEFAULT_LOCALE): string | null {
  const text = createTranslator(locale, RACER_MESSAGES);
  switch (event.kind) {
    case 'enter_car_select': return pick(CAR_SELECT, seq, text);
    case 'enter_map_select': return pick(MAP_SELECT, seq, text);
    case 'car_picked':       return text('commentary.carPickedLine', { name: event.name, reaction: pick(CAR_PICKED, seq, text), car: carName(locale, event.car) });
    case 'map_picked':       return text('commentary.mapPickedLine', { map: trackName(locale, event.map), reaction: pick(MAP_PICKED, seq, text) });
    case 'go':          return pick(GO, seq, text);
    case 'hit':         return pick(HIT, seq, text);
    case 'hit_streak':  return text('commentary.namedLine', { name: event.name, reaction: pick(STREAK, seq, text) });
    case 'fell_to_last':return text('commentary.namedLine', { name: event.name, reaction: pick(LAST, seq, text) });
    case 'lead_change': return text('commentary.namedLine', { name: event.name, reaction: pick(LEAD, seq, text) });
    case 'finish':      return event.place === 1
      ? text('commentary.finishWinner', { name: event.name })
      : text('commentary.finishPlace', { name: event.name, place: ordinal(event.place, locale) });
    case 'race_over':   return pick(OVER, seq, text);
    case 'countdown':   return null;   // the big-text overlay already shows the number
    default:            return null;
  }
}
