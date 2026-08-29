import { describe, expect, it } from 'vitest';
import {
  KARAOKE_MAX_AUDIO_URL_LENGTH,
  KARAOKE_MAX_ARTIST_LENGTH,
  KARAOKE_MAX_ID_LENGTH,
  KARAOKE_MAX_JSON_LENGTH,
  KARAOKE_MAX_WORDS,
  KaraokeValidationError,
  isKaraokeSong,
  isSafeKaraokeAudioUrl,
  isSafeKaraokeId,
  parseKaraokeSong,
  parseKaraokeSongJson,
  validateKaraokeSong,
} from '../shared/karaoke';

function validSong(): Record<string, unknown> {
  return {
    id: 'test-song',
    title: 'Test Song',
    artist: 'Test Artist',
    locale: 'en-US',
    durationMs: 45_000,
    bpm: 100,
    singerCount: 1,
    provenance: 'original-development',
    chart: {
      laneCount: 4,
      words: [
        { id: 'test-song-01', text: 'hello', startMs: 1_000, endMs: 1_600, targetMidi: 60, lane: 0 },
        { id: 'test-song-02', text: 'light', startMs: 1_800, endMs: 2_400, targetMidi: 64, lane: 2 },
      ],
    },
  };
}

function chartOf(song: Record<string, unknown>): Record<string, unknown> {
  return song.chart as Record<string, unknown>;
}

function wordsOf(song: Record<string, unknown>): Array<Record<string, unknown>> {
  return chartOf(song).words as Array<Record<string, unknown>>;
}

describe('Karaoke song contracts', () => {
  it('parses and deeply freezes a complete valid song', () => {
    const parsed = parseKaraokeSong(validSong());
    expect(parsed).toMatchObject({
      id: 'test-song',
      artist: 'Test Artist',
      locale: 'en-US',
      durationMs: 45_000,
      singerCount: 1,
      provenance: 'original-development',
    });
    expect(parsed.audioUrl).toBeUndefined();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.chart)).toBe(true);
    expect(Object.isFrozen(parsed.chart.words)).toBe(true);
    expect(Object.isFrozen(parsed.chart.words[0])).toBe(true);
  });

  it('normalizes display and lyric text without mutating the source', () => {
    const input = validSong();
    input.title = '  Canção  ';
    input.artist = '  Artista  ';
    wordsOf(input)[0]!.text = '  olá  ';
    const parsed = parseKaraokeSong(input);
    expect(parsed.title).toBe('Canção');
    expect(parsed.artist).toBe('Artista');
    expect(parsed.chart.words[0]!.text).toBe('olá');
    expect(input.title).toBe('  Canção  ');
  });

  it('parses JSON and exposes assertion and predicate validators', () => {
    const input: unknown = validSong();
    expect(parseKaraokeSongJson(JSON.stringify(input)).id).toBe('test-song');
    expect(() => validateKaraokeSong(input)).not.toThrow();
    expect(isKaraokeSong(input)).toBe(true);
    expect(isKaraokeSong({})).toBe(false);
  });

  it('rejects malformed and excessively large JSON', () => {
    expect(() => parseKaraokeSongJson('{bad')).toThrow(/valid JSON/);
    expect(() => parseKaraokeSongJson('x'.repeat(KARAOKE_MAX_JSON_LENGTH + 1))).toThrow(/must not exceed/);
  });

  it('rejects unknown and missing fields at every contract level', () => {
    const extraSong = validSong();
    extraSong.singers = [];
    expect(() => parseKaraokeSong(extraSong)).toThrow(/\$\.singers/);

    const missingSong = validSong();
    delete missingSong.title;
    expect(() => parseKaraokeSong(missingSong)).toThrow(/\$\.title/);

    const extraChart = validSong();
    chartOf(extraChart).speed = 2;
    expect(() => parseKaraokeSong(extraChart)).toThrow(/\$\.chart\.speed/);

    const extraWord = validSong();
    wordsOf(extraWord)[0]!.singer = 1;
    expect(() => parseKaraokeSong(extraWord)).toThrow(/words\[0\]\.singer/);
  });

  it('rejects arrays and class instances where plain objects are required', () => {
    expect(() => parseKaraokeSong([])).toThrow(KaraokeValidationError);
    expect(() => parseKaraokeSong(new (class Song {})())).toThrow(/plain object/);
    const song = validSong();
    song.chart = [];
    expect(() => parseKaraokeSong(song)).toThrow(/plain object/);
  });

  it.each([
    ['locale', 'en-GB'],
    ['durationMs', 44_999],
    ['bpm', 39],
    ['bpm', 241],
    ['bpm', Number.NaN],
    ['bpm', Number.POSITIVE_INFINITY],
    ['singerCount', 2],
    ['provenance', 'licensed'],
  ])('rejects invalid song field %s=%s', (field, value) => {
    const song = validSong();
    song[field] = value;
    expect(() => parseKaraokeSong(song)).toThrow();
  });

  it('accepts bounded finite fractional BPM values', () => {
    const song = validSong();
    song.bpm = 113.55;
    expect(parseKaraokeSong(song).bpm).toBe(113.55);
  });

  it('accepts only the modeled user-confirmed licensed provenance', () => {
    const song = validSong();
    song.provenance = 'user-confirmed-licensed';
    song.audioUrl = '/audio/karaoke/licensed.mp3';
    expect(parseKaraokeSong(song)).toMatchObject({
      artist: 'Test Artist',
      provenance: 'user-confirmed-licensed',
      audioUrl: '/audio/karaoke/licensed.mp3',
    });
  });

  it('requires bounded artist display metadata and rejects unmodeled calibration metadata', () => {
    const missing = validSong();
    delete missing.artist;
    expect(() => parseKaraokeSong(missing)).toThrow(/\$\.artist/);

    for (const artist of ['', 'bad\nartist', 'a'.repeat(KARAOKE_MAX_ARTIST_LENGTH + 1)]) {
      const song = validSong();
      song.artist = artist;
      expect(() => parseKaraokeSong(song)).toThrow(/\$\.artist/);
    }

    const unmodeled = validSong();
    unmodeled.pitchCalibration = 'provisional';
    expect(() => parseKaraokeSong(unmodeled)).toThrow(/\$\.pitchCalibration/);
  });

  it('requires exactly four lanes and a bounded, non-empty chart', () => {
    const wrongLanes = validSong();
    chartOf(wrongLanes).laneCount = 5;
    expect(() => parseKaraokeSong(wrongLanes)).toThrow(/laneCount/);

    const empty = validSong();
    chartOf(empty).words = [];
    expect(() => parseKaraokeSong(empty)).toThrow(/1 to 128 words/);

    const tooMany = validSong();
    chartOf(tooMany).words = Array.from({ length: KARAOKE_MAX_WORDS + 1 }, () => ({}));
    expect(() => parseKaraokeSong(tooMany)).toThrow(/1 to 128 words/);
  });

  it.each([
    ['startMs', -1],
    ['startMs', 1.5],
    ['endMs', 45_001],
    ['targetMidi', -1],
    ['targetMidi', 128],
    ['targetMidi', 60.5],
    ['lane', -1],
    ['lane', 4],
    ['lane', 1.5],
  ])('rejects an invalid word field %s=%s', (field, value) => {
    const song = validSong();
    wordsOf(song)[0]![field] = value;
    expect(() => parseKaraokeSong(song)).toThrow();
  });

  it('rejects reversed, very short, very long, overlapping, and unsorted cues', () => {
    for (const [startMs, endMs] of [[1_000, 1_000], [1_000, 1_099], [1_000, 6_001]]) {
      const song = validSong();
      Object.assign(wordsOf(song)[0]!, { startMs, endMs });
      expect(() => parseKaraokeSong(song)).toThrow();
    }

    const overlapping = validSong();
    wordsOf(overlapping)[1]!.startMs = 1_500;
    expect(() => parseKaraokeSong(overlapping)).toThrow(/overlap or precede/);
  });

  it('rejects duplicate cue IDs and invalid lyric text', () => {
    const duplicate = validSong();
    wordsOf(duplicate)[1]!.id = 'test-song-01';
    expect(() => parseKaraokeSong(duplicate)).toThrow(/duplicates/);

    const control = validSong();
    wordsOf(control)[0]!.text = 'bad\nword';
    expect(() => parseKaraokeSong(control)).toThrow(/control characters/);

    const long = validSong();
    wordsOf(long)[0]!.text = 'w'.repeat(33);
    expect(() => parseKaraokeSong(long)).toThrow(/at most 32/);
  });
});

