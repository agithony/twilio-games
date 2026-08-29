import {
  KARAOKE_LANE_COUNT,
  KARAOKE_SONG_DURATION_MS,
  isSafeKaraokeId,
  parseKaraokeSong,
  type KaraokeLane,
  type KaraokeSong,
} from './karaoke';
import type { SupportedLocale } from './i18n/locales';

type WordSpec = readonly [
  text: string,
  startMs: number,
  endMs: number,
  targetMidi: number,
  lane: KaraokeLane,
];

type ExplicitWordSpec = readonly [
  text: string,
  startMs: number,
  endMs: number,
];

type ProvisionalContourWordSpec = readonly [
  text: string,
  targetMidi: number,
  lane: KaraokeLane,
];

function originalDevelopmentSong(
  id: string,
  title: string,
  locale: SupportedLocale,
  words: readonly WordSpec[],
): KaraokeSong {
  return parseKaraokeSong({
    id,
    title,
    artist: 'Voice Karaoke',
    locale,
    durationMs: KARAOKE_SONG_DURATION_MS,
    bpm: 100,
    singerCount: 1,
    provenance: 'original-development',
    // audioUrl is intentionally absent: clients can synthesize these target notes.
    chart: {
      laneCount: KARAOKE_LANE_COUNT,
      words: words.map(([text, startMs, endMs, targetMidi, lane], index) => ({
        id: `${id}-${String(index + 1).padStart(2, '0')}`,
        text,
        startMs,
        endMs,
        targetMidi,
        lane,
      })),
    },
  });
}

function explicitLineWords(
  id: string,
  lines: readonly (readonly ExplicitWordSpec[])[],
  contour: readonly (readonly ProvisionalContourWordSpec[])[],
  offsetMs = 0,
) {
  if (lines.length !== contour.length) throw new Error('Licensed Karaoke line/contour count mismatch');
  return lines.flatMap((line, lineIndex) => {
    const lineContour = contour[lineIndex];
    if (!lineContour || line.length !== lineContour.length) {
      throw new Error(`Licensed Karaoke line ${lineIndex + 1} contour count mismatch`);
    }
    return line.map(([text, startMs, endMs], wordIndex) => {
      const contourWord = lineContour[wordIndex];
      if (!contourWord || contourWord[0] !== text) {
        throw new Error(`Licensed Karaoke contour mismatch at line ${lineIndex + 1}, word ${wordIndex + 1}`);
      }
      return {
        id: `${id}-${String(lineIndex + 1).padStart(2, '0')}-${String(wordIndex + 1).padStart(2, '0')}`,
        text,
        startMs: startMs + offsetMs,
        endMs: endMs + offsetMs,
        targetMidi: contourWord[1],
        lane: contourWord[2],
      };
    });
  });
}

const EN_US_WORDS = [
  ['wake', 1_200, 1_850, 60, 0],
  ['the', 2_100, 2_750, 62, 1],
  ['lights', 3_000, 3_650, 64, 2],
  ['glow', 3_900, 4_550, 67, 3],
  ['take', 4_800, 5_450, 67, 3],
  ['one', 5_700, 6_350, 64, 2],
  ['step', 6_600, 7_250, 62, 1],
  ['slow', 7_500, 8_150, 60, 0],
  ['hear', 8_400, 9_050, 60, 0],
  ['the', 9_300, 9_950, 62, 1],
  ['room', 10_200, 10_850, 65, 2],
  ['ring', 11_100, 11_750, 69, 3],
  ['let', 12_000, 12_650, 67, 3],
  ['your', 12_900, 13_550, 65, 2],
  ['clear', 13_800, 14_450, 64, 2],
  ['voice', 14_700, 15_350, 62, 1],
  ['sing', 15_600, 16_250, 60, 0],
  ['hold', 16_500, 17_150, 62, 1],
  ['the', 17_400, 18_050, 64, 2],
  ['beat', 18_300, 18_950, 67, 3],
  ['near', 19_200, 19_850, 64, 2],
  ['send', 20_100, 20_750, 62, 1],
  ['the', 21_000, 21_650, 60, 0],
  ['sound', 21_900, 22_550, 62, 1],
  ['clear', 22_800, 23_450, 65, 2],
  ['rise', 23_700, 24_350, 69, 3],
  ['with', 24_600, 25_250, 67, 3],
  ['every', 25_500, 26_150, 65, 2],
  ['tone', 26_400, 27_050, 64, 2],
  ['make', 27_300, 27_950, 62, 1],
  ['this', 28_200, 28_850, 60, 0],
  ['stage', 29_100, 29_750, 62, 1],
  ['your', 30_000, 30_650, 64, 2],
  ['own', 30_900, 31_550, 67, 3],
  ['breathe', 31_800, 32_450, 64, 2],
  ['then', 32_700, 33_350, 62, 1],
  ['begin', 33_600, 34_250, 60, 0],
  ['let', 34_500, 35_150, 62, 1],
  ['the', 35_400, 36_050, 64, 2],
  ['rhythm', 36_300, 36_950, 67, 3],
  ['in', 37_200, 37_850, 69, 3],
  ['side', 38_100, 38_750, 67, 3],
  ['to', 39_000, 39_650, 64, 2],
  ['side', 39_900, 40_550, 62, 1],
  ['we', 40_800, 41_450, 60, 0],
  ['sway', 41_700, 42_350, 62, 1],
  ['shine', 42_600, 43_250, 64, 2],
  ['once', 43_500, 44_150, 67, 3],
] as const satisfies readonly WordSpec[];

