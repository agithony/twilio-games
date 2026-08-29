import { describe, expect, it } from 'vitest';
import { KARAOKE_SONG_DURATION_MS, parseKaraokeSongJson } from '../shared/karaoke';
import {
  A_THOUSAND_MILES,
  A_THOUSAND_MILES_ALIGNMENT_OFFSET_MS,
  EN_US_ORIGINAL_DEVELOPMENT_SONG,
  KARAOKE_DEVELOPMENT_SONG_FIXTURES,
  KARAOKE_DEVELOPMENT_SONGS,
  KARAOKE_RUNTIME_SONGS,
  NEVER_GONNA_GIVE_YOU_UP,
  PT_BR_ORIGINAL_DEVELOPMENT_SONG,
  karaokeDevelopmentSongById,
} from '../shared/karaoke-songs';

describe('original Voice Karaoke development songs', () => {
  it('provides one clearly labeled song for each supported development locale', () => {
    expect(KARAOKE_DEVELOPMENT_SONG_FIXTURES).toHaveLength(2);
    expect(KARAOKE_DEVELOPMENT_SONG_FIXTURES.map(song => song.locale)).toEqual(['en-US', 'pt-BR']);
    expect(KARAOKE_DEVELOPMENT_SONG_FIXTURES.every(song => song.provenance === 'original-development')).toBe(true);
    expect(new Set(KARAOKE_DEVELOPMENT_SONG_FIXTURES.map(song => song.id)).size).toBe(2);
  });

  it.each(KARAOKE_DEVELOPMENT_SONG_FIXTURES)('$title is a complete one-singer 45-second chart', song => {
    expect(song.artist).toBe('Voice Karaoke');
    expect(song.durationMs).toBe(KARAOKE_SONG_DURATION_MS);
    expect(song.singerCount).toBe(1);
    expect(song.audioUrl).toBeUndefined();
    expect(song.chart.laneCount).toBe(4);
    expect(song.chart.words).toHaveLength(48);
    expect(song.chart.words[0]!.startMs).toBeGreaterThanOrEqual(1_000);
    expect(song.chart.words.at(-1)!.endMs).toBeGreaterThan(43_000);
    expect(song.chart.words.at(-1)!.endMs).toBeLessThanOrEqual(song.durationMs);
  });

  it.each(KARAOKE_DEVELOPMENT_SONG_FIXTURES)('$title contains safe, playable cue data', song => {
    const ids = new Set<string>();
    let priorEnd = 0;
    for (const word of song.chart.words) {
      expect(word.text).toMatch(/^\p{L}+$/u);
      expect(word.startMs).toBeGreaterThanOrEqual(priorEnd);
      expect(word.endMs).toBeGreaterThan(word.startMs);
      expect(word.targetMidi).toBeGreaterThanOrEqual(0);
      expect(word.targetMidi).toBeLessThanOrEqual(127);
      expect([0, 1, 2, 3]).toContain(word.lane);
      expect(ids.has(word.id)).toBe(false);
      ids.add(word.id);
      priorEnd = word.endMs;
    }
  });

  it('contains original, locale-appropriate English and Portuguese lyrics', () => {
    expect(EN_US_ORIGINAL_DEVELOPMENT_SONG.chart.words.map(word => word.text).slice(0, 4))
      .toEqual(['wake', 'the', 'lights', 'glow']);
    expect(PT_BR_ORIGINAL_DEVELOPMENT_SONG.chart.words.map(word => word.text)).toEqual(
      expect.arrayContaining(['dê', 'ouça', 'faça', 'começar', 'até']),
    );
  });

  it.each(KARAOKE_DEVELOPMENT_SONG_FIXTURES)('$title round-trips through the untrusted JSON parser', song => {
    expect(parseKaraokeSongJson(JSON.stringify(song))).toEqual(song);
  });

  it('looks up known fixtures and fails closed for unknown or unsafe IDs', () => {
    expect(karaokeDevelopmentSongById('neon-hello-dev')).toBe(EN_US_ORIGINAL_DEVELOPMENT_SONG);
    expect(karaokeDevelopmentSongById('luz-no-ritmo-dev')).toBe(PT_BR_ORIGINAL_DEVELOPMENT_SONG);
    expect(karaokeDevelopmentSongById('never-gonna-give-you-up')).toBeNull();
    expect(karaokeDevelopmentSongById('missing')).toBeNull();
    expect(karaokeDevelopmentSongById('../neon-hello-dev')).toBeNull();
    expect(karaokeDevelopmentSongById('a'.repeat(65))).toBeNull();
  });
});

