import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ARCADE_CONFIG,
  parseArcadeConfig,
  type ArcadeConfigSnapshot,
} from '../shared/arcade-config';
import { ArcadeService } from '../server/arcade-service';
import { ArcadeStateStore } from '../server/arcade-state-store';

const directories: string[] = [];
const T0 = Date.parse('2026-07-20T10:00:00.000Z');
const TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
const CONTROL_AUTHORIZATION = Object.freeze({ token: 'station-controller' });
const OPERATOR_AUTHORIZATION = Object.freeze({ token: 'station-operator' });
const CONTROL = Object.freeze({ authorization: CONTROL_AUTHORIZATION });
const OPERATOR = Object.freeze({ authorization: OPERATOR_AUTHORIZATION });

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function stationConfig(input: {
  startingBalance?: number;
  version?: number;
  chargePolicy?: 'per_player' | 'free';
  mode?: 'coin_only' | 'off';
} = {}): ArcadeConfigSnapshot {
  const value = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
  value.version = input.version ?? 1;
  value.updatedAt = '2026-07-20T00:00:00.000Z';
  value.arcade.mode = input.mode ?? 'coin_only';
  value.coins.startingBalance = input.startingBalance ?? 2;
  value.coins.chargePolicy = input.chargePolicy ?? 'per_player';
  return parseArcadeConfig(value);
}

interface Harness {
  store: ArcadeStateStore;
  service: ArcadeService;
  advance: (milliseconds?: number) => void;
  setConfig: (config: ArcadeConfigSnapshot) => void;
  publishedRevisions: number[];
}

async function harness(initialConfig = stationConfig()): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcade-station-service-'));
  directories.push(directory);
  const store = await ArcadeStateStore.open(path.join(directory, 'state.json'));
  let now = T0;
  let sequence = 0;
  let config = initialConfig;
  const publishedRevisions: number[] = [];
  const service = new ArcadeService({
    store,
    config: () => config,
    clock: () => now,
    idGenerator: kind => `${kind}-${++sequence}`,
    challengeTokenSecret: TOKEN_SECRET,
    operatorAuthorizer: authorization => authorization === CONTROL_AUTHORIZATION
      ? { kind: 'system', subject: 'station:test' }
      : authorization === OPERATOR_AUTHORIZATION
        ? { kind: 'operator', subject: 'operator@twilio.com' }
        : null,
    stationUpdated: revision => publishedRevisions.push(revision),
  });
  return {
    store,
    service,
    advance: (milliseconds = 1_000) => { now += milliseconds; },
    setConfig: value => { config = value; },
    publishedRevisions,
  };
}

async function identify(h: Harness, ...playerIds: string[]): Promise<void> {
  for (const playerId of playerIds) {
    await h.service.identifyCoinOnly({ playerId, idempotencyKey: `identify:${playerId}` });
  }
}

async function coin(h: Harness, playerId: string) {
  h.advance();
  return h.service.insertStationCoin({
    stationId: 'expo', playerId, idempotencyKey: `coin:${playerId}`,
  });
}

