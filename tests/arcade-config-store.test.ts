import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArcadeConfigDegradedError,
  ArcadeConfigIdempotencyConflictError,
  ArcadeConfigStore,
  ArcadeConfigUnsupportedDeploymentError,
  ArcadeConfigVersionConflictError,
  type ArcadeConfigStoreFileSystem,
} from '../server/arcade-config-store';
import { ArcadeEventHub } from '../server/arcade-events';
import {
  createDefaultArcadeConfig,
  parseArcadeConfig,
  type ArcadeConfigSettings,
} from '../shared/arcade-config';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcade-config-store-'));
  directories.push(directory);
  return directory;
}

function settings(mode: 'off' | 'coin_only' | 'lead_capture' = 'off'): ArcadeConfigSettings {
  const config = createDefaultArcadeConfig();
  return {
    arcade: { ...config.arcade, mode },
    registration: config.registration,
    coins: config.coins,
    earning: config.earning,
    queue: config.queue,
    channels: config.channels,
    postGame: config.postGame,
    intelligence: config.intelligence,
  };
}

function updateRequest(
  idempotencyKey: string,
  expectedVersion = 1,
  mode: 'off' | 'coin_only' | 'lead_capture' = 'coin_only',
) {
  return {
    expectedVersion,
    idempotencyKey,
    updatedBy: 'admin@example.com',
    settings: settings(mode),
  };
}

