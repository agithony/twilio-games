import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ARCADE_CONFIG, type ArcadeConfigSettings } from '../shared/arcade-config';
import { ArcadeConfigStore } from '../server/arcade-config-store';
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
});
