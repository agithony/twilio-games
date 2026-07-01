import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, hostTurn, fuzzyMatch, matchChoice, HOST_TOOLS, type HostContext } from '../server/game-host';
import type { LlmClient, LlmReply } from '../server/llm';

function ctx(over: Partial<HostContext> = {}): HostContext {
  return {
    phase: 'car_select', cars: ['Batmobile', 'McLaren Senna', 'Lotus Elise'],
    maps: ['Silver Lake', 'Desert Dash'], selectedMap: null, myName: 'Ada', myCar: null, myPlace: null, racerCount: 2,
    setName: () => 'ok-name', selectCarByName: () => 'ok-car', selectMapByName: () => 'ok-map', startRace: () => 'ok-start',
    ...over,
  };
}
/** A fake LLM that returns a scripted reply (say + toolCalls). */
function fakeLlm(reply: LlmReply, enabled = true): LlmClient {
  return { enabled, respond: async () => reply };
}

describe('fuzzyMatch', () => {
  const cars = ['Batmobile', 'McLaren Senna', 'Lotus Elise'];
  it('matches exact + case-insensitive', () => {
    expect(fuzzyMatch('lotus elise', cars)).toBe(2);
  });
  it('matches a substring / partial name', () => {
    expect(fuzzyMatch('mclaren', cars)).toBe(1);
    expect(fuzzyMatch('bat', cars)).toBe(0);
  });
  it('matches by shared word', () => {
    expect(fuzzyMatch('the senna', cars)).toBe(1);
  });
  it('returns -1 for no match / empty', () => {
    expect(fuzzyMatch('ferrari', cars)).toBe(-1);
    expect(fuzzyMatch('', cars)).toBe(-1);
  });
});

describe('matchChoice (number OR name)', () => {
  const cars = ['Batmobile', 'McLaren Senna', 'Lotus Elise', 'Ford Bronco'];
  it('matches by digit number ("car 2" → index 1)', () => {
    expect(matchChoice('car 2', cars)).toBe(1);
    expect(matchChoice('number 4', cars)).toBe(3);
    expect(matchChoice('3', cars)).toBe(2);
  });
  it('matches by number WORD ("the third one", "two")', () => {
    expect(matchChoice('two', cars)).toBe(1);
    expect(matchChoice('give me car four', cars)).toBe(3);
  });
  it('still matches by name when no number is present', () => {
    expect(matchChoice('mclaren', cars)).toBe(1);
    expect(matchChoice('bronco', cars)).toBe(3);
  });
  it('out-of-range number falls through to name match / -1', () => {
    expect(matchChoice('car 99', cars)).toBe(-1);
  });
});

describe('buildSystemPrompt', () => {
  it('includes the phase + car list during car_select', () => {
    const p = buildSystemPrompt(ctx({ phase: 'car_select' }));
    expect(p).toContain('car_select');
    expect(p).toContain('McLaren Senna');
    expect(p.toLowerCase()).toContain('select_car');
  });
  it('mentions the tracks during map_select', () => {
    const p = buildSystemPrompt(ctx({ phase: 'map_select', maps: ['Silver Lake'] }));
    expect(p).toContain('Silver Lake');
  });
  it('tells it to keep quiet during a live race', () => {
    const p = buildSystemPrompt(ctx({ phase: 'racing' }));
    expect(p.toLowerCase()).toMatch(/driving|do not chat|live/);
  });
  it('exposes the action tools (set_name + select_car/map + start_race)', () => {
    expect(HOST_TOOLS.map(t => t.name).sort()).toEqual(['select_car', 'select_map', 'set_name', 'start_race']);
  });
});

describe('hostTurn', () => {
  it('returns null when the LLM is disabled (→ scripted fallback)', async () => {
    const out = await hostTurn(fakeLlm({ say: 'hi', toolCalls: [] }, false), ctx(), []);
    expect(out).toBeNull();
  });
  it('speaks the model reply when it just talks', async () => {
    const out = await hostTurn(fakeLlm({ say: 'The McLaren is fastest!', toolCalls: [] }), ctx(), []);
    expect(out).toBe('The McLaren is fastest!');
  });
  it('executes a select_car tool call; speaks the MODEL words only (no double car name)', async () => {
    let picked = '';
    const c = ctx({ selectCarByName: (n) => { picked = n; return 'Locked in — the McLaren Senna!'; } });
    const out = await hostTurn(fakeLlm({ say: 'Great taste — the McLaren it is!', toolCalls: [{ name: 'select_car', args: { name: 'mclaren' } }] }), c, []);
    expect(picked).toBe('mclaren');                 // the action still ran
    expect(out).toBe('Great taste — the McLaren it is!');   // ...but only the model's words are spoken
    expect(out).not.toContain('Locked in');         // no appended confirmation → no repetition
  });
  it('speaks the tool confirmation when the model gives NO words (bare tool call)', async () => {
    const c = ctx({ selectCarByName: () => 'Locked in — the McLaren Senna!' });
    const out = await hostTurn(fakeLlm({ say: '', toolCalls: [{ name: 'select_car', args: { name: 'mclaren' } }] }), c, []);
    expect(out).toBe('Locked in — the McLaren Senna!');
  });
  it('does NOT run select_car outside car_select', async () => {
    let called = false;
    const c = ctx({ phase: 'map_select', selectCarByName: () => { called = true; return 'x'; } });
    await hostTurn(fakeLlm({ say: '', toolCalls: [{ name: 'select_car', args: { name: 'x' } }] }), c, []);
    expect(called).toBe(false);
  });
  it('speaks only the confirmation when the model calls a tool with no words', async () => {
    const c = ctx({ startRace: () => "Here we go — let's race!" });
    const out = await hostTurn(fakeLlm({ say: '', toolCalls: [{ name: 'start_race', args: {} }] }), c, []);
    expect(out).toBe("Here we go — let's race!");
  });
  it('returns null when there is nothing to say and no action fired', async () => {
    const out = await hostTurn(fakeLlm({ say: '', toolCalls: [] }), ctx(), []);
    expect(out).toBeNull();
  });
  it('runs set_name in any phase (onboarding — captures the caller\'s name)', async () => {
    let named = '';
    const c = ctx({ phase: 'lobby', myName: null, setName: (n) => { named = n; return `Nice, ${n}!`; } });
    const out = await hostTurn(fakeLlm({ say: '', toolCalls: [{ name: 'set_name', args: { name: 'Ada' } }] }), c, []);
    expect(named).toBe('Ada');
    expect(out).toContain('Ada');
  });
  it('prompts for the name first when it is not set yet', () => {
    const p = buildSystemPrompt(ctx({ myName: null }));
    expect(p.toLowerCase()).toMatch(/name/);
    expect(p.toLowerCase()).toContain('set_name');
  });
});
