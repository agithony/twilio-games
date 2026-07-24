import { PLAYABLE_ARCADE_GAMES, type PlayableArcadeGame } from '../shared/arcade-games';
import type { ArcadeStationAggregate, StationReadyEntry } from '../shared/arcade-station';
import { availableBalance } from '../shared/arcade-domain';
import type { ArcadeState } from './arcade-state-store';

const ALL_PLAYABLE_GAMES: ReadonlySet<PlayableArcadeGame> = new Set(
  PLAYABLE_ARCADE_GAMES.map(game => game.id),
);

export type PublicStationProjection = Readonly<{
  phase: ArcadeStationAggregate['station']['phase'];
  revision: number;
  activeGame: ArcadeStationAggregate['station']['activeGame'];
  deadline: string | null;
  currentReadyCount: number;
  nextReadyCount: number;
  roster: readonly Readonly<{ position: number; displayName: string; status: StationReadyEntry['status'] }>[];
  games: readonly Readonly<{
    id: 'racer' | 'monsters' | 'fighter';
    capacity: number;
    playNow: number;
    overflow: number;
    choices: number;
  }>[];
  launch: Readonly<{
    game: 'racer' | 'monsters' | 'fighter';
    route: string;
    roomCode: string;
    matchId: string;
    generation: number;
  }> | null;
  results: readonly Readonly<{
    displayName: string;
    rank: number | null;
    durationSeconds: number | null;
    won: boolean | null;
    completed: boolean;
    score: number | null;
  }>[];
  resultSource: 'ENGINE' | 'RECOVERY' | 'LEGACY_UNAVAILABLE' | null;
}>;

export type PlayerStationProjection = Readonly<{
  phase: PublicStationProjection['phase'];
  revision: number;
  deadline: string | null;
  ready: Readonly<{
    status: StationReadyEntry['status'];
    position: number | null;
    reservation: Readonly<{ amount: number; status: string }> | null;
    gameChoice: 'racer' | 'monsters' | 'fighter' | null;
  }> | null;
  availableBalance: number;
}>;

export type OperatorStationProjection = Readonly<{
  station: ArcadeStationAggregate['station'];
  round: Omit<ArcadeStationAggregate['rounds'][string], 'gameChoicesByReadyEntryId'> | null;
  match: ArcadeStationAggregate['matches'][string] | null;
  readyEntries: readonly Readonly<{
    id: string;
    roundId: string;
    displayName: string;
    originalReadyAt: string;
    status: StationReadyEntry['status'];
    overflowOrdinal: number | null;
    availableBalance: number;
    connected: boolean;
  }>[];
  recentControls: readonly ArcadeState['stationControlEvents'][number][];
}>;

export function emptyPublicStation(): PublicStationProjection {
  return {
    phase: 'ATTRACT',
    revision: 0,
    activeGame: null,
    deadline: null,
    currentReadyCount: 0,
    nextReadyCount: 0,
    roster: [],
    games: PLAYABLE_ARCADE_GAMES.map(game => ({
      id: game.id,
      capacity: game.humanCapacity,
      playNow: 0,
      overflow: 0,
      choices: 0,
    })),
    launch: null,
    results: [],
    resultSource: null,
  };
}

export function stationAggregateFromState(
  state: ArcadeState,
  stationId: string,
): ArcadeStationAggregate | null {
  const station = state.stations[stationId];
  if (!station) return null;
  return {
    station,
    rounds: Object.fromEntries(Object.entries(state.stationRounds).filter(([, round]) => round.stationId === stationId)),
    readyEntries: Object.fromEntries(
      Object.entries(state.stationReadyEntries).filter(([, entry]) => entry.stationId === stationId),
    ),
    matches: Object.fromEntries(Object.entries(state.stationMatches).filter(([, match]) => match.stationId === stationId)),
  };
}

