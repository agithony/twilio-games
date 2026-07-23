import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ARCADE_CONFIG, type ArcadeConfigSettings } from '../shared/arcade-config';
import { ArcadeConfigStore } from '../server/arcade-config-store';
import { ArcadeApi } from '../server/arcade-api';
import { ArcadeEventHub } from '../server/arcade-events';
import { ArcadePlayerRuntime } from '../server/arcade-player-runtime';
import { ArcadeStateStore } from '../server/arcade-state-store';

const SECRET = '0123456789abcdef'.repeat(4);
let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function settings(mode: 'off' | 'coin_only' | 'lead_capture'): ArcadeConfigSettings {
  const copy = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
  delete copy.schemaVersion;
  delete copy.version;
  delete copy.updatedAt;
  delete copy.updatedBy;
  copy.arcade.mode = mode;
  return copy as ArcadeConfigSettings;
}

async function harness(secret: string | null = SECRET): Promise<{
  store: ArcadeConfigStore;
  events: ArcadeEventHub;
  stateFile: string;
  runtime: ArcadePlayerRuntime;
}> {
  directory = await mkdtemp(path.join(tmpdir(), 'arcade-player-runtime-'));
  const events = new ArcadeEventHub();
  const store = new ArcadeConfigStore({ directory: path.join(directory, 'config'), events });
  const stateFile = path.join(directory, 'state', 'arcade.json');
  const runtime = new ArcadePlayerRuntime({
    configStore: store,
    events,
    stateFile,
    publicBaseUrl: 'https://arcade.example',
    signingSecret: () => secret ?? undefined,
  });
  return { store, events, stateFile, runtime };
}

