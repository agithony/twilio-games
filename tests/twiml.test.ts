import { describe, it, expect } from 'vitest';
import { twimlGatherRoomCode, twimlConnectRelay } from '../server/twiml';

describe('twimlGatherRoomCode', () => {
  it('asks for a 4-digit room code via DTMF', () => {
    const xml = twimlGatherRoomCode({ actionUrl: 'https://x.test/voice/join' });
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<Gather');
    expect(xml).toContain('input="dtmf"');
    expect(xml).toContain('numDigits="4"');
    expect(xml).toContain('action="https://x.test/voice/join"');
  });
  it('escapes the action URL in the gather', () => {
    const xml = twimlGatherRoomCode({ actionUrl: 'https://x.test/join?a=1&b=2' });
    expect(xml).toContain('https://x.test/join?a=1&amp;b=2');
  });
});

describe('twimlConnectRelay', () => {
  const xml = twimlConnectRelay({
    wsUrl: 'wss://x.test/voice',
    sessionEndedUrl: 'https://x.test/voice/session-ended',
    roomCode: 'ABCD',
  });
  it('connects to ConversationRelay with the wss url', () => {
    expect(xml).toContain('<Connect');
    expect(xml).toContain('<ConversationRelay');
    expect(xml).toContain('url="wss://x.test/voice"');
  });
  it('enables partial transcripts and biases the vocabulary', () => {
    expect(xml).toContain('speechModel="flux"');
    expect(xml).toContain('partialPrompts="true"');
    expect(xml).toContain('hints="left, right, boost, brake, use power"');
  });
  it('sets the required transcription provider', () => {
    expect(xml).toContain('transcriptionProvider="Deepgram"');
  });
  it('stays silent (no welcome greeting, not interruptible)', () => {
    expect(xml).toContain('welcomeGreeting=""');
    expect(xml).toContain('interruptible="none"');
  });
  it('passes the room code as a Parameter', () => {
    expect(xml).toContain('<Parameter name="roomCode" value="ABCD"');
  });
  it('escapes XML-special characters in the room code', () => {
    const x = twimlConnectRelay({ wsUrl: 'wss://x.test/voice',
      sessionEndedUrl: 'https://x.test/e', roomCode: 'A&B' });
    expect(x).toContain('value="A&amp;B"');
  });
  it('escapes XML-special characters in all interpolated URLs', () => {
    const x = twimlConnectRelay({
      wsUrl: 'wss://x.test/voice?a=1&b=2',
      sessionEndedUrl: 'https://x.test/end?x=1&y=2',
      roomCode: 'ABCD',
    });
    expect(x).toContain('wss://x.test/voice?a=1&amp;b=2');
    expect(x).toContain('https://x.test/end?x=1&amp;y=2');
    expect(x).not.toContain('&b=2');   // raw unescaped ampersand must not appear
  });
});
