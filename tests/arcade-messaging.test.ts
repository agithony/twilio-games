import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ARCADE_CONFIG, parseArcadeConfig, type ArcadeMode } from '../shared/arcade-config';
import { grantRegistrationCoins } from '../shared/arcade-domain';
import { joinQueue } from '../shared/arcade-queue';
import {
  ArcadeService,
  type ArcadeMessagingProtectionOptions,
} from '../server/arcade-service';
import { ArcadeStateStore } from '../server/arcade-state-store';

const directories: string[] = [];
const TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
const OPERATOR_AUTH = Object.freeze({ operator: true });
const T0 = Date.parse('2026-07-20T10:00:00.000Z');

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function harness(
  mode: ArcadeMode,
  chargePolicy: 'per_player' | 'free' = 'per_player',
  configure?: (value: Record<string, any>) => void,
  messagingProtection?: ArcadeMessagingProtectionOptions,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcade-messaging-'));
  directories.push(directory);
  const store = await ArcadeStateStore.open(path.join(directory, 'state.json'));
  const value = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
  value.arcade.mode = mode;
  value.coins.startingBalance = 2;
  value.coins.chargePolicy = chargePolicy;
  configure?.(value);
  let config = parseArcadeConfig(value);
  let sequence = 0;
  let now = T0;
  const service = new ArcadeService({
    store,
    config: () => config,
    clock: () => now++,
    idGenerator: kind => `${kind}-${++sequence}`,
    challengeTokenSecret: TOKEN_SECRET,
    messagingProtection,
    operatorAuthorizer: authorization => authorization === OPERATOR_AUTH
      ? { kind: 'operator', subject: 'operator@twilio.com' }
      : null,
  });
  return {
    store,
    service,
    setCabinet: (cabinetId: string) => {
      const next = JSON.parse(JSON.stringify(config)) as Record<string, any>;
      next.arcade.cabinetId = cabinetId;
      config = parseArcadeConfig(next);
    },
    setMode: (nextMode: ArcadeMode, nextChargePolicy = chargePolicy) => {
      const next = JSON.parse(JSON.stringify(config)) as Record<string, any>;
      next.arcade.mode = nextMode;
      next.coins.chargePolicy = nextChargePolicy;
      config = parseArcadeConfig(next);
    },
    setNow: (value: number) => { now = value; },
    operatorAuthorization: OPERATOR_AUTH,
  };
}

function providerKey(sid: string, from: string): string {
  void from;
  return `provider:${createHash('sha256').update(sid).digest('hex')}`;
}

function message(
  service: ArcadeService,
  sid: string,
  body: string,
  from = '+14155550199',
  channel: 'sms' | 'whatsapp' = 'sms',
  stationId = 'ARCADE-01',
) {
  const providerAddress = channel === 'whatsapp' ? `whatsapp:${from}` : from;
  return service.processInboundStationMessage({
    channel,
    normalizedAddress: from,
    providerAddress,
    providerMessageId: sid,
    body,
    stationId,
    preferredLocale: 'en-US',
    idempotencyKey: providerKey(sid, providerAddress),
  });
}

