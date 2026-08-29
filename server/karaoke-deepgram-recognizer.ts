import WebSocket, { type ClientOptions, type RawData } from 'ws';
import type {
  KaraokeLyricRecognitionResult,
  KaraokeLyricRecognizerFactory,
  KaraokeLyricRecognizerSessionOptions,
  KaraokeRecognizerAudioFrame,
  KaraokeRecognizedWord,
  KaraokeStreamingLyricRecognizer,
} from './karaoke-lyric-recognizer';

export const DEEPGRAM_KARAOKE_MAX_MESSAGE_BYTES = 64 * 1024;
export const DEEPGRAM_KARAOKE_MAX_WORDS_PER_RESULT = 256;
const MAX_PENDING_AUDIO_BYTES = 64 * 1024;
const MAX_TIMELINE_SEGMENTS = 4_096;

interface ParsedDeepgramWord {
  readonly text: string;
  readonly sourceStartMs: number;
  readonly sourceEndMs: number;
  readonly confidence: number;
}

export interface ParsedDeepgramResult {
  readonly resultId: string;
  readonly final: boolean;
  readonly words: readonly ParsedDeepgramWord[];
}

interface AudioTimelineSegment {
  readonly sourceStartMs: number;
  readonly sourceEndMs: number;
  readonly mediaStartMs: number;
  readonly mediaEndMs: number;
}

interface DeepgramSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: () => void): unknown;
  send(data: string | Uint8Array): void;
  close(): void;
  terminate?(): void;
}

export interface DirectDeepgramLyricRecognizerOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly createSocket?: (url: string, options: ClientOptions) => DeepgramSocket;
}

export class DirectDeepgramLyricRecognizerFactory implements KaraokeLyricRecognizerFactory {
  readonly source = 'deepgram';
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly createSocket: (url: string, options: ClientOptions) => DeepgramSocket;

  constructor(options: DirectDeepgramLyricRecognizerOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey || this.apiKey === 'disabled') throw new TypeError('Deepgram API key is required');
    this.endpoint = options.endpoint ?? 'wss://api.deepgram.com/v1/listen';
    const endpoint = new URL(this.endpoint);
    if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.hash) {
      throw new TypeError('Deepgram endpoint must be a credential-free WSS URL');
    }
    this.createSocket = options.createSocket ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
  }

  create(options: KaraokeLyricRecognizerSessionOptions): KaraokeStreamingLyricRecognizer {
    return new DirectDeepgramLyricRecognizerSession({
      ...options,
      apiKey: this.apiKey,
      endpoint: this.endpoint,
      createSocket: this.createSocket,
    });
  }
}

interface DirectSessionOptions extends KaraokeLyricRecognizerSessionOptions {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly createSocket: (url: string, options: ClientOptions) => DeepgramSocket;
}

class DirectDeepgramLyricRecognizerSession implements KaraokeStreamingLyricRecognizer {
  readonly source = 'deepgram';
  private readonly socket: DeepgramSocket;
  private readonly onResult: (result: KaraokeLyricRecognitionResult) => void;
  private readonly onError: () => void;
  private readonly timeline: AudioTimelineSegment[] = [];
  private readonly pendingAudio: Uint8Array[] = [];
  private sourceDurationMs = 0;
  private pendingAudioBytes = 0;
  private opened = false;
  private closed = false;
  private finalizing = false;
  private finalizePromise: Promise<void> | null = null;
  private resolveFinalize: (() => void) | null = null;

  constructor(options: DirectSessionOptions) {
    this.onResult = options.onResult;
    this.onError = options.onError;
    const url = deepgramListenUrl(options.endpoint, options.locale);
    this.socket = options.createSocket(url, {
      headers: { Authorization: `Token ${options.apiKey}` },
      perMessageDeflate: false,
      maxPayload: DEEPGRAM_KARAOKE_MAX_MESSAGE_BYTES,
    });
    this.socket.on('open', () => this.handleOpen());
    this.socket.on('message', (data, isBinary) => this.handleMessage(data, isBinary));
    this.socket.on('error', () => this.fail());
    this.socket.on('close', (code?: number) => this.handleClose(code));
  }

