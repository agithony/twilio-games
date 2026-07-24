import { createHash } from 'node:crypto';
import { PLAYABLE_ARCADE_GAMES, type PlayableArcadeGame } from '../shared/arcade-games';
import {
  DEFAULT_ARCADE_CONFIG,
  type ArcadeConfigSnapshot,
  type StationSettings,
} from '../shared/arcade-config';
import type { ArcadeStationAggregate, StationEngineParticipantResult } from '../shared/arcade-station';
import {
  ARCADE_CONFIG_UPDATED_EVENT,
  ARCADE_STATION_UPDATED_EVENT,
  type ArcadeEventHub,
} from './arcade-events';
import {
  ArcadeService,
  type StationMutationResult,
} from './arcade-service';

type Timer = ReturnType<typeof setTimeout>;

export interface ArcadeStationRuntimeOptions {
  readonly service: ArcadeService;
  readonly events: ArcadeEventHub;
  readonly stationId: () => string;
  readonly systemAuthorization: () => unknown;
  readonly enabled?: () => boolean;
  readonly config?: () => ArcadeConfigSnapshot;
  readonly roomCodeSecret?: () => string;
  readonly clock?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => Timer;
  readonly clearTimer?: (timer: Timer) => void;
  readonly onError?: (error: unknown) => void;
  readonly onMatchRemoved?: (game: PlayableArcadeGame, roomCode: string) => void;
}

type ScheduledTransition = Readonly<{
  at: number;
  phase: ArcadeStationAggregate['station']['phase'];
}>;

export class ArcadeStationRuntime {
  private readonly service: ArcadeService;
  private readonly events: ArcadeEventHub;
  private readonly stationIdSource: () => string;
  private readonly systemAuthorization: () => unknown;
  private readonly clock: () => number;
  private readonly enabled: () => boolean;
  private readonly config: () => ArcadeConfigSnapshot;
  private readonly roomCodeSecret: () => string;
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly onError?: (error: unknown) => void;
  private onMatchRemoved?: (game: PlayableArcadeGame, roomCode: string) => void;
  private timer: Timer | null = null;
  private unsubscribe: (() => void) | null = null;
  private pending: Promise<void> = Promise.resolve();
  private readonly startedEngines = new Set<string>();
  private readonly terminalEngines = new Map<string, 'completed' | 'abandoned'>();
  private readonly engineResults = new Map<string, readonly StationEngineParticipantResult[]>();
  private readonly connectedReadyEntries = new Map<string, string>();
  private readonly canonicalEngineIdByReadyEntry = new Map<string, string>();
  private readonly canonicalEngineIdByCurrentId = new Map<string, string>();
  private started = false;
  private stopped = false;
  private recoverOnStart = true;

  constructor(options: ArcadeStationRuntimeOptions) {
    this.service = options.service;
    this.events = options.events;
    this.stationIdSource = options.stationId;
    this.systemAuthorization = options.systemAuthorization;
    this.enabled = options.enabled ?? (() => true);
    this.config = options.config ?? (() => DEFAULT_ARCADE_CONFIG);
    this.roomCodeSecret = options.roomCodeSecret ?? (() => 'local-station-room-secret');
    this.clock = options.clock ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError;
    this.onMatchRemoved = options.onMatchRemoved;
  }

