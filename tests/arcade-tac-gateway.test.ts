import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MemoryClient } from 'twilio-agent-connect';
import { DEFAULT_ARCADE_CONFIG, type ArcadeConfigSettings } from '../shared/arcade-config';
import { ArcadeConfigStore } from '../server/arcade-config-store';
import { ArcadeEventHub } from '../server/arcade-events';
import {
  ArcadeTacGateway,
  recalledMemoryLocale,
  resolveTacProviderMessageId,
  type ArcadeTacClient,
  type ArcadeTacMessage,
} from '../server/arcade-tac-gateway';

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function settings(mode: 'off' | 'coin_only' | 'lead_capture'): ArcadeConfigSettings {
  const copy = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, unknown>;
  delete copy.schemaVersion;
  delete copy.version;
  delete copy.updatedAt;
  delete copy.updatedBy;
  (copy.arcade as { mode: string }).mode = mode;
  return copy as ArcadeConfigSettings;
}

async function dependencies(): Promise<{ store: ArcadeConfigStore; events: ArcadeEventHub }> {
  directory = await mkdtemp(path.join(tmpdir(), 'arcade-tac-'));
  const events = new ArcadeEventHub();
  const store = new ArcadeConfigStore({ directory, events });
  await store.load();
  return { store, events };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}

