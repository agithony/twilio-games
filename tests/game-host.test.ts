import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, hostTurn, fuzzyMatch, HOST_TOOLS, type HostContext } from '../server/game-host';
import type { LlmClient, LlmReply } from '../server/llm';

function ctx(over: Partial<HostContext> = {}): HostContext {
  return {
    phase: 'car_select', cars: ['Batmobile', 'McLaren Senna', 'Lotus Elise'],
    maps: ['Silver Lake', 'Desert Dash'], selectedMap: null, myCar: null, myPlace: null, racerCount: 2,
    selectCarByName: () => 'ok-car', selectMapByName: () => 'ok-map', startRace: () => 'ok-start',
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
  it('exposes the three action tools', () => {
    expect(HOST_TOOLS.map(t => t.name).sort()).toEqual(['select_car', 'select_map', 'start_race']);
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
  it('executes a select_car tool call + appends the confirmation', async () => {
    let picked = '';
    const c = ctx({ selectCarByName: (n) => { picked = n; return 'Locked in — the McLaren Senna!'; } });
    const out = await hostTurn(fakeLlm({ say: 'Great taste!', toolCalls: [{ name: 'select_car', args: { name: 'mclaren' } }] }), c, []);
    expect(picked).toBe('mclaren');
    expect(out).toContain('Great taste!');
    expect(out).toContain('Locked in');
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
});