describe('ArcadePlayerRuntime', () => {
  it('does not read malformed player state or require a signing secret while mode is off', async () => {
    const h = await harness(null);
    await mkdir(path.dirname(h.stateFile), { recursive: true });
    await writeFile(h.stateFile, '{malformed');
    await h.runtime.start();

    expect(h.runtime.getStatus()).toEqual({
      started: true, mode: 'off', initialized: false, degraded: false, reason: null,
    });
    await expect(h.runtime.getActive()).rejects.toMatchObject({ code: 'MODE_DISABLED' });
    await h.runtime.stop();
  });

  it('does not construct outbound credentials while mode is off', async () => {
    const h = await harness();
    let transportCreates = 0;
    const runtime = new ArcadePlayerRuntime({
      configStore: h.store,
      events: h.events,
      stateFile: h.stateFile,
      publicBaseUrl: 'https://arcade.example',
      signingSecret: () => SECRET,
      outboundMessaging: {
        enabled: () => true,
        createTransport: () => {
          transportCreates++;
          throw new Error('credentials should remain lazy');
        },
      },
    });
    await runtime.start();
    expect(transportCreates).toBe(0);
    expect(runtime.getMessagingStatus()).toBeNull();
    await runtime.stop();
  });

  it('initializes once for concurrent requests after enable and exposes signed sessions', async () => {
    const h = await harness();
    let opens = 0;
    const runtime = new ArcadePlayerRuntime({
      configStore: h.store,
      events: h.events,
      stateFile: h.stateFile,
      publicBaseUrl: 'https://arcade.example',
      signingSecret: () => SECRET,
      openStateStore: async file => { opens++; return ArcadeStateStore.open(file); },
    });
    await runtime.start();
    await h.store.update({
      expectedVersion: 1, idempotencyKey: 'enable', updatedBy: 'admin@twilio.com',
      settings: settings('lead_capture'),
    });
    const [first, second] = await Promise.all([runtime.getActive(), runtime.getActive()]);
    expect(first).toBe(second);
    expect(opens).toBe(1);
    expect(first.sessions.issue('player:one', 'ARCADE-01').token).toBeTruthy();
    await runtime.stop();
  });

  it('records sanitized degraded state while keeping config recoverable', async () => {
    const h = await harness(null);
    let opens = 0;
    let secretReads = 0;
    const runtime = new ArcadePlayerRuntime({
      configStore: h.store,
      events: h.events,
      stateFile: h.stateFile,
      publicBaseUrl: 'https://arcade.example',
      signingSecret: () => { secretReads++; return undefined; },
      openStateStore: async file => { opens++; return ArcadeStateStore.open(file); },
    });
    await runtime.start();
    await h.store.update({
      expectedVersion: 1, idempotencyKey: 'enable', updatedBy: 'admin@twilio.com',
      settings: settings('coin_only'),
    });
    await expect(runtime.getActive()).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE' });
    await expect(runtime.getActive()).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE' });
    expect(secretReads).toBe(1);
    expect(opens).toBe(0);
    expect(runtime.getStatus()).toEqual({
      started: true, mode: 'coin_only', initialized: false,
      degraded: true, reason: 'INITIALIZATION_FAILED',
    });
    await h.store.update({
      expectedVersion: 2, idempotencyKey: 'disable', updatedBy: 'admin@twilio.com',
      settings: settings('off'),
    });
    expect(runtime.getStatus().mode).toBe('off');
    await runtime.stop();
  });

  it('reports config degradation, blocks new value mutations, and permits cleanup', async () => {
    const h = await harness();
    await h.runtime.start();
    const enabled = settings('lead_capture') as Record<string, any>;
    enabled.earning.challenges = [{
      id: 'voice-docs', title: 'Read the Voice docs', message: null, url: 'https://www.twilio.com/docs/voice',
      rewardCoins: 1, enabled: true, maxClaimsPerPlayer: 1, displayOrder: 0,
      startsAt: null, endsAt: null,
    }];
    await h.store.update({
      expectedVersion: 1, idempotencyKey: 'degraded-enable', updatedBy: 'admin@twilio.com',
      settings: enabled,
    });
    const active = await h.runtime.getActive();
    const registrationInput = {
      playerId: 'player:degraded',
      idempotencyKey: 'degraded-register',
      lead: {
        firstName: 'Ada', lastName: 'Lovelace', workEmail: 'ada@example.com',
        companyName: 'Analytical Engines', phoneNumber: '+14155550199', countryCode: 'US',
      },
      termsAccepted: true,
    } as const;
    await active.service.registerPlayer(registrationInput);
    const joined = await active.service.joinQueue({
      playerId: registrationInput.playerId,
      preferredGame: 'racer',
      idempotencyKey: 'degraded-queue-join',
    });
    await h.runtime.stop();
    await appendFile(h.store.auditPath, 'not-json\n');

    const events = new ArcadeEventHub();
    const store = new ArcadeConfigStore({ directory: path.dirname(h.store.cachePath), events });
    const runtime = new ArcadePlayerRuntime({
      configStore: store,
      events,
      stateFile: h.stateFile,
      publicBaseUrl: 'https://arcade.example',
      signingSecret: () => SECRET,
    });
    const api = new ArcadeApi({
      configStore: store,
      events,
      playerRuntime: runtime,
      publicBaseUrl: 'https://arcade.example',
      authorizeAdmin: () => null,
    });
    await api.start();
    expect(store.getStatus().degraded).toBe(true);
    expect(api.getHealthStatus()).toEqual({ degraded: true });
    await expect(runtime.getActive()).rejects.toMatchObject({ code: 'CONFIG_DEGRADED' });

    const cleanup = await runtime.getForCleanup();
    await expect(cleanup.service.insertStationCoin({
      stationId: 'ARCADE-01', playerId: registrationInput.playerId,
      idempotencyKey: 'degraded-station-admission',
    })).rejects.toMatchObject({ code: 'CONFIG_DEGRADED' });
    await expect(cleanup.service.checkInQueueEntry({
      playerId: registrationInput.playerId,
      queueEntryId: joined.entry.id,
      game: 'racer',
      idempotencyKey: 'degraded-spending',
    })).rejects.toMatchObject({ code: 'CONFIG_DEGRADED' });
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = cleanup.challenges.sign({
      v: 1,
      player: registrationInput.playerId,
      challenge: 'voice-docs',
      audience: 'ARCADE-01',
      jti: 'degraded-reward-token',
      issuedAt,
      expiry: issuedAt + 60,
    });
    await expect(cleanup.service.claimChallenge({
      playerId: registrationInput.playerId,
      challengeId: 'voice-docs',
      token,
      idempotencyKey: 'degraded-reward',
    })).rejects.toMatchObject({ code: 'CONFIG_DEGRADED' });

    await expect(cleanup.service.registerPlayer(registrationInput)).resolves.toMatchObject({
      player: { id: registrationInput.playerId },
    });
    await expect(cleanup.service.leaveQueue({
      playerId: registrationInput.playerId,
      queueEntryId: joined.entry.id,
      idempotencyKey: 'degraded-cleanup-leave',
    })).resolves.toMatchObject({ entry: { status: 'LEFT_QUEUE' } });
    await api.stop();
  });

  it('lazy-loads persisted state for authenticated cleanup after an off-mode restart', async () => {
    const h = await harness();
    await h.runtime.start();
    await h.store.update({
      expectedVersion: 1, idempotencyKey: 'enable-cleanup', updatedBy: 'admin@twilio.com',
      settings: settings('lead_capture'),
    });
    const active = await h.runtime.getActive();
    await active.service.registerPlayer({
      playerId: 'player:cleanup',
      idempotencyKey: 'cleanup-register',
      lead: {
        firstName: 'Ada', lastName: 'Lovelace', workEmail: 'ada@example.com',
        companyName: 'Analytical Engines', phoneNumber: '+14155550199', countryCode: 'US',
      },
      termsAccepted: true,
    });
    const joined = await active.service.joinQueue({
      playerId: 'player:cleanup', preferredGame: 'racer', idempotencyKey: 'cleanup-join',
    });
    const authorization = active.operatorAuthorization('admin@twilio.com');
    await active.service.markApproaching({
      playerId: 'player:cleanup', queueEntryId: joined.entry.id,
      idempotencyKey: 'cleanup-approach', reason: 'approaching cabinet', authorization,
    });
    await active.service.confirmPresence({
      playerId: 'player:cleanup', queueEntryId: joined.entry.id, idempotencyKey: 'cleanup-confirm',
    });
    await active.service.callQueueEntry({
      playerId: 'player:cleanup', queueEntryId: joined.entry.id,
      idempotencyKey: 'cleanup-call', reason: 'cabinet ready', authorization,
    });
    await active.service.checkInQueueEntry({
      playerId: 'player:cleanup', queueEntryId: joined.entry.id,
      game: 'racer', idempotencyKey: 'cleanup-check-in',
    });
    await h.store.update({
      expectedVersion: 2, idempotencyKey: 'disable-cleanup', updatedBy: 'admin@twilio.com',
      settings: settings('off'),
    });
    await h.runtime.stop();

    const restarted = new ArcadePlayerRuntime({
      configStore: h.store,
      events: h.events,
      stateFile: h.stateFile,
      publicBaseUrl: 'https://arcade.example',
      signingSecret: () => SECRET,
    });
    await restarted.start();
    expect(restarted.getStatus().initialized).toBe(false);
    const cleanup = await restarted.getForCleanup();
    const released = await cleanup.service.releaseQueueEntry({
      playerId: 'player:cleanup', queueEntryId: joined.entry.id,
      idempotencyKey: 'cleanup-release-after-restart',
      reason: 'restart cleanup',
      authorization: cleanup.operatorAuthorization('admin@twilio.com'),
    });
    expect(released.reservation?.status).toBe('RELEASED');
    await restarted.stop();
  });
});