describe('ArcadeService station journey', () => {
  it('serializes a duplicate first COIN into one round, hold, and ready entry', async () => {
    const h = await harness();
    await identify(h, 'p1');
    const command = { stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' };

    const [first, replay] = await Promise.all([
      h.service.insertStationCoin(command),
      h.service.insertStationCoin(command),
    ]);

    expect(replay).toEqual(first);
    const state = h.store.snapshot();
    expect(Object.keys(state.stationRounds)).toHaveLength(1);
    expect(Object.keys(state.stationReadyEntries)).toHaveLength(1);
    expect(state.wallets.p1?.reservations).toHaveLength(1);
    expect(await h.service.getWalletStatus('p1')).toMatchObject({ reservedBalance: 1, availableBalance: 1 });

    await expect(h.service.insertStationCoin({
      ...command, idempotencyKey: 'coin:p1:different',
    })).rejects.toMatchObject({ code: 'ACTIVE_RESERVATION_EXISTS' });
    expect(Object.keys(h.store.snapshot().stationReadyEntries)).toHaveLength(1);
  });

  it('releases the held coin atomically when a ready player leaves', async () => {
    const h = await harness();
    await identify(h, 'p1');
    const inserted = await coin(h, 'p1');
    h.advance();

    const left = await h.service.leaveStationReadyEntry({
      stationId: 'expo', playerId: 'p1', readyEntryId: inserted.readyEntry.id,
      expectedRevision: inserted.station.revision, idempotencyKey: 'leave:p1',
    });

    expect(left.readyEntry.status).toBe('LEFT');
    expect(left.reservation!.status).toBe('RELEASED');
    expect(await h.service.getWalletStatus('p1')).toMatchObject({ reservedBalance: 0, availableBalance: 2 });
  });

  it('rotates a reset test player into anonymous history so the next JOIN starts fresh', async () => {
    const h = await harness();
    await identify(h, 'p1');
    await h.store.transaction(state => {
      state.players.p1 = {
        ...state.players.p1!,
        conversationProfileId: 'mem-profile-1',
        trustedDestination: '+14155550199',
      };
      state.messagingDrafts.p1 = {
        playerId: 'p1', stationId: 'expo', step: 'COMPLETE', firstName: 'Ada',
        lastName: null, workEmail: null, companyName: null, countryCode: null,
        createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
      };
      state.channelAddresses['channel:p1'] = {
        id: 'channel:p1', playerId: 'p1', channel: 'sms', normalizedAddress: '+14155550199',
        providerAddress: '+14155550199', preferredLocale: 'en-US',
        firstSeenAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0).toISOString(),
      };
      state.channelAddresses['channel:p1:alternate'] = {
        id: 'channel:p1:alternate', playerId: 'p1', channel: 'sms', normalizedAddress: '+14155550198',
        providerAddress: '+14155550198', preferredLocale: 'en-US',
        firstSeenAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0).toISOString(),
      };
    });
    const inserted = await coin(h, 'p1');
    h.advance();
    const command = {
      ...OPERATOR,
      stationId: 'expo',
      readyEntryId: inserted.readyEntry.id,
      expectedRevision: inserted.station.revision,
      idempotencyKey: 'reset-player:p1',
      reason: 'repeat the attendee test',
      deleteMemoryProfile: async () => undefined,
    };

    const reset = await h.service.resetTestPlayer(command);
    expect(await h.service.resetTestPlayer(command)).toEqual(reset);
    const state = h.store.snapshot();
    const historicalEntry = state.stationReadyEntries[inserted.readyEntry.id]!;
    const tombstoneId = historicalEntry.playerId;
    expect(tombstoneId).not.toBe('p1');
    expect(historicalEntry.status).toBe('LEFT');
    expect(state.players.p1).toBeUndefined();
    expect(state.wallets.p1).toBeUndefined();
    expect(state.players[tombstoneId]).toMatchObject({
      lead: null, conversationProfileId: null, trustedDestination: null,
    });
    expect(state.wallets[tombstoneId]?.reservations[0]?.status).toBe('RELEASED');
    expect(state.messagingDrafts.p1).toBeUndefined();
    expect(Object.values(state.channelAddresses).some(address => address.normalizedAddress === '+14155550199')).toBe(false);
    expect(new Set(Object.values(state.channelAddresses).map(address => address.normalizedAddress)).size)
      .toBe(Object.keys(state.channelAddresses).length);
    expect(state.stationControlEvents.filter(event => event.action === 'RESET_TEST_PLAYER')).toHaveLength(1);

    h.advance();
    const providerMessageId = `SM${'a'.repeat(32)}`;
    const joined = await h.service.processInboundStationMessage({
      channel: 'sms',
      normalizedAddress: '+14155550199',
      providerAddress: '+14155550199',
      providerMessageId,
      body: 'JOIN',
      stationId: 'expo',
      preferredLocale: 'en-US',
      conversationProfileId: 'mem-profile-1',
      idempotencyKey: `provider:${createHash('sha256').update(providerMessageId).digest('hex')}`,
    });
    expect(joined.reply).toContain('first name');
    expect(joined.playerId).not.toBe('p1');
    expect(joined.playerId).not.toBe(tombstoneId);
    expect(await h.service.getWalletStatus(joined.playerId!)).toMatchObject({ availableBalance: 0 });
  });

  it('records enabled game choices by trusted player identity and replays idempotently', async () => {
    const h = await harness();
    await identify(h, 'p1', 'p2');
    const inserted = await coin(h, 'p1');
    await expect(h.service.recordStationGameChoice({
      stationId: 'expo', playerId: 'p1', game: 'racer', idempotencyKey: 'choice:early',
    })).rejects.toMatchObject({ code: 'SELECTION_NOT_ACTIVE' });
    h.advance();
    await h.service.closeStationRecruiting({
      ...CONTROL, stationId: 'expo', expectedRevision: inserted.station.revision,
      idempotencyKey: 'choice:close',
    });
    const command = {
      stationId: 'expo', playerId: 'p1', game: 'racer' as const, idempotencyKey: 'choice:p1',
    };
    const chosen = await h.service.recordStationGameChoice(command);
    const replay = await h.service.recordStationGameChoice(command);
    expect(replay).toEqual(chosen);
    expect(chosen).toEqual({ gameChoice: 'racer' });
    expect(h.store.snapshot().stationRounds[inserted.readyEntry.roundId]?.gameChoicesByReadyEntryId)
      .toEqual({ [inserted.readyEntry.id]: 'racer' });
    expect(h.publishedRevisions.at(-1)).toBe(h.store.snapshot().stations.expo?.revision);
    await expect(h.service.recordStationGameChoice({
      stationId: 'expo', playerId: 'p2', game: 'racer', idempotencyKey: 'choice:not-ready',
    })).rejects.toMatchObject({ code: 'READY_ENTRY_NOT_READY' });

    const disabled = JSON.parse(JSON.stringify(stationConfig())) as Record<string, any>;
    disabled.station.games.fighter.enabled = false;
    h.setConfig(parseArcadeConfig(disabled));
    await expect(h.service.recordStationGameChoice({
      stationId: 'expo', playerId: 'p1', game: 'fighter', idempotencyKey: 'choice:disabled',
    })).rejects.toMatchObject({ code: 'GAME_DISABLED' });

    h.advance(30_000);
    await expect(h.service.recordStationGameChoice({
      stationId: 'expo', playerId: 'p1', game: 'racer', idempotencyKey: 'choice:deadline',
    })).rejects.toMatchObject({ code: 'SELECTION_CLOSED' });
    h.advance(1);
    await expect(h.service.recordStationGameChoice({
      stationId: 'expo', playerId: 'p1', game: 'racer', idempotencyKey: 'choice:late',
    })).rejects.toMatchObject({ code: 'SELECTION_CLOSED' });
  });

  it('atomically resets recruiting, removes channel bindings, audits once, and replays idempotently', async () => {
    const h = await harness();
    await identify(h, 'p1');
    const inserted = await coin(h, 'p1');
    await h.store.transaction(state => {
      state.channelAddresses['channel:p1'] = {
        id: 'channel:p1', playerId: 'p1', channel: 'sms', normalizedAddress: '+14155550199',
        providerAddress: '+14155550199', preferredLocale: 'en-US',
        firstSeenAt: inserted.readyEntry.readyAt, lastSeenAt: inserted.readyEntry.readyAt,
      };
      state.stationReadyChannels[inserted.readyEntry.id] = {
        readyEntryId: inserted.readyEntry.id,
        channelAddressId: 'channel:p1',
        consentedAt: inserted.readyEntry.readyAt,
      };
    });
    const command = {
      ...OPERATOR, stationId: 'expo', expectedRevision: inserted.station.revision,
      idempotencyKey: 'reset:recruiting', reason: 'unsafe cabinet state',
    };

    expect(() => h.service.resetStation({ ...command, ...CONTROL }))
      .toThrow(expect.objectContaining({ code: 'STATION_ACTION_UNAUTHORIZED' }));
    expect(() => h.service.resetStation({ ...command, reason: ' ' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    h.advance();
    const reset = await h.service.resetStation(command);
    const replay = await h.service.resetStation(command);

    expect(replay).toEqual(reset);
    expect(reset.station).toMatchObject({
      phase: 'ATTRACT', activeRoundId: null, nextRoundId: null,
      activeGame: null, activeMatchId: null, revision: inserted.station.revision + 1,
    });
    const state = h.store.snapshot();
    expect(state.stationRounds[inserted.readyEntry.roundId]).toMatchObject({ phase: 'CLOSED' });
    expect(state.stationReadyEntries[inserted.readyEntry.id]?.status).toBe('LEFT');
    expect(state.wallets.p1?.reservations[0]?.status).toBe('RELEASED');
    expect(state.stationReadyChannels).toEqual({});
    expect(state.stationControlEvents.filter(event => event.action === 'RESET_STATION')).toEqual([
      expect.objectContaining({
        actorKind: 'operator', actorSubject: 'operator@twilio.com', reason: 'unsafe cabinet state',
        fromRevision: inserted.station.revision, toRevision: inserted.station.revision + 1,
      }),
    ]);
  });

  it('refunds playing participants and releases overflow and next-round holds during reset', async () => {
    const h = await harness();
    await identify(h, 'p1', 'p2', 'p3', 'p4');
    await coin(h, 'p1');
    await coin(h, 'p2');
    const third = await coin(h, 'p3');
    h.advance();
    const selecting = await h.service.closeStationRecruiting({
      ...CONTROL, stationId: 'expo', expectedRevision: third.station.revision, idempotencyKey: 'reset:close',
    });
    h.advance();
    const locked = await h.service.selectStationGame({
      ...CONTROL, stationId: 'expo', expectedRevision: selecting.station.revision,
      game: 'fighter', engineRoomCode: 'RESET-ROOM', idempotencyKey: 'reset:select',
    });
    h.advance();
    const launching = await h.service.requestStationLaunch({
      ...CONTROL, stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'reset:launch',
    });
    h.advance();
    const displayReady = await h.service.markStationDisplayReady({
      ...CONTROL, stationId: 'expo', expectedRevision: launching.station.revision,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      idempotencyKey: 'reset:display-ready',
    });
    h.advance();
    const playing = await h.service.startStationMatch({
      ...CONTROL, stationId: 'expo', expectedRevision: displayReady.station.revision,
      idempotencyKey: 'reset:start',
    });
    const next = await coin(h, 'p4');
    expect(next.station.nextRoundId).not.toBeNull();

    h.advance();
    const reset = await h.service.resetStation({
      ...OPERATOR, stationId: 'expo', expectedRevision: next.station.revision,
      idempotencyKey: 'reset:playing', reason: 'game engine became unsafe',
    });

    expect(reset.station.phase).toBe('ATTRACT');
    const state = h.store.snapshot();
    expect(state.stationMatches[playing.match!.id]).toMatchObject({ phase: 'FAILED' });
    expect(Object.values(state.stationReadyEntries).map(entry => entry.status)).toEqual(Array(4).fill('LEFT'));
    expect(Object.values(state.stationRounds).map(round => round.phase)).toEqual(['CLOSED', 'CLOSED']);
    expect(state.wallets.p1?.reservations[0]?.status).toBe('REFUNDED');
    expect(state.wallets.p2?.reservations[0]?.status).toBe('REFUNDED');
    expect(state.wallets.p3?.reservations[0]?.status).toBe('RELEASED');
    expect(state.wallets.p4?.reservations[0]?.status).toBe('RELEASED');
    for (const playerId of ['p1', 'p2', 'p3', 'p4']) {
      expect(await h.service.getWalletStatus(playerId)).toMatchObject({ reservedBalance: 0, availableBalance: 2 });
    }
  });

  it('charges one coin to every admitted multiplayer participant and preserves overflow holds', async () => {
    const h = await harness();
    await identify(h, 'p1', 'p2', 'p3');
    await coin(h, 'p1');
    await coin(h, 'p2');
    const third = await coin(h, 'p3');
    h.advance();
    const selecting = await h.service.closeStationRecruiting({
      ...CONTROL,
      stationId: 'expo', expectedRevision: third.station.revision, idempotencyKey: 'close',
    });
    h.advance();
    const locked = await h.service.selectStationGame({
      ...CONTROL,
      stationId: 'expo', expectedRevision: selecting.station.revision,
      game: 'fighter', engineRoomCode: 'FIGHT-01', idempotencyKey: 'select',
    });
    expect(Object.values(h.store.snapshot().stationReadyEntries).map(entry => entry.status).sort())
      .toEqual(['ADMITTED', 'ADMITTED', 'OVERFLOW']);
    h.advance();
    const launching = await h.service.requestStationLaunch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch',
    });
    await expect(h.service.startStationMatch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: launching.station.revision, idempotencyKey: 'start-early',
    })).rejects.toMatchObject({ code: 'DISPLAY_NOT_READY' });
    expect(Object.values(h.store.snapshot().wallets).map(wallet => wallet.reservations[0]?.status))
      .toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE']);
    h.advance();
    const ready = await h.service.markStationDisplayReady({
      ...CONTROL,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      stationId: 'expo', expectedRevision: launching.station.revision, idempotencyKey: 'display-ready',
    });
    h.advance();
    const playing = await h.service.startStationMatch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: ready.station.revision, idempotencyKey: 'start',
    });

    expect(playing.station.phase).toBe('PLAYING');
    expect(Object.values(h.store.snapshot().wallets).map(wallet => wallet.reservations[0]?.status))
      .toEqual(['REDEEMED', 'REDEEMED', 'ACTIVE']);
    expect(await h.service.getWalletStatus('p1')).toMatchObject({ ledgerBalance: 1, reservedBalance: 0 });
    expect(await h.service.getWalletStatus('p2')).toMatchObject({ ledgerBalance: 1, reservedBalance: 0 });
    expect(await h.service.getWalletStatus('p3')).toMatchObject({ ledgerBalance: 2, reservedBalance: 1 });
    h.advance();
    const results = await h.service.completeStationMatch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: playing.station.revision, idempotencyKey: 'complete',
    });
    h.setConfig(stationConfig({ version: 2 }));
    h.advance();
    const advanced = await h.service.advanceStationResults({
      ...CONTROL,
      stationId: 'expo', expectedRevision: results.station.revision, idempotencyKey: 'advance',
    });
    expect(advanced.station.phase).toBe('RECRUITING');
    expect(h.store.snapshot().stationReadyEntries[third.readyEntry.id]).toMatchObject({
      status: 'READY', roundId: advanced.round?.id,
    });

    h.advance();
    const selectingAgain = await h.service.closeStationRecruiting({
      ...CONTROL,
      stationId: 'expo', expectedRevision: advanced.station.revision, idempotencyKey: 'close:overflow',
    });
    h.advance();
    const lockedAgain = await h.service.selectStationGame({
      ...CONTROL,
      stationId: 'expo', expectedRevision: selectingAgain.station.revision,
      game: 'racer', engineRoomCode: 'RACE-02', idempotencyKey: 'select:overflow',
    });
    h.advance();
    const launchingAgain = await h.service.requestStationLaunch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: lockedAgain.station.revision, idempotencyKey: 'launch:overflow',
    });
    h.advance();
    const readyAgain = await h.service.markStationDisplayReady({
      ...CONTROL,
      matchId: launchingAgain.match!.id, launchGeneration: launchingAgain.match!.launchGeneration,
      stationId: 'expo', expectedRevision: launchingAgain.station.revision, idempotencyKey: 'ready:overflow',
    });
    h.advance();
    await h.service.startStationMatch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: readyAgain.station.revision, idempotencyKey: 'start:overflow',
    });
    expect(h.store.snapshot().wallets.p3?.reservations[0]).toMatchObject({
      status: 'REDEEMED', configVersion: 1,
    });
  });

  it('keeps reservations active when launch fails', async () => {
    const h = await harness();
    await identify(h, 'p1');
    const inserted = await coin(h, 'p1');
    h.advance();
    const selecting = await h.service.closeStationRecruiting({
      ...CONTROL,
      stationId: 'expo', expectedRevision: inserted.station.revision, idempotencyKey: 'close',
    });
    h.advance();
    const locked = await h.service.selectStationGame({
      ...CONTROL,
      stationId: 'expo', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: 'RACE-01', idempotencyKey: 'select',
    });
    h.advance();
    const launching = await h.service.requestStationLaunch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch',
    });
    h.setConfig(stationConfig({ mode: 'off' }));
    h.advance();
    const recovered = await h.service.failStationLaunch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: launching.station.revision, idempotencyKey: 'fail',
    });

    expect(recovered.station.phase).toBe('RECRUITING');
    expect(h.store.snapshot().stationReadyEntries[inserted.readyEntry.id]?.status).toBe('READY');
    expect(h.store.snapshot().wallets.p1?.reservations[0]?.status).toBe('ACTIVE');

    h.setConfig(stationConfig());
    h.advance();
    const selectingAgain = await h.service.closeStationRecruiting({
      ...CONTROL,
      stationId: 'expo', expectedRevision: recovered.station.revision, idempotencyKey: 'close:retry',
    });
    h.advance();
    const lockedAgain = await h.service.selectStationGame({
      ...CONTROL,
      stationId: 'expo', expectedRevision: selectingAgain.station.revision,
      game: 'racer', engineRoomCode: 'RACE-02', idempotencyKey: 'select:retry',
    });
    h.advance();
    const launchingAgain = await h.service.requestStationLaunch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: lockedAgain.station.revision, idempotencyKey: 'launch:retry',
    });
    h.advance();
    const readyAgain = await h.service.markStationDisplayReady({
      ...CONTROL,
      matchId: launchingAgain.match!.id, launchGeneration: launchingAgain.match!.launchGeneration,
      stationId: 'expo', expectedRevision: launchingAgain.station.revision, idempotencyKey: 'ready:retry',
    });
    h.advance();
    await expect(h.service.startStationMatch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: readyAgain.station.revision, idempotencyKey: 'start:retry',
    })).resolves.toMatchObject({ station: { phase: 'PLAYING' } });
  });

  it('uses the captured reservation version after configuration changes', async () => {
    const h = await harness(stationConfig({ version: 1 }));
    await identify(h, 'p1');
    const inserted = await coin(h, 'p1');
    h.setConfig(stationConfig({ version: 2 }));
    h.advance();
    const selecting = await h.service.closeStationRecruiting({
      ...CONTROL,
      stationId: 'expo', expectedRevision: inserted.station.revision, idempotencyKey: 'close',
    });
    h.advance();
    const locked = await h.service.selectStationGame({
      ...CONTROL,
      stationId: 'expo', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: 'RACE-01', idempotencyKey: 'select',
    });
    h.advance();
    const launching = await h.service.requestStationLaunch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch',
    });
    h.advance();
    const ready = await h.service.markStationDisplayReady({
      ...CONTROL,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      stationId: 'expo', expectedRevision: launching.station.revision, idempotencyKey: 'ready',
    });
    h.advance();
    await h.service.startStationMatch({
      ...CONTROL,
      stationId: 'expo', expectedRevision: ready.station.revision, idempotencyKey: 'start',
    });

    const reservation = h.store.snapshot().wallets.p1?.reservations[0];
    const redemption = h.store.snapshot().wallets.p1?.transactions.find(tx => tx.type === 'redemption');
    expect(reservation).toMatchObject({ status: 'REDEEMED', configVersion: 1 });
    expect(redemption?.configVersion).toBe(1);
  });

  it('runs free play without grants, holds, redemptions, or wallet copy', async () => {
    const h = await harness(stationConfig({ chargePolicy: 'free' }));
    await identify(h, 'p1');
    const inserted = await coin(h, 'p1');
    expect(inserted.reservation).toBeNull();
    expect(inserted.availableBalance).toBe(0);
    expect(h.store.snapshot().wallets.p1?.transactions).toEqual([]);
    expect(h.store.snapshot().wallets.p1?.reservations).toEqual([]);
    h.advance();
    const selecting = await h.service.closeStationRecruiting({
      ...CONTROL, stationId: 'expo', expectedRevision: inserted.station.revision, idempotencyKey: 'free:close',
    });
    h.advance();
    const locked = await h.service.selectStationGame({
      ...CONTROL, stationId: 'expo', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: 'FREE-01', idempotencyKey: 'free:select',
    });
    h.advance();
    const launching = await h.service.requestStationLaunch({
      ...CONTROL, stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'free:launch',
    });
    h.advance();
    const ready = await h.service.markStationDisplayReady({
      ...CONTROL, stationId: 'expo', expectedRevision: launching.station.revision,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      idempotencyKey: 'free:ready',
    });
    h.advance();
    const playing = await h.service.startStationMatch({
      ...CONTROL, stationId: 'expo', expectedRevision: ready.station.revision, idempotencyKey: 'free:start',
    });
    expect(playing.station.phase).toBe('PLAYING');
    expect(h.store.snapshot().wallets.p1?.transactions).toEqual([]);
  });

  it('requires a trusted controller for privileged station transitions', async () => {
    const h = await harness();
    await identify(h, 'p1');
    const inserted = await coin(h, 'p1');

    expect(() => h.service.closeStationRecruiting({
      authorization: null,
      stationId: 'expo', expectedRevision: inserted.station.revision, idempotencyKey: 'close:unauthorized',
    })).toThrow(expect.objectContaining({ code: 'STATION_ACTION_UNAUTHORIZED' }));
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RECRUITING');
  });

  it('allows a player to release a held coin after Arcade mode is disabled', async () => {
    const h = await harness();
    await identify(h, 'p1');
    const inserted = await coin(h, 'p1');
    h.setConfig(stationConfig({ mode: 'off' }));
    h.advance();

    const left = await h.service.leaveStationReadyEntry({
      stationId: 'expo', playerId: 'p1', readyEntryId: inserted.readyEntry.id,
      expectedRevision: inserted.station.revision, idempotencyKey: 'leave:off',
    });
    expect(left.reservation!.status).toBe('RELEASED');
  });

  it('bounds pending players before a persisted match can exceed its limit', async () => {
    const h = await harness(stationConfig({ startingBalance: 1 }));
    const playerIds = Array.from({ length: 65 }, (_, index) => `p${index + 1}`);
    await identify(h, ...playerIds);
    for (const playerId of playerIds.slice(0, 64)) await coin(h, playerId);

    await expect(coin(h, playerIds[64]!)).rejects.toMatchObject({ code: 'READY_POOL_FULL' });
    expect(Object.keys(h.store.snapshot().stationReadyEntries)).toHaveLength(64);
    expect(h.store.snapshot().wallets[playerIds[64]!]!.reservations).toHaveLength(0);
  }, 20_000);

  it('drops an admitted no-show, promotes overflow, and supports audited operator coin grants', async () => {
    const h = await harness();
    await identify(h, 'p1', 'p2', 'p3', 'p4', 'p5');
    const entries = [];
    for (const playerId of ['p1', 'p2', 'p3', 'p4', 'p5']) entries.push(await coin(h, playerId));
    const aggregate = await h.service.getStation('expo');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: aggregate!.station.revision,
      idempotencyKey: 'drop-close', ...CONTROL,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision,
      idempotencyKey: 'drop-select', game: 'racer', engineRoomCode: 'DROP', ...CONTROL,
    });
    h.setConfig(stationConfig({ mode: 'off' }));
    await expect(h.service.dropStationAdmittedEntry({
      stationId: 'expo', readyEntryId: entries[1]!.readyEntry.id,
      expectedRevision: locked.station.revision, idempotencyKey: 'drop-player-paused',
      reason: 'must reset while paused', ...OPERATOR,
    })).rejects.toMatchObject({ code: 'PAUSED_EVENT_RESET_REQUIRED' });
    h.setConfig(stationConfig());
    const dropped = await h.service.dropStationAdmittedEntry({
      stationId: 'expo', readyEntryId: entries[1]!.readyEntry.id,
      expectedRevision: locked.station.revision, idempotencyKey: 'drop-player',
      reason: 'player left the event', ...OPERATOR,
    });
    expect(dropped.match?.participantReadyEntryIds).toContain(entries[4]!.readyEntry.id);
    expect(h.store.snapshot().stationReadyEntries[entries[1]!.readyEntry.id]?.status).toBe('LEFT');
    expect(h.store.snapshot().wallets.p2?.reservations[0]?.status).toBe('RELEASED');

    const granted = await h.service.grantStationPlayerCoins({
      stationId: 'expo', readyEntryId: entries[0]!.readyEntry.id, amount: 3,
      idempotencyKey: 'operator-grant', reason: 'event recovery', ...OPERATOR,
    });
    expect(granted.availableBalance).toBe(4);
    expect(h.store.snapshot().wallets.p1?.transactions.at(-1)).toMatchObject({
      type: 'operator_grant', delta: 3,
      metadata: { source: 'operator', reason: 'event recovery' },
    });
  });
});
