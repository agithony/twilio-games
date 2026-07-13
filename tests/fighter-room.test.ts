import { describe, expect, it } from 'vitest';
import { FIGHTER_LOADING_TIMEOUT_SECONDS, FIGHTER_VICTORY_SECONDS, FighterRoom } from '../server/fighter-room';
import { FIGHTER_INTRO_SECONDS } from '../shared/fighter-protocol';

describe('fighter room', () => {
  it('runs lobby through selection into a solo AI fight', () => {
    const room = new FighterRoom('4821', 1);
    const joined = room.addPlayer('Ada'); if ('error' in joined) throw new Error(joined.error);
    expect(room.advance()).toBe(true);
    expect(room.selectFighter(joined.playerId, 'nyx')).toBe(true);
    expect(room.advance()).toBe(true);
    expect(room.selectMap('void')).toBe(true);
    expect(room.advance()).toBe(true);
    expect(room.phase).toBe('loading');
    expect(room.ready()).toBe(true);
    expect(room.phase).toBe('intro');
    expect(room.command(joined.playerId, 'punch')).toEqual([]);
    expect(room.state().intro).toBe(FIGHTER_INTRO_SECONDS);
    room.tick(FIGHTER_INTRO_SECONDS + 0.1);
    expect(room.phase).toBe('countdown');
    expect(room.state().countdown).toBe(6);
    room.tick(6.1);
    expect(room.phase).toBe('fight');
    expect(room.lobbyPlayers()).toHaveLength(2);
    expect(room.lobbyPlayers()[1]?.isAi).toBe(true);
  });
  it('binds each human to only their own side', () => {
    const room = new FighterRoom('4821', 1);
    const a = room.addPlayer('A'), b = room.addPlayer('B');
    if ('error' in a || 'error' in b) throw new Error('join failed');
    room.advance(); room.selectFighter(a.playerId, 'nyx'); room.selectFighter(b.playerId, 'wraith'); room.advance(); room.selectMap('foundry'); room.advance(); room.ready(); room.tick(FIGHTER_INTRO_SECONDS + 0.1); room.tick(6.1);
    expect(room.command(b.playerId, 'jump')[0]).toEqual({ type: 'action', fighter: 'p2', command: 'jump' });
    expect(room.command('unknown', 'punch')).toEqual([]);
  });
  it('gates advancement on valid selections', () => {
    const room = new FighterRoom('4821'); const joined = room.addPlayer('A'); if ('error' in joined) throw new Error('join failed');
    room.advance(); expect(room.advance()).toBe(false); expect(room.selectFighter(joined.playerId, 'missing')).toBe(false);
  });

  it('rejects late joins after character selection', () => {
    const room = new FighterRoom('4821'); const joined = room.addPlayer('A'); if ('error' in joined) throw new Error('join failed');
    room.advance(); room.selectFighter(joined.playerId, 'nyx'); room.advance();
    expect(room.addPlayer('Late')).toEqual({ error: 'room_full' });
  });

  it('chooses a random solo rival that is never the player fighter', () => {
    const rivals = new Set<string>();
    for (let index = 1; index <= 12; index++) {
      const seed = (index * 0x1f123bb5) >>> 0;
      const room = new FighterRoom(`AI${seed}`, seed); const joined = room.addPlayer('A'); if ('error' in joined) throw new Error('join failed');
      room.advance(); room.selectFighter(joined.playerId, 'nyx'); room.advance(); room.selectMap('foundry'); room.advance();
      const rival = room.lobbyPlayers().find(player => player.isAi)?.fighterId;
      expect(rival).not.toBe('nyx'); if (rival) rivals.add(rival);
    }
    expect(rivals.size).toBeGreaterThan(1);
  });

  it('keeps an assigned side stable when the other player leaves', () => {
    const room = new FighterRoom('4821'); const a = room.addPlayer('A'), b = room.addPlayer('B');
    if ('error' in a || 'error' in b) throw new Error('join failed');
    room.removePlayer(a.playerId);
    expect(room.lobbyPlayers()).toMatchObject([{ playerId: b.playerId, side: 'p2' }]);
    const c = room.addPlayer('C'); if ('error' in c) throw new Error('join failed');
    expect(room.lobbyPlayers()).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: b.playerId, side: 'p2' }),
      expect.objectContaining({ playerId: c.playerId, side: 'p1' }),
    ]));
  });

  it('rejects stale loading generations and falls back to map selection', () => {
    const room = new FighterRoom('4821'); const player = room.addPlayer('A'); if ('error' in player) throw new Error('join failed');
    room.advance(); room.selectFighter(player.playerId, 'nyx'); room.advance(); room.selectMap('void'); room.advance();
    const generation = room.state().loadingGeneration;
    expect(room.ready(generation + 1)).toBe(false);
    room.tick(FIGHTER_LOADING_TIMEOUT_SECONDS);
    expect(room.phase).toBe('map_select');
    expect(room.state().world).toBeNull();
  });

  it('lets the display cancel loading back to map selection', () => {
    const room = new FighterRoom('4821'); const player = room.addPlayer('A'); if ('error' in player) throw new Error('join failed');
    room.advance(); room.selectFighter(player.playerId, 'nyx'); room.advance(); room.selectMap('void'); room.advance();
    expect(room.back()).toBe(true);
    expect(room.phase).toBe('map_select');
    expect(room.state().world).toBeNull();
  });

  it('keeps rematch locked until the authoritative victory presentation finishes', () => {
    const room = new FighterRoom('4821'); const player = room.addPlayer('A'); if ('error' in player) throw new Error('join failed');
    room.advance(); room.selectFighter(player.playerId, 'nyx'); room.advance(); room.selectMap('void'); room.advance();
    room.ready(room.state().loadingGeneration); room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    const world = room.state().world!; world.p1.x = 0; world.p2.x = 1; world.p2.health = 10;
    room.command(player.playerId, 'kick'); room.tick(0.6);
    expect(room.phase).toBe('victory');
    expect(room.advance()).toBe(false);
    room.tick(FIGHTER_VICTORY_SECONDS);
    expect(room.phase).toBe('results');
    expect(room.advance()).toBe(true);
    expect(room.phase).toBe('fighter_select');
  });
});
