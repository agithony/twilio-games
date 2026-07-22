import type { ArcadeGame } from './arcade-config';
import { arcadeGameDefinition, isPlayableArcadeGame, type PlayableArcadeGame } from './arcade-games';

export type StationTimestamp = string;
export type StationPhase = 'ATTRACT' | 'RECRUITING' | 'GAME_SELECTION' | 'LOCKED' | 'LAUNCHING' | 'PLAYING' | 'RESULTS';
export type RecruitingRoundPhase = Exclude<StationPhase, 'ATTRACT'> | 'CLOSED';
export type ReadyEntryStatus = 'READY' | 'ADMITTED' | 'OVERFLOW' | 'PLAYING' | 'COMPLETED' | 'LEFT';
export type StationMatchPhase = 'PREPARING' | 'LAUNCHING' | 'PLAYING' | 'COMPLETED' | 'FAILED';

export interface ArcadeStation {
  readonly id: string;
  readonly phase: StationPhase;
  readonly activeRoundId: string | null;
  readonly nextRoundId: string | null;
  readonly activeGame: PlayableArcadeGame | null;
  readonly activeMatchId: string | null;
  readonly revision: number;
  readonly updatedAt: StationTimestamp;
}

export interface RecruitingRound {
  readonly id: string;
  readonly stationId: string;
  readonly phase: RecruitingRoundPhase;
  readonly firstCoinAt: StationTimestamp;
  readonly recruitingEndsAt: StationTimestamp | null;
  readonly hardEndsAt: StationTimestamp | null;
  readonly selectionEndsAt: StationTimestamp | null;
  readonly selectionStartedAt: StationTimestamp | null;
  readonly lockedEndsAt: StationTimestamp | null;
  readonly lockedAt: StationTimestamp | null;
  readonly selectedGame: PlayableArcadeGame | null;
  readonly gameChoicesByReadyEntryId: Readonly<Record<string, PlayableArcadeGame>>;
  readonly startedAt: StationTimestamp | null;
  readonly resultsAt: StationTimestamp | null;
  readonly closedAt: StationTimestamp | null;
  readonly configVersion: number;
}

export interface StationReadyEntry {
  readonly id: string;
  readonly roundId: string;
  readonly stationId: string;
  readonly playerId: string;
  readonly originalReadyAt: StationTimestamp;
  readonly readyAt: StationTimestamp;
  readonly status: ReadyEntryStatus;
  readonly reservationId: string | null;
  readonly overflowOrdinal: number | null;
}

export interface StationMatch {
  readonly id: string;
  readonly stationId: string;
  readonly roundId: string;
  readonly game: PlayableArcadeGame;
  readonly phase: StationMatchPhase;
  readonly participantReadyEntryIds: readonly string[];
  readonly overflowReadyEntryIds: readonly string[];
  readonly engineRoomCode: string;
  readonly launchGeneration: number;
  readonly launchRequestedAt: StationTimestamp | null;
  readonly displayReadyAt: StationTimestamp | null;
  readonly startedAt: StationTimestamp | null;
  readonly completedAt: StationTimestamp | null;
  readonly enginePlayerIdsByReadyEntryId: Readonly<Record<string, string>>;
  readonly result: StationMatchResult | null;
  readonly configVersion: number;
}

export interface StationEngineParticipantResult {
  readonly enginePlayerId: string;
  readonly rank: number | null;
  readonly completed: boolean;
  readonly won: boolean | null;
  readonly score: number | null;
  readonly durationSeconds: number | null;
}

export interface StationMatchResult {
  readonly source: 'ENGINE' | 'RECOVERY' | 'LEGACY_UNAVAILABLE';
  readonly participants: readonly Readonly<StationEngineParticipantResult & { readyEntryId: string }>[];
}

export interface ArcadeStationAggregate {
  readonly station: ArcadeStation;
  readonly rounds: Readonly<Record<string, RecruitingRound>>;
  readonly readyEntries: Readonly<Record<string, StationReadyEntry>>;
  readonly matches: Readonly<Record<string, StationMatch>>;
}

export interface StationTimingPolicy {
  readonly recruitingSeconds: number;
  readonly hardDeadlineSeconds: number;
  readonly selectionSeconds: number;
  readonly lockedSeconds: number;
  readonly postGameRecruitingSeconds: number;
}

export const DEFAULT_STATION_TIMING: StationTimingPolicy = Object.freeze({
  recruitingSeconds: 90,
  hardDeadlineSeconds: 120,
  selectionSeconds: 30,
  lockedSeconds: 10,
  postGameRecruitingSeconds: 45,
});

const STATION_PHASES = new Set<StationPhase>(['ATTRACT', 'RECRUITING', 'GAME_SELECTION', 'LOCKED', 'LAUNCHING', 'PLAYING', 'RESULTS']);
const ROUND_PHASES = new Set<RecruitingRoundPhase>(['RECRUITING', 'GAME_SELECTION', 'LOCKED', 'LAUNCHING', 'PLAYING', 'RESULTS', 'CLOSED']);
const READY_STATUSES = new Set<ReadyEntryStatus>(['READY', 'ADMITTED', 'OVERFLOW', 'PLAYING', 'COMPLETED', 'LEFT']);
const MATCH_PHASES = new Set<StationMatchPhase>(['PREPARING', 'LAUNCHING', 'PLAYING', 'COMPLETED', 'FAILED']);

export class ArcadeStationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArcadeStationError';
  }
}

export function createArcadeStation(id: string, at: StationTimestamp): ArcadeStationAggregate {
  const stationId = identifier(id, 'station ID');
  timestamp(at, 'station timestamp');
  return freezeAggregate({
    station: {
      id: stationId,
      phase: 'ATTRACT',
      activeRoundId: null,
      nextRoundId: null,
      activeGame: null,
      activeMatchId: null,
      revision: 1,
      updatedAt: at,
    },
    rounds: {},
    readyEntries: {},
    matches: {},
  });
}

