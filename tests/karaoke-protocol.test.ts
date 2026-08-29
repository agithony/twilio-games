import { describe, expect, it } from 'vitest';
import {
  KARAOKE_PROTOCOL_MAX_JSON_LENGTH,
  parseKaraokeClientMessage,
} from '../shared/karaoke-protocol';

describe('karaoke browser protocol', () => {
  it('parses every supported browser command', () => {
    expect(parseKaraokeClientMessage(JSON.stringify({
      type: 'join', roomCode: 'room', name: 'Ada', sessionId: 'stable', locale: 'pt-BR',
    }))).toEqual({ type: 'join', roomCode: 'room', name: 'Ada', sessionId: 'stable', locale: 'pt-BR' });
    expect(parseKaraokeClientMessage('{"type":"spectate","roomCode":"ROOM","locale":"en-US"}'))
      .toEqual({ type: 'spectate', roomCode: 'ROOM', locale: 'en-US' });
    expect(parseKaraokeClientMessage('{"type":"display_auth","roomCode":"ROOM","token":"secret"}'))
      .toEqual({ type: 'display_auth', roomCode: 'ROOM', token: 'secret' });
    expect(parseKaraokeClientMessage('{"type":"clock_sync","clientSentAtMs":1725000000000}'))
      .toEqual({ type: 'clock_sync', clientSentAtMs: 1_725_000_000_000 });
    expect(parseKaraokeClientMessage('{"type":"select_song","songId":"neon-hello-dev"}'))
      .toEqual({ type: 'select_song', songId: 'neon-hello-dev' });
    expect(parseKaraokeClientMessage('{"type":"advance"}')).toEqual({ type: 'advance' });
    expect(parseKaraokeClientMessage('{"type":"ready","loadingGeneration":2}'))
      .toEqual({ type: 'ready', loadingGeneration: 2 });
    expect(parseKaraokeClientMessage('{"type":"retry_loading","loadingGeneration":3}'))
      .toEqual({ type: 'retry_loading', loadingGeneration: 3 });
    expect(parseKaraokeClientMessage('{"type":"lane_input","lane":2}'))
      .toEqual({ type: 'lane_input', lane: 2 });
    expect(parseKaraokeClientMessage('{"type":"leave","sessionId":"stable"}'))
      .toEqual({ type: 'leave', sessionId: 'stable' });
  });

  it('rejects malformed, non-object, and oversized JSON', () => {
    expect(parseKaraokeClientMessage('{bad')).toMatchObject({ type: 'error', code: 'bad_json' });
    expect(parseKaraokeClientMessage('[]')).toMatchObject({ type: 'error', code: 'bad_message' });
    expect(parseKaraokeClientMessage('null')).toMatchObject({ type: 'error', code: 'bad_message' });
    expect(parseKaraokeClientMessage('x'.repeat(KARAOKE_PROTOCOL_MAX_JSON_LENGTH + 1)))
      .toMatchObject({ type: 'error', code: 'bad_json' });
  });

  it('strictly rejects extra fields, unsafe IDs, bad generations, and unsupported locales', () => {
    expect(parseKaraokeClientMessage('{"type":"advance","score":100000}'))
      .toMatchObject({ type: 'error', code: 'bad_advance' });
    expect(parseKaraokeClientMessage('{"type":"select_song","songId":"../secret"}'))
      .toMatchObject({ type: 'error', code: 'bad_select' });
    expect(parseKaraokeClientMessage('{"type":"ready","loadingGeneration":0}'))
      .toMatchObject({ type: 'error', code: 'bad_ready' });
    expect(parseKaraokeClientMessage('{"type":"ready","loadingGeneration":1.5}'))
      .toMatchObject({ type: 'error', code: 'bad_ready' });
    expect(parseKaraokeClientMessage('{"type":"clock_sync","clientSentAtMs":-1}'))
      .toMatchObject({ type: 'error', code: 'bad_clock_sync' });
    expect(parseKaraokeClientMessage('{"type":"lane_input","lane":4}'))
      .toMatchObject({ type: 'error', code: 'bad_lane_input' });
    expect(parseKaraokeClientMessage('{"type":"lane_input","lane":1,"score":100000}'))
      .toMatchObject({ type: 'error', code: 'bad_lane_input' });
    expect(parseKaraokeClientMessage('{"type":"spectate","roomCode":"ROOM","locale":"en-GB"}'))
      .toMatchObject({ type: 'error', code: 'bad_spectate' });
    expect(parseKaraokeClientMessage(JSON.stringify({ type: 'join', roomCode: 'ROOM\n', name: 'Ada' })))
      .toMatchObject({ type: 'error', code: 'bad_join' });
  });

  it('has no browser score or hit submission command', () => {
    for (const message of [
      { type: 'score', score: 100_000 },
      { type: 'update_score', score: 100_000 },
      { type: 'record_hit', wordId: 'neon-hello-dev-01', points: 100_000 },
      { type: 'word_judgment', judgment: 'perfect' },
      { type: 'forged_score', score: 100_000, judgment: 'perfect' },
    ]) {
      expect(parseKaraokeClientMessage(JSON.stringify(message)))
        .toMatchObject({ type: 'error', code: 'unknown_type' });
    }
  });
});
