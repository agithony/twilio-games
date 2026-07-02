// The HP the battle bars DISPLAY during a paced turn resolution. The bug it fixes: the server sends
// the paced damage events, then the settled end-of-turn snapshot; if the bars read the snapshot
// directly, BOTH drop to final HP at once (while the banners still narrate hits one at a time). This
// tracker makes each bar hold its value until that side's damage event actually plays.
import { describe, it, expect } from 'vitest';
import { ResolutionHp } from '../client/battle/resolution-hp';

describe('ResolutionHp', () => {
  it('falls back to the snapshot HP when no resolution is in progress', () => {
    const r = new ResolutionHp();
    expect(r.display('a', 70)).toBe(70);
    expect(r.display('b', 66)).toBe(66);
  });

  it('after begin(), shows the PRE-turn HP even if the settled snapshot (fallback) is already lower', () => {
    const r = new ResolutionHp();
    r.begin(70, 66);                    // pre-turn HP seeded at resolution start
    // Even though the settled snapshot says a=40 / b=20, neither bar has been hit yet → hold pre-turn.
    expect(r.display('a', 40)).toBe(70);
    expect(r.display('b', 20)).toBe(66);
  });

  it('steps a bar down only when THAT side takes its damage hit', () => {
    const r = new ResolutionHp();
    r.begin(70, 66);
    r.hit('b', 20);                     // b was struck first this turn
    expect(r.display('b', 20)).toBe(20);   // b dropped
    expect(r.display('a', 40)).toBe(70);   // a not hit yet → still pre-turn, NOT the settled 40
    r.hit('a', 40);                     // now a is struck (the counterattack)
    expect(r.display('a', 40)).toBe(40);
  });

  it('after end(), the authoritative snapshot drives the bars again (e.g. rematch back to full)', () => {
    const r = new ResolutionHp();
    r.begin(70, 66); r.hit('b', 20); r.end();
    expect(r.display('a', 70)).toBe(70);
    expect(r.display('b', 66)).toBe(66);   // full HP on rematch, no stale override
  });
});