describe('ArcadeTacGateway', () => {
  it('requires a communication-specific provider identity for every inbound message', () => {
    const sid = `SM${'a'.repeat(32)}`;
    expect(resolveTacProviderMessageId({ channelId: sid, message: 'COIN' })).toBe(sid);
    expect(resolveTacProviderMessageId({ lastCommunicationId: 'communication-2', message: 'COIN' }))
      .toBe('communication-2');
    const memory = {
      communications: [{ id: 'communication-memory', content: { text: 'COIN' } }],
    } as unknown as ArcadeTacMessage['memory'];
    expect(resolveTacProviderMessageId({ memory, message: 'COIN' })).toBe('communication-memory');
    expect(() => resolveTacProviderMessageId({ channelId: 'stable-conversation-id', message: 'COIN' }))
      .toThrow('missing a unique provider communication ID');
  });

  it('uses the newest locale-bearing Conversation Memory command', () => {
    const memory = (texts: readonly string[]) => ({
      communications: texts.map(text => ({ content: { text } })),
    }) as unknown as ArcadeTacMessage['memory'];

    expect(recalledMemoryLocale(memory(['JOIN ARCADE-01 LANG pt-BR', 'JOIN']))).toBe('en-US');
    expect(recalledMemoryLocale(memory(['JOIN', 'ENTRAR']))).toBe('pt-BR');
    expect(recalledMemoryLocale(memory(['ENTRAR', 'JOIN ARCADE-01 LANG pt-BR']))).toBe('pt-BR');
    expect(recalledMemoryLocale(memory(['ENTRAR', 'ENTRAR ARCADE-01 LANG en-US']))).toBe('en-US');
    expect(recalledMemoryLocale(memory(['JOIN', 'no locale here']))).toBe('en-US');
  });

  it('does not initialize TAC or require credentials while Arcade mode is off', async () => {
    const { store, events } = await dependencies();
    let factoryCalls = 0;
    const gateway = new ArcadeTacGateway({
      configStore: store,
      events,
      createClient: async () => {
        factoryCalls++;
        throw new Error('must not initialize');
      },
    });

    await gateway.start();
    expect(factoryCalls).toBe(0);
    expect(gateway.getMemoryClient()).toBeNull();
    expect(gateway.getStatus()).toEqual({ started: true, mode: 'off', connected: false, lastError: null });
    await gateway.stop();
  });

  it('connects lazily on enable and disconnects when live configuration returns to off', async () => {
    const { store, events } = await dependencies();
    let factoryCalls = 0;
    let shutdownCalls = 0;
    const memory = {} as MemoryClient;
    const client: ArcadeTacClient = { memory, shutdown: () => { shutdownCalls++; } };
    const gateway = new ArcadeTacGateway({
      configStore: store,
      events,
      createClient: async () => { factoryCalls++; return client; },
    });
    await gateway.start();

    await store.update({
      expectedVersion: 1,
      idempotencyKey: 'enable-tac',
      updatedBy: 'operator@twilio.com',
      settings: settings('coin_only'),
    });
    await waitFor(() => gateway.getStatus().connected);
    expect(factoryCalls).toBe(1);
    expect(gateway.getMemoryClient()).toBe(memory);

    await store.update({
      expectedVersion: 2,
      idempotencyKey: 'disable-tac',
      updatedBy: 'operator@twilio.com',
      settings: settings('off'),
    });
    await waitFor(() => gateway.getStatus().mode === 'off' && !gateway.getStatus().connected);
    expect(shutdownCalls).toBe(1);
    await gateway.stop();
    expect(shutdownCalls).toBe(1);
  });

  it('keeps deterministic fallback available when enabled TAC configuration cannot initialize', async () => {
    const { store, events } = await dependencies();
    await store.update({
      expectedVersion: 1,
      idempotencyKey: 'enable-before-start',
      updatedBy: 'operator@twilio.com',
      settings: settings('lead_capture'),
    });
    const gateway = new ArcadeTacGateway({
      configStore: store,
      events,
      createClient: async () => { throw new Error('missing TAC credentials'); },
    });

    await expect(gateway.start()).resolves.toBeUndefined();
    expect(gateway.getStatus()).toEqual({
      started: true,
      mode: 'lead_capture',
      connected: false,
      lastError: 'missing TAC credentials',
    });
    expect(gateway.ownsMessaging()).toBe(false);
    await gateway.stop();
  });

  it('does not let an in-flight TAC connection block mode-off or shutdown', async () => {
    const { store, events } = await dependencies();
    let factoryCalls = 0;
    let shutdownCalls = 0;
    let resolveClient: ((client: ArcadeTacClient) => void) | undefined;
    const deferred = new Promise<ArcadeTacClient>(resolve => { resolveClient = resolve; });
    const gateway = new ArcadeTacGateway({
      configStore: store,
      events,
      createClient: () => { factoryCalls++; return deferred; },
    });
    await gateway.start();
    await store.update({
      expectedVersion: 1,
      idempotencyKey: 'enable-pending-tac',
      updatedBy: 'operator@twilio.com',
      settings: settings('coin_only'),
    });
    await waitFor(() => factoryCalls === 1);

    await store.update({
      expectedVersion: 2,
      idempotencyKey: 'disable-pending-tac',
      updatedBy: 'operator@twilio.com',
      settings: settings('off'),
    });
    resolveClient!({ memory: {} as MemoryClient, shutdown: () => { shutdownCalls++; } });
    await Promise.resolve();
    expect(gateway.getStatus().connected).toBe(false);
    await waitFor(() => shutdownCalls === 1);
    expect(gateway.getStatus().mode).toBe('off');
    expect(gateway.getStatus().connected).toBe(false);
    await expect(gateway.stop()).resolves.toBeUndefined();
  });

  it('routes Conversation Orchestrator webhooks through the connected TAC client', async () => {
    const { store, events } = await dependencies();
    const processed: Array<{ payload: unknown; token?: string }> = [];
    let installedHandler = false;
    let failWebhook = false;
    const syncedNames: string[] = [];
    const client: ArcadeTacClient = {
      memory: {} as MemoryClient,
      setMessageHandler: () => { installedHandler = true; },
      processWebhook: async (payload, token) => {
        if (failWebhook) throw new Error('temporary Orchestrator failure');
        processed.push({ payload, ...(token ? { token } : {}) });
      },
      syncProfileName: async input => { syncedNames.push(input.firstName); },
      shutdown: () => undefined,
    };
    const gateway = new ArcadeTacGateway({ configStore: store, events, createClient: async () => client });
    gateway.setMessageHandler(async () => 'READY');
    await gateway.start();
    await store.update({
      expectedVersion: 1,
      idempotencyKey: 'enable-tac-messaging',
      updatedBy: 'operator@twilio.com',
      settings: settings('lead_capture'),
    });
    await waitFor(() => gateway.getStatus().connected);

    expect(installedHandler).toBe(true);
    expect(gateway.ownsMessaging()).toBe(true);
    await gateway.syncProfileName({profileId:'mem_profile_1',phoneNumber:'+14155550199',firstName:'Ada',locale:'en-US'});
    expect(syncedNames).toEqual(['Ada']);
    await gateway.processWebhook({ eventType: 'COMMUNICATION_CREATED' }, 'token-1');
    expect(processed).toEqual([{
      payload: { eventType: 'COMMUNICATION_CREATED' }, token: 'token-1',
    }]);
    failWebhook = true;
    await expect(gateway.processWebhook({ eventType: 'COMMUNICATION_CREATED' }, 'token-2'))
      .rejects.toThrow('temporary Orchestrator failure');
    expect(gateway.getStatus()).toMatchObject({ connected: false, lastError: 'temporary Orchestrator failure' });
    expect(gateway.ownsMessaging()).toBe(false);
    failWebhook = false;
    await gateway.processWebhook({ eventType: 'COMMUNICATION_CREATED' }, 'token-2');
    expect(gateway.getStatus()).toMatchObject({ connected: true, lastError: null });
    await gateway.stop();
  });
});
