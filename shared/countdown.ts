const COUNTDOWN_CUES: Record<number, string> = {
  6: 'On your mark',
  5: 'Get ready',
  4: 'Get set',
  3: '3',
  2: '2',
  1: '1',
};

export function countdownCue(n: number): string | null {
  return COUNTDOWN_CUES[n] ?? null;
}

export function countdownDisplay(seconds: number): string {
  if (seconds <= 0) return '';
  return countdownCue(Math.min(6, Math.ceil(seconds))) ?? '';
}

export function isCountdownSoundCue(n: number): boolean {
  return n === 3;
}
