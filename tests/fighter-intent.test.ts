import { describe, expect, it } from 'vitest';
import { matchFighterCommand } from '../shared/fighter-intent';

describe('fighter voice intent', () => {
  it.each([['move forward', 'forward'], ['step back', 'back'], ['LEAP!', 'jump'], ['jab', 'punch'], ['roundhouse', 'kick'], ['defend', 'block']] as const)('%s -> %s', (spoken, command) => {
    expect(matchFighterCommand(spoken)).toBe(command);
  });
  it('rejects ambiguous and conversational phrases', () => {
    expect(matchFighterCommand('punch or kick')).toBeNull();
    expect(matchFighterCommand('can I jump?')).toBeNull();
  });
});
