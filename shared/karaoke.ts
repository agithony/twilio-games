import { isSupportedLocale, type SupportedLocale } from './i18n/locales';

export const KARAOKE_SONG_DURATION_MS = 45_000;
export const KARAOKE_LANE_COUNT = 4;
export const KARAOKE_MAX_WORDS = 128;
export const KARAOKE_MAX_ID_LENGTH = 64;
export const KARAOKE_MAX_AUDIO_URL_LENGTH = 512;
export const KARAOKE_MAX_JSON_LENGTH = 128 * 1024;
export const KARAOKE_MAX_ARTIST_LENGTH = 80;
export const KARAOKE_MIN_MIDI_NOTE = 0;
export const KARAOKE_MAX_MIDI_NOTE = 127;

export const KARAOKE_LANES = [0, 1, 2, 3] as const;
export type KaraokeLane = typeof KARAOKE_LANES[number];
export const KARAOKE_SONG_PROVENANCES = [
  'original-development',
  'user-confirmed-licensed',
] as const;
export type KaraokeSongProvenance = typeof KARAOKE_SONG_PROVENANCES[number];

export interface KaraokeWord {
  readonly id: string;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly targetMidi: number;
  readonly lane: KaraokeLane;
}

export interface KaraokeChart {
  readonly laneCount: typeof KARAOKE_LANE_COUNT;
  readonly words: readonly KaraokeWord[];
}

export interface KaraokeSong {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly locale: SupportedLocale;
  readonly durationMs: typeof KARAOKE_SONG_DURATION_MS;
  readonly bpm: number;
  readonly singerCount: 1;
  readonly provenance: KaraokeSongProvenance;
  readonly audioUrl?: string;
  readonly chart: KaraokeChart;
}

export class KaraokeValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'KaraokeValidationError';
  }
}

const SONG_KEYS = [
  'id', 'title', 'artist', 'locale', 'durationMs', 'bpm', 'singerCount', 'provenance', 'audioUrl', 'chart',
] as const;
const SONG_REQUIRED_KEYS = SONG_KEYS.filter(key => key !== 'audioUrl');
const CHART_KEYS = ['laneCount', 'words'] as const;
const WORD_KEYS = ['id', 'text', 'startMs', 'endMs', 'targetMidi', 'lane'] as const;

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KaraokeValidationError(path, 'must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new KaraokeValidationError(path, 'must be a plain object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).find(key => !allowedSet.has(key));
  if (extra) throw new KaraokeValidationError(`${path}.${extra}`, 'is not supported');
  const missing = required.find(key => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) throw new KaraokeValidationError(`${path}.${missing}`, 'is required');
}

function text(value: unknown, path: string, maxCharacters: number): string {
  if (typeof value !== 'string') throw new KaraokeValidationError(path, 'must be a string');
  const normalized = value.normalize('NFC').trim();
  if (!normalized) throw new KaraokeValidationError(path, 'must not be empty');
  if (/\p{Cc}/u.test(normalized)) throw new KaraokeValidationError(path, 'contains control characters');
  if (Array.from(normalized).length > maxCharacters) {
    throw new KaraokeValidationError(path, `must be at most ${maxCharacters} characters`);
  }
  return normalized;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new KaraokeValidationError(path, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new KaraokeValidationError(path, `must be a finite number from ${min} to ${max}`);
  }
  return value;
}

/** IDs are deliberately limited to path-segment-safe lowercase slugs. */
export function isSafeKaraokeId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= KARAOKE_MAX_ID_LENGTH
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}

function identifier(value: unknown, path: string): string {
  if (!isSafeKaraokeId(value)) {
    throw new KaraokeValidationError(
      path,
      `must be a lowercase slug no longer than ${KARAOKE_MAX_ID_LENGTH} characters`,
    );
  }
  return value;
}