  acceptAudio(frame: KaraokeRecognizerAudioFrame): void {
    if (this.closed || this.finalizing) return;
    if (!(frame.audio instanceof Uint8Array) || frame.audio.byteLength === 0 || frame.audio.byteLength > 64 * 1024) {
      throw new TypeError('Deepgram audio frame is invalid');
    }
    if (!Number.isFinite(frame.mediaTimestampMs) || frame.mediaTimestampMs < 0
      || !Number.isFinite(frame.durationMs) || frame.durationMs <= 0) {
      throw new RangeError('Deepgram audio timestamp is invalid');
    }
    const encodedDurationMs = frame.audio.byteLength / 8;
    if (Math.abs(encodedDurationMs - frame.durationMs) > 1) {
      throw new RangeError('Deepgram audio duration does not match mu-law 8 kHz payload');
    }
    if (this.timeline.length >= MAX_TIMELINE_SEGMENTS) {
      this.fail();
      return;
    }
    const sourceStartMs = this.sourceDurationMs;
    this.sourceDurationMs += encodedDurationMs;
    this.timeline.push(Object.freeze({
      sourceStartMs,
      sourceEndMs: this.sourceDurationMs,
      mediaStartMs: frame.mediaTimestampMs,
      mediaEndMs: frame.mediaTimestampMs + frame.durationMs,
    }));
    if (this.opened && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(frame.audio);
      return;
    }
    if (this.pendingAudioBytes + frame.audio.byteLength > MAX_PENDING_AUDIO_BYTES) {
      this.fail();
      return;
    }
    const copy = Uint8Array.from(frame.audio);
    this.pendingAudio.push(copy);
    this.pendingAudioBytes += copy.byteLength;
  }

  finalize(): Promise<void> {
    if (this.finalizePromise) return this.finalizePromise;
    if (this.closed) return Promise.resolve();
    this.finalizing = true;
    this.finalizePromise = new Promise(resolve => { this.resolveFinalize = resolve; });
    if (this.opened && this.socket.readyState === WebSocket.OPEN) this.requestProviderFinalize();
    return this.finalizePromise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearPendingAudio();
    try { this.socket.close(); }
    catch { this.socket.terminate?.(); }
    this.resolveFinalize?.();
    this.resolveFinalize = null;
  }

  private handleOpen(): void {
    if (this.closed) return;
    this.opened = true;
    for (const audio of this.pendingAudio) {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(audio);
      audio.fill(0);
    }
    this.pendingAudio.length = 0;
    this.pendingAudioBytes = 0;
    if (this.finalizing && this.socket.readyState === WebSocket.OPEN) this.requestProviderFinalize();
  }

  private requestProviderFinalize(): void {
    try {
      this.socket.send(JSON.stringify({ type: 'Finalize' }));
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    } catch {
      this.fail();
    }
  }

  private handleMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    try {
      if (isBinary) throw new DeepgramProtocolError('binary Deepgram result frame');
      const parsed = parseDeepgramKaraokeMessage(data);
      if (!parsed) return;
      const words = parsed.words.map((word): KaraokeRecognizedWord => Object.freeze({
        text: word.text,
        sourceStartMs: word.sourceStartMs,
        sourceEndMs: word.sourceEndMs,
        mediaStartTimestampMs: this.mapSourceTimestamp(word.sourceStartMs),
        mediaEndTimestampMs: this.mapSourceTimestamp(word.sourceEndMs),
        confidence: word.confidence,
      }));
      this.onResult(Object.freeze({
        resultId: parsed.resultId,
        source: this.source,
        final: parsed.final,
        words: Object.freeze(words),
      }));
    } catch {
      this.fail();
    }
  }

  private mapSourceTimestamp(sourceTimestampMs: number): number {
    if (this.timeline.length === 0) throw new DeepgramProtocolError('result arrived before audio');
    let segment = this.timeline.find(candidate => sourceTimestampMs >= candidate.sourceStartMs
      && sourceTimestampMs <= candidate.sourceEndMs);
    if (!segment) {
      segment = sourceTimestampMs < this.timeline[0]!.sourceStartMs
        ? this.timeline[0]
        : this.timeline[this.timeline.length - 1];
    }
    const duration = segment!.sourceEndMs - segment!.sourceStartMs;
    const ratio = duration === 0 ? 0 : Math.max(0, Math.min(1,
      (sourceTimestampMs - segment!.sourceStartMs) / duration));
    return segment!.mediaStartMs + ratio * (segment!.mediaEndMs - segment!.mediaStartMs);
  }

  private handleClose(code?: number): void {
    if (this.closed) return;
    const unexpected = !this.finalizing || code !== 1_000;
    this.closed = true;
    this.clearPendingAudio();
    this.resolveFinalize?.();
    this.resolveFinalize = null;
    if (unexpected) this.onError();
  }

  private fail(): void {
    if (this.closed) return;
    this.onError();
    this.close();
  }

  private clearPendingAudio(): void {
    for (const audio of this.pendingAudio) audio.fill(0);
    this.pendingAudio.length = 0;
    this.pendingAudioBytes = 0;
  }
}

