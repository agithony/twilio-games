import { decodeMuLaw8kMono, MULAW_SAMPLE_RATE } from './mulaw';
import type { TwilioMediaFrame, TwilioMediaTrack } from './twilio-media-stream';

export const KARAOKE_FRAME_WINDOW_MIN_MS = 80;
export const KARAOKE_FRAME_WINDOW_MAX_MS = 120;
export const KARAOKE_FRAME_WINDOW_DEFAULT_MS = 100;

export interface KaraokePcmWindow {
  readonly mediaTimestampMs: number;
  readonly durationMs: number;
  readonly samples: Int16Array;
}

export interface KaraokeFrameWindowOptions {
  readonly windowMs?: number;
  readonly track?: TwilioMediaTrack;
}

/** Coalesces small Media Streams frames into pitch-capable windows. */
export class KaraokeFrameWindow {
  private readonly samplesPerWindow: number;
  private readonly durationMs: number;
  private readonly track: TwilioMediaTrack;
  private readonly buffer: Int16Array;
  private bufferedSamples = 0;
  private windowStartSample: number | null = null;
  private expectedInputSample: number | null = null;
  private closed = false;

  constructor(options: KaraokeFrameWindowOptions = {}) {
    const windowMs = options.windowMs ?? KARAOKE_FRAME_WINDOW_DEFAULT_MS;
    if (!Number.isInteger(windowMs)
      || windowMs < KARAOKE_FRAME_WINDOW_MIN_MS
      || windowMs > KARAOKE_FRAME_WINDOW_MAX_MS) {
      throw new RangeError(
        `windowMs must be an integer from ${KARAOKE_FRAME_WINDOW_MIN_MS} to ${KARAOKE_FRAME_WINDOW_MAX_MS}`,
      );
    }
    this.samplesPerWindow = windowMs * MULAW_SAMPLE_RATE / 1_000;
    this.durationMs = windowMs;
    this.track = options.track ?? 'inbound';
    this.buffer = new Int16Array(this.samplesPerWindow);
  }

  get retainedSampleCount(): number { return this.bufferedSamples; }
  get isClosed(): boolean { return this.closed; }

  push(frame: TwilioMediaFrame): KaraokePcmWindow[] {
    if (this.closed) throw new Error('karaoke frame window is closed');
    if (frame.media.track !== this.track) throw new TypeError(`expected ${this.track} media`);

    const frameStartSample = frame.media.timestampMs * (MULAW_SAMPLE_RATE / 1_000);
    if (!Number.isSafeInteger(frameStartSample)) throw new RangeError('media timestamp is outside the sample range');
    if (this.expectedInputSample !== null && frameStartSample !== this.expectedInputSample) {
      throw new RangeError('media frames must be contiguous');
    }

    const decoded = decodeMuLaw8kMono(frame.media.payload);
    this.expectedInputSample = frameStartSample + decoded.length;
    const windows: KaraokePcmWindow[] = [];
    let sourceOffset = 0;
    try {
      while (sourceOffset < decoded.length) {
        if (this.bufferedSamples === 0) this.windowStartSample = frameStartSample + sourceOffset;
        const copied = Math.min(
          this.samplesPerWindow - this.bufferedSamples,
          decoded.length - sourceOffset,
        );
        this.buffer.set(decoded.subarray(sourceOffset, sourceOffset + copied), this.bufferedSamples);
        this.bufferedSamples += copied;
        sourceOffset += copied;

        if (this.bufferedSamples === this.samplesPerWindow) {
          const startSample = this.windowStartSample!;
          const samples = this.buffer.slice();
          this.buffer.fill(0);
          this.bufferedSamples = 0;
          this.windowStartSample = null;
          windows.push({
            mediaTimestampMs: startSample * 1_000 / MULAW_SAMPLE_RATE,
            durationMs: this.durationMs,
            samples,
          });
        }
      }
    } finally {
      decoded.fill(0);
    }
    return windows;
  }

  /** Erases and discards an incomplete window, returning its sample count. */
  close(): number {
    if (this.closed) return 0;
    const discarded = this.bufferedSamples;
    this.buffer.fill(0);
    this.bufferedSamples = 0;
    this.windowStartSample = null;
    this.expectedInputSample = null;
    this.closed = true;
    return discarded;
  }
}
