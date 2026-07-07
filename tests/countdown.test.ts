import { describe, expect, it } from 'vitest';
import { countdownCue, countdownDisplay } from '../shared/countdown';

describe('countdown cues', () => {
  it('maps staged countdown beats to display and voice text', () => {
    expect(countdownCue(6)).toBe('On your mark');
    expect(countdownCue(5)).toBe('Get ready');
    expect(countdownCue(4)).toBe('Get set');
    expect(countdownCue(3)).toBe('3');
    expect(countdownCue(0)).toBeNull();
  });

  it('uses the same staged labels for countdown seconds', () => {
    expect(countdownDisplay(6.2)).toBe('On your mark');
    expect(countdownDisplay(5.0)).toBe('Get ready');
    expect(countdownDisplay(3.0)).toBe('3');
    expect(countdownDisplay(0)).toBe('');
  });
});
