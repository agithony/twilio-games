import type { Intent } from '../shared/types';

export interface InputAdapter { onIntent(cb: (i: Intent) => void): void; }

export class KeyboardAdapter implements InputAdapter {
  private cbs: ((i: Intent) => void)[] = [];
  constructor() {
    const map: Record<string, Intent> = {
      ArrowLeft: 'MOVE_LEFT', ArrowRight: 'MOVE_RIGHT',
      ArrowUp: 'BOOST', ArrowDown: 'BRAKE', ' ': 'USE_POWER',
    };
    addEventListener('keydown', (e) => {
      const intent = map[e.key];
      if (intent) { e.preventDefault(); this.cbs.forEach(cb => cb(intent)); }
    });
  }
  onIntent(cb: (i: Intent) => void): void { this.cbs.push(cb); }
}