  setMatchRemovedHandler(handler: (game: PlayableArcadeGame, roomCode: string) => void): void {
    this.onMatchRemoved = handler;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Twilio Games station runtime cannot restart after stop');
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.events.subscribe(event => {
      if (event.type === ARCADE_STATION_UPDATED_EVENT || event.type === ARCADE_CONFIG_UPDATED_EVENT) {
        this.enqueueReconcile();
      }
    });
    await this.reconcile();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancelTimer();
    await this.pending.catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  engineRoomCode(game: PlayableArcadeGame, revision: number): string {
    const stationId = this.stationIdSource();
    return createHash('sha256')
      .update(`${this.roomCodeSecret()}\0${stationId}\0${game}\0${revision}`)
      .digest('base64url')
      .slice(0, 12)
      .toUpperCase();
  }

  selectGame(input: {
    game: PlayableArcadeGame;
    expectedRevision: number;
    idempotencyKey: string;
    authorization: unknown;
    reason?: string;
  }): Promise<StationMutationResult> {
    return this.service.selectStationGame({
      stationId: this.stationIdSource(),
      game: input.game,
      engineRoomCode: this.engineRoomCode(input.game, input.expectedRevision),
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      authorization: input.authorization,
      reason: input.reason ?? 'operator game selection',
    });
  }

  markDisplayReady(input: {
    matchId: string;
    launchGeneration: number;
    expectedRevision: number;
    idempotencyKey: string;
  }): Promise<StationMutationResult> {
    return this.service.markStationDisplayReady({
      stationId: this.stationIdSource(),
      matchId: input.matchId,
      launchGeneration: input.launchGeneration,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      authorization: this.systemAuthorization(),
      reason: 'display acknowledged engine readiness',
    });
  }

  async markEngineStarted(game: PlayableArcadeGame, roomCode: string): Promise<void> {
    const aggregate = await this.service.getStation(this.stationIdSource());
    const match = aggregate?.station.activeMatchId
      ? aggregate.matches[aggregate.station.activeMatchId]
      : undefined;
    if (aggregate?.station.phase !== 'LAUNCHING' || match?.game !== game || match.engineRoomCode !== roomCode) return;
    this.startedEngines.add(engineKey(game, roomCode));
    this.enqueueReconcile();
  }

  markParticipantConnected(readyEntryId: string, enginePlayerId = `legacy:${readyEntryId}`): void {
    this.connectedReadyEntries.set(readyEntryId, enginePlayerId);
    const canonical = this.canonicalEngineIdByReadyEntry.get(readyEntryId);
    if (canonical) this.canonicalEngineIdByCurrentId.set(enginePlayerId, canonical);
    this.enqueueReconcile();
  }

  markParticipantDisconnected(readyEntryId: string): void {
    this.connectedReadyEntries.delete(readyEntryId);
  }

  connectedParticipantIds(): ReadonlySet<string> {
    return new Set(this.connectedReadyEntries.keys());
  }

  canonicalEnginePlayerId(enginePlayerId: string): string {
    return this.canonicalEngineIdByCurrentId.get(enginePlayerId) ?? enginePlayerId;
  }

  dropAdmittedEntry(input: {
    readyEntryId: string;
    expectedRevision: number;
    idempotencyKey: string;
    authorization: unknown;
    reason: string;
  }): Promise<StationMutationResult> {
    if (this.connectedReadyEntries.has(input.readyEntryId)) {
      return Promise.reject(new Error('connected player cannot be removed from the launch'));
    }
    return this.service.dropStationAdmittedEntry({
      stationId: this.stationIdSource(),
      readyEntryId: input.readyEntryId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      authorization: input.authorization,
      reason: input.reason,
    });
  }

  async markEngineCompleted(
    game: PlayableArcadeGame,
    roomCode: string,
    results: readonly StationEngineParticipantResult[] = [],
  ): Promise<void> {
    const key = engineKey(game, roomCode);
    this.engineResults.set(key, results);
    this.terminalEngines.set(key, 'completed');
    return this.serialize(async () => {
      const aggregate = await this.service.getStation(this.stationIdSource());
      const match = aggregate?.station.activeMatchId
        ? aggregate.matches[aggregate.station.activeMatchId]
        : undefined;
      if (!aggregate || !match || match.game !== game || match.engineRoomCode !== roomCode
        || (aggregate.station.phase !== 'LAUNCHING' && aggregate.station.phase !== 'PLAYING')) {
        this.terminalEngines.delete(key);
        this.engineResults.delete(key);
        return;
      }
      await this.applyEngineTerminal(aggregate, match, 'completed');
      this.terminalEngines.delete(key);
      this.startedEngines.delete(key);
      this.engineResults.delete(key);
    });
  }

  async markEngineAbandoned(game: PlayableArcadeGame, roomCode: string): Promise<void> {
    const key = engineKey(game, roomCode);
    if (this.terminalEngines.get(key) !== 'completed') this.terminalEngines.set(key, 'abandoned');
    return this.serialize(async () => {
      const aggregate = await this.service.getStation(this.stationIdSource());
      const match = aggregate?.station.activeMatchId
        ? aggregate.matches[aggregate.station.activeMatchId]
        : undefined;
      if (!aggregate || !match || (aggregate.station.phase !== 'LAUNCHING'
        && aggregate.station.phase !== 'PLAYING') || match.game !== game || match.engineRoomCode !== roomCode) {
        this.terminalEngines.delete(key);
        return;
      }
      await this.applyEngineTerminal(aggregate, match, this.terminalEngines.get(key) ?? 'abandoned');
      this.terminalEngines.delete(key);
      this.startedEngines.delete(key);
      this.engineResults.delete(key);
    });
  }

  private enqueueReconcile(): void {
    if (!this.started || this.stopped) return;
    this.pending = this.pending.then(() => this.reconcile()).catch(error => {
      this.report(error);
      if (this.started && !this.stopped) this.scheduleRetry();
    });
  }

  private async reconcile(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.cancelTimer();
    for (let transitions = 0; transitions < 16; transitions += 1) {
      const aggregate = await this.service.getStation(this.stationIdSource());
      if (!aggregate || this.stopped) return;
      const enabled = this.enabled();
      if (this.recoverOnStart && enabled) {
        this.recoverOnStart = false;
        if (aggregate.station.phase === 'LAUNCHING' || aggregate.station.phase === 'PLAYING') {
          try {
            const match = aggregate.station.activeMatchId
              ? aggregate.matches[aggregate.station.activeMatchId]
              : undefined;
            await this.service.recoverStationAfterRestart({
              stationId: aggregate.station.id,
              expectedRevision: aggregate.station.revision,
              idempotencyKey: engineIdempotencyKey(
                'restart', aggregate.station.activeMatchId ?? aggregate.station.activeRoundId ?? 'station',
                aggregate.matches[aggregate.station.activeMatchId ?? '']?.launchGeneration ?? 1,
              ),
              authorization: this.systemAuthorization(),
              reason: 'recover persisted station after process restart',
            });
            if (match) this.onMatchRemoved?.(match.game, match.engineRoomCode);
            continue;
          } catch (error) {
            if (isRevisionRace(error)) continue;
            throw error;
          }
        }
      }
      const activeMatch = aggregate.station.activeMatchId
        ? aggregate.matches[aggregate.station.activeMatchId]
        : undefined;
      const activeEngineKey = activeMatch ? engineKey(activeMatch.game, activeMatch.engineRoomCode) : null;
      for (const key of this.startedEngines) if (key !== activeEngineKey) this.startedEngines.delete(key);
      for (const key of this.terminalEngines.keys()) if (key !== activeEngineKey) {
        this.terminalEngines.delete(key);
        this.engineResults.delete(key);
      }
      const activeParticipants = new Set(activeMatch?.participantReadyEntryIds ?? []);
      for (const id of this.connectedReadyEntries.keys()) if (!activeParticipants.has(id)) this.connectedReadyEntries.delete(id);
      const terminalAction = activeEngineKey ? this.terminalEngines.get(activeEngineKey) : undefined;
      if (activeMatch && terminalAction
        && (aggregate.station.phase === 'LAUNCHING' || aggregate.station.phase === 'PLAYING')) {
        try {
          await this.applyEngineTerminal(aggregate, activeMatch, terminalAction);
          this.terminalEngines.delete(activeEngineKey!);
          this.startedEngines.delete(activeEngineKey!);
          this.engineResults.delete(activeEngineKey!);
          continue;
        } catch (error) {
          if (isRevisionRace(error)) continue;
          throw error;
        }
      }
      if (!enabled) return;
      if (aggregate.station.phase === 'LAUNCHING' && activeMatch?.displayReadyAt
        && !terminalAction
        && !launchDeadlineElapsed(activeMatch, this.config(), this.clock())
        && this.startedEngines.has(engineKey(activeMatch.game, activeMatch.engineRoomCode))
        && activeMatch.participantReadyEntryIds.every(id => this.connectedReadyEntries.has(id))) {
        try {
          const enginePlayerIdsByReadyEntryId = Object.fromEntries(
            activeMatch.participantReadyEntryIds.map(id => [id, this.connectedReadyEntries.get(id)!]),
          );
          await this.service.startStationMatch({
            stationId: aggregate.station.id,
            expectedRevision: aggregate.station.revision,
            idempotencyKey: engineIdempotencyKey('start', activeMatch.id, activeMatch.launchGeneration),
            authorization: this.systemAuthorization(),
            reason: 'authoritative game engine started',
            enginePlayerIdsByReadyEntryId,
          });
          for (const [readyEntryId, enginePlayerId] of Object.entries(enginePlayerIdsByReadyEntryId)) {
            this.canonicalEngineIdByReadyEntry.set(readyEntryId, enginePlayerId);
            this.canonicalEngineIdByCurrentId.set(enginePlayerId, enginePlayerId);
          }
          continue;
        } catch (error) {
          if (isRevisionRace(error)) continue;
          throw error;
        }
      }
      const scheduled = nextStationTransition(aggregate, this.config());
      if (!scheduled) return;
      const delay = scheduled.at - this.clock();
      if (delay > 0) {
        this.timer = this.setTimer(() => {
          this.timer = null;
          this.enqueueReconcile();
        }, Math.min(delay, 2_147_483_647));
        this.timer.unref?.();
        return;
      }
      try {
        await this.applyTransition(aggregate, scheduled);
      } catch (error) {
        if (isRevisionRace(error)) continue;
        throw error;
      }
    }
    throw new Error('Twilio Games station runtime exceeded its overdue transition limit');
  }

  private async applyTransition(
    aggregate: ArcadeStationAggregate,
    transition: ScheduledTransition,
  ): Promise<StationMutationResult> {
    const stationId = aggregate.station.id;
    const expectedRevision = aggregate.station.revision;
    const authorization = this.systemAuthorization();
    const idempotencyKey = timerIdempotencyKey(stationId, transition.phase, expectedRevision, transition.at);
    const common = {
      stationId, expectedRevision, idempotencyKey, authorization,
      reason: `automatic ${transition.phase.toLowerCase()} deadline`,
      // The deadline controls when a transition is due, but later writes may already have advanced
      // station chronology. Apply at the current logical time so an overdue timer cannot wedge.
      occurredAt: new Date(Math.max(transition.at, Date.parse(aggregate.station.updatedAt))).toISOString(),
    };
    if (transition.phase === 'RECRUITING') return this.service.closeStationRecruiting(common);
    if (transition.phase === 'GAME_SELECTION') {
      const game = chooseStationGame(aggregate, this.config().station);
      return this.service.selectStationGame({
        ...common,
        game,
        engineRoomCode: this.engineRoomCode(game, expectedRevision),
      });
    }
    if (transition.phase === 'LOCKED') return this.service.requestStationLaunch(common);
    if (transition.phase === 'LAUNCHING') {
      const match = aggregate.station.activeMatchId
        ? aggregate.matches[aggregate.station.activeMatchId]
        : undefined;
      const disconnected = match?.participantReadyEntryIds.find(
        readyEntryId => !this.connectedReadyEntries.has(readyEntryId),
      );
      if (match && disconnected && match.overflowReadyEntryIds.length > 0) {
        return this.service.dropStationAdmittedEntry({
          stationId,
          readyEntryId: disconnected,
          expectedRevision,
          idempotencyKey: engineIdempotencyKey('no-show-drop', match.id, match.launchGeneration),
          authorization,
          reason: 'automatic launch-time no-show replacement',
        });
      }
      const result = await this.service.failStationLaunch(common);
      if (match) this.onMatchRemoved?.(match.game, match.engineRoomCode);
      return result;
    }
    return Promise.reject(new Error(`unsupported scheduled station phase ${transition.phase}`));
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Runtime error reporting must not break later event reconciliation.
    }
  }

