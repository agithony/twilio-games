import { describe, it, expect } from 'vitest';
import { parseBattleClientMessage } from '../shared/battle-protocol';

describe('parseBattleClientMessage', () => {
  it('parses join + spectate', () => {
    expect(parseBattleClientMessage(JSON.stringify({ type: 'join', roomCode: '4821', name: 'Ada' })))
      .toEqual({ type: 'join', roomCode: '4821', name: 'Ada' });
    expect(parseBattleClientMessage(JSON.stringify({ type: 'spectate', roomCode: '4821' })))
      .toEqual({ type: 'spectate', roomCode: '4821' });
  });

  it('parses the in-game actions', () => {
    expect(parseBattleClientMessage(JSON.stringify({ type: 'select_monster', monsterId: 'embertail' })))
      .toEqual({ type: 'select_monster', monsterId: 'embertail' });
    expect(parseBattleClientMessage(JSON.stringify({ type: 'open_fight' })).type).toBe('open_fight');
    expect(parseBattleClientMessage(JSON.stringify({ type: 'back_menu' })).type).toBe('back_menu');
    expect(parseBattleClientMessage(JSON.stringify({ type: 'choose_move', moveId: 'embertail.ember' })))
      .toEqual({ type: 'choose_move', moveId: 'embertail.ember' });
    expect(parseBattleClientMessage(JSON.stringify({ type: 'advance' })).type).toBe('advance');
    expect(parseBattleClientMessage(JSON.stringify({ type: 'leave' })).type).toBe('leave');
  });

  it('parses the four turn actions (choose_action)', () => {
    const fight = parseBattleClientMessage(JSON.stringify({ type: 'choose_action', action: { kind: 'fight', moveId: 'embertail.ember' } }));
    expect(fight).toEqual({ type: 'choose_action', action: { kind: 'fight', moveId: 'embertail.ember' } });
    expect(parseBattleClientMessage(JSON.stringify({ type: 'choose_action', action: { kind: 'guard' } })).type).toBe('choose_action');
    expect(parseBattleClientMessage(JSON.stringify({ type: 'choose_action', action: { kind: 'taunt' } })).type).toBe('choose_action');
    expect(parseBattleClientMessage(JSON.stringify({ type: 'choose_action', action: { kind: 'item', item: 'potion' } })).type).toBe('choose_action');
  });

  it('rejects malformed / unknown frames', () => {
    expect(parseBattleClientMessage('not json').type).toBe('error');
    expect(parseBattleClientMessage(JSON.stringify({ type: 'join', name: 'x' })).type).toBe('error'); // no room
    expect(parseBattleClientMessage(JSON.stringify({ type: 'choose_move' })).type).toBe('error');     // no move
    expect(parseBattleClientMessage(JSON.stringify({ type: 'choose_action', action: { kind: 'fight' } })).type).toBe('error'); // no moveId
    expect(parseBattleClientMessage(JSON.stringify({ type: 'choose_action', action: { kind: 'item', item: 'bomb' } })).type).toBe('error'); // bad item
    expect(parseBattleClientMessage(JSON.stringify({ type: 'choose_action', action: { kind: 'nope' } })).type).toBe('error'); // bad kind
    expect(parseBattleClientMessage(JSON.stringify({ type: 'wat' })).type).toBe('error');
  });
});
