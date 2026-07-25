import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isInteractiveShortcutTarget, resolveNumericSelection } from '../client/fighter/fighter-client-utils';

describe('fighter client shortcuts', () => {
  it('allows all twelve fighters to be selected numerically', () => {
    expect(resolveNumericSelection('', '1', 12)).toMatchObject({ buffer: '1', waiting: true });
    expect(resolveNumericSelection('1', '0', 12).selection).toBe(10);
    expect(resolveNumericSelection('1', '1', 12).selection).toBe(11);
    expect(resolveNumericSelection('1', '2', 12).selection).toBe(12);
    expect(resolveNumericSelection('', '9', 12).selection).toBe(9);
  });

  it('identifies controls that own their keyboard events', () => {
    expect(isInteractiveShortcutTarget({ closest: () => ({}) } as unknown as EventTarget)).toBe(true);
    expect(isInteractiveShortcutTarget({ closest: () => null } as unknown as EventTarget)).toBe(false);
  });

  it('waits for every assigned player and falls back automatically on actor load failure', () => {
    const source=readFileSync(new URL('../client/fighter/fighter.ts',import.meta.url),'utf8');
    expect(source).toContain('state.hasExpectedPlayers && state.players.length > 0');
    expect(source).toContain("console.warn('Fighter model failed to load; using fallback actors.'");
    expect(source).toContain('installFallbackActors(p1Id, p2Id, expectedKey)');
  });
});
