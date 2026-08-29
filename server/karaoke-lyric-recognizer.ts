export interface KaraokeRecognizerAudioFrame {
  readonly audio: Uint8Array;
  readonly mediaTimestampMs: number;
  readonly durationMs: number;
}

export interface KaraokeRecognizedWord {
  readonly text: string;
  /** Timestamp in the provider's audio-stream domain. */
  readonly sourceStartMs: number;
  readonly sourceEndMs: number;
  /** Timestamp mapped back to Twilio's inbound media domain. */
  readonly mediaStartTimestampMs: number;
  readonly mediaEndTimestampMs: number;
  readonly confidence: number;
}

export interface KaraokeLyricRecognitionResult {
  /** Stable for interim revisions of the same provider segment. */
  readonly resultId: string;
  readonly source: string;
  readonly final: boolean;
  readonly words: readonly KaraokeRecognizedWord[];
}

export interface KaraokeStreamingLyricRecognizer {
  readonly source: string;
  acceptAudio(frame: KaraokeRecognizerAudioFrame): void;
  /** Resolves after the provider has emitted its final available results and closed. */
  finalize(): Promise<void>;
  close(): void;
}

export interface KaraokeLyricRecognizerSessionOptions {
  readonly locale: string;
  readonly expectedWords: readonly string[];
  readonly onResult: (result: KaraokeLyricRecognitionResult) => void;
  readonly onError: () => void;
}

export interface KaraokeLyricRecognizerFactory {
  readonly source: string;
  create(options: KaraokeLyricRecognizerSessionOptions): KaraokeStreamingLyricRecognizer;
}
