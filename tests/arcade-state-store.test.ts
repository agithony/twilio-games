import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ARCADE_CONFIG, parseArcadeConfig } from '../shared/arcade-config';
import { createWallet, grantRegistrationCoins, reserveCoins } from '../shared/arcade-domain';
import { joinQueue } from '../shared/arcade-queue';
import {
  closeStationRecruiting,
  completeStationMatch,
  createArcadeStation,
  insertStationCoin,
  markStationDisplayReady,
  markStationMatchStarted,
  requestStationLaunch,
  selectStationGame,
} from '../shared/arcade-station';
import {
  ARCADE_STATE_SCHEMA_VERSION,
  ArcadeStateStore,
  type ArcadePlayerRecord,
  type ArcadeStateFileSystem,
} from '../server/arcade-state-store';
import { ArcadeService } from '../server/arcade-service';

const directories: string[] = [];
const T0 = '2026-07-20T10:00:00.000Z';

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function stateFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcade-state-'));
  directories.push(directory);
  return path.join(directory, 'nested', 'state.json');
}

function player(id: string): ArcadePlayerRecord {
  return {
    id,
    createdAt: T0,
    updatedAt: T0,
    lead: null,
    preferredLocale: null,
    conversationProfileId: null,
    crmLeadId: null,
    termsAcceptedAt: null,
    marketingConsent: false,
    trustedDestination: null,
  };
}

function addPlayer(id: string) {
  return (state: ReturnType<ArcadeStateStore['snapshot']>) => {
    state.players[id] = player(id);
    state.wallets[id] = createWallet(id, T0);
  };
}

function addReadyPlayer(state: ReturnType<ArcadeStateStore['snapshot']>): void {
  addPlayer('p1')(state);
  const funded = grantRegistrationCoins(state.wallets.p1!, {
    amount: 2, transactionId: 'tx-grant', idempotencyKey: 'grant-p1',
    createdAt: T0, configVersion: 1,
  });
  state.wallets.p1 = reserveCoins(funded, {
    reservationId: 'reservation-1', queueEntryId: 'ready-1', amount: 1,
    transactionId: 'tx-reserve', idempotencyKey: 'reserve-p1',
    createdAt: T0, configVersion: 1,
  });
  const aggregate = insertStationCoin(createArcadeStation('expo', T0), {
    readyEntryId: 'ready-1', roundId: 'round-1', playerId: 'p1',
    reservationId: 'reservation-1', at: T0, configVersion: 1, expectedRevision: 1,
  });
  state.stations.expo = aggregate.station;
  Object.assign(state.stationRounds, aggregate.rounds);
  Object.assign(state.stationReadyEntries, aggregate.readyEntries);
}