export function insertStationCoin(
  state: ArcadeStationAggregate,
  input: {
    readyEntryId: string;
    roundId: string;
    playerId: string;
    reservationId: string | null;
    at: StationTimestamp;
    configVersion: number;
    expectedRevision: number;
  },
  timing: StationTimingPolicy = DEFAULT_STATION_TIMING,
): ArcadeStationAggregate {
  assertStationInvariants(state);
  validateTiming(timing);
  const readyEntryId = identifier(input.readyEntryId, 'ready entry ID');
  const requestedRoundId = identifier(input.roundId, 'round ID');
  const playerId = identifier(input.playerId, 'player ID');
  const reservationId = input.reservationId === null ? null : identifier(input.reservationId, 'reservation ID');
  const atMs = timestamp(input.at, 'coin timestamp');
  positiveInteger(input.configVersion, 'config version');
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  if (state.readyEntries[readyEntryId]) throw new ArcadeStationError('DUPLICATE_READY_ENTRY', 'ready entry already exists');
  if (reservationId !== null && Object.values(state.readyEntries).some(entry => entry.reservationId === reservationId
    && !['COMPLETED', 'LEFT'].includes(entry.status))) {
    throw new ArcadeStationError('DUPLICATE_RESERVATION', 'reservation already belongs to a live ready entry');
  }
  if (Object.values(state.readyEntries).some(entry => entry.playerId === playerId
    && !['COMPLETED', 'LEFT'].includes(entry.status))) {
    throw new ArcadeStationError('PLAYER_ALREADY_READY', 'player already has an active ready entry');
  }

  const rounds = cloneRecord(state.rounds);
  let station = state.station;
  let targetRoundId: string;
  const activeRound = station.activeRoundId ? rounds[station.activeRoundId] : undefined;
  const currentDeadline = activeRound
    ? [activeRound.recruitingEndsAt, activeRound.hardEndsAt]
      .filter((value): value is string => value !== null)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null
    : null;
  const acceptsCurrent = station.phase === 'RECRUITING' && activeRound?.phase === 'RECRUITING'
    && (currentDeadline === null || atMs < timestamp(currentDeadline, 'recruiting deadline'));
  if (station.phase === 'ATTRACT' || acceptsCurrent) {
    targetRoundId = station.activeRoundId ?? requestedRoundId;
    if (!activeRound) {
      if (rounds[targetRoundId]) throw new ArcadeStationError('ROUND_ID_CONFLICT', 'round ID already exists');
      rounds[targetRoundId] = createRound(
        targetRoundId, station.id, input.at, input.configVersion,
        atMs, timing.recruitingSeconds, timing.hardDeadlineSeconds,
      );
      station = reviseStation(station, input.at, {
        phase: 'RECRUITING', activeRoundId: targetRoundId,
      });
    }
  } else {
    targetRoundId = station.nextRoundId ?? requestedRoundId;
    if (!rounds[targetRoundId]) {
      rounds[targetRoundId] = createRound(targetRoundId, station.id, input.at, input.configVersion);
      station = reviseStation(station, input.at, { nextRoundId: targetRoundId });
    } else if (!station.nextRoundId) {
      throw new ArcadeStationError('ROUND_ID_CONFLICT', 'next round ID already exists');
    }
  }

  const readyEntries = cloneRecord(state.readyEntries);
  readyEntries[readyEntryId] = Object.freeze({
    id: readyEntryId,
    roundId: targetRoundId,
    stationId: station.id,
    playerId,
    originalReadyAt: input.at,
    readyAt: input.at,
    status: 'READY',
    reservationId,
    overflowOrdinal: null,
  });
  if (station === state.station) station = reviseStation(station, input.at, {});
  return checked({ station, rounds, readyEntries, matches: state.matches });
}

export function closeStationRecruiting(
  state: ArcadeStationAggregate,
  input: { at: StationTimestamp; expectedRevision: number },
  timing: StationTimingPolicy = DEFAULT_STATION_TIMING,
): ArcadeStationAggregate {
  assertStationInvariants(state);
  validateTiming(timing);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  const atMs = timestamp(input.at, 'selection timestamp');
  if (state.station.phase !== 'RECRUITING' || !state.station.activeRoundId) {
    throw new ArcadeStationError('RECRUITING_NOT_ACTIVE', 'station is not recruiting');
  }
  const round = state.rounds[state.station.activeRoundId]!;
  if (!readyForRound(state, round.id).length) throw new ArcadeStationError('NO_READY_PLAYERS', 'round has no ready players');
  const rounds = cloneRecord(state.rounds);
  rounds[round.id] = Object.freeze({
    ...round,
    phase: 'GAME_SELECTION',
    selectionStartedAt: input.at,
    selectionEndsAt: new Date(atMs + timing.selectionSeconds * 1000).toISOString(),
  });
  return checked({
    ...state,
    station: reviseStation(state.station, input.at, { phase: 'GAME_SELECTION' }),
    rounds,
  });
}

export function recordStationGameChoice(
  state: ArcadeStationAggregate,
  input: {
    readyEntryId: string;
    roundId: string;
    game: ArcadeGame;
    at: StationTimestamp;
    expectedRevision: number;
  },
): ArcadeStationAggregate {
  assertStationInvariants(state);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  const readyEntryId = identifier(input.readyEntryId, 'ready entry ID');
  const roundId = identifier(input.roundId, 'round ID');
  if (!isPlayableArcadeGame(input.game)) {
    throw new ArcadeStationError('GAME_NOT_PLAYABLE', 'game is not station-playable');
  }
  if (state.station.phase !== 'GAME_SELECTION' || state.station.activeRoundId !== roundId) {
    throw new ArcadeStationError('SELECTION_NOT_ACTIVE', 'game selection is not active for this round');
  }
  const round = state.rounds[roundId];
  const entry = state.readyEntries[readyEntryId];
  if (!round || round.phase !== 'GAME_SELECTION') {
    throw new ArcadeStationError('SELECTION_NOT_ACTIVE', 'game selection is not active for this round');
  }
  if (!round.selectionEndsAt
    || timestamp(input.at, 'game choice timestamp') >= timestamp(round.selectionEndsAt, 'selection deadline')) {
    throw new ArcadeStationError('SELECTION_CLOSED', 'game selection deadline has passed');
  }
  if (!entry || entry.roundId !== roundId || entry.status !== 'READY') {
    throw new ArcadeStationError('READY_ENTRY_NOT_READY', 'ready entry cannot choose a game');
  }
  const rounds = cloneRecord(state.rounds);
  rounds[roundId] = Object.freeze({
    ...round,
    gameChoicesByReadyEntryId: Object.freeze({
      ...round.gameChoicesByReadyEntryId,
      [readyEntryId]: input.game,
    }),
  });
  return checked({
    ...state,
    station: reviseStation(state.station, input.at, {}),
    rounds,
  });
}

export function selectStationGame(
  state: ArcadeStationAggregate,
  input: {
    game: ArcadeGame;
    matchId: string;
    engineRoomCode: string;
    at: StationTimestamp;
    expectedRevision: number;
  },
  timing: StationTimingPolicy = DEFAULT_STATION_TIMING,
): ArcadeStationAggregate {
  assertStationInvariants(state);
  validateTiming(timing);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  if (!isPlayableArcadeGame(input.game)) throw new ArcadeStationError('GAME_NOT_PLAYABLE', 'game is not station-playable');
  if (state.station.phase !== 'GAME_SELECTION' || !state.station.activeRoundId) {
    throw new ArcadeStationError('SELECTION_NOT_ACTIVE', 'game selection is not active');
  }
  const definition = arcadeGameDefinition(input.game);
  const capacity = definition.humanCapacity!;
  const matchId = identifier(input.matchId, 'match ID');
  const engineRoomCode = identifier(input.engineRoomCode, 'engine room code');
  const atMs = timestamp(input.at, 'game selection timestamp');
  if (state.matches[matchId]) throw new ArcadeStationError('DUPLICATE_MATCH', 'match already exists');
  const round = state.rounds[state.station.activeRoundId]!;
  const candidates = readyForRound(state, round.id);
  if (!candidates.length) throw new ArcadeStationError('NO_READY_PLAYERS', 'round has no ready players');
  const admitted = candidates.slice(0, capacity);
  const overflow = candidates.slice(capacity);
  const readyEntries = cloneRecord(state.readyEntries);
  admitted.forEach(entry => { readyEntries[entry.id] = Object.freeze({ ...entry, status: 'ADMITTED', overflowOrdinal: null }); });
  overflow.forEach((entry, index) => {
    readyEntries[entry.id] = Object.freeze({ ...entry, status: 'OVERFLOW', overflowOrdinal: index + 1 });
  });
  const rounds = cloneRecord(state.rounds);
  rounds[round.id] = Object.freeze({
    ...round,
    phase: 'LOCKED',
    selectedGame: input.game,
    gameChoicesByReadyEntryId: Object.freeze({}),
    lockedAt: input.at,
    lockedEndsAt: new Date(atMs + timing.lockedSeconds * 1000).toISOString(),
  });
  const matches = cloneRecord(state.matches);
  matches[matchId] = Object.freeze({
    id: matchId,
    stationId: state.station.id,
    roundId: round.id,
    game: input.game,
    phase: 'PREPARING',
    participantReadyEntryIds: Object.freeze(admitted.map(entry => entry.id)),
    overflowReadyEntryIds: Object.freeze(overflow.map(entry => entry.id)),
    engineRoomCode,
    launchGeneration: 1,
    launchRequestedAt: null,
    displayReadyAt: null,
    startedAt: null,
    completedAt: null,
    enginePlayerIdsByReadyEntryId: Object.freeze({}),
    result: null,
    configVersion: round.configVersion,
  });
  return checked({
    station: reviseStation(state.station, input.at, {
      phase: 'LOCKED', activeGame: input.game, activeMatchId: matchId,
    }),
    rounds,
    readyEntries,
    matches,
  });
}