describe('Arcade messaging commands', () => {
  it('deduplicates provider messages durably and converges SMS and WhatsApp identity', async () => {
    const h = await harness('coin_only');
    const joined = await message(h.service, 'SM001', 'JOIN ARCADE-01 LANG en-US');
    expect(joined.reply).toContain('Reply YES');
    expect((await message(h.service, 'SM002', 'YES')).reply).toContain('Reply COIN');
    const status = await message(h.service, 'SM003', 'STATUS');
    expect(status.reply).toContain('Balance: 2');
    expect(await message(h.service, 'SM001', 'JOIN ARCADE-01 LANG en-US')).toEqual(joined);

    const whatsapp = await message(
      h.service, 'SM004', 'JOIN ARCADE-01 LANG en-US', '+14155550199', 'whatsapp',
    );
    expect(whatsapp.playerId).toBe(joined.playerId);
    const coin = await message(h.service, 'SM005', 'COIN');
    expect(coin.reply).toContain('position 1');
    expect(coin.reply).toContain('Watch the screen');
    expect(coin.reply).not.toContain('we will text');
    expect(await message(h.service, 'SM005', 'COIN')).toEqual(coin);

    const state = h.store.snapshot();
    expect(Object.keys(state.inboundMessages)).toHaveLength(5);
    expect(Object.values(state.channelAddresses).map(address => address.playerId))
      .toEqual([joined.playerId, joined.playerId]);
    expect(state.wallets[joined.playerId!]?.reservations).toHaveLength(1);
    await expect(message(h.service, 'SM005', 'LEAVE')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const left = await message(h.service, 'SM006', 'LEAVE');
    expect(left.reply).toContain('held coin is available again');
    expect(h.store.snapshot().wallets[joined.playerId!]?.reservations[0]?.status).toBe('RELEASED');
  });

  it('persists the Conversation Memory profile from the first TAC interaction', async () => {
    const h = await harness('coin_only');
    const result = await h.service.processInboundStationMessage({
      channel: 'sms',
      normalizedAddress: '+14155550199',
      providerAddress: '+14155550199',
      providerMessageId: 'comm-first-memory',
      body: 'JOIN ARCADE-01 LANG pt-BR',
      stationId: 'ARCADE-01',
      preferredLocale: 'pt-BR',
      idempotencyKey: providerKey('comm-first-memory', '+14155550199'),
      conversationProfileId: 'mem_profile_customer_1',
      conversationId: 'conv_customer_1',
    });
    expect(h.store.snapshot().players[result.playerId!]?.conversationProfileId)
      .toBe('mem_profile_customer_1');
    const continued = await h.service.processInboundStationMessage({
      channel: 'whatsapp',
      normalizedAddress: '+14155550200',
      providerAddress: 'whatsapp:+14155550200',
      providerMessageId: 'comm-cross-channel-memory',
      body: 'HELP',
      stationId: 'ARCADE-01',
      preferredLocale: 'en-US',
      idempotencyKey: providerKey('comm-cross-channel-memory', '+14155550200'),
      conversationProfileId: 'mem_profile_customer_1',
      conversationId: 'conv_customer_2',
    });
    expect(continued.playerId).toBe(result.playerId);
    expect(continued.locale).toBe('pt-BR');
    expect(Object.values(h.store.snapshot().channelAddresses).filter(address => address.playerId === result.playerId))
      .toHaveLength(2);
    await expect(h.service.processInboundStationMessage({
      channel: 'sms',
      normalizedAddress: '+14155550199',
      providerAddress: '+14155550199',
      providerMessageId: 'comm-profile-conflict',
      body: 'HELP',
      stationId: 'ARCADE-01',
      preferredLocale: 'en-US',
      idempotencyKey: providerKey('comm-profile-conflict', '+14155550199'),
      conversationProfileId: 'mem_profile_attacker',
    })).rejects.toMatchObject({ code: 'CONVERSATION_PROFILE_CONFLICT' });
  });

  it('completes lead capture before granting coins or accepting COIN', async () => {
    const h = await harness('lead_capture');
    const joined = await message(h.service, 'SM101', 'JOIN ARCADE-01 LANG en-US');
    expect(joined.reply).toContain('first name');
    expect(h.store.snapshot().wallets[joined.playerId!]?.wallet.cachedBalance).toBe(0);
    expect((await message(h.service, 'SM102', 'COIN')).reply).toContain('Finish the quick intro');

    expect((await message(h.service, 'SM103', 'Ada')).reply).toContain('last name');
    expect((await message(h.service, 'SM104', 'Lovelace')).reply).toContain('work email');
    expect((await message(h.service, 'SM105', 'ada@example.com')).reply).toContain('company');
    expect((await message(h.service, 'SM106', 'Analytical Engines')).reply).toContain('country');
    expect((await message(h.service, 'SM107', 'US')).reply).toContain('Reply YES');
    const registered = await message(h.service, 'SM108', 'YES');
    expect(registered.reply).toContain('Registration complete');

    const player = h.store.snapshot().players[joined.playerId!];
    expect(player?.lead).toMatchObject({
      firstName: 'Ada', lastName: 'Lovelace', workEmail: 'ada@example.com',
      companyName: 'Analytical Engines', phoneNumber: '+14155550199', countryCode: 'US',
    });
    expect(h.store.snapshot().wallets[joined.playerId!]?.wallet.cachedBalance).toBe(2);
    expect((await message(h.service, 'SM109', 'COIN')).reply).toContain('Coin inserted');
  });

  it('restores provider deduplication and registration progress after restart', async () => {
    const h = await harness('lead_capture');
    const joined = await message(h.service, 'SM201', 'JOIN ARCADE-01 LANG en-US');
    await message(h.service, 'SM202', 'Grace');

    const restartedStore = await ArcadeStateStore.open(h.store.file);
    let sequence = 100;
    const value = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
    value.arcade.mode = 'lead_capture';
    const restarted = new ArcadeService({
      store: restartedStore,
      config: parseArcadeConfig(value),
      clock: () => T0 + 5_000,
      idGenerator: kind => `${kind}-${++sequence}`,
      challengeTokenSecret: TOKEN_SECRET,
    });

    expect(await message(restarted, 'SM201', 'JOIN ARCADE-01 LANG en-US')).toEqual(joined);
    expect((await message(restarted, 'SM203', 'Hopper')).reply).toContain('work email');
  });

  it('uses READY language and creates no wallet ledger in free play', async () => {
    const h = await harness('coin_only', 'free');
    const joined = await message(h.service, 'SM301', 'JOIN ARCADE-01 LANG en-US');
    expect(joined.reply).toContain('Reply YES');
    expect((await message(h.service, 'SM302', 'YES')).reply).toContain('Reply READY');
    const ready = await message(h.service, 'SM303', 'READY');
    expect(ready.reply).toContain('ready in position 1');
    expect(ready.reply).toContain('Watch the screen');
    expect(ready.reply).not.toContain('we will text');
    expect(h.store.snapshot().wallets[joined.playerId!]?.transactions).toEqual([]);
    expect(h.store.snapshot().wallets[joined.playerId!]?.reservations).toEqual([]);
    expect(Object.values(h.store.snapshot().stationReadyEntries)[0]?.reservationId).toBeNull();
    expect((await message(h.service, 'SM304', 'STATUS')).reply).toBe('Station status: READY.');
  });

  it('requires a fresh JOIN after the cabinet changes', async () => {
    const h = await harness('coin_only');
    await message(h.service, 'SM401', 'JOIN ARCADE-01 LANG en-US');
    await message(h.service, 'SM402', 'YES');
    h.setCabinet('ARCADE-02');
    expect((await message(h.service, 'SM403', 'STATUS', '+14155550199', 'sms', 'ARCADE-02')).reply)
      .toBe('Reply JOIN ARCADE-02 to start.');
    expect((await message(
      h.service, 'SM404', 'JOIN ARCADE-02 LANG en-US', '+14155550199', 'sms', 'ARCADE-02',
    )).reply).toContain('Reply COIN');
  });

  it('reconciles persisted drafts when station mode changes', async () => {
    const coinToLead = await harness('coin_only');
    await message(coinToLead.service, 'SM-MODE-001', 'JOIN ARCADE-01 LANG en-US');
    await message(coinToLead.service, 'SM-MODE-002', 'YES');
    coinToLead.setMode('lead_capture');
    expect((await message(coinToLead.service, 'SM-MODE-003', 'JOIN ARCADE-01 LANG en-US')).reply)
      .toContain('first name');
    expect((await message(coinToLead.service, 'SM-MODE-004', 'Ada')).reply).toContain('last name');

    const leadToCoin = await harness('lead_capture');
    await message(leadToCoin.service, 'SM-MODE-101', 'JOIN ARCADE-01 LANG en-US');
    await message(leadToCoin.service, 'SM-MODE-102', 'Grace');
    leadToCoin.setMode('coin_only', 'free');
    expect((await message(leadToCoin.service, 'SM-MODE-103', 'JOIN ARCADE-01 LANG en-US')).reply)
      .toContain('Reply YES');
    expect((await message(leadToCoin.service, 'SM-MODE-104', 'READY')).reply)
      .toContain('Finish the quick intro');
    await message(leadToCoin.service, 'SM-MODE-105', 'YES');
    expect((await message(leadToCoin.service, 'SM-MODE-106', 'READY')).reply)
      .toContain('ready in position 1');
  });

  it('does not record terms acceptance when acknowledgement is disabled', async () => {
    const h = await harness('lead_capture', 'per_player', value => {
      value.registration.termsAcknowledgementRequired = false;
    });
    const joined = await message(h.service, 'SM501', 'JOIN ARCADE-01 LANG en-US');
    await message(h.service, 'SM502', 'Ada');
    await message(h.service, 'SM503', 'Lovelace');
    await message(h.service, 'SM504', 'ada@example.com');
    await message(h.service, 'SM505', 'Analytical Engines');
    expect((await message(h.service, 'SM506', 'US')).reply).toContain('Registration complete');
    expect(h.store.snapshot().players[joined.playerId!]?.termsAcceptedAt).toBeNull();
  });

  it('rejects browser phone replacement while a verified messaging address is linked', async () => {
    const h = await harness('lead_capture');
    const joined = await message(h.service, 'SM601', 'JOIN ARCADE-01 LANG en-US');
    await message(h.service, 'SM602', 'Ada');
    await message(h.service, 'SM603', 'Lovelace');
    await message(h.service, 'SM604', 'ada@example.com');
    await message(h.service, 'SM605', 'Analytical Engines');
    await message(h.service, 'SM606', 'US');
    await message(h.service, 'SM607', 'YES');
    await expect(h.service.registerPlayer({
      playerId: joined.playerId!,
      lead: {
        firstName: 'Ada', lastName: 'Lovelace', workEmail: 'ada@example.com',
        companyName: 'Analytical Engines', phoneNumber: '+14155550200', countryCode: 'US',
      },
      termsAccepted: true,
      idempotencyKey: 'replace-linked-phone',
    })).rejects.toMatchObject({ code: 'PHONE_CHANGE_REQUIRES_RELINK' });
  });

  it('links a verified inbound sender to a uniquely matching browser lead without duplication', async () => {
    const h = await harness('lead_capture');
    await h.service.registerPlayer({
      playerId: 'browser-player',
      lead: {
        firstName: 'Browser', lastName: 'Player', workEmail: 'browser@example.com',
        companyName: 'Example', phoneNumber: '+14155550199', countryCode: 'US',
      },
      termsAccepted: true,
      idempotencyKey: 'browser-registration',
    });
    const joined = await message(h.service, 'SM701', 'JOIN ARCADE-01 LANG en-US');
    expect(joined.playerId).toBe('browser-player');
    expect(joined.reply).toContain('2 coins');
    expect(h.store.snapshot().players['browser-player']?.lead?.firstName).toBe('Browser');
    expect(Object.keys(h.store.snapshot().players)).toEqual(['browser-player']);
    expect(Object.values(h.store.snapshot().channelAddresses)).toEqual([
      expect.objectContaining({ playerId: 'browser-player', normalizedAddress: '+14155550199' }),
    ]);
  });

  it('replenishes one coin for a messaging player after their prior paid game', async () => {
    const h = await harness('coin_only', 'per_player', config => { config.coins.startingBalance = 1; });
    const joined = await message(h.service, 'SM-REP-001', 'JOIN ARCADE-01 LANG en-US');
    await message(h.service, 'SM-REP-002', 'YES');
    await message(h.service, 'SM-REP-003', 'COIN');
    const station = await h.service.getStation('ARCADE-01');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: station!.station.revision,
      idempotencyKey: 'replenish-close', authorization: h.operatorAuthorization,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      idempotencyKey: 'replenish-select', authorization: h.operatorAuthorization,
      game: 'racer', engineRoomCode: 'REPLENISH',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'replenish-launch', authorization: h.operatorAuthorization,
    });
    const ready = await h.service.markStationDisplayReady({
      stationId: 'ARCADE-01', expectedRevision: launching.station.revision,
      idempotencyKey: 'replenish-ready', authorization: h.operatorAuthorization,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
    });
    const playing = await h.service.startStationMatch({
      stationId: 'ARCADE-01', expectedRevision: ready.station.revision,
      idempotencyKey: 'replenish-start', authorization: h.operatorAuthorization,
    });
    const results = await h.service.completeStationMatch({
      stationId: 'ARCADE-01', expectedRevision: playing.station.revision,
      idempotencyKey: 'replenish-complete', authorization: h.operatorAuthorization,
    });
    await h.service.advanceStationResults({
      stationId: 'ARCADE-01', expectedRevision: results.station.revision,
      idempotencyKey: 'replenish-advance', authorization: h.operatorAuthorization,
    });

    const second = await message(h.service, 'SM-REP-004', 'COIN');
    expect(second.reply).toContain('Coin inserted');
    const wallet = h.store.snapshot().wallets[joined.playerId!]!;
    expect(wallet.transactions.filter(transaction => transaction.type === 'operator_grant'))
      .toHaveLength(1);
    expect(wallet.reservations.filter(reservation => reservation.status === 'ACTIVE')).toHaveLength(1);
  });

  it('prunes stale anonymous drafts in bounded batches while retaining active, economic, and lead players', async () => {
    const h = await harness('lead_capture', 'free', undefined, {
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      pruneBatchSize: 1,
    });
    const staleOne = await message(h.service, 'SM-RET-001', 'JOIN ARCADE-01', '+14155550101');
    const staleTwo = await message(h.service, 'SM-RET-002', 'JOIN ARCADE-01', '+14155550102');
    const economic = await message(h.service, 'SM-RET-003', 'JOIN ARCADE-01', '+14155550103');
    const lead = await message(h.service, 'SM-RET-004', 'JOIN ARCADE-01', '+14155550104');
    await message(h.service, 'SM-RET-005', 'Ada', '+14155550104');
    await message(h.service, 'SM-RET-006', 'Lovelace', '+14155550104');
    await message(h.service, 'SM-RET-007', 'ada@example.com', '+14155550104');
    await message(h.service, 'SM-RET-008', 'Analytical Engines', '+14155550104');
    await message(h.service, 'SM-RET-009', 'US', '+14155550104');
    await message(h.service, 'SM-RET-010', 'YES', '+14155550104');
    const active = await message(h.service, 'SM-RET-011', 'JOIN ARCADE-01', '+14155550105');

    const cleanupAt = T0 + (31 * 24 * 60 * 60 * 1000);
    await h.store.transaction(state => {
      const economicWallet = state.wallets[economic.playerId!]!;
      state.wallets[economic.playerId!] = grantRegistrationCoins(economicWallet, {
        amount: 1,
        transactionId: 'retention-economic-grant',
        idempotencyKey: 'retention-economic-grant',
        createdAt: economicWallet.wallet.createdAt,
        configVersion: 1,
      });
      const activeQueue = joinQueue([], {
        id: 'retention-active-queue',
        eventId: 'retention-active-queue-event',
        cabinetId: 'ARCADE-01',
        playerId: active.playerId!,
        preferredGame: 'racer',
        flexibleGame: false,
        joinedAt: state.players[active.playerId!]!.createdAt,
        configVersion: 1,
      });
      state.queueEntries[activeQueue.entry.id] = activeQueue.entry;
      state.queueEvents.push(activeQueue.event);
    });
    h.setNow(cleanupAt);

    await message(h.service, 'SM-RET-012', 'HELP', '+14155550106');
    let state = h.store.snapshot();
    expect(state.players[staleOne.playerId!]).toBeUndefined();
    expect(state.players[staleTwo.playerId!]).toBeDefined();
    expect(state.inboundMessages[providerKey('SM-RET-001', '+14155550101')]).toBeUndefined();

    await message(h.service, 'SM-RET-013', 'HELP', '+14155550107');
    state = h.store.snapshot();
    expect(state.players[staleTwo.playerId!]).toBeUndefined();
    expect(state.players[active.playerId!]).toBeDefined();
    expect(state.queueEntries['retention-active-queue']?.status).toBe('WAITING');
    expect(state.players[economic.playerId!]).toBeDefined();
    expect(state.wallets[economic.playerId!]?.transactions).toHaveLength(1);
    expect(state.players[lead.playerId!]?.lead?.workEmail).toBe('ada@example.com');
    expect((await h.service.getMessagingStorageStatus()).cleanupEligible).toBe(0);
  });

  it('returns an idempotent capacity response before creating excess messaging identities', async () => {
    const h = await harness('lead_capture', 'free', undefined, { identityCapacity: 2 });
    await message(h.service, 'SM-CAP-001', 'JOIN ARCADE-01', '+14155550201');
    await message(h.service, 'SM-CAP-002', 'JOIN ARCADE-01', '+14155550202');
    const rejected = await message(h.service, 'SM-CAP-003', 'JOIN ARCADE-01', '+14155550203');

    expect(rejected).toMatchObject({ playerId: null, command: 'CAPACITY' });
    expect(rejected.reply).toContain('temporarily at capacity');
    expect(await message(h.service, 'SM-CAP-003', 'JOIN ARCADE-01', '+14155550203'))
      .toEqual(rejected);
    const state = h.store.snapshot();
    expect(Object.keys(state.players)).toHaveLength(2);
    expect(Object.keys(state.messagingDrafts)).toHaveLength(2);
    expect(Object.keys(state.inboundMessages)).toHaveLength(3);
    expect(await h.service.getMessagingStorageStatus()).toMatchObject({
      players: 2,
      messagingIdentities: 2,
      identityCapacity: 2,
      remainingIdentityCapacity: 0,
    });

    for (let index = 0; index < 105; index += 1) {
      await message(
        h.service,
        `SM-CAP-FLOOD-${index}`,
        'JOIN ARCADE-01',
        `+1415666${index.toString().padStart(4, '0')}`,
      );
    }
    const flooded = h.store.snapshot();
    expect(Object.keys(flooded.players)).toHaveLength(2);
    expect(Object.values(flooded.inboundMessages)
      .filter(receipt => receipt.command === 'CAPACITY').length).toBeLessThanOrEqual(100);
    expect(flooded.inboundMessages[providerKey('SM-CAP-001', '+14155550201')]).toBeDefined();

    const fileGuarded = await harness('lead_capture', 'free', undefined, {
      stateAdmissionMaxBytes: 1,
    });
    const fileRejected = await message(
      fileGuarded.service, 'SM-CAP-FILE', 'JOIN ARCADE-01', '+14155550204',
    );
    expect(fileRejected).toMatchObject({ playerId: null, command: 'CAPACITY' });
    expect(Object.keys(fileGuarded.store.snapshot().players)).toHaveLength(0);
  });
});