  private applyEngineTerminal(
    aggregate: ArcadeStationAggregate,
    match: ArcadeStationAggregate['matches'][string],
    action: 'completed' | 'abandoned',
  ): Promise<StationMutationResult> {
    if (aggregate.station.phase === 'LAUNCHING') {
      return this.service.failStationLaunch({
        stationId: aggregate.station.id,
        expectedRevision: aggregate.station.revision,
        idempotencyKey: engineIdempotencyKey(
          action === 'completed' ? 'early-complete' : 'launch-abandoned',
          match.id,
          match.launchGeneration,
        ),
        authorization: this.systemAuthorization(),
        reason: action === 'completed'
          ? 'game engine ended before all launch participants connected'
          : 'game engine abandoned before launch completed',
      }).then(result => {
        this.onMatchRemoved?.(match.game, match.engineRoomCode);
        return result;
      });
    }
    if (action === 'completed') {
      const engineResults = this.engineResults.get(engineKey(match.game, match.engineRoomCode));
      const correlatedResults = engineResults?.length
        ? Object.entries(match.enginePlayerIdsByReadyEntryId).map(([readyEntryId, originalEngineId]) => {
          const currentEngineId = this.connectedReadyEntries.get(readyEntryId) ?? originalEngineId;
          const result = engineResults.find(item => item.enginePlayerId === currentEngineId)
            ?? engineResults.find(item => item.enginePlayerId === originalEngineId);
          return result ? { ...result, enginePlayerId: originalEngineId } : {
            enginePlayerId: originalEngineId,
            rank: null,
            completed: false,
            won: null,
            score: null,
            durationSeconds: null,
          };
        })
        : undefined;
      return this.service.completeStationMatch({
        stationId: aggregate.station.id,
        expectedRevision: aggregate.station.revision,
        idempotencyKey: engineIdempotencyKey('complete', match.id, match.launchGeneration),
        authorization: this.systemAuthorization(),
        reason: 'authoritative game engine completed',
        ...(correlatedResults ? { engineResults: correlatedResults, resultSource: 'ENGINE' as const } : {
          resultSource: 'LEGACY_UNAVAILABLE' as const,
        }),
      });
    }
    return this.service.recoverStationAfterRestart({
      stationId: aggregate.station.id,
      expectedRevision: aggregate.station.revision,
      idempotencyKey: engineIdempotencyKey('abandoned', match.id, match.launchGeneration),
      authorization: this.systemAuthorization(),
      reason: 'authoritative game engine abandoned active match',
    });
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation);
    this.pending = result.catch(error => {
      this.report(error);
      if (this.started && !this.stopped) this.scheduleRetry();
    });
    return result;
  }

  private scheduleRetry(): void {
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.enqueueReconcile();
    }, 1_000);
    this.timer.unref?.();
  }
}

