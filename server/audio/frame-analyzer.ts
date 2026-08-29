import { decodeMuLaw8kMono, MULAW_SAMPLE_RATE } from './mulaw';
import type { TwilioMediaFrame } from './twilio-media-stream';

export interface FrameAnalyzerOptions {
  readonly voiceActivityRms?: number;
  readonly minimumPitchHz?: number;
  readonly maximumPitchHz?: number;
  readonly yinThreshold?: number;
  readonly maximumYinMinimum?: number;
}

export interface AudioFrameObservation {
  readonly mediaTimestampMs: number;
  readonly durationMs: number;
  readonly rms: number;
  readonly rmsDbfs: number;
  readonly voiceActive: boolean;
  readonly pitchHz: number | null;
  readonly pitchClarity: number;
}

const DEFAULT_OPTIONS = {
  voiceActivityRms: 0.02,
  minimumPitchHz: 80,
  maximumPitchHz: 1_000,
  yinThreshold: 0.15,
  maximumYinMinimum: 0.35,
} as const;

function finiteInRange(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function pitchFromYin(
  samples: Int16Array,
  minimumPitchHz: number,
  maximumPitchHz: number,
  threshold: number,
  maximumMinimum: number,
): { pitchHz: number | null; clarity: number } {
  const minimumLag = Math.max(2, Math.floor(MULAW_SAMPLE_RATE / maximumPitchHz));
  const maximumLag = Math.min(
    Math.floor(MULAW_SAMPLE_RATE / minimumPitchHz),
    Math.floor(samples.length / 2),
  );
  if (maximumLag <= minimumLag + 1) return { pitchHz: null, clarity: 0 };

  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= samples.length;

  const difference = new Float64Array(maximumLag + 1);
  for (let lag = 1; lag <= maximumLag; lag += 1) {
    let sum = 0;
    for (let index = 0; index < samples.length - lag; index += 1) {
      const delta = (samples[index]! - mean) - (samples[index + lag]! - mean);
      sum += delta * delta;
    }
    difference[lag] = sum;
  }

  const normalized = new Float64Array(maximumLag + 1);
  normalized[0] = 1;
  let runningSum = 0;
  for (let lag = 1; lag <= maximumLag; lag += 1) {
    runningSum += difference[lag]!;
    normalized[lag] = runningSum === 0 ? 1 : difference[lag]! * lag / runningSum;
  }

  let candidate = -1;
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    if (normalized[lag]! < threshold) {
      candidate = lag;
      while (candidate < maximumLag && normalized[candidate + 1]! < normalized[candidate]!) candidate += 1;
      break;
    }
  }
  if (candidate < 0) {
    candidate = minimumLag;
    for (let lag = minimumLag + 1; lag <= maximumLag; lag += 1) {
      if (normalized[lag]! < normalized[candidate]!) candidate = lag;
    }
    if (normalized[candidate]! > maximumMinimum) return { pitchHz: null, clarity: 0 };
  }

  let refinedLag = candidate;
  if (candidate > minimumLag && candidate < maximumLag) {
    const left = normalized[candidate - 1]!;
    const center = normalized[candidate]!;
    const right = normalized[candidate + 1]!;
    const curvature = left - 2 * center + right;
    if (curvature !== 0) {
      const offset = Math.max(-1, Math.min(1, 0.5 * (left - right) / curvature));
      refinedLag += offset;
    }
  }

  return {
    pitchHz: MULAW_SAMPLE_RATE / refinedLag,
    clarity: Math.max(0, Math.min(1, 1 - normalized[candidate]!)),
  };
}

/** Analyzes one PCM frame using its Media Streams presentation timestamp. */
export function analyzePcmFrame(
  samples: Int16Array,
  mediaTimestampMs: number,
  options: FrameAnalyzerOptions = {},
): AudioFrameObservation {
  if (!(samples instanceof Int16Array) || samples.length === 0) {
    throw new TypeError('PCM frame must be a non-empty Int16Array');
  }
  if (!Number.isSafeInteger(mediaTimestampMs) || mediaTimestampMs < 0) {
    throw new RangeError('mediaTimestampMs must be a non-negative safe integer');
  }

  const voiceActivityRms = options.voiceActivityRms ?? DEFAULT_OPTIONS.voiceActivityRms;
  const minimumPitchHz = options.minimumPitchHz ?? DEFAULT_OPTIONS.minimumPitchHz;
  const maximumPitchHz = options.maximumPitchHz ?? DEFAULT_OPTIONS.maximumPitchHz;
  const yinThreshold = options.yinThreshold ?? DEFAULT_OPTIONS.yinThreshold;
  const maximumYinMinimum = options.maximumYinMinimum ?? DEFAULT_OPTIONS.maximumYinMinimum;
  finiteInRange(voiceActivityRms, 'voiceActivityRms', 0, 1);
  finiteInRange(minimumPitchHz, 'minimumPitchHz', 20, MULAW_SAMPLE_RATE / 4);
  finiteInRange(maximumPitchHz, 'maximumPitchHz', minimumPitchHz, MULAW_SAMPLE_RATE / 2);
  finiteInRange(yinThreshold, 'yinThreshold', 0.01, 1);
  finiteInRange(maximumYinMinimum, 'maximumYinMinimum', yinThreshold, 1);

  let sumOfSquares = 0;
  for (const sample of samples) {
    const normalized = sample / 32_768;
    sumOfSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumOfSquares / samples.length);
  const voiceActive = rms >= voiceActivityRms;
  const pitch = voiceActive
    ? pitchFromYin(samples, minimumPitchHz, maximumPitchHz, yinThreshold, maximumYinMinimum)
    : { pitchHz: null, clarity: 0 };

  return {
    mediaTimestampMs,
    durationMs: samples.length * 1_000 / MULAW_SAMPLE_RATE,
    rms,
    rmsDbfs: rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms),
    voiceActive,
    pitchHz: pitch.pitchHz,
    pitchClarity: pitch.clarity,
  };
}

/** Decodes and analyzes a parsed media frame; no arrival-time input is accepted. */
export function analyzeMediaFrame(
  frame: TwilioMediaFrame,
  options: FrameAnalyzerOptions = {},
): AudioFrameObservation {
  return analyzePcmFrame(decodeMuLaw8kMono(frame.media.payload), frame.media.timestampMs, options);
}