export function projectPublicStation(
  state: ArcadeState,
  aggregate: ArcadeStationAggregate | null,
  includeLaunch = false,
  enabledGames: ReadonlySet<PlayableArcadeGame> = ALL_PLAYABLE_GAMES,
): PublicStationProjection {
  if (!aggregate) return emptyPublicStation();
  const current = readyForRound(aggregate, aggregate.station.activeRoundId);
  const next = readyForRound(aggregate, aggregate.station.nextRoundId);
  const match = aggregate.station.activeMatchId
    ? aggregate.matches[aggregate.station.activeMatchId] ?? null
    : null;
  const overflowNextCount = match
    ? match.overflowReadyEntryIds.filter(id => aggregate.readyEntries[id]?.status === 'OVERFLOW').length
    : 0;
  const overflowNext = match
    ? match.overflowReadyEntryIds.map(id => aggregate.readyEntries[id])
      .filter((entry): entry is StationReadyEntry => entry?.status === 'OVERFLOW')
    : [];
  const visibleRoster = aggregate.station.phase === 'RESULTS'
    ? [...next, ...overflowNext].sort(compareReady)
    : current;
  const launchDefinition = match
    ? PLAYABLE_ARCADE_GAMES.find(game => game.id === match.game)
    : undefined;
  const activeRound = aggregate.station.activeRoundId
    ? aggregate.rounds[aggregate.station.activeRoundId]
    : undefined;
  const liveReadyIds = new Set(current.filter(entry => entry.status === 'READY').map(entry => entry.id));
  return {
    phase: aggregate.station.phase,
    revision: aggregate.station.revision,
    activeGame: aggregate.station.activeGame,
    deadline: stationDeadline(aggregate),
    currentReadyCount: current.length,
    nextReadyCount: next.length + overflowNextCount,
    roster: visibleRoster.map((entry, index) => ({
      position: index + 1,
      displayName: displayName(state, entry.playerId, index),
      status: entry.status,
    })),
    games: PLAYABLE_ARCADE_GAMES.map(game => ({
      id: game.id,
      capacity: game.humanCapacity,
      playNow: Math.min(current.length, game.humanCapacity),
      overflow: Math.max(0, current.length - game.humanCapacity),
      choices: Object.entries(activeRound?.gameChoicesByReadyEntryId ?? {})
        .filter(([readyEntryId, choice]) => liveReadyIds.has(readyEntryId)
          && enabledGames.has(choice) && choice === game.id)
        .length,
    })),
    launch: includeLaunch && match && launchDefinition && ['LAUNCHING', 'PLAYING', 'RESULTS'].includes(aggregate.station.phase)
      ? {
        game: match.game,
        route: launchDefinition.route,
        roomCode: match.engineRoomCode,
        matchId: match.id,
        generation: match.launchGeneration,
      }
      : null,
    results: includeLaunch && aggregate.station.phase === 'RESULTS' && match?.result
      ? match.result.participants.map((participant, index) => {
        const entry = aggregate.readyEntries[participant.readyEntryId];
        return {
          displayName: entry ? displayName(state, entry.playerId, index) : `PLAYER ${index + 1}`,
          rank: participant.rank,
          durationSeconds: participant.durationSeconds,
          won: participant.won,
          completed: participant.completed,
          score: participant.score,
        };
      }).sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER))
      : [],
    resultSource: includeLaunch && aggregate.station.phase === 'RESULTS' ? match?.result?.source ?? null : null,
  };
}

export function projectDisplayStation(
  state: ArcadeState,
  aggregate: ArcadeStationAggregate | null,
  enabledGames: ReadonlySet<PlayableArcadeGame> = ALL_PLAYABLE_GAMES,
): PublicStationProjection {
  return projectPublicStation(state, aggregate, true, enabledGames);
}

export function projectPlayerStation(
  state: ArcadeState,
  aggregate: ArcadeStationAggregate | null,
  playerId: string,
  enabledGames: ReadonlySet<PlayableArcadeGame> = ALL_PLAYABLE_GAMES,
): PlayerStationProjection {
  const wallet = state.wallets[playerId];
  if (!wallet) throw new Error('player wallet is missing');
  if (!aggregate) {
    return {
      phase: 'ATTRACT', revision: 0, deadline: null, ready: null,
      availableBalance: availableBalance(wallet),
    };
  }
  const entry = Object.values(aggregate.readyEntries)
    .filter(candidate => candidate.playerId === playerId && !['COMPLETED', 'LEFT'].includes(candidate.status))
    .sort(compareReady)[0] ?? null;
  const reservation = entry
    ? wallet.reservations.find(candidate => candidate.id === entry.reservationId) ?? null
    : null;
  const peers = entry ? readyForRound(aggregate, entry.roundId) : [];
  const position = entry ? peers.findIndex(candidate => candidate.id === entry.id) : -1;
  const persistedChoice = entry?.status === 'READY'
    ? aggregate.rounds[entry.roundId]?.gameChoicesByReadyEntryId[entry.id] ?? null
    : null;
  return {
    phase: aggregate.station.phase,
    revision: aggregate.station.revision,
    deadline: stationDeadline(aggregate),
    ready: entry ? {
      status: entry.status,
      position: position >= 0 ? position + 1 : null,
      reservation: reservation ? { amount: reservation.amount, status: reservation.status } : null,
      gameChoice: persistedChoice && enabledGames.has(persistedChoice) ? persistedChoice : null,
    } : null,
    availableBalance: availableBalance(wallet),
  };
}

