import { describe, expect, it } from 'vitest';
import {
  TwilioMediaStreamParseError,
  TwilioMediaStreamParser,
  type TwilioMediaFrame,
} from '../server/audio/twilio-media-stream';

const STREAM_SID = 'MZ-test-stream';
const ACCOUNT_SID = 'AC-test-account';
const CALL_SID = 'CA-test-call';
const SILENCE = Buffer.alloc(160, 0xff).toString('base64');

const connected = () => JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });
const start = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  event: 'start',
  sequenceNumber: '1',
  streamSid: STREAM_SID,
  start: {
    accountSid: ACCOUNT_SID,
    streamSid: STREAM_SID,
    callSid: CALL_SID,
    tracks: ['inbound'],
    customParameters: { roomCode: '4821' },
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8_000, channels: 1 },
  },
  ...overrides,
});
const media = (sequenceNumber: number, chunk: number, timestamp: number, payload = SILENCE) => JSON.stringify({
  event: 'media',
  sequenceNumber: String(sequenceNumber),
  streamSid: STREAM_SID,
  media: { track: 'inbound', chunk: String(chunk), timestamp: String(timestamp), payload },
});
const stop = (sequenceNumber: number) => JSON.stringify({
  event: 'stop',
  sequenceNumber: String(sequenceNumber),
  streamSid: STREAM_SID,
  stop: { accountSid: ACCOUNT_SID, callSid: CALL_SID },
});

function startedParser(): TwilioMediaStreamParser {
  const parser = new TwilioMediaStreamParser();
  parser.parse(connected());
  parser.parse(start());
  return parser;
}

function expectCode(action: () => unknown, code: TwilioMediaStreamParseError['code']): void {
  try {
    action();
    throw new Error('Expected parser to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(TwilioMediaStreamParseError);
    expect((error as TwilioMediaStreamParseError).code).toBe(code);
  }
}

describe('TwilioMediaStreamParser', () => {
  it('strictly parses a complete connected/start/media/stop stream', () => {
    const parser = new TwilioMediaStreamParser();
    expect(parser.parse(connected())).toEqual({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    expect(parser.parse(start())).toMatchObject({
      event: 'start',
      sequenceNumber: 1,
      start: { mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8_000, channels: 1 } },
    });
    const frame = parser.parse(media(2, 1, 0)) as TwilioMediaFrame;
    expect(frame.media.timestampMs).toBe(0);
    expect(frame.media.durationMs).toBe(20);
    expect(frame.media.payload).toEqual(new Uint8Array(160).fill(0xff));
    expect(parser.parse(stop(3))).toMatchObject({ event: 'stop', sequenceNumber: 3, streamSid: STREAM_SID });
  });

  it('rejects malformed JSON, unsupported events, bad formats, and non-canonical payloads', () => {
    expectCode(() => new TwilioMediaStreamParser().parse('{bad json'), 'INVALID_JSON');
    expectCode(
      () => new TwilioMediaStreamParser().parse(JSON.stringify({ event: 'mark' })),
      'UNSUPPORTED_EVENT',
    );

    const badFormat = new TwilioMediaStreamParser();
    badFormat.parse(connected());
    expectCode(() => badFormat.parse(start({
      start: {
        accountSid: ACCOUNT_SID,
        streamSid: STREAM_SID,
        callSid: CALL_SID,
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 16_000, channels: 1 },
      },
    })), 'INVALID_FORMAT');

    const badPayload = startedParser();
    expectCode(() => badPayload.parse(media(2, 1, 0, 'not base64!')), 'INVALID_PAYLOAD');
  });

  it('rejects sequence and media chunk gaps', () => {
    expectCode(() => startedParser().parse(media(3, 1, 0)), 'INVALID_SEQUENCE');
    expectCode(() => startedParser().parse(media(2, 2, 0)), 'MEDIA_CHUNK_GAP');
  });

  it('rejects backward media timestamps and timestamp gaps', () => {
    const backwards = startedParser();
    backwards.parse(media(2, 1, 20));
    expectCode(() => backwards.parse(media(3, 2, 10)), 'MEDIA_TIMESTAMP_BACKWARDS');

    const gap = startedParser();
    gap.parse(media(2, 1, 0));
    expectCode(() => gap.parse(media(3, 2, 40)), 'MEDIA_TIMESTAMP_GAP');
  });
});