export class DeepgramProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepgramProtocolError';
  }
}

/** Parses only bounded result/control frames; transcript strings are not returned or retained. */
export function parseDeepgramKaraokeMessage(data: RawData | string): ParsedDeepgramResult | null {
  const raw = boundedUtf8(data, DEEPGRAM_KARAOKE_MAX_MESSAGE_BYTES);
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new DeepgramProtocolError('invalid Deepgram JSON'); }
  const message = plainRecord(value, 'Deepgram message');
  const type = message.type;
  if (type === 'Metadata' || type === 'SpeechStarted' || type === 'UtteranceEnd') return null;
  if (type !== 'Results') throw new DeepgramProtocolError('unsupported Deepgram message type');
  if (typeof message.is_final !== 'boolean') throw new DeepgramProtocolError('invalid Deepgram final flag');
  const startSeconds = boundedNumber(message.start, 'result start', 0, 24 * 60 * 60);
  const durationSeconds = boundedNumber(message.duration, 'result duration', 0, 60);
  const channel = plainRecord(message.channel, 'Deepgram channel');
  if (!Array.isArray(channel.alternatives) || channel.alternatives.length < 1 || channel.alternatives.length > 8) {
    throw new DeepgramProtocolError('invalid Deepgram alternatives');
  }
  const alternative = plainRecord(channel.alternatives[0], 'Deepgram alternative');
  if (typeof alternative.transcript !== 'string' || Buffer.byteLength(alternative.transcript, 'utf8') > 8_192
    || /\p{Cc}/u.test(alternative.transcript)) {
    throw new DeepgramProtocolError('invalid Deepgram transcript');
  }
  if (!Array.isArray(alternative.words) || alternative.words.length > DEEPGRAM_KARAOKE_MAX_WORDS_PER_RESULT) {
    throw new DeepgramProtocolError('invalid Deepgram words');
  }
  const words = alternative.words.map((input): ParsedDeepgramWord => {
    const word = plainRecord(input, 'Deepgram word');
    const text = typeof word.punctuated_word === 'string' && word.punctuated_word.length > 0
      ? word.punctuated_word
      : word.word;
    if (typeof text !== 'string' || text.length === 0 || Array.from(text).length > 128 || /\p{Cc}/u.test(text)) {
      throw new DeepgramProtocolError('invalid Deepgram word text');
    }
    const sourceStartMs = boundedNumber(word.start, 'word start', 0, 24 * 60 * 60) * 1_000;
    const sourceEndMs = boundedNumber(word.end, 'word end', 0, 24 * 60 * 60) * 1_000;
    if (sourceEndMs < sourceStartMs) throw new DeepgramProtocolError('invalid Deepgram word range');
    const confidence = boundedNumber(word.confidence, 'word confidence', 0, 1);
    return Object.freeze({ text, sourceStartMs, sourceEndMs, confidence });
  });
  const startMs = Math.round(startSeconds * 1_000);
  const durationMs = Math.round(durationSeconds * 1_000);
  return Object.freeze({
    resultId: `deepgram-${startMs}`,
    final: message.is_final,
    words: Object.freeze(words),
  });
}

function deepgramListenUrl(endpoint: string, locale: string): string {
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(locale)) throw new TypeError('Deepgram locale is invalid');
  const url = new URL(endpoint);
  url.searchParams.set('model', 'nova-3');
  url.searchParams.set('encoding', 'mulaw');
  url.searchParams.set('sample_rate', '8000');
  url.searchParams.set('channels', '1');
  url.searchParams.set('language', locale);
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('smart_format', 'false');
  return url.toString();
}

function boundedUtf8(data: RawData | string, maximumBytes: number): string {
  if (typeof data === 'string') {
    if (Buffer.byteLength(data, 'utf8') > maximumBytes) throw new DeepgramProtocolError('oversized Deepgram frame');
    return data;
  }
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (Array.isArray(data)) {
    const length = data.reduce((total, part) => total + part.byteLength, 0);
    if (length > maximumBytes) throw new DeepgramProtocolError('oversized Deepgram frame');
    bytes = Buffer.concat(data, length);
  } else bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength > maximumBytes) throw new DeepgramProtocolError('oversized Deepgram frame');
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeepgramProtocolError(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function boundedNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new DeepgramProtocolError(`invalid Deepgram ${name}`);
  }
  return value;
}