const PT_BR_WORDS = [
  ['vem', 1_200, 1_850, 62, 0],
  ['acender', 2_100, 2_750, 64, 1],
  ['a', 3_000, 3_650, 65, 2],
  ['luz', 3_900, 4_550, 69, 3],
  ['dê', 4_800, 5_450, 69, 3],
  ['um', 5_700, 6_350, 65, 2],
  ['passo', 6_600, 7_250, 64, 1],
  ['devagar', 7_500, 8_150, 62, 0],
  ['ouça', 8_400, 9_050, 62, 0],
  ['a', 9_300, 9_950, 64, 1],
  ['sala', 10_200, 10_850, 67, 2],
  ['soar', 11_100, 11_750, 71, 3],
  ['deixe', 12_000, 12_650, 69, 3],
  ['sua', 12_900, 13_550, 67, 2],
  ['voz', 13_800, 14_450, 65, 2],
  ['cantar', 14_700, 15_350, 64, 1],
  ['segure', 15_600, 16_250, 62, 0],
  ['o', 16_500, 17_150, 64, 1],
  ['pulso', 17_400, 18_050, 65, 2],
  ['aqui', 18_300, 18_950, 69, 3],
  ['mande', 19_200, 19_850, 65, 2],
  ['o', 20_100, 20_750, 64, 1],
  ['som', 21_000, 21_650, 62, 0],
  ['claro', 21_900, 22_550, 64, 1],
  ['suba', 22_800, 23_450, 67, 2],
  ['em', 23_700, 24_350, 71, 3],
  ['cada', 24_600, 25_250, 69, 3],
  ['tom', 25_500, 26_150, 67, 2],
  ['faça', 26_400, 27_050, 65, 2],
  ['o', 27_300, 27_950, 64, 1],
  ['palco', 28_200, 28_850, 62, 0],
  ['seu', 29_100, 29_750, 64, 1],
  ['respire', 30_000, 30_650, 65, 2],
  ['para', 30_900, 31_550, 69, 3],
  ['começar', 31_800, 32_450, 65, 2],
  ['deixe', 32_700, 33_350, 64, 1],
  ['o', 33_600, 34_250, 62, 0],
  ['ritmo', 34_500, 35_150, 64, 1],
  ['entrar', 35_400, 36_050, 67, 2],
  ['de', 36_300, 36_950, 69, 3],
  ['lado', 37_200, 37_850, 71, 3],
  ['a', 38_100, 38_750, 69, 3],
  ['lado', 39_000, 39_650, 65, 2],
  ['vamos', 39_900, 40_550, 64, 1],
  ['cantando', 40_800, 41_450, 62, 0],
  ['até', 41_700, 42_350, 64, 1],
  ['o', 42_600, 43_250, 65, 2],
  ['fim', 43_500, 44_150, 69, 3],
] as const satisfies readonly WordSpec[];

const NEVER_GONNA_GIVE_YOU_UP_LINES = [
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
] as const satisfies readonly (readonly ExplicitWordSpec[])[];

