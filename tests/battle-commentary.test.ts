// The battle COMMENTATOR's scripted line bank — pure text spoken/shown for each battle event. Varied
// + informative (explains type matchups, crits, guard/taunt) without rambling. This is the scripted
// fallback the voice layer speaks when the LLM host is off; the LLM path gets its own prompt.
import { describe, it, expect } from 'vitest';
import { commentaryForBattleEvent, battleIntro, type CommentaryCtx } from '../shared/battle-commentary';
import type { BattleEvent } from '../shared/battle-world';

const ctx = (over: Partial<CommentaryCtx> = {}): CommentaryCtx => ({
  aName: 'Sparkmouse', bName: 'Galecoil', ...over,
});

describe('battleIntro', () => {
  it('names both fighters dramatically', () => {
    const line = battleIntro('Sparkmouse', 'Galecoil', 0);
    expect(line).toContain('Sparkmouse');
    expect(line).toContain('Galecoil');
  });
  it('varies by seq', () => {
    expect(new Set([0, 1, 2, 3].map(i => battleIntro('A', 'B', i))).size).toBeGreaterThan(1);
  });
});

describe('commentaryForBattleEvent', () => {
  it('a move names the attacker + move', () => {
    const ev: BattleEvent = { kind: 'move_used', by: 'a', moveId: 'sparkmouse.jolt', moveName: 'Thunder Jolt' };
    const line = commentaryForBattleEvent(ev, ctx(), 0)!;
    expect(line).toContain('Sparkmouse');
    expect(line).toContain('Thunder Jolt');
  });

  it('super-effective is called out with WHY (it explains the matchup)', () => {
    const ev: BattleEvent = { kind: 'effectiveness', on: 'b', multiplier: 2, label: "It's super effective!" };
    const line = commentaryForBattleEvent(ev, ctx(), 0)!;
    expect(line.toLowerCase()).toMatch(/super|effective|weak|strong/);
  });

  it('resisted (0.5x) reads as shrugged-off, not a win', () => {
    const ev: BattleEvent = { kind: 'effectiveness', on: 'b', multiplier: 0.5, label: "It's not very effective…" };
    const line = commentaryForBattleEvent(ev, ctx(), 0)!;
    expect(line.toLowerCase()).toMatch(/resist|shrug|barely|not much|little/);
  });

  it('a crit hit gets a big, distinct callout', () => {
    const ev: BattleEvent = { kind: 'damage', on: 'b', amount: 30, hpLeft: 40, crit: true };
    const line = commentaryForBattleEvent(ev, ctx(), 0)!;
    expect(line.toLowerCase()).toContain('critical');
  });

  it('a normal (non-crit) damage event is quiet (null) — no spammy per-hit chatter', () => {
    const ev: BattleEvent = { kind: 'damage', on: 'b', amount: 12, hpLeft: 60, crit: false };
    expect(commentaryForBattleEvent(ev, ctx(), 0)).toBeNull();
  });

  it('a miss is called out by attacker', () => {
    const ev: BattleEvent = { kind: 'miss', by: 'a', moveName: 'Thunder Jolt' };
    const line = commentaryForBattleEvent(ev, ctx(), 0)!;
    expect(line.toLowerCase()).toMatch(/miss|whiff|dodge/);
  });

  it('guard / item / taunt each get an informative line', () => {
    expect(commentaryForBattleEvent({ kind: 'guard', by: 'a', monsterName: 'Sparkmouse' }, ctx(), 0)!.toLowerCase()).toMatch(/brace|guard|defen/);
    expect(commentaryForBattleEvent({ kind: 'item', by: 'a', item: 'potion', itemName: 'Potion' }, ctx(), 0)!.toLowerCase()).toMatch(/potion|heal|restore/);
    expect(commentaryForBattleEvent({ kind: 'taunt', by: 'a', monsterName: 'Sparkmouse', targetName: 'Galecoil' }, ctx(), 0)!.toLowerCase()).toMatch(/taunt|rattle|mind|aim|shaken/);
  });

  it('a faint + battle over are dramatic and name the winner', () => {
    expect(commentaryForBattleEvent({ kind: 'faint', side: 'b', monsterName: 'Galecoil' }, ctx(), 0)!).toContain('Galecoil');
    const over = commentaryForBattleEvent({ kind: 'battle_over', winner: 'a', winnerName: 'Ada' }, ctx(), 0)!;
    expect(over).toContain('Ada');
  });

  it('varies its phrasing by seq (not the same line every time)', () => {
    const ev: BattleEvent = { kind: 'move_used', by: 'a', moveId: 'x', moveName: 'Ember' };
    const a = commentaryForBattleEvent(ev, ctx(), 0);
    const b = commentaryForBattleEvent(ev, ctx(), 1);
    const c = commentaryForBattleEvent(ev, ctx(), 2);
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);   // at least two distinct phrasings
  });

  it('turn_start is quiet (the banner shows it; no need to speak every turn)', () => {
    expect(commentaryForBattleEvent({ kind: 'turn_start', turn: 3 }, ctx(), 0)).toBeNull();
  });
});
