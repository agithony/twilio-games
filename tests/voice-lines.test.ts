import { describe, it, expect } from 'vitest';
import { greetingLine, lineForEvent, placeLine, ordinal } from '../server/voice-lines';

describe('voice-lines', () => {
  it('greeting mentions how to drive', () => {
    const g = greetingLine().toLowerCase();
    expect(g).toContain('left');
    expect(g).toContain('boost');
  });

  it('countdown speaks the number, but not n=0', () => {
    expect(lineForEvent({ kind: 'countdown', n: 3 }, 'p1')).toBe('3...');
    expect(lineForEvent({ kind: 'countdown', n: 0 }, 'p1')).toBeNull();
  });

  it('go event is spoken', () => {
    expect(lineForEvent({ kind: 'go' }, 'p1')).toContain('Go');
  });

  it('finish is spoken only for the caller\'s own player', () => {
    expect(lineForEvent({ kind: 'finish', playerId: 'p1', name: 'Me', place: 1 }, 'p1')).toContain('First');
    expect(lineForEvent({ kind: 'finish', playerId: 'p2', name: 'Them', place: 1 }, 'p1')).toBeNull();
    expect(lineForEvent({ kind: 'finish', playerId: 'p1', name: 'Me', place: 1 }, null)).toBeNull();
  });

  it('mid-race cues are NOT spoken to the caller (screen-only)', () => {
    expect(lineForEvent({ kind: 'lead_change', playerId: 'p1', name: 'Me' }, 'p1')).toBeNull();
    expect(lineForEvent({ kind: 'hit', playerId: 'p1' }, 'p1')).toBeNull();
    expect(lineForEvent({ kind: 'race_over' }, 'p1')).toBeNull();
  });

  it('placeLine covers podium + generic ordinals', () => {
    expect(placeLine(1).toLowerCase()).toContain('first');
    expect(placeLine(2).toLowerCase()).toContain('second');
    expect(placeLine(3).toLowerCase()).toContain('third');
    expect(placeLine(5)).toContain('5th');
  });

  it('ordinal handles the tricky cases', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(21)).toBe('21st');
  });
});
