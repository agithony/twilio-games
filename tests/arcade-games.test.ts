import { describe, expect, it } from 'vitest';
import {
  ARCADE_GAME_DEFINITIONS,
  PLAYABLE_ARCADE_GAMES,
  arcadeGameDefinition,
  isPlayableArcadeGame,
} from '../shared/arcade-games';

describe('Arcade game registry', () => {
  it('defines the approved playable capacities from one source', () => {
    expect(PLAYABLE_ARCADE_GAMES.map(game => [game.id, game.humanCapacity])).toEqual([
      ['racer', 2], ['monsters', 2], ['fighter', 2], ['karaoke', 1],
    ]);
    expect(arcadeGameDefinition('racer').route).toBe('/play.html');
    expect(arcadeGameDefinition('karaoke')).toMatchObject({
      route: '/karaoke.html', humanCapacity: 1, minimumHumans: 1, aiFallback: false, playable: true,
    });
  });

  it('keeps Trivia visible as future work but not station-selectable', () => {
    expect(ARCADE_GAME_DEFINITIONS.trivia).toMatchObject({ playable: false, route: null });
    expect(isPlayableArcadeGame('trivia')).toBe(false);
    expect(isPlayableArcadeGame('racer')).toBe(true);
    expect(isPlayableArcadeGame('karaoke')).toBe(true);
    expect(isPlayableArcadeGame('__proto__')).toBe(false);
  });
});