describe('Karaoke identifier and audio URL safety', () => {
  it.each(['song', 'song-2', 'a'.repeat(KARAOKE_MAX_ID_LENGTH)])('accepts safe ID %s', id => {
    expect(isSafeKaraokeId(id)).toBe(true);
  });

  it.each([
    '', '..', '.', '../song', 'songs/test', 'songs\\test', '-song', 'song-', 'Song',
    'a'.repeat(KARAOKE_MAX_ID_LENGTH + 1),
  ])('rejects unsafe ID %s', id => {
    expect(isSafeKaraokeId(id)).toBe(false);
    const song = validSong();
    song.id = id;
    expect(() => parseKaraokeSong(song)).toThrow(/lowercase slug/);
  });

  it.each([
    '/assets/karaoke/test-song.mp3',
    '/audio/test_song-v2.ogg?version=2',
    'https://cdn.example.com/karaoke/test-song.m4a',
    'https://cdn.example.com/audio/test.wav?token=abc123',
  ])('accepts safe audio URL %s', audioUrl => {
    expect(isSafeKaraokeAudioUrl(audioUrl)).toBe(true);
    const song = validSong();
    song.audioUrl = audioUrl;
    expect(parseKaraokeSong(song).audioUrl).toBe(audioUrl);
  });

  it.each([
    '../secret.mp3',
    '/assets/../secret.mp3',
    '/assets/%2e%2e/secret.mp3',
    '/assets/%252e%252e/secret.mp3',
    '/assets\\secret.mp3',
    '//evil.example/test.mp3',
    'http://cdn.example.com/test.mp3',
    'https://user:pass@cdn.example.com/test.mp3',
    'https://cdn.example.com/test.mp3#fragment',
    '/assets//test.mp3',
    `/${'a'.repeat(81)}.mp3`,
    'x'.repeat(KARAOKE_MAX_AUDIO_URL_LENGTH + 1),
  ])('rejects unsafe audio URL %s', audioUrl => {
    expect(isSafeKaraokeAudioUrl(audioUrl)).toBe(false);
    const song = validSong();
    song.audioUrl = audioUrl;
    expect(() => parseKaraokeSong(song)).toThrow(/safe root-relative or HTTPS/);
  });

  it('distinguishes an omitted audio URL from an invalid undefined field', () => {
    expect(parseKaraokeSong(validSong()).audioUrl).toBeUndefined();
    const song = validSong();
    song.audioUrl = undefined;
    expect(() => parseKaraokeSong(song)).toThrow(/audioUrl/);
  });
});
