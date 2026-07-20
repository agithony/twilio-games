import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWallet } from '../shared/arcade-domain';
import { joinQueue } from '../shared/arcade-queue';
import {
  ARCADE_STATE_SCHEMA_VERSION,
  ArcadeStateStore,
  type ArcadePlayerRecord,
  type ArcadeStateFileSystem,
} from '../server/arcade-state-store';

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

  it('persists schema-v1 state and restores it after restart', async () => {
    const file = await stateFile();
    const first = await ArcadeStateStore.open(file);
    await first.transaction(addPlayer('trusted:p1'));

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk.schemaVersion).toBe(ARCADE_STATE_SCHEMA_VERSION);
    expect(Object.keys(onDisk)).toEqual([
      'schemaVersion', 'players', 'wallets', 'queueEntries', 'queueEntryConfigs',
      'queueEvents', 'idempotencyRecords',
    ]);

    const restarted = await ArcadeStateStore.open(file);
    expect(restarted.snapshot().players['trusted:p1']?.id).toBe('trusted:p1');
    expect(restarted.snapshot().wallets['trusted:p1']?.wallet.cachedBalance).toBe(0);
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

  it('keeps committed memory and disk unchanged when the atomic write fails', async () => {
    const file = await stateFile();
    const injected = failingRenameFileSystem();
    const store = await ArcadeStateStore.open(file, { fileSystem: injected.fs, temporaryId: () => 'unique' });
    await store.transaction(addPlayer('p1'));
    const before = store.snapshot();
    injected.fail();

    await expect(store.transaction(addPlayer('p2'))).rejects.toThrow('injected rename failure');
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
