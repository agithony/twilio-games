import { parseKaraokeSong, type KaraokeSong } from './karaoke';

export const KARAOKE_TIMINGS_VERSION = 1 as const;

export interface KaraokeWordTimingOverride {
  readonly wordId: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface KaraokeSongTimingOverrides {
  readonly songId: string;
  readonly words: readonly KaraokeWordTimingOverride[];
}

export interface KaraokeTimingConfig {
  readonly version: typeof KARAOKE_TIMINGS_VERSION;
  readonly songs: readonly KaraokeSongTimingOverrides[];
}

export type KaraokeWordTimingDragMode = 'move' | 'start' | 'end';

export interface KaraokeWordTimingDrag {
  readonly mode: KaraokeWordTimingDragMode;
  readonly startMs: number;
  readonly endMs: number;
  readonly previousEndMs: number;
  readonly nextStartMs: number;
}

interface MutableWordTiming {
  startMs: number;
  endMs: number;
}

export interface KaraokeWordTimingSnapshot {
  readonly startMs: number;
  readonly endMs: number;
}

export const EMPTY_KARAOKE_TIMING_CONFIG: KaraokeTimingConfig = Object.freeze({
  version: KARAOKE_TIMINGS_VERSION,
  songs: Object.freeze([]),
});

export function applyKaraokeWordTimingDrag(
  words: readonly MutableWordTiming[],
  index: number,
  drag: KaraokeWordTimingDrag,
  deltaMs: number,
): void {
  const word = words[index];
  if (!word || !Number.isFinite(deltaMs)) return;
  const previous = words[index - 1];
  const next = words[index + 1];
  if (previous) previous.endMs = drag.previousEndMs;
  if (next) next.startMs = drag.nextStartMs;
  const roundedDelta = Math.round(deltaMs);

  if (drag.mode === 'start') {
    const minimum = Math.max(0, drag.endMs - 5_000, previous ? previous.startMs + 100 : 0);
    word.startMs = bounded(drag.startMs + roundedDelta, minimum, drag.endMs - 100);
    word.endMs = drag.endMs;
    if (previous && word.startMs < drag.previousEndMs) previous.endMs = word.startMs;
    return;
  }
  if (drag.mode === 'end') {
    const maximum = Math.min(45_000, drag.startMs + 5_000, next ? next.endMs - 100 : 45_000);
    word.startMs = drag.startMs;
    word.endMs = bounded(drag.endMs + roundedDelta, drag.startMs + 100, maximum);
    if (next && word.endMs > drag.nextStartMs) next.startMs = word.endMs;
    return;
  }

  const minimumDelta = (previous ? previous.startMs + 100 : 0) - drag.startMs;
  const maximumDelta = (next ? next.endMs - 100 : 45_000) - drag.endMs;
  const boundedDelta = bounded(roundedDelta, minimumDelta, maximumDelta);
  word.startMs = drag.startMs + boundedDelta;
  word.endMs = drag.endMs + boundedDelta;
  if (previous && word.startMs < drag.previousEndMs) previous.endMs = word.startMs;
  if (next && word.endMs > drag.nextStartMs) next.startMs = word.endMs;
}

export function applyKaraokeWordTimingGroupDrag(
  words: readonly MutableWordTiming[],
  firstIndex: number,
  lastIndex: number,
  snapshot: readonly KaraokeWordTimingSnapshot[],
  deltaMs: number,
): void {
  if (!Number.isInteger(firstIndex) || !Number.isInteger(lastIndex)
    || firstIndex < 0 || lastIndex < firstIndex || lastIndex >= words.length
    || snapshot.length !== words.length || !Number.isFinite(deltaMs)) return;
  for (let index = 0; index < words.length; index++) {
    words[index]!.startMs = snapshot[index]!.startMs;
    words[index]!.endMs = snapshot[index]!.endMs;
  }
  const first = snapshot[firstIndex]!;
  const last = snapshot[lastIndex]!;
  const previous = snapshot[firstIndex - 1];
  const next = snapshot[lastIndex + 1];
  const minimumDelta = (previous ? previous.startMs + 100 : 0) - first.startMs;
  const maximumDelta = (next ? next.endMs - 100 : 45_000) - last.endMs;
  const offset = bounded(Math.round(deltaMs), minimumDelta, maximumDelta);
  for (let index = firstIndex; index <= lastIndex; index++) {
    words[index]!.startMs = snapshot[index]!.startMs + offset;
    words[index]!.endMs = snapshot[index]!.endMs + offset;
  }
  if (previous && words[firstIndex]!.startMs < previous.endMs) {
    words[firstIndex - 1]!.endMs = words[firstIndex]!.startMs;
  }
  if (next && words[lastIndex]!.endMs > next.startMs) {
    words[lastIndex + 1]!.startMs = words[lastIndex]!.endMs;
  }
}

export function parseKaraokeTimingConfig(
  value: unknown,
  catalog: readonly KaraokeSong[],
): KaraokeTimingConfig {
  const input = record(value, '$');
  exactKeys(input, ['version', 'songs'], '$');
  if (input.version !== KARAOKE_TIMINGS_VERSION) throw new TypeError('$.version must equal 1');
  if (!Array.isArray(input.songs) || input.songs.length > catalog.length) {
    throw new TypeError('$.songs must be an array with at most one entry per catalog song');
  }

  const catalogById = new Map(catalog.map(song => [song.id, song]));
  const songIds = new Set<string>();
  const songs = input.songs.map((candidate, songIndex) => {
    const path = `$.songs[${songIndex}]`;
    const songInput = record(candidate, path);
    exactKeys(songInput, ['songId', 'words'], path);
    if (typeof songInput.songId !== 'string' || !catalogById.has(songInput.songId)) {
      throw new TypeError(`${path}.songId must identify a catalog song`);
    }
    if (songIds.has(songInput.songId)) throw new TypeError(`${path}.songId must be unique`);
    songIds.add(songInput.songId);
    const source = catalogById.get(songInput.songId)!;
    if (!Array.isArray(songInput.words) || songInput.words.length === 0
      || songInput.words.length > source.chart.words.length) {
      throw new TypeError(`${path}.words must contain timing overrides for catalog words`);
    }
    const sourceWords = new Set(source.chart.words.map(word => word.id));
    const wordIds = new Set<string>();
    const words = songInput.words.map((candidateWord, wordIndex) => {
      const wordPath = `${path}.words[${wordIndex}]`;
      const wordInput = record(candidateWord, wordPath);
      exactKeys(wordInput, ['wordId', 'startMs', 'endMs'], wordPath);
      if (typeof wordInput.wordId !== 'string' || !sourceWords.has(wordInput.wordId)) {
        throw new TypeError(`${wordPath}.wordId must identify a word in ${source.id}`);
      }
      if (wordIds.has(wordInput.wordId)) throw new TypeError(`${wordPath}.wordId must be unique`);
      wordIds.add(wordInput.wordId);
      if (!Number.isInteger(wordInput.startMs) || !Number.isInteger(wordInput.endMs)) {
        throw new TypeError(`${wordPath} timings must be integer milliseconds`);
      }
      return Object.freeze({
        wordId: wordInput.wordId,
        startMs: wordInput.startMs as number,
        endMs: wordInput.endMs as number,
      });
    });
    return Object.freeze({ songId: songInput.songId, words: Object.freeze(words) });
  });
  const config = Object.freeze({ version: KARAOKE_TIMINGS_VERSION, songs: Object.freeze(songs) });
  void applyKaraokeTimingConfig(catalog, config);
  return config;
}

export function applyKaraokeTimingConfig(
  catalog: readonly KaraokeSong[],
  config: KaraokeTimingConfig,
): readonly KaraokeSong[] {
  const songs = new Map(config.songs.map(song => [song.songId, song]));
  return Object.freeze(catalog.map(source => {
    const songOverrides = songs.get(source.id);
    if (!songOverrides) return source;
    const words = new Map(songOverrides.words.map(word => [word.wordId, word]));
    return parseKaraokeSong({
      ...source,
      chart: {
        ...source.chart,
        words: source.chart.words.map(word => {
          const override = words.get(word.id);
          return override ? { ...word, startMs: override.startMs, endMs: override.endMs } : word;
        }),
      },
    });
  }));
}

export function karaokeTimingConfigFromSongs(
  catalog: readonly KaraokeSong[],
  effectiveSongs: readonly KaraokeSong[],
): KaraokeTimingConfig {
  const effectiveById = new Map(effectiveSongs.map(song => [song.id, song]));
  const songs: KaraokeSongTimingOverrides[] = [];
  for (const source of catalog) {
    const effective = effectiveById.get(source.id);
    if (!effective) throw new TypeError(`effective catalog is missing ${source.id}`);
    const sourceWords = new Map(source.chart.words.map(word => [word.id, word]));
    const words = effective.chart.words.flatMap(word => {
      const original = sourceWords.get(word.id);
      if (!original) throw new TypeError(`${source.id} has an unknown effective word: ${word.id}`);
      return word.startMs === original.startMs && word.endMs === original.endMs
        ? []
        : [{ wordId: word.id, startMs: word.startMs, endMs: word.endMs }];
    });
    if (words.length) songs.push({ songId: source.id, words });
  }
  return parseKaraokeTimingConfig({ version: KARAOKE_TIMINGS_VERSION, songs }, catalog);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !expected.has(key))) {
    throw new TypeError(`${path} must contain exactly: ${keys.join(', ')}`);
  }
}

function bounded(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