function failingRenameFileSystem(): {
  fs: ArcadeStateFileSystem;
  fail: () => void;
  failDirectorySync: () => void;
} {
  let shouldFail = false;
  let shouldFailDirectorySync = false;
  return {
    fail: () => { shouldFail = true; },
    failDirectorySync: () => { shouldFailDirectorySync = true; },
    fs: {
      mkdir,
      readFile,
      open: async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        return {
          writeFile: (data, encoding) => handle.writeFile(data, encoding),
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
      rename: async (from, to) => {
        if (shouldFail) throw new Error('injected rename failure');
        await rename(from, to);
      },
      unlink,
      syncDirectory: async () => {
        if (shouldFailDirectorySync) throw new Error('injected directory sync failure');
      },
    },
  };
}

describe('ArcadeStateStore', () => {
  it('fails closed until the store has loaded successfully', async () => {
    const file = await stateFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{not json');
    const store = new ArcadeStateStore(file);

    expect(() => store.snapshot()).toThrow(/loaded successfully/);
    await expect(store.transaction(addPlayer('p1'))).rejects.toMatchObject({ code: 'STORE_NOT_INITIALIZED' });
    await expect(store.load()).rejects.toMatchObject({ code: 'INVALID_JSON' });
    await expect(store.transaction(addPlayer('p1'))).rejects.toMatchObject({ code: 'STORE_NOT_INITIALIZED' });
  });

  it('persists schema-v7 state and restores it after restart', async () => {
    const file = await stateFile();
    const first = await ArcadeStateStore.open(file);
    await first.transaction(addPlayer('trusted:p1'));

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk.schemaVersion).toBe(ARCADE_STATE_SCHEMA_VERSION);
    expect(Object.keys(onDisk)).toEqual([
      'schemaVersion', 'players', 'wallets', 'queueEntries', 'queueEntryConfigs',
      'queueEvents', 'idempotencyRecords', 'stations', 'stationRounds',
      'stationReadyEntries', 'stationMatches', 'channelAddresses', 'messagingDrafts',
      'inboundMessages', 'stationReadyChannels', 'outboundNotifications', 'messagingAuditEvents',
      'stationControlEvents',
    ]);

    const restarted = await ArcadeStateStore.open(file);
    expect(restarted.snapshot().players['trusted:p1']?.id).toBe('trusted:p1');
    expect(restarted.snapshot().wallets['trusted:p1']?.wallet.cachedBalance).toBe(0);
  });

  it('migrates schema-v1 state losslessly and writes schema v7 on the next transaction', async () => {
    const file = await stateFile();
    const first = await ArcadeStateStore.open(file);
    await first.transaction(addPlayer('p1'));
    const legacy = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.stations;
    delete legacy.stationRounds;
    delete legacy.stationReadyEntries;
    delete legacy.stationMatches;
    delete legacy.channelAddresses;
    delete legacy.messagingDrafts;
    delete legacy.inboundMessages;
    delete legacy.stationReadyChannels;
    delete legacy.outboundNotifications;
    delete legacy.messagingAuditEvents;
    delete legacy.stationControlEvents;
    await writeFile(file, JSON.stringify(legacy));

    const migrated = await ArcadeStateStore.open(file);
    expect(migrated.snapshot().players.p1).toEqual(player('p1'));
    expect(migrated.snapshot().schemaVersion).toBe(ARCADE_STATE_SCHEMA_VERSION);
    expect(migrated.snapshot().stations).toEqual({});

    await migrated.transaction(() => undefined);
    const upgraded = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(upgraded.schemaVersion).toBe(7);
    expect(upgraded.stations).toEqual({});
  });

  it('migrates schema-v3 messaging state to an empty v7 outbox and audit', async () => {
    const file = await stateFile();
    const first = await ArcadeStateStore.open(file);
    await first.transaction(addPlayer('p1'));
    const legacy = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    legacy.schemaVersion = 3;
    delete legacy.stationReadyChannels;
    delete legacy.outboundNotifications;
    delete legacy.messagingAuditEvents;
    delete legacy.stationControlEvents;
    await writeFile(file, JSON.stringify(legacy));

    const migrated = await ArcadeStateStore.open(file);
    expect(migrated.snapshot()).toMatchObject({
      schemaVersion: 7,
      stationReadyChannels: {},
      outboundNotifications: {},
      messagingAuditEvents: {},
      stationControlEvents: [],
    });
  });

  it('migrates schema-v4 outbox state by adding a dedicated empty messaging audit', async () => {
    const file = await stateFile();
    const first = await ArcadeStateStore.open(file);
    await first.transaction(addPlayer('p1'));
    const legacy = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    legacy.schemaVersion = 4;
    delete legacy.messagingAuditEvents;
    await writeFile(file, JSON.stringify(legacy));

    const migrated = await ArcadeStateStore.open(file);
    expect(migrated.snapshot()).toMatchObject({
      schemaVersion: 7,
      players: { p1: player('p1') },
      outboundNotifications: {},
      messagingAuditEvents: {},
    });
  });

  it.each(['PLAYING', 'COMPLETED'] as const)('migrates a schema-v5 %s match into valid v7 state', async phase => {
    const file = await stateFile();
    const first = await ArcadeStateStore.open(file);
    await first.transaction(state => {
      addPlayer('p1')(state);
      let aggregate = insertStationCoin(createArcadeStation('expo', T0), {
        readyEntryId: 'ready-1', roundId: 'round-1', playerId: 'p1', reservationId: null,
        at: T0, configVersion: 1, expectedRevision: 1,
      });
      aggregate = closeStationRecruiting(aggregate, { at: T0, expectedRevision: 2 });
      aggregate = selectStationGame(aggregate, {
        game: 'racer', matchId: 'match-1', engineRoomCode: '4821', at: T0, expectedRevision: 3,
      });
      aggregate = requestStationLaunch(aggregate, { at: T0, expectedRevision: 4 });
      aggregate = markStationDisplayReady(aggregate, {
        at: T0, expectedRevision: 5,
      });
      aggregate = markStationMatchStarted(aggregate, {
        at: T0, expectedRevision: 6, redeemedReservationIds: [],
        enginePlayerIdsByReadyEntryId: { 'ready-1': 'engine-1' },
      });
      if (phase === 'COMPLETED') aggregate = completeStationMatch(aggregate, {
        at: T0, expectedRevision: 7,
        engineResults: [{
          enginePlayerId: 'engine-1', rank: 1, completed: true, won: true,
          score: 100, durationSeconds: 12,
        }],
      });
      state.stations.expo = aggregate.station;
      Object.assign(state.stationRounds, aggregate.rounds);
      Object.assign(state.stationReadyEntries, aggregate.readyEntries);
      Object.assign(state.stationMatches, aggregate.matches);
    });
    const legacy = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    legacy.schemaVersion = 5;
    for (const value of Object.values(legacy.stationMatches) as Array<Record<string, unknown>>) {
      delete value.enginePlayerIdsByReadyEntryId;
      delete value.result;
    }
    await writeFile(file, JSON.stringify(legacy));

    const migrated = await ArcadeStateStore.open(file);
    const match = migrated.snapshot().stationMatches['match-1'];
    expect(match).toMatchObject({
      phase, result: phase === 'COMPLETED' ? { source: 'LEGACY_UNAVAILABLE', participants: [] } : null,
    });
    expect(match?.enginePlayerIdsByReadyEntryId['ready-1']).toMatch(/^legacy:[a-f0-9]{32}$/);
  });

  it('migrates every schema-v6 round with an empty game choice map', async () => {
    const file = await stateFile();
    const first = await ArcadeStateStore.open(file);
    await first.transaction(addReadyPlayer);
    const legacy = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    legacy.stationRounds['round-closed'] = {
      ...legacy.stationRounds['round-1'],
      id: 'round-closed',
      phase: 'CLOSED',
      closedAt: T0,
    };
    legacy.schemaVersion = 6;
    for (const round of Object.values(legacy.stationRounds) as Array<Record<string, unknown>>) {
      delete round.gameChoicesByReadyEntryId;
    }
    await writeFile(file, JSON.stringify(legacy));

    const migrated = await ArcadeStateStore.open(file);
    expect(migrated.snapshot()).toMatchObject({
      schemaVersion: 7,
      stationRounds: {
        'round-1': { gameChoicesByReadyEntryId: {} },
        'round-closed': { gameChoicesByReadyEntryId: {} },
      },
    });
  });

  it('migrates embedded schema-v6 station results and replays them without touching unrelated results', async () => {
    const file = await stateFile();
    const first = await ArcadeStateStore.open(file);
    await first.transaction(addReadyPlayer);
    const legacy = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    const selected = closeStationRecruiting({
      station: legacy.stations.expo,
      rounds: legacy.stationRounds,
      readyEntries: legacy.stationReadyEntries,
      matches: legacy.stationMatches,
    }, { at: T0, expectedRevision: 2 });
    const selectedJson = JSON.parse(JSON.stringify(selected)) as typeof selected;
    legacy.stations.expo = selectedJson.station;
    legacy.stationRounds = selectedJson.rounds;
    const authorization = { trusted: true };
    const payload = {
      authorizedBy: { kind: 'system', subject: 'migration:test' },
      expectedRevision: 2,
      occurredAt: null,
      reason: null,
      stationId: 'expo',
    };
    legacy.idempotencyRecords['schema6-close-replay'] = {
      key: 'schema6-close-replay',
      operation: 'CLOSE_STATION_RECRUITING',
      playerId: null,
      fingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      result: { station: selectedJson.station, round: selectedJson.rounds['round-1'], match: null },
      configVersion: 1,
      createdAt: T0,
    };
    legacy.idempotencyRecords['schema6-unrelated'] = {
      key: 'schema6-unrelated',
      operation: 'REGISTER_PLAYER',
      playerId: 'p1',
      fingerprint: 'a'.repeat(64),
      result: { round: { sentinel: 'untouched' } },
      configVersion: 1,
      createdAt: T0,
    };
    legacy.schemaVersion = 6;
    delete legacy.stationRounds['round-1'].gameChoicesByReadyEntryId;
    delete legacy.idempotencyRecords['schema6-close-replay'].result.round.gameChoicesByReadyEntryId;
    await writeFile(file, JSON.stringify(legacy));

    const migrated = await ArcadeStateStore.open(file);
    const snapshot = migrated.snapshot();
    expect((snapshot.idempotencyRecords['schema6-close-replay']?.result as Record<string, any>).round)
      .toMatchObject({ gameChoicesByReadyEntryId: {} });
    expect(snapshot.idempotencyRecords['schema6-unrelated']?.result)
      .toEqual({ round: { sentinel: 'untouched' } });

    const configInput = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
    configInput.arcade.mode = 'coin_only';
    const service = new ArcadeService({
      store: migrated,
      config: parseArcadeConfig(configInput),
      clock: () => T0,
      idGenerator: kind => `unused-${kind}`,
      challengeTokenSecret: '0123456789abcdef0123456789abcdef',
      operatorAuthorizer: value => value === authorization
        ? { kind: 'system', subject: 'migration:test' }
        : null,
    });
    const replay = await service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: 2,
      idempotencyKey: 'schema6-close-replay', authorization,
    });
    expect(replay.round?.gameChoicesByReadyEntryId).toEqual({});
  });

  it('restores a station recruiting round and its reserved coin after restart', async () => {
    const file = await stateFile();
    const first = await ArcadeStateStore.open(file);
    await first.transaction(addReadyPlayer);

    const restarted = await ArcadeStateStore.open(file);
    const snapshot = restarted.snapshot();
    expect(snapshot.stations.expo?.phase).toBe('RECRUITING');
    expect(snapshot.stationRounds['round-1']?.phase).toBe('RECRUITING');
    expect(snapshot.stationReadyEntries['ready-1']?.status).toBe('READY');
    expect(snapshot.wallets.p1?.reservations[0]).toMatchObject({
      id: 'reservation-1', queueEntryId: 'ready-1', status: 'ACTIVE',
    });
  });

  it('serializes concurrent copy-on-write transactions without losing updates', async () => {
    const file = await stateFile();
    const store = await ArcadeStateStore.open(file);
    const order: string[] = [];
    await Promise.all([
      store.transaction(async state => {
        await new Promise(resolve => setTimeout(resolve, 15));
        addPlayer('p1')(state);
        order.push('first');
      }),
      store.transaction(state => {
        addPlayer('p2')(state);
        order.push('second');
      }),
    ]);

    expect(order).toEqual(['first', 'second']);
    expect(Object.keys(store.snapshot().players).sort()).toEqual(['p1', 'p2']);
    expect(Object.keys((await ArcadeStateStore.open(file)).snapshot().players).sort()).toEqual(['p1', 'p2']);
  });

  it('runs serialized state checks without writing an unchanged snapshot', async () => {
    const file = await stateFile();
    const store = await ArcadeStateStore.open(file);
    const result = await store.runExclusive(state => {
      expect(Object.isFrozen(state)).toBe(true);
      expect(state.stations).toEqual({});
      return 'checked';
    });
    expect(result).toBe('checked');
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps committed memory and disk unchanged when the atomic write fails', async () => {
    const file = await stateFile();
    const injected = failingRenameFileSystem();
    const store = await ArcadeStateStore.open(file, { fileSystem: injected.fs, temporaryId: () => 'unique' });
    await store.transaction(addPlayer('p1'));
    const before = store.snapshot();
    injected.fail();

    await expect(store.transaction(addPlayer('p2'))).rejects.toThrow('injected rename failure');
    await expect(store.flush()).rejects.toThrow('injected rename failure');
    expect(store.snapshot()).toEqual(before);
    expect((await ArcadeStateStore.open(file)).snapshot()).toEqual(before);
  });

  it('fails closed when durability cannot be confirmed after rename', async () => {
    const file = await stateFile();
    const injected = failingRenameFileSystem();
    const store = await ArcadeStateStore.open(file, { fileSystem: injected.fs, temporaryId: () => 'unique' });
    injected.failDirectorySync();

    await expect(store.transaction(addPlayer('p1')))
      .rejects.toMatchObject({ code: 'DIRECTORY_SYNC_FAILED' });
    expect(() => store.snapshot()).toThrow(/loaded successfully/);
    expect((await ArcadeStateStore.open(file)).snapshot().players.p1).toBeDefined();
  });

  it('discards a failed mutation and continues processing later transactions', async () => {
    const file = await stateFile();
    const store = await ArcadeStateStore.open(file);
    await expect(store.transaction(state => {
      addPlayer('discarded')(state);
      throw new Error('mutation failed');
    })).rejects.toThrow('mutation failed');
    await store.transaction(addPlayer('committed'));
    expect(store.snapshot().players.discarded).toBeUndefined();
    expect(store.snapshot().players.committed).toBeDefined();
  });

  it('flushes cleanly after a rejected business mutation', async () => {
    const file = await stateFile();
    const store = await ArcadeStateStore.open(file);
    await expect(store.transaction(() => { throw new Error('rejected mutation'); }))
      .rejects.toThrow('rejected mutation');
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it('returns deeply frozen detached snapshots', async () => {
    const file = await stateFile();
    const store = await ArcadeStateStore.open(file);
    await store.transaction(addPlayer('p1'));
    const snapshot = store.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.players.p1)).toBe(true);
    expect(() => { (snapshot.players.p1 as { id: string }).id = 'changed'; }).toThrow();
    expect(store.snapshot().players.p1?.id).toBe('p1');
  });

  it('fails closed when persisted exact shapes or enums are malformed', async () => {
    const file = await stateFile();
    const store = await ArcadeStateStore.open(file);
    await store.transaction(state => {
      addPlayer('p1')(state);
      const reduction = joinQueue([], {
        id: 'queue-1', eventId: 'event-1', cabinetId: 'ARCADE-01', playerId: 'p1',
        preferredGame: 'racer', flexibleGame: false, joinedAt: T0, configVersion: 1,
      });
      state.queueEntries[reduction.entry.id] = reduction.entry;
      state.queueEvents.push(reduction.event);
    });
    const malformed = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    malformed.queueEntries['queue-1'].status = 'ADMIN';
    await writeFile(file, JSON.stringify(malformed));
    await expect(ArcadeStateStore.open(file)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    malformed.queueEntries['queue-1'].status = 'WAITING';
    malformed.players.p1.unexpected = true;
    await writeFile(file, JSON.stringify(malformed));
    await expect(ArcadeStateStore.open(file)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('rejects corrupted station ownership and reservation bindings', async () => {
    const file = await stateFile();
    const store = await ArcadeStateStore.open(file);
    await store.transaction(addReadyPlayer);
    const malformed = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    malformed.stationReadyEntries['ready-1'].reservationId = 'missing';
    await writeFile(file, JSON.stringify(malformed));

    await expect(ArcadeStateStore.open(file)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('requires the exact schema-v7 round choice map', async () => {
    const file = await stateFile();
    const store = await ArcadeStateStore.open(file);
    await store.transaction(addReadyPlayer);
    const malformed = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    delete malformed.stationRounds['round-1'].gameChoicesByReadyEntryId;
    await writeFile(file, JSON.stringify(malformed));

    await expect(ArcadeStateStore.open(file)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('rejects admitted station entries without an active match', async () => {
    const file = await stateFile();
    const store = await ArcadeStateStore.open(file);
    await store.transaction(addReadyPlayer);
    const malformed = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    malformed.stationReadyEntries['ready-1'].status = 'ADMITTED';
    await writeFile(file, JSON.stringify(malformed));

    await expect(ArcadeStateStore.open(file)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('rejects duplicate live entries and semantically invalid queue events', async () => {
    const file = await stateFile();
    const store = await ArcadeStateStore.open(file);
    await expect(store.transaction(state => {
      addPlayer('p1')(state);
      const reduction = joinQueue([], {
        id: 'queue-1', eventId: 'event-1', cabinetId: 'ARCADE-01', playerId: 'p1',
        preferredGame: 'racer', flexibleGame: false, joinedAt: T0, configVersion: 1,
      });
      state.queueEntries['queue-1'] = reduction.entry;
      state.queueEntries['queue-2'] = { ...reduction.entry, id: 'queue-2' };
      state.queueEvents.push(reduction.event);
    })).rejects.toThrow(/multiple live entries/);

    await expect(store.transaction(state => {
      addPlayer('p1')(state);
      const reduction = joinQueue([], {
        id: 'queue-1', eventId: 'event-1', cabinetId: 'ARCADE-01', playerId: 'p1',
        preferredGame: 'racer', flexibleGame: false, joinedAt: T0, configVersion: 1,
      });
      state.queueEntries['queue-1'] = reduction.entry;
      state.queueEvents.push({ ...reduction.event, fromStatus: 'WAITING' });
    })).rejects.toThrow(/QUEUE_JOINED has invalid statuses/);
  });

  it('rejects unsafe or oversized temporary IDs before creating a temp file', async () => {
    const file = await stateFile();
    const store = await ArcadeStateStore.open(file, { temporaryId: () => '../escape' });
    await expect(store.transaction(addPlayer('p1')))
      .rejects.toMatchObject({ code: 'INVALID_TEMPORARY_ID' });
    expect(store.snapshot().players.p1).toBeUndefined();
  });
});