export function requestStationLaunch(
  state: ArcadeStationAggregate,
  input: { at: StationTimestamp; expectedRevision: number },
): ArcadeStationAggregate {
  assertStationInvariants(state);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  timestamp(input.at, 'launch timestamp');
  const { station } = state;
  if (station.phase !== 'LOCKED' || !station.activeMatchId || !station.activeRoundId) {
    throw new ArcadeStationError('MATCH_NOT_LOCKED', 'station match is not locked');
  }
  const match = state.matches[station.activeMatchId]!;
  const round = state.rounds[station.activeRoundId]!;
  return checked({
    ...state,
    station: reviseStation(station, input.at, { phase: 'LAUNCHING' }),
    rounds: { ...state.rounds, [round.id]: Object.freeze({ ...round, phase: 'LAUNCHING' }) },
    matches: {
      ...state.matches,
      [match.id]: Object.freeze({ ...match, phase: 'LAUNCHING', launchRequestedAt: input.at }),
    },
  });
}

export function markStationMatchStarted(
  state: ArcadeStationAggregate,
  input: {
    at: StationTimestamp;
    expectedRevision: number;
    redeemedReservationIds: readonly string[];
    enginePlayerIdsByReadyEntryId?: Readonly<Record<string, string>>;
  },
): ArcadeStationAggregate {
  assertStationInvariants(state);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  timestamp(input.at, 'match start timestamp');
  const { station } = state;
  if (station.phase !== 'LAUNCHING' || !station.activeMatchId || !station.activeRoundId) {
    throw new ArcadeStationError('LAUNCH_NOT_ACTIVE', 'station is not launching');
  }
  const match = state.matches[station.activeMatchId]!;
  const round = state.rounds[station.activeRoundId]!;
  if (!match.displayReadyAt) {
    throw new ArcadeStationError('DISPLAY_NOT_READY', 'game display must acknowledge readiness before match start');
  }
  const expectedReservations = match.participantReadyEntryIds
    .map(id => state.readyEntries[id]!.reservationId)
    .filter((id): id is string => id !== null)
    .sort();
  const redeemedReservations = [...input.redeemedReservationIds].sort();
  if (expectedReservations.length !== redeemedReservations.length
    || expectedReservations.some((id, index) => id !== redeemedReservations[index])) {
    throw new ArcadeStationError('RESERVATIONS_NOT_REDEEMED', 'every admitted reservation must be redeemed');
  }
  const bindings = input.enginePlayerIdsByReadyEntryId ?? Object.fromEntries(
    match.participantReadyEntryIds.map(id => [id, `legacy:${id}`]),
  );
  const bindingKeys = Object.keys(bindings).sort();
  const expectedBindingKeys = [...match.participantReadyEntryIds].sort();
  if (bindingKeys.length !== expectedBindingKeys.length
    || bindingKeys.some((id, index) => id !== expectedBindingKeys[index])
    || new Set(Object.values(bindings)).size !== bindingKeys.length
    || Object.values(bindings).some(id => typeof id !== 'string' || !id.trim())) {
    throw new ArcadeStationError('ENGINE_BINDINGS_INVALID', 'every admitted player needs one unique engine binding');
  }
  const readyEntries = cloneRecord(state.readyEntries);
  for (const id of match.participantReadyEntryIds) {
    const entry = readyEntries[id]!;
    readyEntries[id] = Object.freeze({ ...entry, status: 'PLAYING' });
  }
  return checked({
    station: reviseStation(station, input.at, { phase: 'PLAYING' }),
    rounds: { ...state.rounds, [round.id]: Object.freeze({ ...round, phase: 'PLAYING', startedAt: input.at }) },
    readyEntries,
    matches: { ...state.matches, [match.id]: Object.freeze({
      ...match,
      phase: 'PLAYING',
      startedAt: input.at,
      enginePlayerIdsByReadyEntryId: Object.freeze({ ...bindings }),
    }) },
  });
}

export function completeStationMatch(
  state: ArcadeStationAggregate,
  input: {
    at: StationTimestamp;
    expectedRevision: number;
    engineResults?: readonly StationEngineParticipantResult[];
    resultSource?: StationMatchResult['source'];
  },
): ArcadeStationAggregate {
  assertStationInvariants(state);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  timestamp(input.at, 'match completion timestamp');
  const { station } = state;
  if (station.phase !== 'PLAYING' || !station.activeMatchId || !station.activeRoundId) {
    throw new ArcadeStationError('MATCH_NOT_PLAYING', 'station match is not playing');
  }
  const match = state.matches[station.activeMatchId]!;
  const round = state.rounds[station.activeRoundId]!;
  const bindings = Object.entries(match.enginePlayerIdsByReadyEntryId);
  let result: StationMatchResult;
  if (input.engineResults) {
    const byEngineId = new Map(input.engineResults.map(item => [item.enginePlayerId, item]));
    if (byEngineId.size !== input.engineResults.length || byEngineId.size !== bindings.length
      || bindings.some(([, enginePlayerId]) => !byEngineId.has(enginePlayerId))) {
      throw new ArcadeStationError('ENGINE_RESULTS_INVALID', 'engine results do not match admitted players');
    }
    result = Object.freeze({
      source: input.resultSource ?? 'ENGINE',
      participants: Object.freeze(bindings.map(([readyEntryId, enginePlayerId]) => {
        const item = byEngineId.get(enginePlayerId)!;
        return Object.freeze({ ...item, readyEntryId });
      })),
    });
  } else {
    result = Object.freeze({ source: input.resultSource ?? 'LEGACY_UNAVAILABLE', participants: Object.freeze([]) });
  }
  const readyEntries = cloneRecord(state.readyEntries);
  for (const id of match.participantReadyEntryIds) {
    const entry = readyEntries[id]!;
    readyEntries[id] = Object.freeze({ ...entry, status: 'COMPLETED' });
  }
  return checked({
    station: reviseStation(station, input.at, { phase: 'RESULTS' }),
    rounds: { ...state.rounds, [round.id]: Object.freeze({ ...round, phase: 'RESULTS', resultsAt: input.at }) },
    readyEntries,
    matches: { ...state.matches, [match.id]: Object.freeze({
      ...match, phase: 'COMPLETED', completedAt: input.at, result,
    }) },
  });
}

