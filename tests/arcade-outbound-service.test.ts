import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ARCADE_CONFIG, parseArcadeConfig, type ArcadeConfigSnapshot } from '../shared/arcade-config';
import { ArcadeService } from '../server/arcade-service';
import { ArcadeStateStore } from '../server/arcade-state-store';

const directories: string[] = [];
const AUTHORIZATION = Object.freeze({ trusted: true });
const TOKEN_SECRET = '0123456789abcdef0123456789abcdef';

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcade-outbound-service-'));
  directories.push(directory);
  const store = await ArcadeStateStore.open(path.join(directory, 'state.json'));
  let config = stationConfig('coin_only');
  let now = Date.parse('2026-07-21T10:00:00.000Z');
  let sequence = 0;
  const service = new ArcadeService({
    store,
    config: () => config,
    clock: () => now++,
    idGenerator: kind => `${kind}-${++sequence}`,
    challengeTokenSecret: TOKEN_SECRET,
    operatorAuthorizer: value => value === AUTHORIZATION
      ? { kind: 'system', subject: 'outbound-test' }
      : null,
    stationNotifications: {
      enabled: () => true,
      callNumber: () => '+14155550100',
      whatsappContentSid: () => `HX${'a'.repeat(32)}`,
    },
  });
  return {
    store,
    service,
    setMode: (mode: 'off' | 'coin_only') => { config = stationConfig(mode); },
    setVoice: (enabled: boolean, numbers: { 'en-US': string | null; 'pt-BR': string | null }) => {
      const value = JSON.parse(JSON.stringify(config)) as Record<string, any>;
      value.channels.voice = enabled;
      value.channels.voiceNumbers = numbers;
      config = parseArcadeConfig(value);
    },
  };
}

function stationConfig(mode: 'off' | 'coin_only'): ArcadeConfigSnapshot {
  const value = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
  value.arcade.mode = mode;
  value.coins.startingBalance = 1;
  value.channels.voiceNumbers = {
    'en-US': '+14155550100',
    'pt-BR': '+551155555555',
  };
  value.channels.whatsapp = true;
  value.postGame.enabled = false;
  value.postGame.channels = [];
  value.postGame.includeChallenges = true;
  value.earning.challenges = [{
    id: 'voice-docs', title: 'Voice docs', message: 'Visit the Voice docs to earn another coin.',
    url: 'https://www.twilio.com/docs/voice', rewardCoins: 1, enabled: true,
    maxClaimsPerPlayer: 1, displayOrder: 0, startsAt: null, endsAt: null,
  }];
  return parseArcadeConfig(value);
}

function providerKey(sid: string): string {
  return `provider:${createHash('sha256').update(sid).digest('hex')}`;
}

async function inbound(
  service: ArcadeService,
  sid: string,
  body: string,
  from: string,
  channel: 'sms' | 'whatsapp' = 'sms',
) {
  return service.processInboundStationMessage({
    channel,
    normalizedAddress: from,
    providerAddress: channel === 'whatsapp' ? `whatsapp:${from}` : from,
    providerMessageId: sid,
    body,
    stationId: 'ARCADE-01',
    preferredLocale: body.includes('pt-BR') ? 'pt-BR' : 'en-US',
    idempotencyKey: providerKey(sid),
  });
}

async function createThreeReadyPlayers(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  for (const [index, locale] of ['en-US', 'pt-BR', 'pt-BR'].entries()) {
    const from = `+1415555010${index + 1}`;
    await inbound(h.service, `SM-JOIN-${index}`, `JOIN ARCADE-01 LANG ${locale}`, from);
    await inbound(h.service, `SM-NAME-${index}`, `Player${index + 1}`, from);
    await inbound(h.service, `SM-TERMS-${index}`, locale === 'pt-BR' ? 'SIM' : 'YES', from);
    const ready = await inbound(
      h.service, `SM-COIN-${index}`, locale === 'pt-BR' ? 'MOEDA' : 'COIN', from,
    );
    if (index === 0) expect(ready.reply).toContain('we will text assignment and call updates');
  }
}