export function chooseStationGame(
  aggregate: ArcadeStationAggregate,
  stationConfig: StationSettings = DEFAULT_ARCADE_CONFIG.station,
): PlayableArcadeGame {
  const roundId = aggregate.station.activeRoundId;
  const readyCount = roundId
    ? Object.values(aggregate.readyEntries).filter(entry => entry.roundId === roundId && entry.status === 'READY').length
    : 0;
  const enabledOrder = stationConfig.automaticSelection.order.filter(game => stationConfig.games[game].enabled);
  if (!enabledOrder.length) throw new Error('Twilio Games station has no enabled games');
  const round = roundId ? aggregate.rounds[roundId] : undefined;
  const liveReadyIds = new Set(Object.values(aggregate.readyEntries)
    .filter(entry => entry.roundId === roundId && entry.status === 'READY')
    .map(entry => entry.id));
  const votes = new Map(enabledOrder.map(game => [game, 0]));
  for (const [readyEntryId, game] of Object.entries(round?.gameChoicesByReadyEntryId ?? {})) {
    if (liveReadyIds.has(readyEntryId) && votes.has(game)) votes.set(game, votes.get(game)! + 1);
  }
  const highestVoteCount = Math.max(0, ...votes.values());
  const eligible = highestVoteCount > 0
    ? enabledOrder.filter(game => votes.get(game) === highestVoteCount)
    : enabledOrder;
  return chooseByAutomaticPolicy(aggregate, stationConfig, eligible, readyCount);
}

