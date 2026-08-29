import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { A_THOUSAND_MILES, NEVER_GONNA_GIVE_YOU_UP } from '../shared/karaoke-songs';

const EXCERPT = new URL('../client/public/audio/karaoke/classic-instrumental-45s.mp3', import.meta.url);
const THOUSAND_MILES_EXCERPT = new URL('../client/public/audio/karaoke/thousand-miles-45s.mp3', import.meta.url);
const MPEG1_LAYER_3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
] as const;

interface Mp3Header {
  readonly offset: number;
  readonly bitrate: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly hasCrc: boolean;
}

function synchsafeInteger(bytes: Buffer, offset: number): number {
  return ((bytes[offset]! & 0x7f) << 21)
    | ((bytes[offset + 1]! & 0x7f) << 14)
    | ((bytes[offset + 2]! & 0x7f) << 7)
    | (bytes[offset + 3]! & 0x7f);
}

function firstFrameHeader(bytes: Buffer): Mp3Header {
  const offset = bytes.subarray(0, 3).toString('ascii') === 'ID3'
    ? 10 + synchsafeInteger(bytes, 6)
    : 0;
  const header = bytes.readUInt32BE(offset);
  expect(header >>> 21).toBe(0x7ff);
  expect((header >>> 19) & 0x3).toBe(0x3);
  expect((header >>> 17) & 0x3).toBe(0x1);
  const bitrate = MPEG1_LAYER_3_BITRATES[(header >>> 12) & 0xf]! * 1_000;
  const sampleRate = [44_100, 48_000, 32_000][(header >>> 10) & 0x3]!;
  const channels = ((header >>> 6) & 0x3) === 0x3 ? 1 : 2;
  return { offset, bitrate, sampleRate, channels, hasCrc: ((header >>> 16) & 1) === 0 };
}

function gaplessDurationSeconds(bytes: Buffer, header: Mp3Header): number {
  const sideInfoBytes = header.channels === 1 ? 17 : 32;
  const infoOffset = header.offset + 4 + (header.hasCrc ? 2 : 0) + sideInfoBytes;
  expect(['Info', 'Xing']).toContain(bytes.subarray(infoOffset, infoOffset + 4).toString('ascii'));
  const flags = bytes.readUInt32BE(infoOffset + 4);
  let cursor = infoOffset + 8;
  expect(flags & 1).toBe(1);
  const frameCount = bytes.readUInt32BE(cursor);
  cursor += 4;
  if (flags & 2) cursor += 4;
  if (flags & 4) cursor += 100;
  if (flags & 8) cursor += 4;

  expect(bytes.subarray(cursor, cursor + 4).toString('ascii')).toBe('Lavc');
  const delayPaddingOffset = cursor + 21;
  const encoderDelay = (bytes[delayPaddingOffset]! << 4) | (bytes[delayPaddingOffset + 1]! >>> 4);
  const endPadding = ((bytes[delayPaddingOffset + 1]! & 0xf) << 8) | bytes[delayPaddingOffset + 2]!;
  return (frameCount * 1_152 - encoderDelay - endPadding) / header.sampleRate;
}

describe('licensed Karaoke audio assets', () => {
  it('keeps authoring sources outside the production public directory', () => {
    expect(readdirSync(new URL('../client/public/audio/karaoke/', import.meta.url))).toEqual([
      'classic-instrumental-45s.mp3',
      'thousand-miles-45s.mp3',
    ]);
  });

  it('ships the exact gapless Thousand Miles excerpt at the catalog URL', () => {
    expect(A_THOUSAND_MILES.audioUrl).toBe('/audio/karaoke/thousand-miles-45s.mp3?v=20260828-iconic-2');
    const bytes = readFileSync(THOUSAND_MILES_EXCERPT);
    const header = firstFrameHeader(bytes);
    expect(header).toMatchObject({ bitrate: 192_000, sampleRate: 44_100, channels: 2 });
    expect(gaplessDurationSeconds(bytes, header)).toBe(45);
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('08fe505e4c91c7b0533d2bdf1a6cabaae93a244cbccf38ac9990e400b5b0f7a4');
  });

  it('ships an exact gapless 45-second stereo excerpt at the catalog URL', () => {
    expect(NEVER_GONNA_GIVE_YOU_UP.audioUrl).toBe('/audio/karaoke/classic-instrumental-45s.mp3?v=20260827-sync-2');
    const bytes = readFileSync(EXCERPT);
    const header = firstFrameHeader(bytes);
    expect(header).toMatchObject({ bitrate: 192_000, sampleRate: 44_100, channels: 2 });
    expect(gaplessDurationSeconds(bytes, header)).toBe(45);
  });
});
