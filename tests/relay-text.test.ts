import { describe, expect, it } from 'vitest';
import { relayTextChunks } from '../server/http-server';

describe('relayTextChunks', () => {
  it('splits long Voice Racer control instructions into paced chunks', () => {
    const chunks = relayTextChunks('Before you start, check the controls on the screen. Say left or right to steer. Say boost to speed up. Say brake to slow down. Say nitro to break through a wall.');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('Before you start');
    expect(chunks.at(-1)).toContain('nitro');
  });

  it('splits dense Voice Monsters controls around or-say phrasing', () => {
    const chunks = relayTextChunks('How to play: on your turn, say fight, then pick one of the four attacks. You can also say guard, item, or taunt.');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('say fight');
  });

  it('leaves short non-instruction commentary as one utterance', () => {
    expect(relayTextChunks('Sparkmouse lets loose Thunder Jolt!')).toEqual(['Sparkmouse lets loose Thunder Jolt!']);
  });
});
