import type { GameEvent } from '../shared/types';
import { speechSafeText } from '../shared/speech-text';
import { commentaryFor } from './commentary';

export interface SpeechSink { speak(text: string, opts: { priority: boolean }): void; }

const HIGH_PRIORITY = new Set<GameEvent['kind']>(['go', 'finish', 'race_over']);

export class Announcer {
  private seq = 0;
  private muted = false;
  private sink: SpeechSink | null;
  private onLine?: (text: string) => void;

  constructor(deps: { sink?: SpeechSink | null; onLine?: (text: string) => void }) {
    this.sink = deps.sink ?? null;
    this.onLine = deps.onLine;
  }

  setMuted(m: boolean): void { this.muted = m; }

  handle(event: GameEvent): void {
    const line = commentaryFor(event, this.seq);
    if (line === null) return;
    this.seq++;
    this.onLine?.(line);
    if (this.muted || !this.sink) return;
    try { this.sink.speak(line, { priority: HIGH_PRIORITY.has(event.kind) }); }
    catch { /* speech failure must never break the game */ }
  }
}

/** Build a SpeechSink over the browser speechSynthesis, or null if unavailable. */
export function browserSpeechSink(): SpeechSink | null {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth) return null;
  let lastAt = 0;
  return {
    speak(text, opts) {
      try {
        const spoken = speechSafeText(text);
        if (!spoken) return;
        const now = performance.now();
        // priority lines cancel the queue; normal lines respect a small min-gap
        if (opts.priority) synth.cancel();
        else if (now - lastAt < 700) return;
        lastAt = now;
        const u = new SpeechSynthesisUtterance(spoken);
        u.rate = 1.05; u.pitch = 1.0;
        synth.speak(u);
      } catch { /* ignore */ }
    },
  };
}
