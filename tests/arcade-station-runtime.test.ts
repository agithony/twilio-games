import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ARCADE_CONFIG, parseArcadeConfig } from '../shared/arcade-config';
import { ArcadeEventHub, createArcadeStationUpdatedEvent } from '../server/arcade-events';
import { ArcadeService } from '../server/arcade-service';
import { ArcadeStateStore } from '../server/arcade-state-store';
import { ArcadeStationRuntime } from '../server/arcade-station-runtime';

const directories: string[] = [];
const T0 = Date.parse('2026-07-20T10:00:00.000Z');
const TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
const AUTHORIZATION = Object.freeze({ trusted: true });
const OPERATOR_AUTHORIZATION = Object.freeze({ operator: true });

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function harness(configure?: (input: Record<string, any>) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcade-station-runtime-'));
  directories.push(directory);
  const store = await ArcadeStateStore.open(path.join(directory, 'state.json'));
  const input = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
  input.arcade.mode = 'coin_only';
  input.coins.startingBalance = 2;
  configure?.(input);
  const config = parseArcadeConfig(input);
  const events = new ArcadeEventHub();
  let now = T0;
  let sequence = 0;
  let scheduled: { handle: NodeJS.Timeout; callback: () => void; delayMs: number } | null = null;
  const removedMatches: Array<{ game: string; roomCode: string }> = [];
  const runtimeErrors: unknown[] = [];
  const service = new ArcadeService({
    store,
    config,
    clock: () => now,
    idGenerator: kind => `${kind}-${++sequence}`,
    challengeTokenSecret: TOKEN_SECRET,
    operatorAuthorizer: authorization => authorization === AUTHORIZATION
      ? { kind: 'system', subject: 'runtime:test' }
      : authorization === OPERATOR_AUTHORIZATION
        ? { kind: 'operator', subject: 'operator@twilio.com' }
        : null,
    stationUpdated: revision => events.publish(createArcadeStationUpdatedEvent(revision)),
  });
  const makeRuntime = () => new ArcadeStationRuntime({
    service,
    events,
    stationId: () => 'expo',
    systemAuthorization: () => AUTHORIZATION,
    config: () => config,
    clock: () => now,
    setTimer: (callback, delayMs) => {
      const handle = setTimeout(() => undefined, 2_147_483_647);
      handle.unref();
      scheduled = { handle, callback, delayMs };
      return handle;
    },
    clearTimer: handle => {
      clearTimeout(handle);
      if (scheduled?.handle === handle) scheduled = null;
    },
    onMatchRemoved: (game, roomCode) => removedMatches.push({ game, roomCode }),
    onError: error => runtimeErrors.push(error),
  });
  return {
    store,
    service,
    makeRuntime,
    setTime: (value: number) => { now = value; },
    scheduled: () => scheduled,
    removedMatches,
    runtimeErrors,
    fire: () => {
      const current = scheduled;
      if (!current) throw new Error('no station timer is scheduled');
      clearTimeout(current.handle);
      scheduled = null;
      current.callback();
    },
  };
}