const LICENSED_LINES = [
  [['And', 4_100, 4_820], ['if', 4_820, 5_100], ['you', 5_100, 5_380], ['ask', 5_380, 5_860], ['me', 5_860, 6_160], ['how', 6_160, 6_440], ["I'm", 6_440, 6_820], ['feeling', 6_820, 7_400]],
  [["Don't", 8_460, 8_760], ['tell', 8_760, 9_000], ['me', 9_000, 9_300], ["you're", 9_300, 9_540], ['too', 9_540, 9_880], ['blind', 9_880, 10_300], ['to', 10_300, 10_580], ['see', 10_580, 11_020]],
  [['Never', 11_460, 11_680], ['gonna', 11_680, 11_920], ['give', 11_920, 12_300], ['you', 12_300, 12_780], ['up', 12_780, 13_300]],
  [['Never', 13_560, 13_780], ['gonna', 13_780, 14_040], ['let', 14_040, 14_340], ['you', 14_340, 14_760], ['down', 14_760, 15_440]],
  [['Never', 15_660, 15_920], ['gonna', 15_920, 16_160], ['run', 16_160, 16_700], ['around', 16_700, 17_420], ['and', 17_420, 17_880], ['desert', 17_880, 18_520], ['you', 18_520, 19_340]],
  [['Never', 19_740, 20_120], ['gonna', 20_120, 20_340], ['make', 20_340, 20_740], ['you', 20_740, 21_100], ['cry', 21_100, 21_660]],
  [['Never', 21_960, 22_240], ['gonna', 22_240, 22_440], ['say', 22_440, 22_940], ['goodbye', 22_940, 23_440]],
  [['Never', 24_220, 24_340], ['gonna', 24_340, 24_560], ['tell', 24_560, 25_080], ['a', 25_080, 25_400], ['lie', 25_400, 26_200], ['and', 26_320, 26_740], ['hurt', 26_740, 27_200], ['you', 27_200, 27_800]],
  [['Never', 27_800, 28_520], ['gonna', 28_520, 28_800], ['give', 28_800, 29_160], ['you', 29_160, 29_680], ['up', 29_680, 30_160]],
  [['Never', 30_520, 30_640], ['gonna', 30_640, 30_940], ['let', 30_940, 31_240], ['you', 31_240, 31_660], ['down', 31_660, 32_300]],
  [['Never', 32_600, 32_780], ['gonna', 32_780, 33_060], ['run', 33_060, 33_480], ['around', 33_480, 34_340], ['and', 34_340, 34_740], ['desert', 34_740, 35_380], ['you', 35_380, 36_240]],
  [['Never', 36_800, 37_000], ['gonna', 37_000, 37_240], ['make', 37_240, 37_620], ['you', 37_620, 37_960], ['cry', 37_960, 38_560]],
  [['Never', 38_920, 39_100], ['gonna', 39_100, 39_320], ['say', 39_320, 39_860], ['goodbye', 39_860, 40_420]],
  [['Never', 41_040, 41_240], ['gonna', 41_240, 41_500], ['tell', 41_500, 42_020], ['a', 42_020, 42_400], ['lie', 42_400, 43_040], ['and', 43_420, 43_640], ['hurt', 43_640, 44_060], ['you', 44_060, 44_720]],
] as const;

