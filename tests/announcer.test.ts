import { afterEach, describe, it, expect, vi } from 'vitest';
import { Announcer, browserSpeechSink } from '../client/announcer';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const spoken: { text: string; priority: boolean }[] = [];
  const lines: string[] = [];
  const sink = { speak: (text: string, opts: { priority: boolean }) => spoken.push({ text, priority: opts.priority }) };
  const a = new Announcer({ sink, onLine: (t) => lines.push(t) });
  return { a, spoken, lines };
}

describe('Announcer', () => {
  it('speaks and tickers a line for an event with commentary', () => {
    const { a, spoken, lines } = setup();
    a.handle({ kind: 'lead_change', playerId: 'p1', name: 'Ada' });
    expect(spoken).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Ada');
  });
  it('does NOT speak/ticker events with no commentary (countdown tick)', () => {
    const { a, spoken, lines } = setup();
    a.handle({ kind: 'countdown', n: 3 });
    expect(spoken).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });
  it('marks go/finish/race_over as high priority', () => {
    const { a, spoken } = setup();
    a.handle({ kind: 'go' });
    expect(spoken[0]!.priority).toBe(true);
  });
  it('when muted, still tickers but does not speak', () => {
    const { a, spoken, lines } = setup();
    a.setMuted(true);
    a.handle({ kind: 'go' });
    expect(spoken).toHaveLength(0);
    expect(lines).toHaveLength(1);
  });
  it('does not throw when there is no speech sink (headless / unsupported)', () => {
    const lines: string[] = [];
    const a = new Announcer({ sink: null, onLine: (t) => lines.push(t) });
    expect(() => a.handle({ kind: 'go' })).not.toThrow();
    expect(lines).toHaveLength(1);   // ticker still works
  });
  it('varies repeated lines (seq advances)', () => {
    const { a, lines } = setup();
    a.handle({ kind: 'hit', playerId: 'p1' });
    a.handle({ kind: 'hit', playerId: 'p1' });
    a.handle({ kind: 'hit', playerId: 'p1' });
    expect(new Set(lines).size).toBeGreaterThan(1);
  });

  it('uses localized commentary and sets the browser utterance language', () => {
    const utterances: Array<{ text: string; lang: string }> = [];
    class FakeUtterance {
      lang = '';
      rate = 1;
      pitch = 1;
      constructor(public text: string) {}
    }
    vi.stubGlobal('window', {
      speechSynthesis: { cancel: vi.fn(), speak: (utterance: FakeUtterance) => utterances.push(utterance) },
    });
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);

    const lines: string[] = [];
    const announcer = new Announcer({ sink: browserSpeechSink('pt-BR'), onLine: line => lines.push(line), locale: 'pt-BR' });
    announcer.handle({ kind: 'go' });

    expect(lines[0]).toMatch(/vai|largaram/i);
    expect(utterances[0]!.lang).toBe('pt-BR');
  });
});
