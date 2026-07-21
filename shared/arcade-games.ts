import type { ArcadeGame } from './arcade-config';

export type PlayableArcadeGame = Exclude<ArcadeGame, 'trivia'>;

export type ArcadeGameDefinition = Readonly<{
  id: ArcadeGame;
  route: string | null;
  humanCapacity: number | null;
  minimumHumans: number | null;
  aiFallback: boolean;
  playable: boolean;
}>;

export const ARCADE_GAME_DEFINITIONS: Readonly<Record<ArcadeGame, ArcadeGameDefinition>> = Object.freeze({
  racer: Object.freeze({
    id: 'racer', route: '/play.html', humanCapacity: 4, minimumHumans: 1,
    aiFallback: true, playable: true,
  }),
  monsters: Object.freeze({
    id: 'monsters', route: '/monsters.html', humanCapacity: 2, minimumHumans: 1,
    aiFallback: true, playable: true,
  }),
  fighter: Object.freeze({
    id: 'fighter', route: '/fighter.html', humanCapacity: 2, minimumHumans: 1,
    aiFallback: true, playable: true,
  }),
  trivia: Object.freeze({
    id: 'trivia', route: null, humanCapacity: null, minimumHumans: null,
    aiFallback: false, playable: false,
  }),
});

export const PLAYABLE_ARCADE_GAMES = Object.freeze(
  Object.values(ARCADE_GAME_DEFINITIONS)
    .filter((game): game is ArcadeGameDefinition & { id: PlayableArcadeGame; route: string; humanCapacity: number; minimumHumans: number } => game.playable),
);

export function arcadeGameDefinition(game: ArcadeGame): ArcadeGameDefinition {
  return ARCADE_GAME_DEFINITIONS[game];
}

export function isPlayableArcadeGame(value: unknown): value is PlayableArcadeGame {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(ARCADE_GAME_DEFINITIONS, value)
    && ARCADE_GAME_DEFINITIONS[value as ArcadeGame].playable;
}