function chooseByAutomaticPolicy(
  aggregate: ArcadeStationAggregate,
  stationConfig: StationSettings,
  eligibleGames: readonly PlayableArcadeGame[],
  readyCount: number,
): PlayableArcadeGame {
  const allEnabledOrder = stationConfig.automaticSelection.order.filter(game => stationConfig.games[game].enabled);
  const enabledOrder = allEnabledOrder.filter(game => eligibleGames.includes(game));
  if (!enabledOrder.length) throw new Error('Twilio Games station has no eligible enabled games');
  if (stationConfig.automaticSelection.policy === 'fixed_priority') return enabledOrder[0]!;
  if (stationConfig.automaticSelection.policy === 'round_robin') {
    const latest = Object.values(aggregate.matches).at(-1);
    const previousIndex = latest ? allEnabledOrder.indexOf(latest.game) : -1;
    for (let offset = 1; offset <= allEnabledOrder.length; offset += 1) {
      const game = allEnabledOrder[(previousIndex + offset) % allEnabledOrder.length]!;
      if (eligibleGames.includes(game)) return game;
    }
  }
  const usage = new Map<PlayableArcadeGame, number>();
  const order = new Map(enabledOrder.map((game, index) => [game, index]));
  for (const game of PLAYABLE_ARCADE_GAMES) usage.set(game.id, 0);
  for (const match of Object.values(aggregate.matches)) {
    usage.set(match.game, (usage.get(match.game) ?? 0) + 1);
  }
  return PLAYABLE_ARCADE_GAMES.filter(game => enabledOrder.includes(game.id)).sort((left, right) => {
    const leftAdmitted = Math.min(readyCount, left.humanCapacity);
    const rightAdmitted = Math.min(readyCount, right.humanCapacity);
    return rightAdmitted - leftAdmitted
      || (usage.get(left.id) ?? 0) - (usage.get(right.id) ?? 0)
      || order.get(left.id)! - order.get(right.id)!;
  })[0]!.id;
}