describe('ArcadeStationRuntime', () => {
  it('recovers an overdue recruiting deadline and advances later deadlines deterministically', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    h.setTime(T0 + 91_000);
    const runtime = h.makeRuntime();

    await runtime.start();
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('GAME_SELECTION');
    expect(h.scheduled()?.delayMs).toBe(29_000);

    h.setTime(T0 + 122_000);
    h.fire();
    await runtime.flush();
    expect(await h.service.getStation('expo')).toMatchObject({
      station: { phase: 'LOCKED', activeGame: 'racer' },
    });
    expect(h.scheduled()?.delayMs).toBe(8_000);

    h.setTime(T0 + 133_000);
    h.fire();
    await runtime.flush();
    const launching = await h.service.getStation('expo');
    expect(launching?.station.phase).toBe('LAUNCHING');
    expect(h.scheduled()?.delayMs).toBe(117_000);

    await runtime.markEngineStarted('racer', launching!.matches[launching!.station.activeMatchId!]!.engineRoomCode);
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('LAUNCHING');
    const activeMatch = launching!.matches[launching!.station.activeMatchId!]!;
    runtime.markParticipantConnected(activeMatch.participantReadyEntryIds[0]!);
    await runtime.markDisplayReady({
      matchId: activeMatch.id,
      launchGeneration: activeMatch.launchGeneration,
      expectedRevision: launching!.station.revision,
      idempotencyKey: 'display-ready',
    });
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('PLAYING');

    await runtime.markEngineCompleted('racer', activeMatch.engineRoomCode);
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RESULTS');
    expect(h.scheduled()?.delayMs).toBe(10_000);
    h.setTime(T0 + 144_000);
    h.fire();
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('ATTRACT');
    await runtime.stop();
  });

  it('rebuilds its wakeup from persisted deadlines after restart', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const first = h.makeRuntime();
    await first.start();
    await first.flush();
    expect(h.scheduled()?.delayMs).toBe(90_000);
    await first.stop();

    h.setTime(T0 + 100_000);
    const restarted = h.makeRuntime();
    await restarted.start();
    await restarted.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('GAME_SELECTION');
    expect(h.scheduled()?.delayMs).toBe(20_000);
    await restarted.stop();
  });

  it('does not wedge an overdue recruiting timer after a later coin updates station chronology', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    h.setTime(T0 + 91_000);
    await h.service.identifyCoinOnly({ playerId: 'p2', idempotencyKey: 'identify:p2' });
    const later = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p2', idempotencyKey: 'coin:p2' });
    expect(later.readyEntry.roundId).not.toBe((await h.service.getStation('expo'))?.station.activeRoundId);
    const runtime = h.makeRuntime();

    await runtime.start();
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('GAME_SELECTION');
    expect(h.scheduled()?.delayMs).toBe(30_000);
    await runtime.stop();
  });

  it('returns an interrupted launch to recruiting without losing the hold', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });

    const restarted = h.makeRuntime();
    await restarted.start();
    await restarted.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RECRUITING');
    expect((await h.service.getWalletStatus('p1'))?.reservedBalance).toBe(1);
    expect(h.removedMatches).toEqual([{ game: 'racer', roomCode: '4821' }]);
    await restarted.stop();
  });

  it('reconciles a reset event by cancelling launch work and forgetting the old engine room', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'reset-identify:p1' });
    const coin = await h.service.insertStationCoin({
      stationId: 'expo', playerId: 'p1', idempotencyKey: 'reset-coin:p1',
    });
    const runtime = h.makeRuntime();
    await runtime.start();
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision,
      idempotencyKey: 'reset-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision,
      idempotencyKey: 'reset-select', authorization: AUTHORIZATION,
      game: 'racer', engineRoomCode: 'RESET-4821',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision,
      idempotencyKey: 'reset-launch', authorization: AUTHORIZATION,
    });
    await runtime.markEngineStarted('racer', 'RESET-4821');
    runtime.markParticipantConnected(launching.match!.participantReadyEntryIds[0]!);
    await runtime.flush();
    expect(h.scheduled()).not.toBeNull();

    await h.service.resetStation({
      stationId: 'expo', expectedRevision: launching.station.revision,
      idempotencyKey: 'reset-emergency', authorization: OPERATOR_AUTHORIZATION,
      reason: 'cabinet emergency stop',
    });
    await runtime.flush();

    expect((await h.service.getStation('expo'))?.station.phase).toBe('ATTRACT');
    expect(h.scheduled()).toBeNull();
    expect((await h.service.getWalletStatus('p1'))).toMatchObject({ reservedBalance: 0, availableBalance: 2 });
    await runtime.markEngineCompleted('racer', 'RESET-4821');
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('ATTRACT');
    await runtime.stop();
  });

  it('fails a launch when the engine ends before every participant connects', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const runtime = h.makeRuntime();
    await runtime.start();
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    await runtime.markEngineCompleted('racer', '4821');
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RECRUITING');
    expect((await h.service.getWalletStatus('p1'))).toMatchObject({ reservedBalance: 1, availableBalance: 1 });
    expect(h.removedMatches).toEqual([{ game: 'racer', roomCode: '4821' }]);
    await runtime.stop();
  });

  it('fails an overdue launch instead of starting from late readiness signals', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const runtime = h.makeRuntime();
    await runtime.start();
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    await runtime.markDisplayReady({
      matchId: launching.match!.id,
      launchGeneration: launching.match!.launchGeneration,
      expectedRevision: launching.station.revision,
      idempotencyKey: 'late-display-ready',
    });
    h.setTime(T0 + 121_000);
    runtime.markParticipantConnected(launching.match!.participantReadyEntryIds[0]!);
    await runtime.markEngineStarted('racer', '4821');
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RECRUITING');
    expect(h.removedMatches).toEqual([{ game: 'racer', roomCode: '4821' }]);
    await runtime.stop();
  });

  it('automatically replaces a launch-time no-show with FIFO overflow', async () => {
    const h = await harness();
    for (let index = 1; index <= 5; index++) {
      await h.service.identifyCoinOnly({ playerId: `p${index}`, idempotencyKey: `identify:p${index}` });
      await h.service.insertStationCoin({ stationId: 'expo', playerId: `p${index}`, idempotencyKey: `coin:p${index}` });
    }
    const runtime = h.makeRuntime();await runtime.start();await runtime.flush();
    const aggregate = await h.service.getStation('expo');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: aggregate!.station.revision, idempotencyKey: 'auto-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'auto-select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: 'AUTO',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'auto-launch', authorization: AUTHORIZATION,
    });
    await runtime.markDisplayReady({
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      expectedRevision: launching.station.revision, idempotencyKey: 'auto-ready',
    });
    await runtime.markEngineStarted('racer','AUTO');
    const admitted=launching.match!.participantReadyEntryIds;
    for(const readyEntryId of admitted.slice(0,3))runtime.markParticipantConnected(readyEntryId);
    await runtime.flush();
    expect(h.scheduled()?.delayMs).toBe(120_000);
    h.setTime(T0+121_000);h.fire();await runtime.flush();
    const replaced=await h.service.getStation('expo');
    expect(h.runtimeErrors).toEqual([]);
    expect(replaced?.station.phase).toBe('LAUNCHING');
    expect(Object.values(replaced!.readyEntries).filter(entry=>entry.status==='LEFT').map(entry=>entry.id))
      .toEqual([admitted[3]]);
    expect(replaced?.matches[replaced.station.activeMatchId!]!.participantReadyEntryIds)
      .toContain(launching.match!.overflowReadyEntryIds[0]);
    expect(replaced?.matches[replaced.station.activeMatchId!]!.launchGeneration).toBe(2);
    expect(h.scheduled()?.delayMs).toBe(120_000);
    await runtime.stop();
  });

  it('replays a terminal engine event after a transient state transaction failure', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const runtime = h.makeRuntime();
    await runtime.start();
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    const ready = await h.service.markStationDisplayReady({
      stationId: 'expo', expectedRevision: launching.station.revision, idempotencyKey: 'ready',
      authorization: AUTHORIZATION, matchId: launching.match!.id,
      launchGeneration: launching.match!.launchGeneration,
    });
    await h.service.startStationMatch({
      stationId: 'expo', expectedRevision: ready.station.revision, idempotencyKey: 'start', authorization: AUTHORIZATION,
    });
    await runtime.flush();
    const transaction = h.store.transaction.bind(h.store);
    let failNextTransaction = true;
    h.store.transaction = async mutation => {
      if (failNextTransaction) {
        failNextTransaction = false;
        throw new Error('temporary persistence failure');
      }
      return transaction(mutation);
    };
    await expect(runtime.markEngineCompleted('racer', '4821')).rejects.toThrow('temporary persistence failure');
    expect((await h.service.getStation('expo'))?.station.phase).toBe('PLAYING');
    expect(h.scheduled()?.delayMs).toBe(1_000);
    h.setTime(T0 + 1_000);
    h.fire();
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RESULTS');
    await runtime.stop();
  });

  it('correlates Racer results after a participant reconnects with a new engine identity', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const runtime = h.makeRuntime();
    await runtime.start();
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    const readyEntryId = launching.match!.participantReadyEntryIds[0]!;
    const ready = await h.service.markStationDisplayReady({
      stationId: 'expo', expectedRevision: launching.station.revision, idempotencyKey: 'ready',
      authorization: AUTHORIZATION, matchId: launching.match!.id,
      launchGeneration: launching.match!.launchGeneration,
    });
    await h.service.startStationMatch({
      stationId: 'expo', expectedRevision: ready.station.revision, idempotencyKey: 'start',
      authorization: AUTHORIZATION, enginePlayerIdsByReadyEntryId: { [readyEntryId]: 'engine-old' },
    });
    runtime.markParticipantConnected(readyEntryId, 'engine-new');
    await runtime.markEngineCompleted('racer', '4821', [{
      enginePlayerId: 'engine-new', rank: 1, completed: true, won: true, score: 100, durationSeconds: 12,
    }]);
    const completed = await h.service.getStation('expo');
    expect(completed?.station.phase).toBe('RESULTS');
    expect(completed?.matches[completed.station.activeMatchId!]?.result?.participants[0]).toMatchObject({
      readyEntryId, enginePlayerId: 'engine-old', rank: 1, completed: true, score: 100,
    });
    await runtime.stop();
  });

  it('refunds an interrupted playing match during restart recovery', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    const ready = await h.service.markStationDisplayReady({
      stationId: 'expo', expectedRevision: launching.station.revision, idempotencyKey: 'ready',
      authorization: AUTHORIZATION, matchId: launching.match!.id,
      launchGeneration: launching.match!.launchGeneration,
    });
    await h.service.startStationMatch({
      stationId: 'expo', expectedRevision: ready.station.revision, idempotencyKey: 'start', authorization: AUTHORIZATION,
    });

    const restarted = h.makeRuntime();
    await restarted.start();
    await restarted.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RESULTS');
    expect((await h.service.getWalletStatus('p1'))).toMatchObject({
      reservedBalance: 0, availableBalance: 2,
    });
    expect(h.scheduled()?.delayMs).toBe(10_000);
    await restarted.stop();
  });

  it('uses configured timings and enabled-game fixed priority', async () => {
    const h = await harness(input => {
      input.station.timings.recruitingSeconds = 20;
      input.station.timings.hardDeadlineSeconds = 25;
      input.station.timings.postGameRecruitingSeconds = 20;
      input.station.games.racer.enabled = false;
      input.station.automaticSelection.policy = 'fixed_priority';
      input.station.automaticSelection.order = ['fighter', 'monsters', 'racer'];
    });
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const runtime = h.makeRuntime();
    await runtime.start();
    await runtime.flush();
    expect(h.scheduled()?.delayMs).toBe(20_000);
    h.setTime(T0 + 21_000);h.fire();await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('GAME_SELECTION');
    h.setTime(T0 + 52_000);h.fire();await runtime.flush();
    expect(await h.service.getStation('expo')).toMatchObject({
      station: { phase: 'LOCKED', activeGame: 'fighter' },
    });
    await runtime.stop();
  });
});