export function advanceStationResults(
  state: ArcadeStationAggregate,
  input: { nextRoundId: string; at: StationTimestamp; configVersion: number; expectedRevision: number },
  timing: StationTimingPolicy = DEFAULT_STATION_TIMING,
): ArcadeStationAggregate {
  assertStationInvariants(state);
  validateTiming(timing);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  const atMs = timestamp(input.at, 'results advance timestamp');
  positiveInteger(input.configVersion, 'config version');
  if (state.station.phase !== 'RESULTS' || !state.station.activeRoundId || !state.station.activeMatchId) {
    throw new ArcadeStationError('RESULTS_NOT_ACTIVE', 'station results are not active');
  }
  const currentRound = state.rounds[state.station.activeRoundId]!;
  const match = state.matches[state.station.activeMatchId]!;
  const overflowEntries = match.overflowReadyEntryIds
    .map(id => state.readyEntries[id]!)
    .filter(entry => entry.status === 'OVERFLOW');
  const existingNext = state.station.nextRoundId ? state.rounds[state.station.nextRoundId] : undefined;
  const hasNextPlayers = (existingNext ? readyForRound(state, existingNext.id).length : 0)
    + overflowEntries.length > 0;
  const rounds = cloneRecord(state.rounds);
  rounds[currentRound.id] = Object.freeze({
    ...currentRound,
    phase: 'CLOSED',
    gameChoicesByReadyEntryId: Object.freeze({}),
    closedAt: input.at,
  });
  const readyEntries = cloneRecord(state.readyEntries);
  let activeRoundId: string | null = null;
  let phase: StationPhase = 'ATTRACT';
  if (hasNextPlayers) {
    const nextRoundId = existingNext?.id ?? identifier(input.nextRoundId, 'next round ID');
    if (!existingNext && rounds[nextRoundId]) {
      throw new ArcadeStationError('ROUND_ID_CONFLICT', 'next round ID already exists');
    }
    const nextRound = existingNext ?? createRound(nextRoundId, state.station.id, input.at, input.configVersion);
    const resultsAtMs = timestamp(currentRound.resultsAt, 'results timestamp');
    rounds[nextRoundId] = Object.freeze({
      ...nextRound,
      recruitingEndsAt: new Date(Math.max(
        resultsAtMs + timing.postGameRecruitingSeconds * 1000,
        atMs,
      )).toISOString(),
      hardEndsAt: new Date(Math.max(
        resultsAtMs + timing.hardDeadlineSeconds * 1000,
        atMs,
      )).toISOString(),
    });
    overflowEntries.forEach(entry => {
      readyEntries[entry.id] = Object.freeze({
        ...entry, roundId: nextRoundId, status: 'READY', overflowOrdinal: null,
      });
    });
    activeRoundId = nextRoundId;
    phase = 'RECRUITING';
  }
  return checked({
    station: reviseStation(state.station, input.at, {
      phase,
      activeRoundId,
      nextRoundId: null,
      activeGame: null,
      activeMatchId: null,
    }),
    rounds,
    readyEntries,
    matches: state.matches,
  });
}

export function leaveStationReadyEntry(
  state: ArcadeStationAggregate,
  input: { readyEntryId: string; at: StationTimestamp; expectedRevision: number },
  timing: StationTimingPolicy = DEFAULT_STATION_TIMING,
): ArcadeStationAggregate {
  assertStationInvariants(state);
  validateTiming(timing);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  const readyEntryId = identifier(input.readyEntryId, 'ready entry ID');
  const entry = state.readyEntries[readyEntryId];
  if (!entry || ['COMPLETED', 'LEFT'].includes(entry.status)) {
    throw new ArcadeStationError('READY_ENTRY_NOT_ACTIVE', 'ready entry is not active');
  }
  if (entry.status === 'PLAYING') throw new ArcadeStationError('MATCH_ALREADY_PLAYING', 'playing entry cannot leave');
  if (entry.status === 'ADMITTED') throw new ArcadeStationError('MATCH_LOCKED', 'admitted entry requires launch cancellation');
  const readyEntries = cloneRecord(state.readyEntries);
  readyEntries[readyEntryId] = Object.freeze({ ...entry, status: 'LEFT' });
  const matches = cloneRecord(state.matches);
  for (const match of Object.values(matches).filter(candidate => candidate.id === state.station.activeMatchId)) {
    if (!match.participantReadyEntryIds.includes(readyEntryId)
      && !match.overflowReadyEntryIds.includes(readyEntryId)) continue;
    const remainingOverflow = match.overflowReadyEntryIds.filter(id => id !== readyEntryId);
    remainingOverflow.forEach((id, index) => {
      const overflow = readyEntries[id];
      if (overflow?.status === 'OVERFLOW') {
        readyEntries[id] = Object.freeze({ ...overflow, overflowOrdinal: index + 1 });
      }
    });
    matches[match.id] = Object.freeze({
      ...match,
      participantReadyEntryIds: Object.freeze(match.participantReadyEntryIds.filter(id => id !== readyEntryId)),
      overflowReadyEntryIds: Object.freeze(remainingOverflow),
    });
  }
  const rounds = cloneRecord(state.rounds);
  const entryRound = rounds[entry.roundId]!;
  if (Object.prototype.hasOwnProperty.call(entryRound.gameChoicesByReadyEntryId, readyEntryId)) {
    const choices = { ...entryRound.gameChoicesByReadyEntryId };
    delete choices[readyEntryId];
    rounds[entry.roundId] = Object.freeze({
      ...entryRound,
      gameChoicesByReadyEntryId: Object.freeze(choices),
    });
  }
  let station = state.station;
  const remaining = Object.values(readyEntries).some(candidate => candidate.roundId === entry.roundId
    && ['READY', 'OVERFLOW'].includes(candidate.status));
  if (!remaining && station.activeRoundId === entry.roundId
    && (station.phase === 'RECRUITING' || station.phase === 'GAME_SELECTION')) {
    rounds[entry.roundId] = Object.freeze({
      ...rounds[entry.roundId]!,
      phase: 'CLOSED',
      gameChoicesByReadyEntryId: Object.freeze({}),
      closedAt: input.at,
    });
    const nextRound = station.nextRoundId ? rounds[station.nextRoundId] : undefined;
    const nextHasPlayers = nextRound && Object.values(readyEntries).some(candidate => (
      candidate.roundId === nextRound.id && candidate.status === 'READY'
    ));
    if (nextRound && nextHasPlayers) {
      const atMs = timestamp(input.at, 'leave timestamp');
      rounds[nextRound.id] = Object.freeze({
        ...nextRound,
        recruitingEndsAt: new Date(atMs + timing.postGameRecruitingSeconds * 1000).toISOString(),
        hardEndsAt: new Date(atMs + timing.hardDeadlineSeconds * 1000).toISOString(),
      });
      station = reviseStation(station, input.at, {
        phase: 'RECRUITING', activeRoundId: nextRound.id, nextRoundId: null,
      });
    } else {
      if (nextRound) rounds[nextRound.id] = Object.freeze({
        ...nextRound,
        phase: 'CLOSED',
        gameChoicesByReadyEntryId: Object.freeze({}),
        closedAt: input.at,
      });
      station = reviseStation(station, input.at, { phase: 'ATTRACT', activeRoundId: null, nextRoundId: null });
    }
  } else if (!remaining && station.nextRoundId === entry.roundId) {
    rounds[entry.roundId] = Object.freeze({
      ...rounds[entry.roundId]!,
      phase: 'CLOSED',
      gameChoicesByReadyEntryId: Object.freeze({}),
      closedAt: input.at,
    });
    station = reviseStation(station, input.at, { nextRoundId: null });
  } else {
    station = reviseStation(station, input.at, {});
  }
  return checked({
    ...state,
    station,
    rounds,
    readyEntries,
    matches,
  });
}

