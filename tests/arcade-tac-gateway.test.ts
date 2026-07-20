import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MemoryClient } from 'twilio-agent-connect';
import { DEFAULT_ARCADE_CONFIG, type ArcadeConfigSettings } from '../shared/arcade-config';
import { ArcadeConfigStore } from '../server/arcade-config-store';
import { ArcadeEventHub } from '../server/arcade-events';
import { ArcadeTacGateway, type ArcadeTacClient } from '../server/arcade-tac-gateway';

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

  it('fails startup closed when enabled TAC configuration cannot initialize', async () => {
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

    await expect(gateway.start()).rejects.toThrow('missing TAC credentials');
    expect(gateway.getStatus()).toEqual({
      started: false,
      mode: 'lead_capture',
      connected: false,
      lastError: 'missing TAC credentials',
    });
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
});