describe('Arcade station outbound outbox', () => {
  it('atomically queues admitted, overflow, call-now, results, and promoted-next notices', async () => {
    const h = await harness();
    await createThreeReadyPlayers(h);
    const activePlayerId = Object.values(h.store.snapshot().channelAddresses)[0]!.playerId;
    await expect(h.service.restorePlayerStartingBalance({
      playerId: activePlayerId, expectedConfigVersion: 1, idempotencyKey: 'restore-active-player',
      authorization: AUTHORIZATION, reason: 'should be blocked',
    })).rejects.toMatchObject({ code: 'PLAYER_ACTIVE_ADMISSION' });
    const recruiting = await h.service.getStation('ARCADE-01');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const selectionInput = {
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'fighter' as const, engineRoomCode: '4821', idempotencyKey: 'select',
      authorization: AUTHORIZATION,
    };
    const locked = await h.service.selectStationGame(selectionInput);
    await expect(h.service.selectStationGame(selectionInput)).resolves.toEqual(locked);

    expect(Object.values(h.store.snapshot().outboundNotifications).map(item => item.kind).sort())
      .toEqual(['STATION_ADMITTED', 'STATION_ADMITTED', 'STATION_OVERFLOW']);
    expect(Object.keys(h.store.snapshot().stationReadyChannels)).toHaveLength(3);
    expect(Object.values(h.store.snapshot().outboundNotifications)
      .find(item => item.kind === 'STATION_OVERFLOW')?.body).toContain('próximo jogo');

    const launching = await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    const callNow = Object.values(h.store.snapshot().outboundNotifications)
      .filter(item => item.kind === 'STATION_CALL_NOW');
    expect(callNow.find(item => item.locale === 'en-US')?.body).toContain('+14155550100');
    expect(callNow.find(item => item.locale === 'pt-BR')?.body).toContain('+551155555555');
    const displayReady = await h.service.markStationDisplayReady({
      stationId: 'ARCADE-01', expectedRevision: launching.station.revision,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      idempotencyKey: 'display-ready', authorization: AUTHORIZATION,
    });
    const playing = await h.service.startStationMatch({
      stationId: 'ARCADE-01', expectedRevision: displayReady.station.revision,
      idempotencyKey: 'start', authorization: AUTHORIZATION,
    });
    const results = await h.service.completeStationMatch({
      stationId: 'ARCADE-01', expectedRevision: playing.station.revision,
      idempotencyKey: 'complete', authorization: AUTHORIZATION,
    });
    const resultNotice = Object.values(h.store.snapshot().outboundNotifications)
      .find(item => item.kind === 'STATION_RESULTS' && item.locale === 'en-US')!;
    expect(resultNotice.body).toContain('Your Voice Fighter match is complete');
    expect(resultNotice.body).not.toContain('Available balance');
    expect(resultNotice.body).toContain('Reply MORE for challenge links');
    expect(resultNotice.templateVariables).toEqual({ '1': 'Voice Fighter' });
    expect(Object.values(h.store.snapshot().outboundNotifications)
      .filter(item => item.kind === 'STATION_RESULTS' && item.channel === 'whatsapp')
      .every(item => item.templateContentSid === null)).toBe(true);
    const recovery = await h.service.listPlayersNeedingCoins();
    expect(recovery).toMatchObject({ startingBalance: 1, players: [{ availableBalance: 0 }, { availableBalance: 0 }] });
    expect(JSON.stringify(recovery)).not.toContain('+1415555010');
    const target = recovery.players[0]!;
    const restoreInput = {
      playerId: target.playerId, expectedConfigVersion: recovery.configVersion,
      idempotencyKey: 'restore-zero-player', authorization: AUTHORIZATION, reason: 'help attendee replay',
    };
    const restored = await h.service.restorePlayerStartingBalance(restoreInput);
    expect(restored).toMatchObject({ restored: true, amountGranted: 1, targetBalance: 1, availableBalance: 1 });
    expect(await h.service.restorePlayerStartingBalance(restoreInput)).toEqual(restored);
    await expect(h.service.restorePlayerStartingBalance({ ...restoreInput, idempotencyKey: 'restore-zero-player-again' }))
      .rejects.toMatchObject({ code: 'PLAYER_BALANCE_CHANGED' });
    const restoredWallet = h.store.snapshot().wallets[target.playerId]!;
    expect(restoredWallet.transactions.filter(transaction => transaction.type === 'operator_grant')).toEqual([
      expect.objectContaining({ delta: 1, metadata: expect.objectContaining({
        action: 'restore_starting_balance', reason: 'help attendee replay',
        configuredStartingBalance: 1, previousAvailableBalance: 0,
      }) }),
    ]);
    expect((await h.service.listPlayersNeedingCoins()).players).toHaveLength(1);
    await h.service.advanceStationResults({
      stationId: 'ARCADE-01', expectedRevision: results.station.revision,
      idempotencyKey: 'advance', authorization: AUTHORIZATION,
    });

    const kinds = Object.values(h.store.snapshot().outboundNotifications).map(item => item.kind).sort();
    expect(kinds).toEqual([
      'STATION_ADMITTED', 'STATION_ADMITTED', 'STATION_CALL_NOW', 'STATION_CALL_NOW',
      'STATION_NEXT_GAME', 'STATION_OVERFLOW', 'STATION_RESULTS', 'STATION_RESULTS',
    ].sort());
    expect(new Set(Object.values(h.store.snapshot().outboundNotifications).map(item => item.id)).size).toBe(8);
  });

  it('does not bind or notify a browser-created ready entry', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'browser-player', idempotencyKey: 'identify-browser' });
    const ready = await h.service.insertStationCoin({
      stationId: 'ARCADE-01', playerId: 'browser-player', idempotencyKey: 'browser-coin',
    });
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: ready.station.revision,
      idempotencyKey: 'browser-close', authorization: AUTHORIZATION,
    });
    await h.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: '4821', idempotencyKey: 'browser-select',
      authorization: AUTHORIZATION,
    });
    expect(h.store.snapshot().stationReadyChannels).toEqual({});
    expect(h.store.snapshot().outboundNotifications).toEqual({});
  });

  it('suppresses call-now notices when the selected locale has no voice number', async () => {
    const h = await harness();
    h.setVoice(true, { 'en-US': '+14155550100', 'pt-BR': null });
    await inbound(h.service, 'SM-NO-CALL-JOIN', 'JOIN ARCADE-01 LANG pt-BR', '+5511999999999');
    await inbound(h.service, 'SM-NO-CALL-NAME', 'Bia', '+5511999999999');
    await inbound(h.service, 'SM-NO-CALL-TERMS', 'SIM', '+5511999999999');
    await inbound(h.service, 'SM-NO-CALL-COIN', 'MOEDA', '+5511999999999');
    const recruiting = await h.service.getStation('ARCADE-01');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'no-call-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: '4821', idempotencyKey: 'no-call-select',
      authorization: AUTHORIZATION,
    });
    await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'no-call-launch', authorization: AUTHORIZATION,
    });
    expect(Object.values(h.store.snapshot().outboundNotifications)
      .some(item => item.kind === 'STATION_CALL_NOW')).toBe(false);
  });

  it('allows off-mode completion without queuing results', async () => {
    const h = await harness();
    await inbound(h.service, 'SM-OFF-JOIN', 'JOIN ARCADE-01 LANG en-US', '+14155550200');
    await inbound(h.service, 'SM-OFF-NAME', 'Ada', '+14155550200');
    await inbound(h.service, 'SM-OFF-TERMS', 'YES', '+14155550200');
    await inbound(h.service, 'SM-OFF-COIN', 'COIN', '+14155550200');
    const recruiting = await h.service.getStation('ARCADE-01');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'off-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: '4821', idempotencyKey: 'off-select', authorization: AUTHORIZATION,
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'off-launch', authorization: AUTHORIZATION,
    });
    const ready = await h.service.markStationDisplayReady({
      stationId: 'ARCADE-01', expectedRevision: launching.station.revision,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      idempotencyKey: 'off-ready', authorization: AUTHORIZATION,
    });
    const playing = await h.service.startStationMatch({
      stationId: 'ARCADE-01', expectedRevision: ready.station.revision,
      idempotencyKey: 'off-start', authorization: AUTHORIZATION,
    });
    h.setMode('off');
    await h.service.completeStationMatch({
      stationId: 'ARCADE-01', expectedRevision: playing.station.revision,
      idempotencyKey: 'off-complete', authorization: AUTHORIZATION,
    });
    expect(Object.values(h.store.snapshot().outboundNotifications)
      .some(item => item.kind === 'STATION_RESULTS')).toBe(false);
  });
});
