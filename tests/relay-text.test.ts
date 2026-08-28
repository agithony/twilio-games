import { describe, expect, it } from 'vitest';
import { relaySpeechMarkup, relayTextChunks } from '../server/http-server';

describe('relayTextChunks', () => {
  it('uses Twilio official SSML pronunciation only for English Relay speech', () => {
    expect(relaySpeechMarkup('Powered by Twilio Conversation Relay.', 'en-US')).toContain('<phoneme alphabet="ipa" ph="ˈtwɪlioʊ">Twilio</phoneme>');
    expect(relaySpeechMarkup('TWILIO', 'en-US')).toContain('>Twilio</phoneme>');
    expect(relaySpeechMarkup('Tecnologia Twilio Conversation Relay.', 'pt-BR')).toBe('Tecnologia Twilio Conversation Relay.');
  });
  it('splits long Voice Racer control instructions into paced chunks', () => {
    const chunks = relayTextChunks('Before you start, check the controls on the screen. Say left or right to steer. Say boost to speed up. Say brake to slow down. Say nitro to break through a wall.');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('Before you start');
    expect(chunks.at(-1)).toContain('nitro');
  });

  it('splits dense Voice Monsters controls around or-say phrasing', () => {
    const chunks = relayTextChunks('How to play: on your turn, say attack, then pick one of the four moves. You can also say guard, item, or taunt.');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('say attack');
  });

  it('leaves short non-instruction commentary as one utterance', () => {
    expect(relayTextChunks('Sparkmouse lets loose Thunder Jolt!')).toEqual(['Sparkmouse lets loose Thunder Jolt!']);
  });
});