describe('licensed Voice Karaoke production catalog', () => {
  it('uses the licensed English recording by default and retains the Portuguese fallback', () => {
    expect(KARAOKE_RUNTIME_SONGS).toEqual([
      NEVER_GONNA_GIVE_YOU_UP,
      A_THOUSAND_MILES,
      PT_BR_ORIGINAL_DEVELOPMENT_SONG,
    ]);
    expect(KARAOKE_DEVELOPMENT_SONGS).toBe(KARAOKE_RUNTIME_SONGS);
    expect(KARAOKE_RUNTIME_SONGS.filter(song => song.locale === 'en-US')).toEqual([
      NEVER_GONNA_GIVE_YOU_UP,
      A_THOUSAND_MILES,
    ]);
    expect(KARAOKE_RUNTIME_SONGS).not.toContain(EN_US_ORIGINAL_DEVELOPMENT_SONG);
  });

  it('includes the complete user-confirmed 45-second Thousand Miles excerpt', () => {
    expect(A_THOUSAND_MILES).toMatchObject({
      id: 'a-thousand-miles',
      title: 'A Thousand Miles',
      artist: 'Vanessa Carlton',
      durationMs: 45_000,
      bpm: 95,
      provenance: 'user-confirmed-licensed',
      audioUrl: '/audio/karaoke/thousand-miles-45s.mp3?v=20260828-iconic-2',
    });
    expect(A_THOUSAND_MILES.chart.words).toHaveLength(55);
    expect(A_THOUSAND_MILES_ALIGNMENT_OFFSET_MS).toBe(424);
    expect(A_THOUSAND_MILES.chart.words[0]).toMatchObject({ text: 'Staring', startMs: 3_084 });
    expect(A_THOUSAND_MILES.chart.words.at(-1)).toMatchObject({ text: 'tonight', endMs: 43_864 });
    expect(A_THOUSAND_MILES.chart.words.filter(word => word.id.endsWith('-01')).map(word => word.startMs))
      .toEqual([3_084, 4_544, 5_824, 14_454, 17_044, 20_167, 23_044, 28_354, 33_254, 37_904]);
    expect(A_THOUSAND_MILES.chart.words.every((word, index, words) => (
      index === 0 || word.startMs >= words[index - 1]!.endMs
    ))).toBe(true);
    expect(new Set(A_THOUSAND_MILES.chart.words.map(word => word.lane))).toEqual(new Set([0, 1, 2, 3]));
    expect(parseKaraokeSongJson(JSON.stringify(A_THOUSAND_MILES))).toEqual(A_THOUSAND_MILES);
  });

  it('has exact production metadata and survives strict JSON parsing', () => {
    expect(NEVER_GONNA_GIVE_YOU_UP).toMatchObject({
      id: 'never-gonna-give-you-up',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      locale: 'en-US',
      durationMs: 45_000,
      bpm: 113.55,
      singerCount: 1,
      provenance: 'user-confirmed-licensed',
      audioUrl: '/audio/karaoke/classic-instrumental-45s.mp3?v=20260827-sync-2',
    });
    expect(parseKaraokeSongJson(JSON.stringify(NEVER_GONNA_GIVE_YOU_UP)))
      .toEqual(NEVER_GONNA_GIVE_YOU_UP);
  });

  it('preserves every supplied word window, line ID, and contraction', () => {
    for (const [lineIndex, expectedLine] of LICENSED_LINES.entries()) {
      const prefix = `never-gonna-give-you-up-${String(lineIndex + 1).padStart(2, '0')}-`;
      const words = NEVER_GONNA_GIVE_YOU_UP.chart.words.filter(word => word.id.startsWith(prefix));
      expect(words.map(word => [word.text, word.startMs, word.endMs])).toEqual(expectedLine);
      expect(words.map(word => word.id)).toEqual(expectedLine.map((_, wordIndex) => (
        `${prefix}${String(wordIndex + 1).padStart(2, '0')}`
      )));
    }
    expect(NEVER_GONNA_GIVE_YOU_UP.chart.words.map(word => word.text))
      .toEqual(expect.arrayContaining(["I'm", "Don't", "you're"]));
  });

  it('preserves every real rest and the four-lane provisional contour', () => {
    const words = NEVER_GONNA_GIVE_YOU_UP.chart.words;
    expect(words).toHaveLength(84);
    expect(words.every((word, index) => index === 0 || word.startMs >= words[index - 1]!.endMs)).toBe(true);
    expect(new Set(words.map(word => word.lane))).toEqual(new Set([0, 1, 2, 3]));
    expect(new Set(words.map(word => word.targetMidi))).toEqual(new Set([57, 59, 61, 62]));
    expect(words.every(word => word.lane === [57, 59, 61, 62].indexOf(word.targetMidi))).toBe(true);

    expect(words.slice(1).flatMap((word, index) => {
      const prior = words[index]!;
      return word.startMs > prior.endMs ? [[prior.endMs, word.startMs]] : [];
    })).toEqual([
      [7_400, 8_460], [11_020, 11_460], [13_300, 13_560], [15_440, 15_660],
      [19_340, 19_740], [21_660, 21_960], [23_440, 24_220], [26_200, 26_320],
      [30_160, 30_520], [32_300, 32_600], [36_240, 36_800], [38_560, 38_920],
      [40_420, 41_040], [43_040, 43_420],
    ]);
  });
});