export function projectOperatorStation(
  state: ArcadeState,
  aggregate: ArcadeStationAggregate,
  connectedReadyEntryIds: ReadonlySet<string> = new Set(),
): OperatorStationProjection {
  const activeRound = aggregate.station.activeRoundId ? aggregate.rounds[aggregate.station.activeRoundId] : undefined;
  const round = activeRound ? withoutGameChoiceIdentities(activeRound) : null;
  const resetReadyEntryIds = new Set(Object.values(state.idempotencyRecords)
    .filter(record => record.operation === 'RESET_TEST_PLAYER')
    .map(record => (record.result as { resetReadyEntryId?: unknown } | null)?.resetReadyEntryId)
    .filter((id): id is string => typeof id === 'string'));
  const isResetHistory = (entry: StationReadyEntry): boolean => {
    const player = state.players[entry.playerId];
    return resetReadyEntryIds.has(entry.id) || Boolean(['COMPLETED', 'LEFT'].includes(entry.status)
      && entry.playerId.startsWith('reset-player:')
      && player && player.lead === null && player.preferredLocale === null
      && player.conversationProfileId === null && player.crmLeadId === null
      && player.trustedDestination === null && !player.marketingConsent);
  };
  return {
    station: aggregate.station,
    round,
    match: aggregate.station.activeMatchId ? aggregate.matches[aggregate.station.activeMatchId] ?? null : null,
    readyEntries: Object.values(aggregate.readyEntries).filter(entry => !isResetHistory(entry)).sort(compareReady).map((entry, index) => ({
      id: entry.id,
      roundId: entry.roundId,
      displayName: displayName(state, entry.playerId, index),
      originalReadyAt: entry.originalReadyAt,
      status: entry.status,
      overflowOrdinal: entry.overflowOrdinal,
      connected: connectedReadyEntryIds.has(entry.id),
      availableBalance: state.wallets[entry.playerId]
        ? availableBalance(state.wallets[entry.playerId]!)
        : 0,
    })),
    recentControls: state.stationControlEvents
      .filter(event => event.stationId === aggregate.station.id)
      .slice(-20)
      .reverse(),
  };
}

function withoutGameChoiceIdentities(
  round: ArcadeStationAggregate['rounds'][string],
): Omit<ArcadeStationAggregate['rounds'][string], 'gameChoicesByReadyEntryId'> {
  const { gameChoicesByReadyEntryId: _choices, ...safe } = round;
  return safe;
}

function readyForRound(aggregate: ArcadeStationAggregate, roundId: string | null): StationReadyEntry[] {
  if (!roundId) return [];
  return Object.values(aggregate.readyEntries)
    .filter(entry => entry.roundId === roundId && !['COMPLETED', 'LEFT'].includes(entry.status))
    .sort(compareReady);
}

function compareReady(left: StationReadyEntry, right: StationReadyEntry): number {
  return Date.parse(left.originalReadyAt) - Date.parse(right.originalReadyAt) || left.id.localeCompare(right.id);
}

function displayName(state: ArcadeState, playerId: string, index: number): string {
  const name = state.players[playerId]?.lead?.firstName.trim()
    || state.messagingDrafts[playerId]?.firstName?.trim();
  return name ? name.slice(0, 50) : `PLAYER ${index + 1}`;
}

function stationDeadline(aggregate: ArcadeStationAggregate): string | null {
  const round = aggregate.station.activeRoundId ? aggregate.rounds[aggregate.station.activeRoundId] : undefined;
  if (!round) return null;
  if (aggregate.station.phase === 'RECRUITING') {
    if (!round.recruitingEndsAt) return round.hardEndsAt;
    if (!round.hardEndsAt) return round.recruitingEndsAt;
    return Date.parse(round.recruitingEndsAt) <= Date.parse(round.hardEndsAt)
      ? round.recruitingEndsAt
      : round.hardEndsAt;
  }
  if (aggregate.station.phase === 'GAME_SELECTION') return round.selectionEndsAt;
  if (aggregate.station.phase === 'LOCKED') return round.lockedEndsAt;
  return null;
}