// This narrow MIDI contour remains provisional pending calibration against an isolated guide vocal.
const NEVER_GONNA_GIVE_YOU_UP_CONTOUR = [
  [['And', 57, 0], ['if', 57, 0], ['you', 59, 1], ['ask', 61, 2], ['me', 59, 1], ['how', 61, 2], ["I'm", 62, 3], ['feeling', 59, 1]],
  [["Don't", 59, 1], ['tell', 61, 2], ['me', 62, 3], ["you're", 61, 2], ['too', 59, 1], ['blind', 57, 0], ['to', 59, 1], ['see', 57, 0]],
  [['Never', 59, 1], ['gonna', 61, 2], ['give', 62, 3], ['you', 61, 2], ['up', 57, 0]],
  [['Never', 59, 1], ['gonna', 61, 2], ['let', 62, 3], ['you', 61, 2], ['down', 57, 0]],
  [['Never', 59, 1], ['gonna', 61, 2], ['run', 62, 3], ['around', 61, 2], ['and', 59, 1], ['desert', 57, 0], ['you', 59, 1]],
  [['Never', 59, 1], ['gonna', 61, 2], ['make', 62, 3], ['you', 61, 2], ['cry', 57, 0]],
  [['Never', 59, 1], ['gonna', 61, 2], ['say', 62, 3], ['goodbye', 57, 0]],
  [['Never', 59, 1], ['gonna', 61, 2], ['tell', 62, 3], ['a', 61, 2], ['lie', 59, 1], ['and', 57, 0], ['hurt', 59, 1], ['you', 57, 0]],
  [['Never', 59, 1], ['gonna', 61, 2], ['give', 62, 3], ['you', 61, 2], ['up', 57, 0]],
  [['Never', 59, 1], ['gonna', 61, 2], ['let', 62, 3], ['you', 61, 2], ['down', 57, 0]],
  [['Never', 59, 1], ['gonna', 61, 2], ['run', 62, 3], ['around', 61, 2], ['and', 59, 1], ['desert', 57, 0], ['you', 59, 1]],
  [['Never', 59, 1], ['gonna', 61, 2], ['make', 62, 3], ['you', 61, 2], ['cry', 57, 0]],
  [['Never', 59, 1], ['gonna', 61, 2], ['say', 62, 3], ['goodbye', 57, 0]],
  [['Never', 59, 1], ['gonna', 61, 2], ['tell', 62, 3], ['a', 61, 2], ['lie', 59, 1], ['and', 57, 0], ['hurt', 59, 1], ['you', 57, 0]],
] as const satisfies readonly (readonly ProvisionalContourWordSpec[])[];

const A_THOUSAND_MILES_LINES = [
  [['Staring', 2_660, 2_980], ['blankly', 2_980, 3_680], ['ahead', 3_680, 4_120]],
  [['Just', 4_120, 4_420], ['making', 4_420, 4_780], ['my', 4_780, 5_120], ['way', 5_120, 5_400]],
  [['Making', 5_400, 6_060], ['a', 6_060, 6_440], ['way', 6_440, 6_820], ['through', 6_820, 7_200], ['the', 7_200, 7_600], ['crowd', 7_600, 9_260]],
  [['And', 14_030, 14_660], ['I', 14_660, 15_290], ['need', 15_290, 15_920], ['you', 15_920, 16_250]],
  [['And', 16_620, 17_250], ['I', 17_250, 17_880], ['miss', 17_880, 18_510], ['you', 18_510, 19_250]],
  [['And', 19_743, 20_387], ['now', 20_387, 21_020], ['I', 21_020, 21_653], ['wonder', 21_653, 22_276]],
  [['If', 22_620, 23_678], ['I', 23_678, 24_016], ['could', 24_016, 24_482], ['fall', 24_482, 25_159], ['into', 25_159, 26_534], ['the', 26_534, 27_211], ['sky', 27_211, 27_576]],
  [['Do', 27_930, 28_869], ['you', 28_869, 29_150], ['think', 29_150, 29_601], ['time', 29_601, 30_239], ['would', 30_239, 31_084], ['pass', 31_084, 31_610], ['me', 31_610, 32_060], ['by', 32_060, 32_600]],
  [["'Cause", 32_830, 33_554], ['you', 33_554, 33_897], ['know', 33_897, 34_393], ["I'd", 34_393, 35_269], ['walk', 35_269, 35_708], ['a', 35_708, 36_146], ['thousand', 36_146, 36_622], ['miles', 36_622, 37_300]],
  [['If', 37_480, 37_900], ['I', 37_900, 38_140], ['could', 38_140, 38_500], ['just', 38_500, 39_080], ['see', 39_080, 39_940], ['you', 39_940, 41_640], ['tonight', 41_640, 43_440]],
] as const satisfies readonly (readonly ExplicitWordSpec[])[];

export const A_THOUSAND_MILES_ALIGNMENT_OFFSET_MS = 424;

