import { describe, expect, it } from 'vitest';
import { EN_US_ORIGINAL_DEVELOPMENT_SONG, NEVER_GONNA_GIVE_YOU_UP } from '../shared/karaoke-songs';
import {
  KARAOKE_DEFAULT_APPROACH_MS,
  KARAOKE_MAX_APPROACH_MS,
  activeKaraokeWordAtTime,
  karaokeLyricsAtTime,
  karaokeSongProgressAtTime,
  karaokeWordPhaseAtTime,
  visibleKaraokeWordsAtTime,
} from '../shared/karaoke-timeline';

const song = EN_US_ORIGINAL_DEVELOPMENT_SONG;
const chart = song.chart;
const first = chart.words[0]!;

describe('Karaoke timeline helpers', () => {
  it('uses half-open word intervals for pending, active, and complete phases', () => {
    expect(karaokeWordPhaseAtTime(first, first.startMs - 1)).toBe('pending');
    expect(karaokeWordPhaseAtTime(first, first.startMs)).toBe('active');
    expect(karaokeWordPhaseAtTime(first, first.endMs - 0.01)).toBe('active');
    expect(karaokeWordPhaseAtTime(first, first.endMs)).toBe('complete');
  });

  it('returns the active word only within its exact singing window', () => {
    expect(activeKaraokeWordAtTime(chart, first.startMs - 1)).toBeNull();
    expect(activeKaraokeWordAtTime(chart, first.startMs)).toBe(first);
    expect(activeKaraokeWordAtTime(chart, first.endMs)).toBeNull();
  });

  it('provides current and upcoming lyrics for accessible and fallback projections', () => {
    const second = chart.words[1]!;
    expect(karaokeLyricsAtTime(chart, first.startMs - 1)).toEqual({ current: null, upcoming: first });
    expect(karaokeLyricsAtTime(chart, first.startMs)).toEqual({ current: first, upcoming: second });
    expect(Object.isFrozen(karaokeLyricsAtTime(chart, first.startMs))).toBe(true);
  });

  it('projects the licensed chart exactly across line boundaries', () => {
    const licensed = NEVER_GONNA_GIVE_YOU_UP.chart;
    const opening = licensed.words[0]!;
    const nextLine = licensed.words.find(word => word.id.endsWith('-02-01'))!;
    expect(opening.startMs).toBe(4_100);
    expect(karaokeLyricsAtTime(licensed, 4_099)).toEqual({ current: null, upcoming: opening });
    expect(activeKaraokeWordAtTime(licensed, 4_100)).toBe(opening);
    expect(nextLine.startMs).toBe(8_460);
    expect(activeKaraokeWordAtTime(licensed, 8_460)).toBe(nextLine);
    expect(licensed.words.at(-1)!.endMs).toBe(44_720);
    expect(activeKaraokeWordAtTime(licensed, 45_000)).toBeNull();
  });

  it('spawns a falling word at zero progress exactly approachMs before its start', () => {
    const spawnMs = first.startMs - KARAOKE_DEFAULT_APPROACH_MS;
    expect(visibleKaraokeWordsAtTime(chart, spawnMs - 1).some(item => item.word === first)).toBe(false);
    const visible = visibleKaraokeWordsAtTime(chart, spawnMs).find(item => item.word === first)!;
    expect(visible).toMatchObject({
      word: first,
      phase: 'approaching',
      fallProgress: 0,
      timeToStartMs: KARAOKE_DEFAULT_APPROACH_MS,
    });
  });

  it('moves linearly toward the target and reaches it at the word start', () => {
    const spawnMs = first.startMs - KARAOKE_DEFAULT_APPROACH_MS;
    const midpoint = visibleKaraokeWordsAtTime(chart, (spawnMs + first.startMs) / 2)
      .find(item => item.word === first)!;
    expect(midpoint.fallProgress).toBeCloseTo(0.5);
    expect(midpoint.phase).toBe('approaching');

    const active = visibleKaraokeWordsAtTime(chart, first.startMs).find(item => item.word === first)!;
    expect(active.fallProgress).toBe(1);
    expect(active.phase).toBe('active');
    expect(active.timeToStartMs).toBe(0);
  });

  it('keeps an active word visible and removes it exactly at its end', () => {
    const active = visibleKaraokeWordsAtTime(chart, first.endMs - 1).find(item => item.word === first)!;
    expect(active.phase).toBe('active');
    expect(active.timeToEndMs).toBe(1);
    expect(visibleKaraokeWordsAtTime(chart, first.endMs).some(item => item.word === first)).toBe(false);
  });

  it('returns all visible words in chart order without mutating the chart', () => {
    const before = chart.words.map(word => word.id);
    const visible = visibleKaraokeWordsAtTime(chart, 0);
    expect(visible.length).toBeGreaterThan(1);
    expect(visible.map(item => item.word.id)).toEqual(before.slice(0, visible.length));
    expect(chart.words.map(word => word.id)).toEqual(before);
    expect(Object.isFrozen(visible)).toBe(true);
    expect(visible.every(Object.isFrozen)).toBe(true);
  });

  it('supports a custom approach window', () => {
    expect(visibleKaraokeWordsAtTime(chart, first.startMs - 501, 500).some(item => item.word === first)).toBe(false);
    expect(visibleKaraokeWordsAtTime(chart, first.startMs - 500, 500)[0]).toMatchObject({
      word: first,
      fallProgress: 0,
    });
  });

  it('clamps song progress before zero and after the 45-second duration', () => {
    expect(karaokeSongProgressAtTime(song, -100)).toBe(0);
    expect(karaokeSongProgressAtTime(song, song.durationMs / 2)).toBe(0.5);
    expect(karaokeSongProgressAtTime(song, song.durationMs)).toBe(1);
    expect(karaokeSongProgressAtTime(song, song.durationMs + 100)).toBe(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite song time %s',
    songTimeMs => {
      expect(() => karaokeWordPhaseAtTime(first, songTimeMs)).toThrow(/finite/);
      expect(() => activeKaraokeWordAtTime(chart, songTimeMs)).toThrow(/finite/);
      expect(() => karaokeLyricsAtTime(chart, songTimeMs)).toThrow(/finite/);
      expect(() => visibleKaraokeWordsAtTime(chart, songTimeMs)).toThrow(/finite/);
      expect(() => karaokeSongProgressAtTime(song, songTimeMs)).toThrow(/finite/);
    },
  );

  it.each([0, -1, Number.NaN, KARAOKE_MAX_APPROACH_MS + 1])(
    'rejects invalid approach window %s',
    approachMs => {
      expect(() => visibleKaraokeWordsAtTime(chart, 0, approachMs)).toThrow(/approachMs/);
    },
  );
});
