import { describe, expect, it } from 'vitest';
import { KARAOKE_RUNTIME_SONGS } from '../shared/karaoke-songs';
import {
  EMPTY_KARAOKE_TIMING_CONFIG,
  applyKaraokeWordTimingGroupDrag,
  applyKaraokeWordTimingDrag,
  applyKaraokeTimingConfig,
  karaokeTimingConfigFromSongs,
  parseKaraokeTimingConfig,
} from '../shared/karaoke-timings';

describe('Karaoke timing overrides', () => {
  it('moves contiguous targets by following only the crossed neighbor edge', () => {
    const words = [
      { startMs: 100, endMs: 500 },
      { startMs: 500, endMs: 800 },
      { startMs: 800, endMs: 1_200 },
    ];
    const drag = { mode: 'move' as const, startMs: 500, endMs: 800, previousEndMs: 500, nextStartMs: 800 };
    applyKaraokeWordTimingDrag(words, 1, drag, 100);
    expect(words).toEqual([
      { startMs: 100, endMs: 500 },
      { startMs: 600, endMs: 900 },
      { startMs: 900, endMs: 1_200 },
    ]);
    applyKaraokeWordTimingDrag(words, 1, drag, -100);
    expect(words).toEqual([
      { startMs: 100, endMs: 400 },
      { startMs: 400, endMs: 700 },
      { startMs: 800, endMs: 1_200 },
    ]);
  });

  it('extends contiguous starts and stops by moving the shared edge', () => {
    const words = [
      { startMs: 100, endMs: 500 },
      { startMs: 500, endMs: 800 },
      { startMs: 800, endMs: 1_200 },
    ];
    applyKaraokeWordTimingDrag(words, 1, {
      mode: 'start', startMs: 500, endMs: 800, previousEndMs: 500, nextStartMs: 800,
    }, -100);
    expect(words.slice(0, 2)).toEqual([
      { startMs: 100, endMs: 400 },
      { startMs: 400, endMs: 800 },
    ]);
    applyKaraokeWordTimingDrag(words, 1, {
      mode: 'end', startMs: 400, endMs: 800, previousEndMs: 400, nextStartMs: 800,
    }, 100);
    expect(words.slice(1)).toEqual([
      { startMs: 400, endMs: 900 },
      { startMs: 900, endMs: 1_200 },
    ]);
  });

  it('moves a contiguous selection as one section and preserves its internal timing', () => {
    const words = [
      { startMs: 100, endMs: 400 },
      { startMs: 400, endMs: 700 },
      { startMs: 700, endMs: 1_000 },
      { startMs: 1_000, endMs: 1_400 },
    ];
    const snapshot = words.map(word => ({ ...word }));
    applyKaraokeWordTimingGroupDrag(words, 1, 2, snapshot, 150);
    expect(words).toEqual([
      { startMs: 100, endMs: 400 },
      { startMs: 550, endMs: 850 },
      { startMs: 850, endMs: 1_150 },
      { startMs: 1_150, endMs: 1_400 },
    ]);
    applyKaraokeWordTimingGroupDrag(words, 1, 2, snapshot, -150);
    expect(words).toEqual([
      { startMs: 100, endMs: 250 },
      { startMs: 250, endMs: 550 },
      { startMs: 550, endMs: 850 },
      { startMs: 1_000, endMs: 1_400 },
    ]);
  });

  it('applies sparse word timings without changing song content', () => {
    const source = KARAOKE_RUNTIME_SONGS[0]!;
    const first = source.chart.words[0]!;
    const config = parseKaraokeTimingConfig({
      version: 1,
      songs: [{ songId: source.id, words: [{
        wordId: first.id, startMs: first.startMs + 20, endMs: first.endMs,
      }] }],
    }, KARAOKE_RUNTIME_SONGS);
    const effective = applyKaraokeTimingConfig(KARAOKE_RUNTIME_SONGS, config);
    expect(effective[0]!.id).toBe(source.id);
    expect(effective[0]!.title).toBe(source.title);
    expect(effective[0]!.audioUrl).toBe(source.audioUrl);
    expect(effective[0]!.chart.words[0]).toMatchObject({
      id: first.id, text: first.text, startMs: first.startMs + 20, endMs: first.endMs,
    });
    expect(effective[1]).toBe(KARAOKE_RUNTIME_SONGS[1]);
    expect(karaokeTimingConfigFromSongs(KARAOKE_RUNTIME_SONGS, effective)).toEqual(config);
  });

  it('uses an empty document as the compiled timing fallback', () => {
    expect(applyKaraokeTimingConfig(KARAOKE_RUNTIME_SONGS, EMPTY_KARAOKE_TIMING_CONFIG))
      .toEqual(KARAOKE_RUNTIME_SONGS);
  });

  it('rejects unknown IDs, duplicate overrides, overlaps, and unknown keys', () => {
    const source = KARAOKE_RUNTIME_SONGS[0]!;
    const [first, second] = source.chart.words;
    const parse = (songs: unknown) => parseKaraokeTimingConfig({ version: 1, songs }, KARAOKE_RUNTIME_SONGS);
    expect(() => parse([{ songId: 'missing', words: [{ wordId: first!.id, startMs: 1, endMs: 101 }] }]))
      .toThrow(/catalog song/);
    expect(() => parse([{ songId: source.id, words: [
      { wordId: first!.id, startMs: first!.startMs, endMs: first!.endMs },
      { wordId: first!.id, startMs: first!.startMs, endMs: first!.endMs },
    ] }])).toThrow(/unique/);
    expect(() => parse([{ songId: source.id, words: [{
      wordId: first!.id, startMs: first!.startMs, endMs: second!.startMs + 1,
    }] }])).toThrow(/startMs/);
    expect(() => parse([{ songId: source.id, words: [{
      wordId: first!.id, startMs: first!.startMs, endMs: first!.endMs, extra: true,
    }] }])).toThrow(/exactly/);
  });
});
