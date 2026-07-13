import { describe, expect, it } from 'vitest';
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
});