export function dropStationAdmittedEntry(
  state: ArcadeStationAggregate,
  input: { readyEntryId: string; at: StationTimestamp; expectedRevision: number },
): ArcadeStationAggregate {
  assertStationInvariants(state);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  const readyEntryId = identifier(input.readyEntryId, 'ready entry ID');
  if (!['LOCKED', 'LAUNCHING'].includes(state.station.phase) || !state.station.activeMatchId) {
    throw new ArcadeStationError('MATCH_NOT_WAITING', 'players can be removed only before gameplay starts');
  }
  const match = state.matches[state.station.activeMatchId]!;
  const target = state.readyEntries[readyEntryId];
  if (!target || target.status !== 'ADMITTED' || !match.participantReadyEntryIds.includes(readyEntryId)) {
    throw new ArcadeStationError('READY_ENTRY_NOT_ADMITTED', 'ready entry is not an admitted player');
  }
  const ordered = [...match.participantReadyEntryIds.filter(id => id !== readyEntryId), ...match.overflowReadyEntryIds]
    .map(id => state.readyEntries[id]!)
    .sort(compareReadyEntries);
  const capacity = arcadeGameDefinition(match.game).humanCapacity!;
  const participants = ordered.slice(0, capacity);
  if (participants.length < arcadeGameDefinition(match.game).minimumHumans!) {
    throw new ArcadeStationError('MINIMUM_PLAYERS_REQUIRED', 'cannot remove the final admitted player');
  }
  const overflow = ordered.slice(capacity);
  const renewedLaunch = state.station.phase === 'LAUNCHING';
  const readyEntries = cloneRecord(state.readyEntries);
  readyEntries[readyEntryId] = Object.freeze({ ...target, status: 'LEFT', overflowOrdinal: null });
  participants.forEach(entry => {
    readyEntries[entry.id] = Object.freeze({ ...entry, status: 'ADMITTED', overflowOrdinal: null });
  });
  overflow.forEach((entry, index) => {
    readyEntries[entry.id] = Object.freeze({ ...entry, status: 'OVERFLOW', overflowOrdinal: index + 1 });
  });
  return checked({
    ...state,
    station: reviseStation(state.station, input.at, {}),
    readyEntries,
    matches: {
      ...state.matches,
      [match.id]: Object.freeze({
        ...match,
        participantReadyEntryIds: Object.freeze(participants.map(entry => entry.id)),
        overflowReadyEntryIds: Object.freeze(overflow.map(entry => entry.id)),
        ...(renewedLaunch ? {
          launchGeneration: match.launchGeneration + 1,
          launchRequestedAt: input.at,
          displayReadyAt: null,
        } : {}),
      }),
    },
  });
}

export function markStationDisplayReady(
  state: ArcadeStationAggregate,
  input: { at: StationTimestamp; expectedRevision: number },
): ArcadeStationAggregate {
  assertStationInvariants(state);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  if (state.station.phase !== 'LAUNCHING' || !state.station.activeMatchId) {
    throw new ArcadeStationError('LAUNCH_NOT_ACTIVE', 'station is not launching');
  }
  const match = state.matches[state.station.activeMatchId]!;
  return checked({
    ...state,
    station: reviseStation(state.station, input.at, {}),
    matches: { ...state.matches, [match.id]: Object.freeze({ ...match, displayReadyAt: input.at }) },
  });
}

export function failStationLaunch(
  state: ArcadeStationAggregate,
  input: { at: StationTimestamp; expectedRevision: number },
  timing: StationTimingPolicy = DEFAULT_STATION_TIMING,
): ArcadeStationAggregate {
  assertStationInvariants(state);
  validateTiming(timing);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  const atMs = timestamp(input.at, 'launch failure timestamp');
  if (!['LOCKED', 'LAUNCHING'].includes(state.station.phase)
    || !state.station.activeMatchId || !state.station.activeRoundId) {
    throw new ArcadeStationError('LAUNCH_NOT_ACTIVE', 'station has no recoverable launch');
  }
  const match = state.matches[state.station.activeMatchId]!;
  const round = state.rounds[state.station.activeRoundId]!;
  const readyEntries = cloneRecord(state.readyEntries);
  for (const id of [...match.participantReadyEntryIds, ...match.overflowReadyEntryIds]) {
    const entry = readyEntries[id];
    if (entry && entry.status !== 'LEFT') {
      readyEntries[id] = Object.freeze({ ...entry, status: 'READY', overflowOrdinal: null });
    }
  }
  return checked({
    station: reviseStation(state.station, input.at, {
      phase: 'RECRUITING', activeGame: null, activeMatchId: null,
    }),
    rounds: {
      ...state.rounds,
      [round.id]: Object.freeze({
        ...round,
        phase: 'RECRUITING',
        recruitingEndsAt: new Date(atMs + timing.postGameRecruitingSeconds * 1000).toISOString(),
        hardEndsAt: new Date(atMs + timing.hardDeadlineSeconds * 1000).toISOString(),
        selectionStartedAt: null,
        selectionEndsAt: null,
        lockedAt: null,
        lockedEndsAt: null,
        selectedGame: null,
        gameChoicesByReadyEntryId: Object.freeze({}),
      }),
    },
    readyEntries,
    matches: {
      ...state.matches,
      [match.id]: Object.freeze({ ...match, phase: 'FAILED', completedAt: input.at }),
    },
  });
}

export function resetArcadeStation(
  state: ArcadeStationAggregate,
  input: { at: StationTimestamp; expectedRevision: number },
): ArcadeStationAggregate {
  assertStationInvariants(state);
  requireRevision(state, input.expectedRevision);
  requireChronology(state.station, input.at);
  timestamp(input.at, 'station reset timestamp');
  if (state.station.phase === 'ATTRACT') {
    throw new ArcadeStationError('STATION_ALREADY_IDLE', 'station is already idle');
  }

  const rounds = cloneRecord(state.rounds);
  for (const roundId of [state.station.activeRoundId, state.station.nextRoundId]) {
    if (!roundId) continue;
    const round = rounds[roundId]!;
    if (round.phase !== 'CLOSED') {
      rounds[roundId] = Object.freeze({
        ...round,
        phase: 'CLOSED',
        gameChoicesByReadyEntryId: Object.freeze({}),
        closedAt: input.at,
      });
    }
  }

  const readyEntries = cloneRecord(state.readyEntries);
  for (const entry of Object.values(readyEntries)) {
    if (!['COMPLETED', 'LEFT'].includes(entry.status)) {
      readyEntries[entry.id] = Object.freeze({ ...entry, status: 'LEFT', overflowOrdinal: null });
    }
  }

  const matches = cloneRecord(state.matches);
  for (const match of Object.values(matches)) {
    if (['PREPARING', 'LAUNCHING', 'PLAYING'].includes(match.phase)) {
      matches[match.id] = Object.freeze({ ...match, phase: 'FAILED', completedAt: input.at });
    }
  }

  return checked({
    station: reviseStation(state.station, input.at, {
      phase: 'ATTRACT',
      activeRoundId: null,
      nextRoundId: null,
      activeGame: null,
      activeMatchId: null,
    }),
    rounds,
    readyEntries,
    matches,
  });
}

export function stationReadyEntries(state: ArcadeStationAggregate, roundId: string): readonly StationReadyEntry[] {
  assertStationInvariants(state);
  return Object.freeze(readyForRound(state, roundId));
}

