import { describe, it, expect } from 'vitest';
import { Lobby } from '../shared/lobby';

const opts = () => ({ carCount: 19, maps: ['Silver Lake', 'Neon City'] });

describe('Lobby — join + roster', () => {
  it('starts in the lobby phase with no players', () => {
    const l = new Lobby(opts());
    expect(l.phase).toBe('lobby');
    expect(l.players()).toEqual([]);
  });

  it('adds players with name/color and no car chosen yet', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00');
    const [p] = l.players();
    expect(p).toMatchObject({ id: 'p1', name: 'Ada', color: '#f00', carIndex: null, ready: false });
  });

  it('removes a player', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.addPlayer('p2', 'Rex', '#0f0');
    l.removePlayer('p1');
    expect(l.players().map(p => p.id)).toEqual(['p2']);
  });
});

describe('Lobby — phase advance', () => {
  it('advances lobby → car_select → map_select → ready-to-start', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00');
    expect(l.phase).toBe('lobby');
    l.advance(); expect(l.phase).toBe('car_select');
    l.selectCar('p1', 3);
    l.advance(); expect(l.phase).toBe('map_select');
    l.selectMap('Neon City');
    expect(l.canStart()).toBe(true);
  });

  it('does not advance out of lobby with zero players', () => {
    const l = new Lobby(opts());
    l.advance();
    expect(l.phase).toBe('lobby');
  });

  it('does not advance car_select → map_select until at least ONE player has picked', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.addPlayer('p2', 'Rex', '#0f0');
    l.advance();                       // car_select
    expect(l.anyPicked()).toBe(false);
    l.advance();                       // blocked — nobody has picked
    expect(l.phase).toBe('car_select');
    l.selectCar('p1', 1);              // one pick is enough (idle players fall back)
    expect(l.anyPicked()).toBe(true);
    l.advance();
    expect(l.phase).toBe('map_select');
  });
});

describe('Lobby — car selection', () => {
  it('selecting a car sets carIndex and locks the player ready', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00');
    l.advance();
    l.selectCar('p1', 7);
    expect(l.players()[0]).toMatchObject({ carIndex: 7, ready: true });
  });

  it('a player can change their car (re-select) and stays ready', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.advance();
    l.selectCar('p1', 2); l.selectCar('p1', 5);
    expect(l.players()[0]).toMatchObject({ carIndex: 5, ready: true });
  });

  it('ignores out-of-range car indices', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.advance();
    l.selectCar('p1', 99);
    l.selectCar('p1', -1);
    expect(l.players()[0]!.carIndex).toBe(null);
  });

  it('allows two players to pick the SAME car (duplicates ok, Smash-style)', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.addPlayer('p2', 'Rex', '#0f0'); l.advance();
    l.selectCar('p1', 4); l.selectCar('p2', 4);
    expect(l.players().map(p => p.carIndex)).toEqual([4, 4]);
  });

  it('only accepts car selection during car_select', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00');
    l.selectCar('p1', 3);              // still in lobby — ignored
    expect(l.players()[0]!.carIndex).toBe(null);
  });
});

describe('Lobby — map selection', () => {
  it('accepts a valid map only during map_select', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.advance(); l.selectCar('p1', 0); l.advance();
    l.selectMap('nope');               // invalid
    expect(l.selectedMap).toBe(null);
    l.selectMap('Silver Lake');
    expect(l.selectedMap).toBe('Silver Lake');
  });

  it('cannot start until a map is selected', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.advance(); l.selectCar('p1', 0); l.advance();
    expect(l.canStart()).toBe(false);
    l.selectMap('Silver Lake');
    expect(l.canStart()).toBe(true);
  });
});

describe('Lobby — race init + reset', () => {
  it('produces PlayerInit list carrying the chosen carIndex (defaulting unpicked to join order)', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.addPlayer('p2', 'Rex', '#0f0'); l.advance();
    l.selectCar('p1', 8);              // p2 never picks
    const inits = l.toRaceInits();
    expect(inits[0]).toMatchObject({ id: 'p1', name: 'Ada', color: '#f00', carIndex: 8 });
    expect(inits[1]).toMatchObject({ id: 'p2', carIndex: 1 });   // fallback = join index % carCount
  });

  it('reset returns to the lobby phase but keeps players (clears car/ready/map)', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.advance(); l.selectCar('p1', 8); l.advance(); l.selectMap('Neon City');
    l.reset();
    expect(l.phase).toBe('lobby');
    expect(l.players()[0]).toMatchObject({ carIndex: null, ready: false });
    expect(l.selectedMap).toBe(null);
  });

  it('back() steps the phase backward (map_select → car_select → lobby)', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.advance(); l.selectCar('p1', 0); l.advance();
    expect(l.phase).toBe('map_select');
    l.back(); expect(l.phase).toBe('car_select');
    l.back(); expect(l.phase).toBe('lobby');
    l.back(); expect(l.phase).toBe('lobby');   // clamps
  });

  it('back() out of map_select clears the selected map (no stale-map premature start)', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.advance(); l.selectCar('p1', 0); l.advance();
    l.selectMap('Silver Lake');
    expect(l.selectedMap).toBe('Silver Lake');
    l.back();                                  // → car_select
    expect(l.selectedMap).toBe(null);          // map de-armed
    l.advance();                               // → map_select again
    expect(l.canStart()).toBe(false);          // must re-pick a map
  });
});

describe('Lobby — late join + idle robustness', () => {
  it('a player who joins during map_select can still pick a car (no permanent wedge)', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.advance(); l.selectCar('p1', 1); l.advance();
    expect(l.phase).toBe('map_select');
    l.addPlayer('p2', 'Late', '#0f0');         // joins late, carIndex null → would block canStart
    expect(l.allPicked()).toBe(false);
    l.selectCar('p2', 2);                      // must be accepted in map_select
    expect(l.allPicked()).toBe(true);
    l.selectMap('Silver Lake');
    expect(l.canStart()).toBe(true);
  });

  it('advance() out of car_select progresses once at least one player has picked (idle players fall back)', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.addPlayer('p2', 'Idle', '#0f0');
    l.advance();                               // car_select
    l.selectCar('p1', 3);                      // p2 never picks (AFK)
    l.advance();                               // should NOT wedge — at least one picked
    expect(l.phase).toBe('map_select');
    const inits = l.toRaceInits();
    expect(inits.find(i => i.id === 'p1')!.carIndex).toBe(3);
    expect(inits.find(i => i.id === 'p2')!.carIndex).toBe(1);   // join-index fallback
  });

  it('still does not advance car_select with ZERO picks', () => {
    const l = new Lobby(opts());
    l.addPlayer('p1', 'Ada', '#f00'); l.addPlayer('p2', 'Idle', '#0f0');
    l.advance();                               // car_select
    l.advance();                               // nobody picked → stay
    expect(l.phase).toBe('car_select');
  });
});