describe('ArcadeConfigStore loading and persistence', () => {
  it('loads a missing store as an immutable default with arcade mode off', async () => {
    const store = new ArcadeConfigStore(await temporaryDirectory());
    const snapshot = await store.load();

    expect(snapshot).toMatchObject({ version: 1, arcade: { mode: 'off' } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.arcade)).toBe(true);
    expect(store.getSnapshot()).toBe(snapshot);
  });

  it('rejects an explicitly non-single-process deployment', async () => {
    const directory = await temporaryDirectory();
    expect(() => new ArcadeConfigStore({
      directory,
      deploymentMode: 'multi-process' as never,
    })).toThrow(ArcadeConfigUnsupportedDeploymentError);
  });

  it('serializes concurrent updates and checks expectedVersion inside the queue', async () => {
    const store = new ArcadeConfigStore(await temporaryDirectory(), {
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => store.update(updateRequest(`request-${index}`))),
    );

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(result => result.status === 'rejected');
    expect(rejected).toHaveLength(11);
    expect(rejected.every(result => result.reason instanceof ArcadeConfigVersionConflictError)).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      version: 2,
      updatedAt: '2026-07-20T12:00:00.000Z',
      updatedBy: 'admin@example.com',
    });

    const next = await store.update(updateRequest('request-next', 2, 'off'));
    expect(next.version).toBe(3);
    await store.flush();
  });

  it('returns the original revision for an exact replay and rejects a conflicting replay', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory);
    const first = await store.update(updateRequest('same-key'));
    const replay = await store.update(updateRequest('same-key'));

    expect(replay).toBe(first);
    expect(replay.version).toBe(2);
    await expect(store.update(updateRequest('same-key', 1, 'off')))
      .rejects.toBeInstanceOf(ArcadeConfigIdempotencyConflictError);
    const audit = await readFile(path.join(directory, 'arcade-config-audit.jsonl'), 'utf8');
    expect(audit.trim().split('\n')).toHaveLength(1);

    const restarted = new ArcadeConfigStore(directory);
    expect((await restarted.update(updateRequest('same-key'))).version).toBe(2);
  });

  it('does not trust an orphan cache when the authoritative audit is missing', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory);
    await store.update(updateRequest('orphaned'));
    await unlink(store.auditPath);

    const recovered = new ArcadeConfigStore(directory);
    expect((await recovered.load()).version).toBe(1);
    expect(recovered.getSnapshot().arcade.mode).toBe('off');
    expect(parseArcadeConfig(await readFile(store.cachePath, 'utf8')).version).toBe(1);
  });

  it('recovers a corrupt or missing cache from the latest complete audit revision and repairs it', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory);
    await store.update(updateRequest('revision-2'));
    await store.update(updateRequest('revision-3', 2, 'off'));
    await appendFile(store.auditPath, '{"partial":', 'utf8');
    await writeFile(store.cachePath, 'not json', 'utf8');

    const recovered = new ArcadeConfigStore(directory);
    const snapshot = await recovered.load();
    expect(snapshot).toMatchObject({ version: 3, arcade: { mode: 'off' } });
    expect(recovered.getStatus().degraded).toBe(false);
    expect(parseArcadeConfig(await readFile(store.cachePath, 'utf8')).version).toBe(3);

    const revision4 = await recovered.update(updateRequest('revision-4', 3));
    expect(revision4.version).toBe(4);
    await unlink(store.cachePath);
    expect((await new ArcadeConfigStore(directory).load()).version).toBe(4);
  });

  it('quarantines a complete corrupt suffix and serves the verified prefix in fail-closed mode', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory);
    await store.update(updateRequest('revision-2'));
    const validRecord = await readFile(store.auditPath, 'utf8');
    await writeFile(store.auditPath, `${validRecord}not-json\n${validRecord}`, 'utf8');

    const recovered = new ArcadeConfigStore(directory);
    expect((await recovered.load()).version).toBe(2);
    const degraded = recovered.getStatus();
    expect(degraded).toMatchObject({ degraded: true, version: 2 });
    expect(degraded.reason).toMatch(/line 2/);
    expect(degraded.quarantinePath).toMatch(/\.corrupt-[0-9a-f-]+\.jsonl$/);
    expect(await readFile(store.auditPath, 'utf8')).toBe(validRecord);
    expect(await readFile(degraded.quarantinePath!, 'utf8')).toBe(`not-json\n${validRecord}`);
    if (process.platform !== 'win32') {
      expect((await stat(degraded.quarantinePath!)).mode & 0o777).toBe(0o600);
      expect((await stat(recovered.degradedPath)).mode & 0o777).toBe(0o600);
    }
    await expect(recovered.update(updateRequest('blocked', 2))).rejects.toBeInstanceOf(ArcadeConfigDegradedError);

    const restarted = new ArcadeConfigStore(directory);
    expect((await restarted.load()).version).toBe(2);
    expect(restarted.getStatus().degraded).toBe(true);
    await expect(restarted.update(updateRequest('still-blocked', 2)))
      .rejects.toBeInstanceOf(ArcadeConfigDegradedError);

    expect((await restarted.repairAudit()).degraded).toBe(false);
    await expect(stat(restarted.degradedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await restarted.update(updateRequest('revision-3', 2))).version).toBe(3);
  });

  it('detects a tampered hash chain and recovers only through the preceding revision', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory);
    await store.update(updateRequest('revision-2'));
    await store.update(updateRequest('revision-3', 2, 'off'));
    const lines = (await readFile(store.auditPath, 'utf8')).trim().split('\n');
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first.previousVersion).toBe(1);
    expect(second.previousVersion).toBe(2);
    expect(first.previousHash).toBe('0'.repeat(64));
    expect(second.previousHash).toBe(first.recordHash);
    second.previousHash = 'f'.repeat(64);
    await writeFile(store.auditPath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, 'utf8');

    const recovered = new ArcadeConfigStore(directory);
    expect((await recovered.load()).version).toBe(2);
    expect(recovered.getStatus()).toMatchObject({ degraded: true, version: 2 });
    expect((await readFile(store.auditPath, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('creates private data files and directories where mode bits are supported', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory);
    await store.update(updateRequest('private-files'));

    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(store.cachePath)).mode & 0o777).toBe(0o600);
      expect((await stat(store.auditPath)).mode & 0o777).toBe(0o600);
    }
  });
});