export function assertStationInvariants(value: ArcadeStationAggregate): void {
  if (!value || typeof value !== 'object') throw new ArcadeStationError('INVALID_STATION', 'station aggregate is required');
  const station = value.station;
  identifier(station.id, 'station ID');
  timestamp(station.updatedAt, 'station updatedAt');
  positiveInteger(station.revision, 'station revision');
  if (!STATION_PHASES.has(station.phase)) throw new ArcadeStationError('INVALID_STATION', 'unknown station phase');
  if (station.activeRoundId && station.activeRoundId === station.nextRoundId) {
    throw new ArcadeStationError('INVALID_STATION', 'active and next round must differ');
  }
  if (station.activeRoundId && !value.rounds[station.activeRoundId]) {
    throw new ArcadeStationError('INVALID_STATION', 'active round does not exist');
  }
  if (station.nextRoundId && !value.rounds[station.nextRoundId]) {
    throw new ArcadeStationError('INVALID_STATION', 'next round does not exist');
  }
  if (station.activeMatchId && !value.matches[station.activeMatchId]) {
    throw new ArcadeStationError('INVALID_STATION', 'active match does not exist');
  }
  if (station.phase === 'ATTRACT') {
    if (station.activeRoundId || station.nextRoundId || station.activeGame || station.activeMatchId) {
      throw new ArcadeStationError('INVALID_STATION', 'attract station has active state');
    }
  } else if (!station.activeRoundId) {
    throw new ArcadeStationError('INVALID_STATION', 'active station phase requires a round');
  }
  const matchPhases = new Set<StationPhase>(['LOCKED', 'LAUNCHING', 'PLAYING', 'RESULTS']);
  if (matchPhases.has(station.phase)) {
    if (!station.activeGame || !station.activeMatchId) {
      throw new ArcadeStationError('INVALID_STATION', 'match station phase requires game and match');
    }
  } else if (station.activeGame || station.activeMatchId) {
    throw new ArcadeStationError('INVALID_STATION', 'non-match station phase has active game or match');
  }
  if (station.nextRoundId && value.rounds[station.nextRoundId]!.phase !== 'RECRUITING') {
    throw new ArcadeStationError('INVALID_STATION', 'next round must be recruiting');
  }
  const stationUpdatedAt = Date.parse(station.updatedAt);
  const seenPlayers = new Set<string>();
  const seenReservations = new Set<string>();
  for (const [key, round] of Object.entries(value.rounds)) {
    identifier(round.id, 'round ID');
    if (key !== round.id) throw new ArcadeStationError('INVALID_STATION', 'round key does not match ID');
    if (!ROUND_PHASES.has(round.phase)) throw new ArcadeStationError('INVALID_STATION', 'unknown round phase');
    if (round.stationId !== station.id) throw new ArcadeStationError('INVALID_STATION', 'round belongs to another station');
    if (!round.gameChoicesByReadyEntryId || typeof round.gameChoicesByReadyEntryId !== 'object'
      || Array.isArray(round.gameChoicesByReadyEntryId)) {
      throw new ArcadeStationError('INVALID_STATION', 'round game choices must be a record');
    }
    for (const [readyEntryId, game] of Object.entries(round.gameChoicesByReadyEntryId)) {
      identifier(readyEntryId, 'choice ready entry ID');
      const entry = value.readyEntries[readyEntryId];
      if (!isPlayableArcadeGame(game) || !entry || entry.roundId !== round.id || entry.status !== 'READY') {
        throw new ArcadeStationError('INVALID_STATION', 'round game choice is stale or invalid');
      }
    }
    if (round.phase !== 'GAME_SELECTION' && Object.keys(round.gameChoicesByReadyEntryId).length > 0) {
      throw new ArcadeStationError('INVALID_STATION', 'game choices exist outside selection');
    }
    const first = timestamp(round.firstCoinAt, 'round firstCoinAt');
    const dates = [round.recruitingEndsAt, round.hardEndsAt, round.selectionStartedAt,
      round.selectionEndsAt, round.lockedAt, round.lockedEndsAt, round.startedAt,
      round.resultsAt, round.closedAt];
    for (const date of dates) if (date && timestamp(date, 'round timestamp') < first) {
      throw new ArcadeStationError('INVALID_STATION', 'round timestamp precedes first coin');
    }
    const eventDates = [round.firstCoinAt, round.selectionStartedAt, round.lockedAt,
      round.startedAt, round.resultsAt, round.closedAt];
    if (eventDates.some(date => date && Date.parse(date) > stationUpdatedAt)) {
      throw new ArcadeStationError('INVALID_STATION', 'round timestamp follows station updatedAt');
    }
    const phaseChronology = [round.selectionStartedAt, round.lockedAt, round.startedAt,
      round.resultsAt, round.closedAt].filter((date): date is string => date !== null).map(Date.parse);
    if (phaseChronology.some((date, index) => index > 0 && date < phaseChronology[index - 1]!)) {
      throw new ArcadeStationError('INVALID_STATION', 'round phase chronology is invalid');
    }
    if (round.recruitingEndsAt && round.hardEndsAt
      && Date.parse(round.recruitingEndsAt) > Date.parse(round.hardEndsAt)) {
      throw new ArcadeStationError('INVALID_STATION', 'round recruiting deadline follows hard deadline');
    }
    if (round.selectionStartedAt && (!round.selectionEndsAt
      || Date.parse(round.selectionEndsAt) < Date.parse(round.selectionStartedAt))) {
      throw new ArcadeStationError('INVALID_STATION', 'round selection chronology is invalid');
    }
    if (round.lockedAt && (!round.lockedEndsAt || Date.parse(round.lockedEndsAt) < Date.parse(round.lockedAt))) {
      throw new ArcadeStationError('INVALID_STATION', 'round lock chronology is invalid');
    }
    if (['RECRUITING', 'GAME_SELECTION'].includes(round.phase) && round.selectedGame !== null) {
      throw new ArcadeStationError('INVALID_STATION', 'unlocked round has selected game');
    }
    if (['LOCKED', 'LAUNCHING', 'PLAYING', 'RESULTS'].includes(round.phase)
      && (!round.selectedGame || !isPlayableArcadeGame(round.selectedGame))) {
      throw new ArcadeStationError('INVALID_STATION', 'active round requires playable selected game');
    }
    if (round.phase === 'GAME_SELECTION' && (!round.selectionStartedAt || !round.selectionEndsAt)) {
      throw new ArcadeStationError('INVALID_STATION', 'selection round lacks timestamp evidence');
    }
    if (['LOCKED', 'LAUNCHING', 'PLAYING', 'RESULTS'].includes(round.phase)
      && (!round.selectionStartedAt || !round.selectionEndsAt || !round.lockedAt || !round.lockedEndsAt)) {
      throw new ArcadeStationError('INVALID_STATION', 'locked round lacks timestamp evidence');
    }
    if (['PLAYING', 'RESULTS'].includes(round.phase) && !round.startedAt) {
      throw new ArcadeStationError('INVALID_STATION', 'playing round lacks start timestamp');
    }
    if (round.phase === 'RESULTS' && !round.resultsAt) {
      throw new ArcadeStationError('INVALID_STATION', 'results round lacks results timestamp');
    }
    if (round.phase === 'CLOSED' && !round.closedAt) {
      throw new ArcadeStationError('INVALID_STATION', 'closed round lacks close timestamp');
    }
  }
  const activeRound = station.activeRoundId ? value.rounds[station.activeRoundId]! : null;
  if (activeRound && activeRound.phase !== station.phase) {
    throw new ArcadeStationError('INVALID_STATION', 'station and active round phases differ');
  }
  for (const [key, entry] of Object.entries(value.readyEntries)) {
    identifier(entry.id, 'ready entry ID');
    if (key !== entry.id) throw new ArcadeStationError('INVALID_STATION', 'ready entry key does not match ID');
    if (!READY_STATUSES.has(entry.status)) throw new ArcadeStationError('INVALID_STATION', 'unknown ready entry status');
    if (!value.rounds[entry.roundId] || entry.stationId !== station.id) {
      throw new ArcadeStationError('INVALID_STATION', 'ready entry has invalid station or round');
    }
    const original = timestamp(entry.originalReadyAt, 'originalReadyAt');
    if (timestamp(entry.readyAt, 'readyAt') < original) throw new ArcadeStationError('INVALID_STATION', 'readyAt precedes originalReadyAt');
    if (entry.reservationId !== null) {
      identifier(entry.reservationId, 'reservation ID');
      if (seenReservations.has(entry.reservationId)) throw new ArcadeStationError('INVALID_STATION', 'duplicate reservation ID');
      seenReservations.add(entry.reservationId);
    }
    if (Date.parse(entry.readyAt) > stationUpdatedAt) {
      throw new ArcadeStationError('INVALID_STATION', 'ready entry timestamp follows station updatedAt');
    }
    if (!['COMPLETED', 'LEFT'].includes(entry.status)) {
      if (entry.roundId !== station.activeRoundId && entry.roundId !== station.nextRoundId) {
        throw new ArcadeStationError('INVALID_STATION', 'live ready entry is not reachable from station');
      }
      if (seenPlayers.has(entry.playerId)) throw new ArcadeStationError('INVALID_STATION', 'player has multiple live ready entries');
      seenPlayers.add(entry.playerId);
    }
  }
  for (const [key, match] of Object.entries(value.matches)) {
    if (key !== match.id) throw new ArcadeStationError('INVALID_STATION', 'match key does not match ID');
    if (!MATCH_PHASES.has(match.phase)) throw new ArcadeStationError('INVALID_STATION', 'unknown match phase');
    if (!value.rounds[match.roundId] || match.stationId !== station.id) {
      throw new ArcadeStationError('INVALID_STATION', 'match has invalid station or round');
    }
    if (!isPlayableArcadeGame(match.game)) throw new ArcadeStationError('INVALID_STATION', 'match game is not playable');
    if (value.rounds[match.roundId]!.selectedGame !== match.game && match.phase !== 'FAILED') {
      throw new ArcadeStationError('INVALID_STATION', 'match game differs from round selection');
    }
    const allIds = [...match.participantReadyEntryIds, ...match.overflowReadyEntryIds];
    if (new Set(allIds).size !== allIds.length || allIds.some(id => !value.readyEntries[id])) {
      throw new ArcadeStationError('INVALID_STATION', 'match ready entries are invalid');
    }
    if (match.participantReadyEntryIds.length > arcadeGameDefinition(match.game).humanCapacity!) {
      throw new ArcadeStationError('INVALID_STATION', 'match exceeds game capacity');
    }
    const expectedAdmissionCount = Math.min(arcadeGameDefinition(match.game).humanCapacity!, allIds.length);
    if (match.participantReadyEntryIds.length !== expectedAdmissionCount) {
      throw new ArcadeStationError('INVALID_STATION', 'match admission count does not match capacity');
    }
    if (match.phase !== 'FAILED' && match.participantReadyEntryIds.length < 1) {
      throw new ArcadeStationError('INVALID_STATION', 'match has no participants');
    }
    const ordered = allIds.map(id => value.readyEntries[id]!).sort(compareReadyEntries);
    const expectedParticipants = ordered.slice(0, match.participantReadyEntryIds.length).map(entry => entry.id);
    if (expectedParticipants.some((id, index) => id !== match.participantReadyEntryIds[index])) {
      throw new ArcadeStationError('INVALID_STATION', 'match assignment is not FIFO');
    }
    const expectedOverflow = ordered.slice(match.participantReadyEntryIds.length).map(entry => entry.id);
    if (expectedOverflow.some((id, index) => id !== match.overflowReadyEntryIds[index])) {
      throw new ArcadeStationError('INVALID_STATION', 'match overflow assignment is not FIFO');
    }
    const bindingEntries = Object.entries(match.enginePlayerIdsByReadyEntryId);
    if (new Set(bindingEntries.map(([, engineId]) => engineId)).size !== bindingEntries.length
      || bindingEntries.some(([readyEntryId, engineId]) => !match.participantReadyEntryIds.includes(readyEntryId)
        || typeof engineId !== 'string' || !engineId.trim())) {
      throw new ArcadeStationError('INVALID_STATION', 'match engine bindings are invalid');
    }
    if (['PLAYING', 'COMPLETED'].includes(match.phase)
      && bindingEntries.length !== match.participantReadyEntryIds.length) {
      throw new ArcadeStationError('INVALID_STATION', 'playing match lacks engine bindings');
    }
    if (match.phase === 'COMPLETED' && !match.result) {
      throw new ArcadeStationError('INVALID_STATION', 'completed match lacks a result');
    }
    if (match.phase !== 'COMPLETED' && match.result !== null) {
      throw new ArcadeStationError('INVALID_STATION', 'non-completed match has a result');
    }
    if (match.result) {
      const resultIds = match.result.participants.map(item => item.readyEntryId);
      if (new Set(resultIds).size !== resultIds.length
        || resultIds.some(id => !match.participantReadyEntryIds.includes(id))) {
        throw new ArcadeStationError('INVALID_STATION', 'match result participants are invalid');
      }
      if (match.result.source === 'ENGINE' && resultIds.length !== match.participantReadyEntryIds.length) {
        throw new ArcadeStationError('INVALID_STATION', 'engine result is incomplete');
      }
    }
    const lifecycle = [match.launchRequestedAt, match.displayReadyAt, match.startedAt, match.completedAt]
      .filter((date): date is string => date !== null)
      .map(date => timestamp(date, 'match timestamp'));
    if (lifecycle.some(date => date > stationUpdatedAt)) {
      throw new ArcadeStationError('INVALID_STATION', 'match timestamp follows station updatedAt');
    }
    if (lifecycle.some((date, index) => index > 0 && date < lifecycle[index - 1]!)) {
      throw new ArcadeStationError('INVALID_STATION', 'match timestamp chronology is invalid');
    }
    if (match.phase === 'PREPARING'
      && [match.launchRequestedAt, match.displayReadyAt, match.startedAt, match.completedAt].some(Boolean)) {
      throw new ArcadeStationError('INVALID_STATION', 'preparing match has premature timestamps');
    }
    if (match.phase === 'LAUNCHING' && (!match.launchRequestedAt || match.startedAt || match.completedAt)) {
      throw new ArcadeStationError('INVALID_STATION', 'launching match timestamp evidence is invalid');
    }
    if (match.phase === 'PLAYING'
      && (!match.launchRequestedAt || !match.displayReadyAt || !match.startedAt || match.completedAt)) {
      throw new ArcadeStationError('INVALID_STATION', 'playing match lacks timestamp evidence');
    }
    if (match.phase === 'COMPLETED'
      && (!match.launchRequestedAt || !match.displayReadyAt || !match.startedAt || !match.completedAt)) {
      throw new ArcadeStationError('INVALID_STATION', 'completed match lacks timestamp evidence');
    }
    if (match.phase === 'FAILED' && (!match.completedAt
      || (match.startedAt && (!match.launchRequestedAt || !match.displayReadyAt)))) {
      throw new ArcadeStationError('INVALID_STATION', 'failed match timestamp evidence is invalid');
    }
    if (station.activeMatchId === match.id) {
      const participantStatuses: Record<StationMatchPhase, readonly ReadyEntryStatus[]> = {
        PREPARING: ['ADMITTED'], LAUNCHING: ['ADMITTED'], PLAYING: ['PLAYING'],
        COMPLETED: ['COMPLETED'], FAILED: ['READY', 'LEFT'],
      };
      if (match.participantReadyEntryIds.some(id => !participantStatuses[match.phase].includes(value.readyEntries[id]!.status))) {
        throw new ArcadeStationError('INVALID_STATION', 'active match participant status is invalid');
      }
      const overflowStatuses = match.phase === 'COMPLETED' ? ['READY', 'OVERFLOW', 'LEFT'] : ['OVERFLOW', 'LEFT'];
      if (match.overflowReadyEntryIds.some(id => !overflowStatuses.includes(value.readyEntries[id]!.status))) {
        throw new ArcadeStationError('INVALID_STATION', 'active match overflow status is invalid');
      }
      match.overflowReadyEntryIds.forEach((id, index) => {
        const entry = value.readyEntries[id]!;
        if (entry.status === 'OVERFLOW' && entry.overflowOrdinal !== index + 1) {
          throw new ArcadeStationError('INVALID_STATION', 'overflow ordinal is invalid');
        }
      });
    }
  }
  if (station.activeMatchId) {
    const activeMatch = value.matches[station.activeMatchId]!;
    const expectedPhase: Partial<Record<StationPhase, StationMatchPhase>> = {
      LOCKED: 'PREPARING', LAUNCHING: 'LAUNCHING', PLAYING: 'PLAYING', RESULTS: 'COMPLETED',
    };
    if (expectedPhase[station.phase] !== activeMatch.phase || station.activeGame !== activeMatch.game
      || station.activeRoundId !== activeMatch.roundId) {
      throw new ArcadeStationError('INVALID_STATION', 'active station and match state differ');
    }
    const matchIds = [...activeMatch.participantReadyEntryIds, ...activeMatch.overflowReadyEntryIds];
    if (matchIds.some(id => value.readyEntries[id]!.roundId !== activeMatch.roundId)) {
      throw new ArcadeStationError('INVALID_STATION', 'active match entry belongs to another round');
    }
    const activeRoundLiveIds = Object.values(value.readyEntries)
      .filter(entry => entry.roundId === activeMatch.roundId && entry.status !== 'LEFT')
      .map(entry => entry.id)
      .sort();
    const activeMatchLiveIds = matchIds
      .filter(id => value.readyEntries[id]!.status !== 'LEFT')
      .slice()
      .sort();
    if (activeRoundLiveIds.length !== activeMatchLiveIds.length
      || activeRoundLiveIds.some((id, index) => id !== activeMatchLiveIds[index])) {
      throw new ArcadeStationError('INVALID_STATION', 'active round membership differs from match');
    }
  }
  if (station.nextRoundId && Object.values(value.readyEntries).some(entry => (
    entry.roundId === station.nextRoundId && !['READY', 'LEFT'].includes(entry.status)
  ))) {
    throw new ArcadeStationError('INVALID_STATION', 'next round contains non-ready entry');
  }
}

