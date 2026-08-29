import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  DEEPGRAM_KARAOKE_MAX_MESSAGE_BYTES,
  DeepgramProtocolError,
  DirectDeepgramLyricRecognizerFactory,
  parseDeepgramKaraokeMessage,
} from '../server/karaoke-deepgram-recognizer';

function providerResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'Results',
    start: 0,
    duration: 0.4,
    is_final: false,
    channel: {
      alternatives: [{
        transcript: 'tone',
        confidence: 0.95,
        words: [{ word: 'tone', punctuated_word: 'Tone!', start: 0, end: 0.4, confidence: 0.9 }],
      }],
    },
    ...overrides,
  });
}

class FakeDeepgramSocket extends EventEmitter {
  readyState = 0;
  readonly sent: Array<string | Uint8Array> = [];
  readonly close = vi.fn();

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? data : Uint8Array.from(data));
  }
}

describe('direct Deepgram Karaoke recognizer', () => {
  it('strictly parses bounded interim/final words and preserves source evidence', () => {
    expect(parseDeepgramKaraokeMessage(providerResult())).toEqual({
      resultId: 'deepgram-0',
      final: false,
      words: [{ text: 'Tone!', sourceStartMs: 0, sourceEndMs: 400, confidence: 0.9 }],
    });
    expect(parseDeepgramKaraokeMessage(providerResult({ is_final: true }))?.final).toBe(true);
    expect(parseDeepgramKaraokeMessage('{"type":"Metadata"}')).toBeNull();
  });

  it.each([
    ['invalid JSON', '{'],
    ['unsupported type', '{"type":"Unknown"}'],
    ['missing final flag', providerResult({ is_final: undefined })],
    ['malformed channel', providerResult({ channel: [] })],
    ['invalid word confidence', providerResult({
      channel: { alternatives: [{ transcript: 'tone', words: [{ word: 'tone', start: 0, end: 1, confidence: 2 }] }] },
    })],
  ])('rejects %s provider frames', (_name, frame) => {
    expect(() => parseDeepgramKaraokeMessage(frame)).toThrow(DeepgramProtocolError);
  });

  it('rejects oversized provider frames before JSON parsing', () => {
    expect(() => parseDeepgramKaraokeMessage('x'.repeat(DEEPGRAM_KARAOKE_MAX_MESSAGE_BYTES + 1)))
      .toThrow(/oversized Deepgram frame/);
  });

  it('uses mu-law 8 kHz locale options and maps provider time to live inbound media time', async () => {
    const socket = new FakeDeepgramSocket();
    let openedUrl = '';
    let authorization = '';
    const results: unknown[] = [];
    const errors = vi.fn();
    const factory = new DirectDeepgramLyricRecognizerFactory({
      apiKey: 'deepgram-test-key',
      createSocket: (url, options) => {
        openedUrl = url;
        authorization = String((options.headers as Record<string, string>)?.Authorization);
        return socket;
      },
    });
    const recognizer = factory.create({ locale: 'pt-BR', onResult: result => results.push(result), onError: errors });
    const inbound = new Uint8Array(3_200).fill(0xaa);
    recognizer.acceptAudio({ audio: inbound, mediaTimestampMs: 1_000, durationMs: 400 });
    expect(socket.sent).toHaveLength(0);
    socket.readyState = 1;
    socket.emit('open');

    const url = new URL(openedUrl);
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: 'nova-3', encoding: 'mulaw', sample_rate: '8000', channels: '1',
      language: 'pt-BR', interim_results: 'true', punctuate: 'true', smart_format: 'false',
    });
    expect(authorization).toBe('Token deepgram-test-key');
    expect(socket.sent).toEqual([inbound]);

    socket.emit('message', Buffer.from(providerResult()), false);
    expect(results).toEqual([{
      resultId: 'deepgram-0', source: 'deepgram', final: false,
      words: [{
        text: 'Tone!', sourceStartMs: 0, sourceEndMs: 400,
        mediaStartTimestampMs: 1_000, mediaEndTimestampMs: 1_400, confidence: 0.9,
      }],
    }]);
    expect(errors).not.toHaveBeenCalled();

    const finalized = recognizer.finalize();
    expect(socket.sent.slice(1)).toEqual([
      JSON.stringify({ type: 'Finalize' }),
      JSON.stringify({ type: 'CloseStream' }),
    ]);
    socket.emit('close', 1_000);
    await finalized;
  });

  it('reports an unexpected provider close as a recognition failure', () => {
    const socket = new FakeDeepgramSocket();
    const errors = vi.fn();
    const recognizer = new DirectDeepgramLyricRecognizerFactory({
      apiKey: 'deepgram-test-key',
      createSocket: () => socket,
    }).create({ locale: 'en-US', onResult: vi.fn(), onError: errors });
    socket.emit('close', 1_006);
    expect(errors).toHaveBeenCalledOnce();
    recognizer.close();
  });

  it('reports an abnormal close while finalizing instead of treating it as success', async () => {
    const socket = new FakeDeepgramSocket();
    socket.readyState = 1;
    const errors = vi.fn();
    const recognizer = new DirectDeepgramLyricRecognizerFactory({
      apiKey: 'deepgram-test-key',
      createSocket: () => socket,
    }).create({ locale: 'en-US', onResult: vi.fn(), onError: errors });
    const finalized = recognizer.finalize();
    socket.emit('close', 1_011);
    await finalized;
    expect(errors).toHaveBeenCalledOnce();
  });
});