describe('ArcadeConfigStore failure and publication semantics', () => {
  it('leaves memory unchanged after a write failure and does not poison the update queue', async () => {
    const directory = await temporaryDirectory();
    let failNextWrite = true;
    const writeThrough: ArcadeConfigStoreFileSystem['writeFile'] = async (file, contents) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('injected cache failure');
      }
      await writeFile(file, contents, 'utf8');
    };
    const store = new ArcadeConfigStore(directory, { fs: { writeFile: writeThrough } });

    await expect(store.update(updateRequest('failed'))).rejects.toThrow(/injected cache failure/);
    expect(store.getSnapshot().version).toBe(1);

    const successful = await store.update(updateRequest('successful'));
    expect(successful.version).toBe(2);
    expect(store.getSnapshot()).toBe(successful);
    await store.flush();
  });

  it('rolls back an uncommitted cache when appending the audit record fails', async () => {
    const directory = await temporaryDirectory();
    let failNextAppend = true;
    const store = new ArcadeConfigStore(directory, {
      fs: {
        appendFile: async (file, contents) => {
          if (failNextAppend) {
            failNextAppend = false;
            throw new Error('injected audit failure');
          }
          await appendFile(file, contents, 'utf8');
        },
      },
    });

    await expect(store.update(updateRequest('failed-audit'))).rejects.toThrow(/injected audit failure/);
    expect(store.getSnapshot().version).toBe(1);
    expect(parseArcadeConfig(await readFile(store.cachePath, 'utf8')).version).toBe(1);

    expect((await store.update(updateRequest('successful-audit'))).version).toBe(2);
    await store.flush();
  });

  it('publishes exactly once, only after the cache and audit are durable', async () => {
    const directory = await temporaryDirectory();
    const operations: string[] = [];
    const events = new ArcadeEventHub();
    const subscriber = vi.fn(() => { operations.push('event'); });
    events.subscribe(subscriber);
    let auditSyncAttempts = 0;
    const store = new ArcadeConfigStore(directory, {
      events,
      fs: {
        rename: async (from, to) => {
          await writeFile(to, await readFile(from, 'utf8'), 'utf8');
          await unlink(from);
          operations.push('cache');
        },
        appendFile: async (file, contents) => {
          await appendFile(file, contents, 'utf8');
          operations.push('audit');
        },
        syncFile: async file => {
          if (file.endsWith('arcade-config-audit.jsonl')) {
            auditSyncAttempts += 1;
            operations.push(`audit-sync-${auditSyncAttempts}`);
            if (auditSyncAttempts === 1) throw new Error('injected first fsync failure');
          } else {
            operations.push('cache-sync');
          }
        },
        syncDirectory: async () => { operations.push('directory-sync'); },
      },
    });

    const revision = await store.update(updateRequest('published'));
    expect(auditSyncAttempts).toBe(2);
    expect(operations.indexOf('event')).toBeGreaterThan(operations.indexOf('audit-sync-2'));
    expect(operations.indexOf('event')).toBeGreaterThan(operations.lastIndexOf('directory-sync'));
    expect(subscriber).toHaveBeenCalledWith({ type: 'arcade_config_updated', version: 2 });

    await store.update(updateRequest('published'));
    expect(subscriber).toHaveBeenCalledOnce();
    expect(revision.version).toBe(2);
  });

  it('does not publish when audit durability fails and keeps the queue usable', async () => {
    const directory = await temporaryDirectory();
    const events = new ArcadeEventHub();
    const subscriber = vi.fn();
    events.subscribe(subscriber);
    let rejectAuditSync = true;
    const store = new ArcadeConfigStore(directory, {
      events,
      fs: {
        syncFile: async file => {
          if (rejectAuditSync && file.endsWith('arcade-config-audit.jsonl')) {
            throw new Error('injected durable audit failure');
          }
        },
        syncDirectory: async () => undefined,
      },
    });

    await expect(store.update(updateRequest('not-durable'))).rejects.toThrow(/durable audit failure/);
    expect(store.getSnapshot().version).toBe(1);
    expect(subscriber).not.toHaveBeenCalled();

    rejectAuditSync = false;
    expect((await store.update(updateRequest('durable'))).version).toBe(2);
    expect(subscriber).toHaveBeenCalledOnce();
  });
});
