import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ARCADE_CONFIG, parseArcadeConfig, type ArcadeConfigSnapshot } from '../shared/arcade-config';
import { ArcadeEventHub } from '../server/arcade-events';
import {
  ArcadeMessagingRuntime,
  ArcadeMessagingTransportError,
  type ArcadeMessagingTransport,
} from '../server/arcade-messaging-runtime';
import { ArcadeService } from '../server/arcade-service';
import { ArcadeStateStore } from '../server/arcade-state-store';

const directories: string[] = [];
const AUTHORIZATION = Object.freeze({ trusted: true });
const TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
const T0 = Date.parse('2026-07-21T10:00:00.000Z');
const CONTENT_SID = `HX${'a'.repeat(32)}`;
const MESSAGE_SID = `SM${'b'.repeat(32)}`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function outboxHarness(input: {
  channel?: 'sms' | 'whatsapp';
  template?: boolean;
  playerCount?: number;
  game?: 'racer' | 'fighter';
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcade-messaging-runtime-'));
  directories.push(directory);
  const store = await ArcadeStateStore.open(path.join(directory, 'state.json'));
  const events = new ArcadeEventHub();
  let now = T0;
  let config = stationConfig('coin_only');
  let sequence = 0;
  const service = new ArcadeService({
    store,
    config: () => config,
    clock: () => now,
    idGenerator: kind => `${kind}-${++sequence}`,
    challengeTokenSecret: TOKEN_SECRET,
    operatorAuthorizer: value => value === AUTHORIZATION
      ? { kind: 'operator', subject: 'messaging-runtime-test' }
      : null,
    stationNotifications: {
      enabled: () => true,
      callNumber: () => '+14155550100',
      whatsappContentSid: () => input.template === false ? null : CONTENT_SID,
    },
  });
  const channel = input.channel ?? 'sms';
  for (let index = 0; index < (input.playerCount ?? 1); index += 1) {
    const from = `+1415555019${index}`;
    for (const [suffix, body] of [['JOIN', 'JOIN ARCADE-01 LANG en-US'], ['TERMS', 'YES'], ['COIN', 'COIN']] as const) {
      const providerMessageId = `SM-${suffix}-${index}`;
      await service.processInboundStationMessage({
        channel,
        normalizedAddress: from,
        providerAddress: channel === 'whatsapp' ? `whatsapp:${from}` : from,
        providerMessageId,
        body,
        stationId: 'ARCADE-01',
        preferredLocale: 'en-US',
        idempotencyKey: providerKey(providerMessageId),
      });
    }
  }
  const recruiting = await service.getStation('ARCADE-01');
  const selecting = await service.closeStationRecruiting({
    stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
    idempotencyKey: 'close', authorization: AUTHORIZATION,
  });
  await service.selectStationGame({
    stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
    game: input.game ?? 'racer', engineRoomCode: '4821', idempotencyKey: 'select', authorization: AUTHORIZATION,
  });
  return {
    store,
    service,
    events,
    now: () => now,
    setNow: (value: number) => { now = value; },
    setMode: (mode: 'off' | 'coin_only') => { config = stationConfig(mode); },
    setVoiceEnabled: (enabled: boolean) => {
      const value = JSON.parse(JSON.stringify(config)) as Record<string, any>;
      value.channels.voice = enabled;
      config = parseArcadeConfig(value);
    },
    config: () => config,
  };
}

function stationConfig(mode: 'off' | 'coin_only'): ArcadeConfigSnapshot {
  const value = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
  value.arcade.mode = mode;
  value.coins.startingBalance = 2;
  value.channels.sms = true;
  value.channels.whatsapp = true;
  value.postGame.enabled = true;
  value.postGame.channels = ['sms', 'whatsapp'];
  return parseArcadeConfig(value);
}

function providerKey(value: string): string {
  return `provider:${createHash('sha256').update(value).digest('hex')}`;
}

function runtime(
  h: Awaited<ReturnType<typeof outboxHarness>>,
  transport: ArcadeMessagingTransport,
  timer?: {
    set: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clear: (handle: NodeJS.Timeout) => void;
  },
) {
  return new ArcadeMessagingRuntime({
    store: h.store,
    config: h.config,
    events: h.events,
    publicBaseUrl: 'https://arcade.example',
    enabled: () => true,
    callNumber: () => '+14155550100',
    createTransport: () => transport,
    clock: h.now,
    setTimer: timer?.set,
    clearTimer: timer?.clear,
  });
}

function controlledTimer() {
  let scheduled: { handle: NodeJS.Timeout; callback: () => void; delayMs: number } | null = null;
  return {
    timer: {
      set: (callback: () => void, delayMs: number) => {
        const handle = setTimeout(() => undefined, 2_147_483_647);
        handle.unref();
        scheduled = { handle, callback, delayMs };
        return handle;
      },
      clear: (handle: NodeJS.Timeout) => {
        clearTimeout(handle);
        if (scheduled?.handle === handle) scheduled = null;
      },
    },
    scheduled: () => scheduled,
    fire: () => {
      const current = scheduled;
      if (!current) throw new Error('no timer scheduled');
      clearTimeout(current.handle);
      scheduled = null;
      current.callback();
    },
  };
}

describe('ArcadeMessagingRuntime', () => {
  it('claims durably before send and applies monotonic status callbacks', async () => {
    const h = await outboxHarness();
    let callbackUrl = '';
    const transport: ArcadeMessagingTransport = {
      send: async input => {
        const record = Object.values(h.store.snapshot().outboundNotifications)[0]!;
        expect(record.status).toBe('SENDING');
        expect(record.attempts).toHaveLength(1);
        callbackUrl = input.statusCallback;
        return { providerMessageId: MESSAGE_SID, status: 'queued' };
      },
    };
    const worker = runtime(h, transport);
    await worker.start();

    const accepted = Object.values(h.store.snapshot().outboundNotifications)[0]!;
    expect(accepted).toMatchObject({ status: 'ACCEPTED' });
    expect(accepted.attempts[0]).toMatchObject({ providerMessageId: MESSAGE_SID, providerStatus: 'queued' });
    const parsed = new URL(callbackUrl.split('#')[0]!);
    const callback = {
      notificationId: parsed.searchParams.get('n')!,
      attemptId: parsed.searchParams.get('a')!,
      providerMessageId: MESSAGE_SID,
    };
    expect(await worker.recordStatus({ ...callback, providerStatus: 'delivered' })).toBe(true);
    expect(await worker.recordStatus({ ...callback, providerStatus: 'sent' })).toBe(true);
    expect(Object.values(h.store.snapshot().outboundNotifications)[0]).toMatchObject({ status: 'DELIVERED' });
    expect(Object.values(h.store.snapshot().outboundNotifications)[0]!.attempts[0]!.providerStatus)
      .toBe('delivered');
    expect(worker.getStatus().counts.DELIVERED).toBe(1);
    await worker.stop();
  });

  it('keeps a callback that arrives before the REST response is persisted', async () => {
    const h = await outboxHarness();
    let worker: ArcadeMessagingRuntime;
    worker = runtime(h, {
      send: async input => {
        const parsed = new URL(input.statusCallback.split('#')[0]!);
        await worker.recordStatus({
          notificationId: parsed.searchParams.get('n')!,
          attemptId: parsed.searchParams.get('a')!,
          providerMessageId: MESSAGE_SID,
          providerStatus: 'delivered',
        });
        return { providerMessageId: MESSAGE_SID, status: 'queued' };
      },
    });
    await worker.start();
    const notification = Object.values(h.store.snapshot().outboundNotifications)[0]!;
    expect(notification.status).toBe('DELIVERED');
    expect(notification.attempts[0]).toMatchObject({
      providerMessageId: MESSAGE_SID,
      providerStatus: 'delivered',
    });
    await worker.stop();
  });

  it('preserves failure diagnostics when a lower status callback arrives late', async () => {
    const h = await outboxHarness();
    let callbackUrl = '';
    const worker = runtime(h, {
      send: async input => {
        callbackUrl = input.statusCallback;
        return { providerMessageId: MESSAGE_SID, status: 'queued' };
      },
    });
    await worker.start();
    const parsed = new URL(callbackUrl.split('#')[0]!);
    const callback = {
      notificationId: parsed.searchParams.get('n')!,
      attemptId: parsed.searchParams.get('a')!,
      providerMessageId: MESSAGE_SID,
    };
    await worker.recordStatus({
      ...callback, providerStatus: 'failed', errorCode: '30003', errorMessage: 'Unreachable',
    });
    await worker.recordStatus({ ...callback, providerStatus: 'sent' });
    const attempt = Object.values(h.store.snapshot().outboundNotifications)[0]!.attempts[0]!;
    expect(attempt).toMatchObject({
      providerStatus: 'failed', errorCode: '30003', errorMessage: 'Unreachable',
    });
    await worker.stop();
  });

  it('retries transient failures with bounded backoff and stops after five attempts', async () => {
    const h = await outboxHarness();
    const notification = Object.values(h.store.snapshot().outboundNotifications)[0]!;
    await h.store.transaction(state => {
      state.outboundNotifications[notification.id] = {
        ...notification,
        expiresAt: new Date(T0 + 2 * 60 * 60 * 1000).toISOString(),
      };
    });
    const clock = controlledTimer();
    let attempts = 0;
    const worker = runtime(h, {
      send: async () => {
        attempts++;
        throw new ArcadeMessagingTransportError('temporary outage', true, '503');
      },
    }, clock.timer);
    await worker.start();
    expect(clock.scheduled()?.delayMs).toBe(5_000);
    for (const delay of [5_000, 30_000, 120_000, 600_000]) {
      h.setNow(h.now() + delay);
      clock.fire();
      await worker.flush();
    }
    const failed = Object.values(h.store.snapshot().outboundNotifications)[0]!;
    expect(attempts).toBe(5);
    expect(failed.status).toBe('FAILED');
    expect(failed.attempts).toHaveLength(5);
    await expect(worker.retryFailedNotification({
      notificationId: failed.id,
      actorSubject: 'operator@twilio.com',
      reason: 'retry after transient outage',
      idempotencyKey: 'retry-exhausted',
    })).rejects.toMatchObject({ code: 'ATTEMPTS_EXHAUSTED' });
    expect(clock.scheduled()).toBeNull();
    await worker.stop();
  });

  it('quarantines an unknown transport outcome without retrying', async () => {
    const h = await outboxHarness();
    let sends = 0;
    const worker = runtime(h, {
      send: async () => { sends += 1; throw new Error('socket timed out after request write'); },
    });
    await worker.start();
    const notification = Object.values(h.store.snapshot().outboundNotifications)[0]!;
    expect(notification).toMatchObject({
      status: 'ACCEPTED', terminalReason: 'AMBIGUOUS_PROVIDER_ACCEPTANCE',
    });
    expect(notification.attempts).toHaveLength(1);
    expect(sends).toBe(1);
    await expect(worker.retryFailedNotification({
      notificationId: notification.id,
      actorSubject: 'operator@twilio.com',
      reason: 'unsafe ambiguous retry',
      idempotencyKey: 'retry-ambiguous',
    })).rejects.toMatchObject({ code: 'NOTIFICATION_NOT_RETRYABLE' });
    expect(h.store.snapshot().messagingAuditEvents).toEqual({});
    await worker.stop();
  });

  it('does not resend when persisting a successful provider result fails', async () => {
    const h = await outboxHarness();
    const clock = controlledTimer();
    const transaction = h.store.transaction.bind(h.store);
    let failNextTransaction = false;
    vi.spyOn(h.store, 'transaction').mockImplementation(async mutation => {
      if (failNextTransaction) {
        failNextTransaction = false;
        throw new Error('persistence unavailable');
      }
      return transaction(mutation);
    });
    let sends = 0;
    const worker = runtime(h, {
      send: async () => {
        sends += 1;
        failNextTransaction = true;
        return { providerMessageId: MESSAGE_SID, status: 'queued' };
      },
    }, clock.timer);
    await worker.start();
    expect(Object.values(h.store.snapshot().outboundNotifications)[0]!.status).toBe('SENDING');
    expect(clock.scheduled()?.delayMs).toBe(30_000);
    h.setNow(h.now() + 30_000);
    clock.fire();
    await worker.flush();
    expect(Object.values(h.store.snapshot().outboundNotifications)[0]).toMatchObject({
      status: 'ACCEPTED', terminalReason: 'AMBIGUOUS_PROVIDER_ACCEPTANCE',
    });
    expect(sends).toBe(1);
    await worker.stop();
  });

  it('recovers a stale claimed attempt after restart', async () => {
    const h = await outboxHarness();
    const notification = Object.values(h.store.snapshot().outboundNotifications)[0]!;
    await h.store.transaction(state => {
      state.outboundNotifications[notification.id] = {
        ...notification,
        status: 'SENDING',
        nextAttemptAt: null,
        attempts: [{
          id: `${notification.id}:attempt:1`, ordinal: 1, providerMessageId: null,
          providerStatus: null, startedAt: new Date(T0 - 31_000).toISOString(),
          finishedAt: null, callbackAt: null, errorCode: null, errorMessage: null,
        }],
      };
    });
    let sends = 0;
    const worker = runtime(h, {
      send: async () => { sends += 1; return { providerMessageId: MESSAGE_SID, status: 'queued' }; },
    });
    await worker.start();
    const recovered = h.store.snapshot().outboundNotifications[notification.id]!;
    expect(recovered.status).toBe('ACCEPTED');
    expect(recovered.attempts).toHaveLength(1);
    expect(recovered.terminalReason).toBe('AMBIGUOUS_PROVIDER_ACCEPTANCE');
    expect(recovered.attempts[0]).toMatchObject({
      errorCode: 'SEND_RESULT_UNKNOWN',
      providerMessageId: null,
    });
    expect(sends).toBe(0);
    await worker.stop();
  });

  it('uses a template outside the WhatsApp window and suppresses when none is configured', async () => {
    const inWindow = await outboxHarness({ channel: 'whatsapp' });
    let freeForm: Parameters<ArcadeMessagingTransport['send']>[0] | null = null;
    const inWindowWorker = runtime(inWindow, {
      send: async input => {
        freeForm = input;
        return { providerMessageId: MESSAGE_SID, status: 'queued' };
      },
    });
    await inWindowWorker.start();
    expect(freeForm).toHaveProperty('body');
    expect(freeForm).not.toHaveProperty('contentSid');
    await inWindowWorker.stop();

    const templated = await outboxHarness({ channel: 'whatsapp' });
    const templatedRecord = Object.values(templated.store.snapshot().outboundNotifications)[0]!;
    await templated.store.transaction(state => {
      state.outboundNotifications[templatedRecord.id] = {
        ...templatedRecord,
        expiresAt: new Date(T0 + 26 * 60 * 60 * 1000).toISOString(),
      };
    });
    templated.setNow(T0 + 24 * 60 * 60 * 1000);
    let sent: Parameters<ArcadeMessagingTransport['send']>[0] | null = null;
    const first = runtime(templated, {
      send: async input => {
        sent = input;
        return { providerMessageId: MESSAGE_SID, status: 'queued' };
      },
    });
    await first.start();
    expect(sent).toMatchObject({ contentSid: CONTENT_SID });
    expect(sent).not.toHaveProperty('body');
    await first.stop();

    const missing = await outboxHarness({ channel: 'whatsapp', template: false });
    const missingRecord = Object.values(missing.store.snapshot().outboundNotifications)[0]!;
    await missing.store.transaction(state => {
      state.outboundNotifications[missingRecord.id] = {
        ...missingRecord,
        expiresAt: new Date(T0 + 26 * 60 * 60 * 1000).toISOString(),
      };
    });
    missing.setNow(T0 + 24 * 60 * 60 * 1000);
    let sends = 0;
    const second = runtime(missing, {
      send: async () => { sends++; return { providerMessageId: MESSAGE_SID, status: 'queued' }; },
    });
    await second.start();
    expect(sends).toBe(0);
    expect(missing.store.snapshot().outboundNotifications[missingRecord.id]).toMatchObject({
      status: 'SUPPRESSED', terminalReason: 'WHATSAPP_TEMPLATE_REQUIRED',
    });
    await second.stop();
  });

  it('sends nothing while mode is off and prunes retained terminal records after re-enable', async () => {
    const h = await outboxHarness();
    const notification = Object.values(h.store.snapshot().outboundNotifications)[0]!;
    h.setMode('off');
    let sends = 0;
    const worker = runtime(h, {
      send: async () => { sends++; return { providerMessageId: MESSAGE_SID, status: 'queued' }; },
    });
    await worker.start();
    expect(sends).toBe(0);
    expect(h.store.snapshot().outboundNotifications[notification.id]?.status).toBe('PENDING');
    await worker.stop();

    await h.store.transaction(state => {
      state.outboundNotifications[notification.id] = {
        ...notification,
        status: 'DELIVERED', nextAttemptAt: null, terminalReason: 'DELIVERED',
        terminalAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
      };
    });
    h.setMode('coin_only');
    h.setNow(T0 + 31 * 24 * 60 * 60 * 1000);
    const pruner = runtime(h, {
      send: async () => { throw new Error('should not send'); },
    });
    await pruner.start();
    expect(h.store.snapshot().outboundNotifications[notification.id]).toBeUndefined();
    await pruner.stop();
  });

  it('suppresses a pending call-now notice after its voice route becomes invalid', async () => {
    const h = await outboxHarness();
    const selected = await h.service.getStation('ARCADE-01');
    await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: selected!.station.revision,
      idempotencyKey: 'call-now-launch', authorization: AUTHORIZATION,
    });
    h.setVoiceEnabled(false);
    const worker = runtime(h, {
      send: async () => ({ providerMessageId: MESSAGE_SID, status: 'queued' }),
    });
    await worker.start();
    const callNow = Object.values(h.store.snapshot().outboundNotifications)
      .find(notification => notification.kind === 'STATION_CALL_NOW')!;
    expect(callNow).toMatchObject({ status: 'SUPPRESSED', terminalReason: 'VOICE_ROUTE_CHANGED' });
    await worker.stop();
  });

  it('revalidates admitted, overflow, and call notices after launch failure', async () => {
    const h = await outboxHarness({ playerCount: 3, game: 'fighter' });
    const locked = await h.service.getStation('ARCADE-01');
    const launching = await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked!.station.revision,
      idempotencyKey: 'obsolete-launch', authorization: AUTHORIZATION,
    });
    await h.service.failStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: launching.station.revision,
      idempotencyKey: 'obsolete-fail', authorization: AUTHORIZATION,
    });
    let sends = 0;
    const worker = runtime(h, {
      send: async () => { sends += 1; return { providerMessageId: MESSAGE_SID, status: 'queued' }; },
    });
    await worker.start();

    const notices = Object.values(h.store.snapshot().outboundNotifications);
    expect(sends).toBe(0);
    expect(notices.filter(item => item.kind === 'STATION_ADMITTED')
      .every(item => item.status === 'SUPPRESSED' && item.terminalReason === 'ADMISSION_OBSOLETE')).toBe(true);
    expect(notices.find(item => item.kind === 'STATION_OVERFLOW')).toMatchObject({
      status: 'SUPPRESSED', terminalReason: 'OVERFLOW_OBSOLETE',
    });
    expect(notices.filter(item => item.kind === 'STATION_CALL_NOW')
      .every(item => item.status === 'SUPPRESSED' && item.terminalReason === 'CALL_NOW_OBSOLETE')).toBe(true);
    await worker.stop();
  });

  it('revalidates result and next-game notices after reset and later selection', async () => {
    const resetHarness = await outboxHarness();
    const locked = await resetHarness.service.getStation('ARCADE-01');
    const launching = await resetHarness.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked!.station.revision,
      idempotencyKey: 'result-launch', authorization: AUTHORIZATION,
    });
    const displayReady = await resetHarness.service.markStationDisplayReady({
      stationId: 'ARCADE-01', expectedRevision: launching.station.revision,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      idempotencyKey: 'result-display', authorization: AUTHORIZATION,
    });
    const playing = await resetHarness.service.startStationMatch({
      stationId: 'ARCADE-01', expectedRevision: displayReady.station.revision,
      idempotencyKey: 'result-start', authorization: AUTHORIZATION,
    });
    const results = await resetHarness.service.completeStationMatch({
      stationId: 'ARCADE-01', expectedRevision: playing.station.revision,
      idempotencyKey: 'result-complete', authorization: AUTHORIZATION,
    });
    await resetHarness.service.resetStation({
      stationId: 'ARCADE-01', expectedRevision: results.station.revision,
      idempotencyKey: 'result-reset', reason: 'test reset invalidates screen result',
      authorization: AUTHORIZATION,
    });
    const resetWorker = runtime(resetHarness, {
      send: async () => { throw new Error('obsolete result should not send'); },
    });
    await resetWorker.start();
    expect(Object.values(resetHarness.store.snapshot().outboundNotifications)
      .find(item => item.kind === 'STATION_RESULTS')).toMatchObject({
      status: 'SUPPRESSED', terminalReason: 'RESULTS_OBSOLETE',
    });
    await resetWorker.stop();

    const promotedHarness = await outboxHarness({ playerCount: 3, game: 'fighter' });
    const promotedLocked = await promotedHarness.service.getStation('ARCADE-01');
    const promotedLaunching = await promotedHarness.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: promotedLocked!.station.revision,
      idempotencyKey: 'next-launch', authorization: AUTHORIZATION,
    });
    const promotedDisplay = await promotedHarness.service.markStationDisplayReady({
      stationId: 'ARCADE-01', expectedRevision: promotedLaunching.station.revision,
      matchId: promotedLaunching.match!.id, launchGeneration: promotedLaunching.match!.launchGeneration,
      idempotencyKey: 'next-display', authorization: AUTHORIZATION,
    });
    const promotedPlaying = await promotedHarness.service.startStationMatch({
      stationId: 'ARCADE-01', expectedRevision: promotedDisplay.station.revision,
      idempotencyKey: 'next-start', authorization: AUTHORIZATION,
    });
    const promotedResults = await promotedHarness.service.completeStationMatch({
      stationId: 'ARCADE-01', expectedRevision: promotedPlaying.station.revision,
      idempotencyKey: 'next-complete', authorization: AUTHORIZATION,
    });
    const recruiting = await promotedHarness.service.advanceStationResults({
      stationId: 'ARCADE-01', expectedRevision: promotedResults.station.revision,
      idempotencyKey: 'next-advance', authorization: AUTHORIZATION,
    });
    const selecting = await promotedHarness.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting.station.revision,
      idempotencyKey: 'next-close', authorization: AUTHORIZATION,
    });
    await promotedHarness.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: '5932', idempotencyKey: 'next-select',
      authorization: AUTHORIZATION,
    });
    let promotedSends = 0;
    const promotedWorker = runtime(promotedHarness, {
      send: async () => ({
        providerMessageId: `SM${(++promotedSends).toString(16).padStart(32, '0')}`,
        status: 'queued',
      }),
    });
    await promotedWorker.start();
    expect(Object.values(promotedHarness.store.snapshot().outboundNotifications)
      .find(item => item.kind === 'STATION_NEXT_GAME')).toMatchObject({
      status: 'SUPPRESSED', terminalReason: 'NEXT_GAME_OBSOLETE',
    });
    await promotedWorker.stop();
  });

  it('keeps callback failures terminal until an idempotent audited operator retry', async () => {
    const h = await outboxHarness();
    const callbackUrls: string[] = [];
    let sends = 0;
    const worker = runtime(h, {
      send: async input => {
        callbackUrls.push(input.statusCallback);
        sends += 1;
        return {
          providerMessageId: `SM${(sends === 1 ? 'b' : 'c').repeat(32)}`,
          status: 'queued',
        };
      },
    });
    await worker.start();
    const firstCallback = new URL(callbackUrls[0]!.split('#')[0]!);
    const first = {
      notificationId: firstCallback.searchParams.get('n')!,
      attemptId: firstCallback.searchParams.get('a')!,
      providerMessageId: `SM${'b'.repeat(32)}`,
    };
    await worker.recordStatus({
      ...first, providerStatus: 'undelivered', errorCode: '30003', errorMessage: 'Unreachable',
    });
    await worker.recordStatus({ ...first, providerStatus: 'delivered' });
    expect(h.store.snapshot().outboundNotifications[first.notificationId]).toMatchObject({
      status: 'FAILED', terminalReason: 'UNDELIVERED',
    });
    expect(sends).toBe(1);

    const retryInput = {
      notificationId: first.notificationId,
      actorSubject: 'operator@twilio.com',
      reason: 'visitor confirmed the handset is reachable',
      idempotencyKey: 'operator-retry-1',
    };
    await expect(worker.retryFailedNotification(retryInput)).resolves.toMatchObject({
      status: 'PENDING', replayed: false,
    });
    await worker.flush();
    expect(sends).toBe(2);
    const secondCallback = new URL(callbackUrls[1]!.split('#')[0]!);
    await worker.recordStatus({
      notificationId: secondCallback.searchParams.get('n')!,
      attemptId: secondCallback.searchParams.get('a')!,
      providerMessageId: `SM${'c'.repeat(32)}`,
      providerStatus: 'delivered',
    });
    await expect(worker.retryFailedNotification(retryInput)).resolves.toMatchObject({
      status: 'DELIVERED', replayed: true,
    });
    expect(sends).toBe(2);
    expect(Object.values(h.store.snapshot().messagingAuditEvents)).toEqual([
      expect.objectContaining({
        action: 'RETRY_OUTBOUND_NOTIFICATION', actorSubject: 'operator@twilio.com',
        reason: retryInput.reason, notificationId: first.notificationId, attemptCount: 1,
      }),
    ]);
    const restarted = await ArcadeStateStore.open(h.store.file);
    expect(Object.values(restarted.snapshot().messagingAuditEvents)).toHaveLength(1);
    await worker.stop();
  });
});
