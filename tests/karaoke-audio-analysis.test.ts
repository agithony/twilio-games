import { describe, expect, it } from 'vitest';
import { analyzeMediaFrame } from '../server/audio/frame-analyzer';
import { decodeMuLaw8kMono, MULAW_DECODE_TABLE } from '../server/audio/mulaw';
import { TwilioMediaStreamParser, type TwilioMediaFrame } from '../server/audio/twilio-media-stream';

function encodeMuLaw(sampleInput: number): number {
  let sample = Math.max(-32_635, Math.min(32_635, Math.round(sampleInput)));
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  sample += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent -= 1, mask >>= 1) {
    // Locate the segment containing the magnitude.
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function parsedMedia(payload: Uint8Array, timestampMs: number): TwilioMediaFrame {
  const parser = new TwilioMediaStreamParser();
  parser.parse(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  parser.parse(JSON.stringify({
    event: 'start', sequenceNumber: '1', streamSid: 'MZ-analysis',
    start: {
      accountSid: 'AC-analysis', streamSid: 'MZ-analysis', callSid: 'CA-analysis', tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8_000, channels: 1 },
    },
  }));
  return parser.parse(JSON.stringify({
    event: 'media', sequenceNumber: '2', streamSid: 'MZ-analysis',
    media: {
      track: 'inbound', chunk: '1', timestamp: String(timestampMs),
      payload: Buffer.from(payload).toString('base64'),
    },
  })) as TwilioMediaFrame;
}

describe('mu-law decoding and frame analysis', () => {
  it('uses the complete G.711 mu-law decode table', () => {
    expect(MULAW_DECODE_TABLE).toHaveLength(256);
    expect(decodeMuLaw8kMono(Uint8Array.of(0x00, 0x7f, 0x80, 0xff))).toEqual(
      Int16Array.of(-32_124, 0, 32_124, 0),
    );
  });

  it('reports deterministic silence from the media timestamp', () => {
    const observation = analyzeMediaFrame(parsedMedia(new Uint8Array(160).fill(0xff), 250));
    expect(observation.mediaTimestampMs).toBe(250);
    expect(observation.durationMs).toBe(20);
    expect(observation.rms).toBe(0);
    expect(observation.rmsDbfs).toBe(Number.NEGATIVE_INFINITY);
    expect(observation.voiceActive).toBe(false);
    expect(observation.pitchHz).toBeNull();
  });

  it('detects an encoded 440 Hz tone with YIN-style pitch analysis', () => {
    const sampleCount = 800;
    const payload = new Uint8Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      payload[index] = encodeMuLaw(16_000 * Math.sin(2 * Math.PI * 440 * index / 8_000));
    }
    const observation = analyzeMediaFrame(parsedMedia(payload, 1_000));
    expect(observation.mediaTimestampMs).toBe(1_000);
    expect(observation.durationMs).toBe(100);
    expect(observation.voiceActive).toBe(true);
    expect(observation.rms).toBeGreaterThan(0.3);
    expect(observation.pitchHz).not.toBeNull();
    expect(observation.pitchHz!).toBeCloseTo(440, -0.5);
    expect(observation.pitchClarity).toBeGreaterThan(0.9);
  });
});
