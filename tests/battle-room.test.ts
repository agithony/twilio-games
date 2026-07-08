// The server-side game room for Voice Monsters: lobby → monster_select → battle → results. Wraps the
// pure BattleWorld and manages joining, per-player monster picks, single-player (1 human vs AI) vs
// 2-player (human vs human), and AI move responses. Mirrors Room's public shape so the GameServer
// wiring is familiar. Kept free of ws/http so it's unit-testable.
import { describe, it, expect } from 'vitest';
import { BattleRoom } from '../server/battle-room';
import { ROSTER } from '../shared/monster-roster';

function room() { return new BattleRoom('4821', 42); }
const M0 = ROSTER[0]!.id, M1 = ROSTER[1]!.id;

describe('BattleRoom', () => {
  it('starts in lobby and accepts up to 2 human players', () => {
    const r = room();
    expect(r.phase).toBe('lobby');
    const a = r.addPlayer('Ada'); const b = r.addPlayer('Bo');
    expect('playerId' in a && 'playerId' in b).toBe(true);
    const c = r.addPlayer('Cy');   // 3rd human rejected — battles are 1v1
    expect('error' in c).toBe(true);
    expect(r.playerCount).toBe(2);
  });

  it('advances lobby → monster_select and records each pick', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance();
    expect(r.phase).toBe('monster_select');
    r.selectMonster(a.playerId, M0);
    expect(r.lobbyPlayers().find(p => p.playerId === a.playerId)!.monsterId).toBe(M0);
  });

  it('rejects an unknown monster id', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, 'not-a-monster');
    expect(r.lobbyPlayers()[0]!.monsterId).toBeNull();
  });

  it('SINGLE-PLAYER: 1 human who picked → start battles an AI opponent (with its own monster)', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance();                 // → monster_select
    r.selectMonster(a.playerId, M0);
    r.advance();                 // → battle (AI fills the 2nd slot)
    expect(r.phase).toBe('battle');
    const s = r.snapshot()!;
    expect(s.a.monsterId).toBe(M0);
    expect(s.b.monsterId).toBeTruthy();          // AI got a monster
    expect(s.b.id).not.toBe(a.playerId);         // opponent isn't the human
  });

  it('rejects late joins during an active battle instead of corrupting the current matchup', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, M0);
    r.advance();

    const late = r.addPlayer('Late');

    expect('error' in late).toBe(true);
    expect(r.playerCount).toBe(1);
    expect(r.phase).toBe('battle');
  });

  it('does not reset a full results room when a late player tries to join', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    const b = r.addPlayer('Bo') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, 'embertail'); r.selectMonster(b.playerId, 'thornling');
    r.advance();
    for (let i = 0; i < 100 && r.phase === 'battle'; i++) {
      const s = r.snapshot()!;
      const active = r.activeSide();
      if (active === 'a') r.chooseMove(a.playerId, s.a.moves[1]!.id);
      else if (active === 'b') r.chooseMove(b.playerId, s.b.moves[0]!.id);
    }
    expect(r.phase).toBe('results');

    const late = r.addPlayer('Late');

    expect('error' in late).toBe(true);
    expect(r.phase).toBe('results');
    expect(r.playerCount).toBe(2);
  });

  it('SINGLE-PLAYER: human action resolves immediately → AI is pending for the next beat', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(a.playerId, M0); r.advance();
    const before = r.snapshot()!;
    r.chooseMove(a.playerId, before.a.moves[0]!.id);   // human's action resolves now…
    expect(r.snapshot()!.turn).toBe(before.turn + 1);
    expect(r.snapshot()!.chosen.a).toBe(false);
    expect(r.activeSide()).toBe('b');                   // …then the AI gets a separate beat.
    expect(r.aiPending()).toBe(true);
    r.resolveAiTurn();                                 // server calls this ~700ms later
    const after = r.snapshot()!;
    expect(after.turn).toBe(before.turn + 2);
    expect(after.b.hp).toBeLessThanOrEqual(before.b.hp);
    expect(r.activeSide()).toBe('a');
    expect(r.aiPending()).toBe(false);
  });

  it('TWO-PLAYER: each active human action resolves before the next player is prompted', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    const b = r.addPlayer('Bo') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, M0); r.selectMonster(b.playerId, M1);
    r.advance();
    expect(r.phase).toBe('battle');
    const before = r.snapshot()!;
    r.chooseMove(a.playerId, before.a.moves[0]!.id);
    expect(r.snapshot()!.turn).toBe(before.turn + 1);  // Ada's attack happened
    expect(r.activeSide()).toBe('b');                  // now Bo's turn
    r.chooseMove(b.playerId, before.b.moves[0]!.id);
    expect(r.snapshot()!.turn).toBe(before.turn + 2);  // Bo's attack happened
    expect(r.activeSide()).toBe('a');                  // back to Ada
  });

  it('TWO-PLAYER: exposes one active chooser at a time and rejects out-of-turn commits', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    const b = r.addPlayer('Bo') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, M0); r.selectMonster(b.playerId, M1);
    r.advance();
    const before = r.snapshot()!;

    expect(r.activeSide()).toBe('a');
    r.chooseMove(b.playerId, before.b.moves[0]!.id);   // Bo tries early — ignored
    expect(r.snapshot()!.chosen.b).toBe(false);
    expect(r.snapshot()!.turn).toBe(before.turn);

    r.chooseMove(a.playerId, before.a.moves[0]!.id);
    expect(r.activeSide()).toBe('b');
    expect(r.snapshot()!.chosen.a).toBe(false);
    expect(r.snapshot()!.turn).toBe(before.turn + 1);

    r.chooseMove(b.playerId, before.b.moves[0]!.id);
    expect(r.snapshot()!.turn).toBe(before.turn + 2);
    expect(r.activeSide()).toBe('a');
  });

  it('server-synced fight menu only opens for the active side', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    const b = r.addPlayer('Bo') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, M0); r.selectMonster(b.playerId, M1);
    r.advance();

    r.openFightMenu(b.playerId);
    expect(r.activeMenu()).toBe('root');
    r.openFightMenu(a.playerId);
    expect(r.activeMenu()).toBe('fight');
    r.backMenu(a.playerId);
    expect(r.activeMenu()).toBe('root');
  });

  it('interrupts a 2P battle if an active participant leaves so the remaining player is not stuck', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    const b = r.addPlayer('Bo') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, M0); r.selectMonster(b.playerId, M1);
    r.advance();
    expect(r.phase).toBe('battle');

    r.removePlayer(a.playerId);

    expect(r.phase).toBe('monster_select');
    expect(r.playerCount).toBe(1);
    expect(r.snapshot()).toBeNull();
    expect(r.lobbyPlayers()[0]!.monsterId).toBeNull();
  });

  it('reaches results with a winner when a monster faints', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(a.playerId, 'embertail'); r.advance();
    for (let i = 0; i < 100 && r.phase === 'battle'; i++) {
      const s = r.snapshot()!;
      r.chooseMove(a.playerId, s.a.moves[1]!.id);   // strong move
      if (r.aiPending()) r.resolveAiTurn();          // the AI's beat (server would defer this)
    }
    expect(r.phase).toBe('results');
    expect(r.result()!.winnerName.length).toBeGreaterThan(0);
  });

  it('drains ordered battle events for the renderer/commentator', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(a.playerId, M0); r.advance();
    r.chooseMove(a.playerId, r.snapshot()!.a.moves[0]!.id);
    r.resolveAiTurn();                         // the turn resolves once the AI takes its beat
    const evs = r.drainEvents();
    expect(evs.some(e => e.kind === 'move_used')).toBe(true);
    expect(r.drainEvents()).toHaveLength(0);   // drained once
  });

  it('removing the only player empties the room', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    expect(r.isEmpty).toBe(false);
    r.removePlayer(a.playerId);
    expect(r.isEmpty).toBe(true);
  });
});
