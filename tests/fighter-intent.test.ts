import { describe, expect, it } from 'vitest';
import { matchFighterCommand, matchFighterCommands } from '../shared/fighter-intent';

describe('fighter voice intent', () => {
  it.each([['move forward', 'forward'], ['step back', 'back'], ['LEAP!', 'jump'], ['jab', 'punch'], ['roundhouse', 'kick'], ['defend', 'block']] as const)('%s -> %s', (spoken, command) => {
    expect(matchFighterCommand(spoken)).toBe(command);
  });
  it('rejects ambiguous and conversational phrases', () => {
    expect(matchFighterCommand('punch or kick')).toBeNull();
    expect(matchFighterCommand('can I jump?')).toBeNull();
  });
  it('parses repeated and chained commands without treating conversation as gameplay', () => {
    expect(matchFighterCommands('punch five times')).toEqual(['punch', 'punch', 'punch', 'punch', 'punch']);
    expect(matchFighterCommands('punch punch kick')).toEqual(['punch', 'punch', 'kick']);
    expect(matchFighterCommands('move forward then block')).toEqual(['forward', 'block']);
    expect(matchFighterCommands('can I punch now')).toEqual([]);
  });
});