// Conservative melody contour pending isolated-vocal pitch calibration.
const A_THOUSAND_MILES_CONTOUR = [
  [['Staring', 66, 0], ['blankly', 66, 0], ['ahead', 64, 0]],
  [['Just', 64, 0], ['making', 66, 0], ['my', 66, 0], ['way', 68, 1]],
  [['Making', 66, 0], ['a', 66, 0], ['way', 68, 1], ['through', 69, 1], ['the', 68, 1], ['crowd', 66, 0]],
  [['And', 66, 0], ['I', 66, 0], ['need', 71, 2], ['you', 73, 3]],
  [['And', 66, 0], ['I', 66, 0], ['miss', 71, 2], ['you', 73, 3]],
  [['And', 66, 0], ['now', 66, 0], ['I', 68, 1], ['wonder', 69, 1]],
  [['If', 71, 2], ['I', 71, 2], ['could', 71, 2], ['fall', 73, 3], ['into', 75, 3], ['the', 73, 3], ['sky', 71, 2]],
  [['Do', 71, 2], ['you', 71, 2], ['think', 71, 2], ['time', 73, 3], ['would', 75, 3], ['pass', 73, 3], ['me', 71, 2], ['by', 68, 1]],
  [["'Cause", 68, 1], ['you', 68, 1], ['know', 68, 1], ["I'd", 71, 2], ['walk', 73, 3], ['a', 71, 2], ['thousand', 68, 1], ['miles', 66, 0]],
  [['If', 71, 2], ['I', 71, 2], ['could', 71, 2], ['just', 73, 3], ['see', 75, 3], ['you', 73, 3], ['tonight', 71, 2]],
] as const satisfies readonly (readonly ProvisionalContourWordSpec[])[];

/** ORIGINAL DEVELOPMENT SONG: English chart authored for Voice Karaoke. */
export const EN_US_ORIGINAL_DEVELOPMENT_SONG = originalDevelopmentSong(
  'neon-hello-dev',
  'Neon Hello',
  'en-US',
  EN_US_WORDS,
);

/** ORIGINAL DEVELOPMENT SONG: Brazilian Portuguese chart authored for Voice Karaoke. */
export const PT_BR_ORIGINAL_DEVELOPMENT_SONG = originalDevelopmentSong(
  'luz-no-ritmo-dev',
  'Luz no Ritmo',
  'pt-BR',
  PT_BR_WORDS,
);

/** User-provided recording with user-confirmed synchronization, performance, and distribution rights. */
export const NEVER_GONNA_GIVE_YOU_UP = parseKaraokeSong({
  id: 'never-gonna-give-you-up',
  title: 'Never Gonna Give You Up',
  artist: 'Rick Astley',
  locale: 'en-US',
  durationMs: KARAOKE_SONG_DURATION_MS,
  bpm: 113.55,
  singerCount: 1,
  provenance: 'user-confirmed-licensed',
  audioUrl: '/audio/karaoke/classic-instrumental-45s.mp3?v=20260827-sync-2',
  chart: {
    laneCount: KARAOKE_LANE_COUNT,
    words: explicitLineWords(
      'never-gonna-give-you-up',
      NEVER_GONNA_GIVE_YOU_UP_LINES,
      NEVER_GONNA_GIVE_YOU_UP_CONTOUR,
    ),
  },
});

/** User-provided recording with user-confirmed synchronization, performance, and distribution rights. */
export const A_THOUSAND_MILES = parseKaraokeSong({
  id: 'a-thousand-miles',
  title: 'A Thousand Miles',
  artist: 'Vanessa Carlton',
  locale: 'en-US',
  durationMs: KARAOKE_SONG_DURATION_MS,
  bpm: 95,
  singerCount: 1,
  provenance: 'user-confirmed-licensed',
  audioUrl: '/audio/karaoke/thousand-miles-45s.mp3?v=20260828-iconic-2',
  chart: {
    laneCount: KARAOKE_LANE_COUNT,
    words: explicitLineWords(
      'a-thousand-miles',
      A_THOUSAND_MILES_LINES,
      A_THOUSAND_MILES_CONTOUR,
      A_THOUSAND_MILES_ALIGNMENT_OFFSET_MS,
    ),
  },
});

export const KARAOKE_DEVELOPMENT_SONG_FIXTURES = Object.freeze([
  EN_US_ORIGINAL_DEVELOPMENT_SONG,
  PT_BR_ORIGINAL_DEVELOPMENT_SONG,
] as const);

/** Production defaults: licensed English recording and Portuguese development fallback. */
export const KARAOKE_RUNTIME_SONGS = Object.freeze([
  NEVER_GONNA_GIVE_YOU_UP,
  A_THOUSAND_MILES,
  PT_BR_ORIGINAL_DEVELOPMENT_SONG,
] as const);

// Current server adapters import this historical name. Keep it as a runtime-catalog alias so the
// HTTP/media scoring implementation does not need to change until pitch calibration is complete.
export const KARAOKE_DEVELOPMENT_SONGS = KARAOKE_RUNTIME_SONGS;

const DEVELOPMENT_SONGS_BY_ID = new Map(KARAOKE_DEVELOPMENT_SONG_FIXTURES.map(song => [song.id, song]));

export function karaokeDevelopmentSongById(id: string): KaraokeSong | null {
  if (!isSafeKaraokeId(id)) return null;
  return DEVELOPMENT_SONGS_BY_ID.get(id) ?? null;
}