function nextStationTransition(
  aggregate: ArcadeStationAggregate,
  config: ArcadeConfigSnapshot,
): ScheduledTransition | null {
  const round = aggregate.station.activeRoundId ? aggregate.rounds[aggregate.station.activeRoundId] : undefined;
  if (!round) return null;
  let timestamp: string | null = null;
  if (aggregate.station.phase === 'RECRUITING') {
    timestamp = earlierTimestamp(round.recruitingEndsAt, round.hardEndsAt);
  } else if (aggregate.station.phase === 'GAME_SELECTION') {
    timestamp = round.selectionEndsAt;
  } else if (aggregate.station.phase === 'LOCKED') {
    timestamp = round.lockedEndsAt;
  } else if (aggregate.station.phase === 'LAUNCHING') {
    const match = aggregate.station.activeMatchId ? aggregate.matches[aggregate.station.activeMatchId] : undefined;
    timestamp = match?.launchRequestedAt
      ? new Date(Date.parse(match.launchRequestedAt) + config.station.timings.launchTimeoutSeconds * 1000).toISOString()
      : null;
  }
  if (!timestamp) return null;
  const at = Date.parse(timestamp);
  return Number.isFinite(at) ? { at, phase: aggregate.station.phase } : null;
}

function earlierTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function timerIdempotencyKey(stationId: string, phase: string, revision: number, at: number): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([stationId, phase, revision, at]))
    .digest('hex');
  return `station-timer:${digest}`;
}

function isRevisionRace(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === 'REVISION_CONFLICT';
}

function engineKey(game: PlayableArcadeGame, roomCode: string): string {
  return `${game}\0${roomCode}`;
}

function engineIdempotencyKey(action: string, matchId: string, generation: number): string {
  const digest = createHash('sha256').update(JSON.stringify([action, matchId, generation])).digest('hex');
  return `station-engine:${digest}`;
}

function launchDeadlineElapsed(
  match: ArcadeStationAggregate['matches'][string],
  config: ArcadeConfigSnapshot,
  now: number,
): boolean {
  return match.launchRequestedAt !== null
    && Date.parse(match.launchRequestedAt) + config.station.timings.launchTimeoutSeconds * 1_000 <= now;
}