function createRound(
  id: string,
  stationId: string,
  at: StationTimestamp,
  configVersion: number,
  atMs?: number,
  recruitingSeconds?: number,
  hardSeconds?: number,
): RecruitingRound {
  return Object.freeze({
    id,
    stationId,
    phase: 'RECRUITING',
    firstCoinAt: at,
    recruitingEndsAt: atMs === undefined ? null : new Date(atMs + recruitingSeconds! * 1000).toISOString(),
    hardEndsAt: atMs === undefined ? null : new Date(atMs + hardSeconds! * 1000).toISOString(),
    selectionEndsAt: null,
    selectionStartedAt: null,
    lockedEndsAt: null,
    lockedAt: null,
    selectedGame: null,
    gameChoicesByReadyEntryId: Object.freeze({}),
    startedAt: null,
    resultsAt: null,
    closedAt: null,
    configVersion,
  });
}

function readyForRound(state: ArcadeStationAggregate, roundId: string): StationReadyEntry[] {
  return Object.values(state.readyEntries)
    .filter(entry => entry.roundId === roundId && ['READY', 'OVERFLOW'].includes(entry.status))
    .slice()
    .sort(compareReadyEntries);
}

function reviseStation(
  station: ArcadeStation,
  at: StationTimestamp,
  changes: Partial<Omit<ArcadeStation, 'id' | 'revision' | 'updatedAt'>>,
): ArcadeStation {
  return Object.freeze({ ...station, ...changes, revision: station.revision + 1, updatedAt: at });
}

