const SAMPLE_RATE = 8_000;
const SAMPLES_PER_MILLISECOND = SAMPLE_RATE / 1_000;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type TwilioMediaTrack = 'inbound' | 'outbound';

export type TwilioMediaStreamFrame =
  | TwilioConnectedFrame
  | TwilioStartFrame
  | TwilioMediaFrame
  | TwilioStopFrame;

export interface TwilioConnectedFrame {
  readonly event: 'connected';
  readonly protocol: 'Call';
  readonly version: '1.0.0';
}

export interface TwilioStartFrame {
  readonly event: 'start';
  readonly sequenceNumber: number;
  readonly streamSid: string;
  readonly start: Readonly<{
    accountSid: string;
    streamSid: string;
    callSid: string;
    tracks: readonly TwilioMediaTrack[];
    customParameters: Readonly<Record<string, string>>;
    mediaFormat: Readonly<{
      encoding: 'audio/x-mulaw';
      sampleRate: 8_000;
      channels: 1;
    }>;
  }>;
}

export interface TwilioMediaFrame {
  readonly event: 'media';
  readonly sequenceNumber: number;
  readonly streamSid: string;
  readonly media: Readonly<{
    track: TwilioMediaTrack;
    chunk: number;
    timestampMs: number;
    durationMs: number;
    payload: Uint8Array;
  }>;
}

export interface TwilioStopFrame {
  readonly event: 'stop';
  readonly sequenceNumber: number;
  readonly streamSid: string;
  readonly stop: Readonly<{
    accountSid: string;
    callSid: string;
  }>;
}

export type TwilioMediaStreamParseErrorCode =
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'INVALID_FRAME'
  | 'UNSUPPORTED_EVENT'
  | 'UNEXPECTED_EVENT'
  | 'INVALID_SEQUENCE'
  | 'INVALID_FORMAT'
  | 'INVALID_PAYLOAD'
  | 'STREAM_MISMATCH'
  | 'MEDIA_CHUNK_GAP'
  | 'MEDIA_TIMESTAMP_BACKWARDS'
  | 'MEDIA_TIMESTAMP_OVERLAP'
  | 'MEDIA_TIMESTAMP_GAP';

export class TwilioMediaStreamParseError extends Error {
  constructor(
    readonly code: TwilioMediaStreamParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TwilioMediaStreamParseError';
  }
}

type JsonObject = Record<string, unknown>;

interface TrackPosition {
  readonly chunk: number;
  readonly startSample: number;
  readonly endSample: number;
}

function fail(code: TwilioMediaStreamParseErrorCode, message: string): never {
  throw new TwilioMediaStreamParseError(code, message);
}

function record(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_FRAME', `${field} must be an object`);
  }
  return value as JsonObject;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_FRAME', `${field} must be a non-empty string`);
  }
  return value;
}

function decimalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    fail('INVALID_FRAME', `${field} must be a canonical decimal string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('INVALID_FRAME', `${field} is outside the supported integer range`);
  }
  return parsed;
}

function parseInput(input: string | Uint8Array): JsonObject {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else if (input instanceof Uint8Array) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      fail('INVALID_UTF8', 'Media Streams frame is not valid UTF-8');
    }
  } else {
    fail('INVALID_FRAME', 'Media Streams frame must be a string or Uint8Array');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('INVALID_JSON', 'Media Streams frame is not valid JSON');
  }
  return record(parsed, 'frame');
}

function decodePayload(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_PATTERN.test(value)) {
    fail('INVALID_PAYLOAD', 'media.payload must be non-empty canonical base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    fail('INVALID_PAYLOAD', 'media.payload must be non-empty canonical base64');
  }
  return new Uint8Array(decoded);
}

function parseTracks(value: unknown): readonly TwilioMediaTrack[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('INVALID_FRAME', 'start.tracks must be a non-empty array');
  }
  const tracks: TwilioMediaTrack[] = [];
  for (const track of value) {
    if (track !== 'inbound' && track !== 'outbound') {
      fail('INVALID_FRAME', 'start.tracks contains an unsupported track');
    }
    if (tracks.includes(track)) fail('INVALID_FRAME', 'start.tracks contains a duplicate track');
    tracks.push(track);
  }
  return tracks;
}

function parseCustomParameters(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const input = record(value, 'start.customParameters');
  const parameters: Record<string, string> = {};
  for (const [key, parameter] of Object.entries(input)) {
    if (typeof parameter !== 'string') {
      fail('INVALID_FRAME', `start.customParameters.${key} must be a string`);
    }
    parameters[key] = parameter;
  }
  return parameters;
}

/** Strictly parses one complete Twilio Media Streams session. */
export class TwilioMediaStreamParser {
  private phase: 'connected' | 'started' | 'stopped' | 'awaiting-connected' = 'awaiting-connected';
  private expectedSequence = 1;
  private streamSid: string | null = null;
  private accountSid: string | null = null;
  private callSid: string | null = null;
  private tracks: readonly TwilioMediaTrack[] = [];
  private readonly trackPositions = new Map<TwilioMediaTrack, TrackPosition>();

  parse(input: string | Uint8Array): TwilioMediaStreamFrame {
    const frame = parseInput(input);
    const event = nonEmptyString(frame.event, 'event');
    switch (event) {
      case 'connected':
        return this.parseConnected(frame);
      case 'start':
        return this.parseStart(frame);
      case 'media':
        return this.parseMedia(frame);
      case 'stop':
        return this.parseStop(frame);
      default:
        return fail('UNSUPPORTED_EVENT', `Unsupported Media Streams event: ${event}`);
    }
  }

  private parseConnected(frame: JsonObject): TwilioConnectedFrame {
    if (this.phase !== 'awaiting-connected') {
      fail('UNEXPECTED_EVENT', `connected event is not valid while parser is ${this.phase}`);
    }
    const protocol = nonEmptyString(frame.protocol, 'protocol');
    const version = nonEmptyString(frame.version, 'version');
    if (protocol.length > 64 || version.length > 64 || /[\p{Cc}]/u.test(protocol + version)) {
      fail('INVALID_FRAME', 'connected protocol metadata is invalid');
    }
    this.phase = 'connected';
    return { event: 'connected', protocol: 'Call', version: '1.0.0' };
  }

  private parseStart(frame: JsonObject): TwilioStartFrame {
    if (this.phase !== 'connected') {
      fail('UNEXPECTED_EVENT', `start event is not valid while parser is ${this.phase}`);
    }
    const sequenceNumber = this.sequence(frame.sequenceNumber);
    const streamSid = nonEmptyString(frame.streamSid, 'streamSid');
    const start = record(frame.start, 'start');
    const nestedStreamSid = nonEmptyString(start.streamSid, 'start.streamSid');
    if (nestedStreamSid !== streamSid) fail('STREAM_MISMATCH', 'start stream SIDs do not match');

    const accountSid = nonEmptyString(start.accountSid, 'start.accountSid');
    const callSid = nonEmptyString(start.callSid, 'start.callSid');
    const tracks = parseTracks(start.tracks);
    const mediaFormat = record(start.mediaFormat, 'start.mediaFormat');
    if (
      mediaFormat.encoding !== 'audio/x-mulaw'
      || mediaFormat.sampleRate !== SAMPLE_RATE
      || mediaFormat.channels !== 1
    ) {
      fail('INVALID_FORMAT', 'Only audio/x-mulaw, 8000 Hz, mono Media Streams are supported');
    }
    const customParameters = parseCustomParameters(start.customParameters);

    this.phase = 'started';
    this.expectedSequence = sequenceNumber + 1;
    this.streamSid = streamSid;
    this.accountSid = accountSid;
    this.callSid = callSid;
    this.tracks = tracks;
    return {
      event: 'start',
      sequenceNumber,
      streamSid,
      start: {
        accountSid,
        streamSid,
        callSid,
        tracks,
        customParameters,
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: SAMPLE_RATE, channels: 1 },
      },
    };
  }

  private parseMedia(frame: JsonObject): TwilioMediaFrame {
    if (this.phase !== 'started') {
      fail('UNEXPECTED_EVENT', `media event is not valid while parser is ${this.phase}`);
    }
    const sequenceNumber = this.sequence(frame.sequenceNumber);
    const streamSid = this.validStreamSid(frame.streamSid);
    const media = record(frame.media, 'media');
    const trackValue = nonEmptyString(media.track, 'media.track');
    if (trackValue !== 'inbound' && trackValue !== 'outbound') {
      fail('INVALID_FRAME', 'media.track is unsupported');
    }
    const track = trackValue;
    if (!this.tracks.includes(track)) fail('INVALID_FRAME', 'media.track was not declared by start.tracks');

    const chunk = decimalInteger(media.chunk, 'media.chunk', 1, Number.MAX_SAFE_INTEGER - 1);
    const timestampMs = decimalInteger(
      media.timestamp,
      'media.timestamp',
      0,
      Math.floor(Number.MAX_SAFE_INTEGER / SAMPLES_PER_MILLISECOND),
    );
    const payload = decodePayload(media.payload);
    const startSample = timestampMs * SAMPLES_PER_MILLISECOND;
    const endSample = startSample + payload.length;
    if (!Number.isSafeInteger(endSample)) fail('INVALID_FRAME', 'media payload exceeds the timestamp range');

    const previous = this.trackPositions.get(track);
    const expectedChunk = (previous?.chunk ?? 0) + 1;
    if (chunk !== expectedChunk) {
      fail('MEDIA_CHUNK_GAP', `Expected ${track} media chunk ${expectedChunk}, received ${chunk}`);
    }
    if (previous) {
      if (startSample < previous.startSample) {
        fail('MEDIA_TIMESTAMP_BACKWARDS', `${track} media.timestamp moved backwards`);
      }
      if (startSample < previous.endSample) {
        fail('MEDIA_TIMESTAMP_OVERLAP', `${track} media payload overlaps the previous payload`);
      }
      if (startSample > previous.endSample) {
        fail('MEDIA_TIMESTAMP_GAP', `${track} media.timestamp has an audio gap`);
      }
    }

    this.expectedSequence = sequenceNumber + 1;
    this.trackPositions.set(track, { chunk, startSample, endSample });
    return {
      event: 'media',
      sequenceNumber,
      streamSid,
      media: {
        track,
        chunk,
        timestampMs,
        durationMs: payload.length / SAMPLES_PER_MILLISECOND,
        payload,
      },
    };
  }

  private parseStop(frame: JsonObject): TwilioStopFrame {
    if (this.phase !== 'started') {
      fail('UNEXPECTED_EVENT', `stop event is not valid while parser is ${this.phase}`);
    }
    const sequenceNumber = this.sequence(frame.sequenceNumber);
    const streamSid = this.validStreamSid(frame.streamSid);
    const stop = record(frame.stop, 'stop');
    const accountSid = nonEmptyString(stop.accountSid, 'stop.accountSid');
    const callSid = nonEmptyString(stop.callSid, 'stop.callSid');
    if (accountSid !== this.accountSid || callSid !== this.callSid) {
      fail('STREAM_MISMATCH', 'stop identifiers do not match the start event');
    }

    this.phase = 'stopped';
    this.expectedSequence = sequenceNumber + 1;
    return { event: 'stop', sequenceNumber, streamSid, stop: { accountSid, callSid } };
  }

  private sequence(value: unknown): number {
    const sequence = decimalInteger(value, 'sequenceNumber', 1, Number.MAX_SAFE_INTEGER - 1);
    if (sequence !== this.expectedSequence) {
      fail('INVALID_SEQUENCE', `Expected sequenceNumber ${this.expectedSequence}, received ${sequence}`);
    }
    return sequence;
  }

  private validStreamSid(value: unknown): string {
    const streamSid = nonEmptyString(value, 'streamSid');
    if (streamSid !== this.streamSid) fail('STREAM_MISMATCH', 'streamSid does not match the start event');
    return streamSid;
  }
}