function rawUrlPath(value: string): string | null {
  if (value.startsWith('/')) {
    if (value.startsWith('//')) return null;
    return value.split(/[?#]/, 1)[0] ?? null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;

  const afterScheme = value.slice('https://'.length);
  const pathStart = afterScheme.indexOf('/');
  if (pathStart < 0) return '/';
  return afterScheme.slice(pathStart).split(/[?#]/, 1)[0] ?? null;
}

/** Allows same-origin absolute paths and HTTPS URLs without ambiguous or traversable path segments. */
export function isSafeKaraokeAudioUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > KARAOKE_MAX_AUDIO_URL_LENGTH
    || value !== value.trim() || /[\s\\\p{Cc}]/u.test(value) || value.includes('#')) return false;
  const path = rawUrlPath(value);
  if (!path || path.length > 256) return false;
  const segments = path.split('/').slice(1);
  return segments.length > 0 && segments.every(segment => segment.length > 0 && segment.length <= 80
    && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(segment) && segment !== '.' && segment !== '..');
}

function parseWord(
  value: unknown,
  index: number,
  durationMs: number,
  ids: Set<string>,
  previousEndMs: number,
): KaraokeWord {
  const path = `$.chart.words[${index}]`;
  const raw = plainRecord(value, path);
  exactKeys(raw, WORD_KEYS, WORD_KEYS, path);
  const id = identifier(raw.id, `${path}.id`);
  if (ids.has(id)) throw new KaraokeValidationError(`${path}.id`, `duplicates ${id}`);
  ids.add(id);

  const startMs = integer(raw.startMs, `${path}.startMs`, 0, durationMs - 1);
  const endMs = integer(raw.endMs, `${path}.endMs`, 1, durationMs);
  if (endMs <= startMs) throw new KaraokeValidationError(`${path}.endMs`, 'must be after startMs');
  if (endMs - startMs < 100 || endMs - startMs > 5_000) {
    throw new KaraokeValidationError(`${path}.endMs`, 'word duration must be from 100 to 5000ms');
  }
  if (startMs < previousEndMs) {
    throw new KaraokeValidationError(`${path}.startMs`, 'must not overlap or precede the prior word');
  }

  return Object.freeze({
    id,
    text: text(raw.text, `${path}.text`, 32),
    startMs,
    endMs,
    targetMidi: integer(
      raw.targetMidi,
      `${path}.targetMidi`,
      KARAOKE_MIN_MIDI_NOTE,
      KARAOKE_MAX_MIDI_NOTE,
    ),
    lane: integer(raw.lane, `${path}.lane`, 0, KARAOKE_LANE_COUNT - 1) as KaraokeLane,
  });
}

function parseChart(value: unknown, durationMs: number): KaraokeChart {
  const raw = plainRecord(value, '$.chart');
  exactKeys(raw, CHART_KEYS, CHART_KEYS, '$.chart');
  if (raw.laneCount !== KARAOKE_LANE_COUNT) {
    throw new KaraokeValidationError('$.chart.laneCount', `must equal ${KARAOKE_LANE_COUNT}`);
  }
  if (!Array.isArray(raw.words) || raw.words.length === 0 || raw.words.length > KARAOKE_MAX_WORDS) {
    throw new KaraokeValidationError('$.chart.words', `must contain 1 to ${KARAOKE_MAX_WORDS} words`);
  }

  const ids = new Set<string>();
  let previousEndMs = 0;
  const words = raw.words.map((word, index) => {
    const parsed = parseWord(word, index, durationMs, ids, previousEndMs);
    previousEndMs = parsed.endMs;
    return parsed;
  });
  return Object.freeze({ laneCount: KARAOKE_LANE_COUNT, words: Object.freeze(words) });
}

/** Parses untrusted song data into an immutable, fully validated Karaoke contract. */
export function parseKaraokeSong(value: unknown): KaraokeSong {
  const raw = plainRecord(value, '$');
  exactKeys(raw, SONG_KEYS, SONG_REQUIRED_KEYS, '$');
  const id = identifier(raw.id, '$.id');
  const title = text(raw.title, '$.title', 80);
  const artist = text(raw.artist, '$.artist', KARAOKE_MAX_ARTIST_LENGTH);
  if (!isSupportedLocale(raw.locale)) {
    throw new KaraokeValidationError('$.locale', 'must be a supported locale');
  }
  if (raw.durationMs !== KARAOKE_SONG_DURATION_MS) {
    throw new KaraokeValidationError('$.durationMs', `must equal ${KARAOKE_SONG_DURATION_MS}`);
  }
  const bpm = finiteNumber(raw.bpm, '$.bpm', 40, 240);
  if (raw.singerCount !== 1) throw new KaraokeValidationError('$.singerCount', 'must equal 1');
  if (!KARAOKE_SONG_PROVENANCES.includes(raw.provenance as KaraokeSongProvenance)) {
    throw new KaraokeValidationError(
      '$.provenance',
      `must be one of ${KARAOKE_SONG_PROVENANCES.join(', ')}`,
    );
  }
  const hasAudioUrl = Object.prototype.hasOwnProperty.call(raw, 'audioUrl');
  if (hasAudioUrl && !isSafeKaraokeAudioUrl(raw.audioUrl)) {
    throw new KaraokeValidationError('$.audioUrl', 'must be a safe root-relative or HTTPS audio URL');
  }
  const chart = parseChart(raw.chart, KARAOKE_SONG_DURATION_MS);

  const song: KaraokeSong = {
    id,
    title,
    artist,
    locale: raw.locale,
    durationMs: KARAOKE_SONG_DURATION_MS,
    bpm,
    singerCount: 1,
    provenance: raw.provenance as KaraokeSongProvenance,
    ...(hasAudioUrl ? { audioUrl: raw.audioUrl as string } : {}),
    chart,
  };
  return Object.freeze(song);
}

export function parseKaraokeSongJson(raw: string): KaraokeSong {
  if (typeof raw !== 'string' || raw.length > KARAOKE_MAX_JSON_LENGTH) {
    throw new KaraokeValidationError('$', `JSON must not exceed ${KARAOKE_MAX_JSON_LENGTH} characters`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new KaraokeValidationError('$', 'must be valid JSON');
  }
  return parseKaraokeSong(value);
}

export function validateKaraokeSong(value: unknown): asserts value is KaraokeSong {
  void parseKaraokeSong(value);
}

export function isKaraokeSong(value: unknown): value is KaraokeSong {
  try {
    parseKaraokeSong(value);
    return true;
  } catch {
    return false;
  }
}