function checked(value: ArcadeStationAggregate): ArcadeStationAggregate {
  const frozen = freezeAggregate(value);
  assertStationInvariants(frozen);
  return frozen;
}

function freezeAggregate(value: ArcadeStationAggregate): ArcadeStationAggregate {
  const rounds = Object.fromEntries(Object.entries(value.rounds).map(([key, round]) => [key, Object.freeze({
    ...round,
    gameChoicesByReadyEntryId: Object.freeze({ ...round.gameChoicesByReadyEntryId }),
  })]));
  const readyEntries = Object.fromEntries(Object.entries(value.readyEntries).map(([key, entry]) => [key, Object.freeze({ ...entry })]));
  const matches = Object.fromEntries(Object.entries(value.matches).map(([key, match]) => [key, Object.freeze({
    ...match,
    participantReadyEntryIds: Object.freeze([...match.participantReadyEntryIds]),
    overflowReadyEntryIds: Object.freeze([...match.overflowReadyEntryIds]),
  })]));
  return Object.freeze({ station: Object.freeze({ ...value.station }), rounds: Object.freeze(rounds),
    readyEntries: Object.freeze(readyEntries), matches: Object.freeze(matches) });
}

function compareReadyEntries(a: StationReadyEntry, b: StationReadyEntry): number {
  const time = Date.parse(a.originalReadyAt) - Date.parse(b.originalReadyAt);
  if (time !== 0) return time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function requireRevision(state: ArcadeStationAggregate, expectedRevision: number): void {
  positiveInteger(expectedRevision, 'expected revision');
  if (state.station.revision !== expectedRevision) {
    throw new ArcadeStationError('REVISION_CONFLICT', 'station revision changed');
  }
}

function requireChronology(station: ArcadeStation, at: StationTimestamp): void {
  if (timestamp(at, 'operation timestamp') < timestamp(station.updatedAt, 'station updatedAt')) {
    throw new ArcadeStationError('BACKDATED_OPERATION', 'operation precedes station chronology');
  }
}

function cloneRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, value);
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ArcadeStationError('INVALID_INPUT', `${field} must be a non-empty bounded string`);
  }
  return value;
}

function timestamp(value: unknown, field: string): number {
  const id = identifier(value, field);
  const milliseconds = Date.parse(id);
  if (!Number.isFinite(milliseconds)) throw new ArcadeStationError('INVALID_INPUT', `${field} must be an ISO timestamp`);
  return milliseconds;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ArcadeStationError('INVALID_INPUT', `${field} must be a positive integer`);
  }
  return value as number;
}

function validateTiming(value: StationTimingPolicy): void {
  for (const [field, seconds] of Object.entries(value)) positiveInteger(seconds, field);
  if (value.hardDeadlineSeconds < value.recruitingSeconds) {
    throw new ArcadeStationError('INVALID_INPUT', 'hard deadline must not precede recruiting deadline');
  }
  if (value.hardDeadlineSeconds < value.postGameRecruitingSeconds) {
    throw new ArcadeStationError('INVALID_INPUT', 'hard deadline must not precede post-game recruiting deadline');
  }
}
