import type { KaraokeChart, KaraokeSong, KaraokeWord } from './karaoke';

export const KARAOKE_DEFAULT_APPROACH_MS = 3_000;
export const KARAOKE_MAX_APPROACH_MS = 10_000;

export type KaraokeWordPhase = 'pending' | 'active' | 'complete';
export type VisibleKaraokeWordPhase = 'approaching' | 'active';

export interface VisibleKaraokeWord {
  readonly word: KaraokeWord;
  readonly phase: VisibleKaraokeWordPhase;
  /** Zero at spawn and one when the word reaches its target at startMs. */
  readonly fallProgress: number;
  readonly timeToStartMs: number;
  readonly timeToEndMs: number;
}

export interface KaraokeLyricProjection {
  readonly current: KaraokeWord | null;
  readonly upcoming: KaraokeWord | null;
}

function finiteTime(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

export function karaokeWordPhaseAtTime(word: KaraokeWord, songTimeMs: number): KaraokeWordPhase {
  const time = finiteTime(songTimeMs, 'songTimeMs');
  if (time < word.startMs) return 'pending';
  if (time < word.endMs) return 'active';
  return 'complete';
}

export function activeKaraokeWordAtTime(chart: KaraokeChart, songTimeMs: number): KaraokeWord | null {
  const time = finiteTime(songTimeMs, 'songTimeMs');
  return chart.words.find(word => time >= word.startMs && time < word.endMs) ?? null;
}

export function karaokeLyricsAtTime(chart: KaraokeChart, songTimeMs: number): KaraokeLyricProjection {
  const time = finiteTime(songTimeMs, 'songTimeMs');
  const current = activeKaraokeWordAtTime(chart, time);
  const upcoming = chart.words.find(word => word.startMs > time && word.id !== current?.id) ?? null;
  return Object.freeze({ current, upcoming });
}

/** Projects the immutable chart into the falling words that should currently be rendered. */
export function visibleKaraokeWordsAtTime(
  chart: KaraokeChart,
  songTimeMs: number,
  approachMs = KARAOKE_DEFAULT_APPROACH_MS,
): readonly VisibleKaraokeWord[] {
  const time = finiteTime(songTimeMs, 'songTimeMs');
  if (!Number.isFinite(approachMs) || approachMs <= 0 || approachMs > KARAOKE_MAX_APPROACH_MS) {
    throw new RangeError(`approachMs must be greater than 0 and at most ${KARAOKE_MAX_APPROACH_MS}`);
  }

  return Object.freeze(chart.words.flatMap(word => {
    const spawnMs = word.startMs - approachMs;
    if (time < spawnMs || time >= word.endMs) return [];
    const active = time >= word.startMs;
    return [Object.freeze({
      word,
      phase: active ? 'active' as const : 'approaching' as const,
      fallProgress: active ? 1 : Math.min(1, Math.max(0, (time - spawnMs) / approachMs)),
      timeToStartMs: word.startMs - time,
      timeToEndMs: word.endMs - time,
    })];
  }));
}

export function karaokeSongProgressAtTime(song: KaraokeSong, songTimeMs: number): number {
  const time = finiteTime(songTimeMs, 'songTimeMs');
  return Math.min(1, Math.max(0, time / song.durationMs));
}
