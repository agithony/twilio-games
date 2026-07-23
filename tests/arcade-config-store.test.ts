import { createHash } from 'node:crypto';
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
  ARCADE_CONFIG_SCHEMA_VERSION,
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
    station: config.station,
    registration: config.registration,
    coins: config.coins,
    earning: config.earning,
    queue: config.queue,
    channels: config.channels,
    postGame: config.postGame,
    intelligence: config.intelligence,
  };
}

function legacyConfig(version = 2): any {
  const config = JSON.parse(JSON.stringify(createDefaultArcadeConfig()));
  config.schemaVersion = 1;
  config.version = version;
  config.updatedAt = '2026-07-19T12:00:00.000Z';
  config.updatedBy = 'legacy@example.com';
  config.arcade.mode = 'coin_only';
  delete config.station;
  delete config.channels.voiceNumbers;
  return config;
}

function legacyAuditRecord(config: any, previousHash = '0'.repeat(64)): any {
  const record = {
    auditVersion: 1,
    idempotencyKey: `legacy-revision-${config.version}`,
    requestHash: 'a'.repeat(64),
    previousVersion: config.version - 1,
    previousHash,
    config,
  };
  return {
    ...record,
    recordHash: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
  };
}

function schema2Config(version = 2): any {
  const config = JSON.parse(JSON.stringify(createDefaultArcadeConfig()));
  config.schemaVersion = 2;
  config.version = version;
  config.updatedAt = '2026-07-19T13:00:00.000Z';
  config.updatedBy = 'schema2@example.com';
  delete config.channels.voiceNumbers;
  return config;
}

function schema3Config(version = 2): any {
  const config = JSON.parse(JSON.stringify(createDefaultArcadeConfig()));
  config.schemaVersion = 3;
  config.version = version;
  config.updatedAt = '2026-07-19T14:00:00.000Z';
  config.updatedBy = 'schema3@example.com';
  config.postGame.includeChallenges = false;
  config.earning.challenges = [{
    id: 'voice-docs', title: 'Voice docs', url: 'https://www.twilio.com/docs/voice',
    rewardCoins: 1, enabled: true, maxClaimsPerPlayer: 1, displayOrder: 0,
    startsAt: null, endsAt: null,
  }];
  return config;
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

    expect(snapshot).toMatchObject({
      schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
      version: 1,
      arcade: { mode: 'off' },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.arcade)).toBe(true);
    expect(store.getSnapshot()).toBe(snapshot);
  });

  it('loads v1 cache and audit bytes losslessly, then appends schema 3 to the old hash chain', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory, {
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    });
    const oldConfig = legacyConfig();
    const oldRecord = legacyAuditRecord(oldConfig);
    const cacheBytes = `${JSON.stringify(oldConfig, null, 2)}\n`;
    const auditBytes = `${JSON.stringify(oldRecord)}\n`;
    await writeFile(store.cachePath, cacheBytes, 'utf8');
    await writeFile(store.auditPath, auditBytes, 'utf8');

    const migrated = await store.load();
    expect(migrated).toMatchObject({
      schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
      version: 2,
      updatedAt: oldConfig.updatedAt,
      updatedBy: oldConfig.updatedBy,
      arcade: oldConfig.arcade,
      station: createDefaultArcadeConfig().station,
    });
    const legacyShape = JSON.parse(JSON.stringify(migrated));
    legacyShape.schemaVersion = 1;
    delete legacyShape.station;
    delete legacyShape.channels.voiceNumbers;
    expect(legacyShape).toEqual(oldConfig);
    expect(Object.isFrozen(migrated.station.automaticSelection.order)).toBe(true);
    expect(await readFile(store.cachePath, 'utf8')).toBe(cacheBytes);
    expect(await readFile(store.auditPath, 'utf8')).toBe(auditBytes);

    const next = await store.update(updateRequest('schema-3-write', 2, 'off'));
    expect(next).toMatchObject({ schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION, version: 3 });
    const auditLines = (await readFile(store.auditPath, 'utf8')).trim().split('\n');
    expect(auditLines).toHaveLength(2);
    expect(auditLines[0]).toBe(JSON.stringify(oldRecord));
    const schema3Record = JSON.parse(auditLines[1]!) as any;
    expect(schema3Record.previousHash).toBe(oldRecord.recordHash);
    expect(schema3Record.config).toMatchObject({ schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION, version: 3 });
    expect(schema3Record.config.station).toEqual(createDefaultArcadeConfig().station);
    expect(parseArcadeConfig(await readFile(store.cachePath, 'utf8'))).toEqual(next);

    const restarted = new ArcadeConfigStore(directory);
    expect(await restarted.load()).toEqual(next);
    expect(restarted.getStatus().degraded).toBe(false);
  });

  it('safely disables a valid coin-only v1 config with no messaging channel and extends its hash chain', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory, {
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    });
    const oldConfig = legacyConfig();
    oldConfig.channels.voice = false;
    oldConfig.channels.sms = false;
    oldConfig.channels.whatsapp = false;
    const oldRecord = legacyAuditRecord(oldConfig);
    const cacheBytes = `${JSON.stringify(oldConfig, null, 2)}\n`;
    const auditBytes = `${JSON.stringify(oldRecord)}\n`;
    await writeFile(store.cachePath, cacheBytes, 'utf8');
    await writeFile(store.auditPath, auditBytes, 'utf8');

    const migrated = await store.load();
    const expectedRuntime = parseArcadeConfig({
      ...oldConfig,
      schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
      arcade: { ...oldConfig.arcade, mode: 'off' },
      station: createDefaultArcadeConfig().station,
      channels: {
        ...oldConfig.channels,
        voiceNumbers: { 'en-US': null, 'pt-BR': null },
      },
    });
    expect(migrated).toEqual(expectedRuntime);
    expect(migrated).toMatchObject({
      version: oldConfig.version,
      updatedAt: oldConfig.updatedAt,
      updatedBy: oldConfig.updatedBy,
      arcade: { mode: 'off' },
      channels: { voice: false, sms: false, whatsapp: false },
    });
    expect(await readFile(store.cachePath, 'utf8')).toBe(cacheBytes);
    expect(await readFile(store.auditPath, 'utf8')).toBe(auditBytes);
    expect(store.getStatus().degraded).toBe(false);

    const next = await store.update(updateRequest('safe-v1-schema-3-write', oldConfig.version, 'off'));
    const auditLines = (await readFile(store.auditPath, 'utf8')).trim().split('\n');
    expect(next.version).toBe(oldConfig.version + 1);
    expect(auditLines).toHaveLength(2);
    expect(auditLines[0]).toBe(JSON.stringify(oldRecord));
    expect(JSON.parse(auditLines[1]!) as any).toMatchObject({
      previousVersion: oldConfig.version,
      previousHash: oldRecord.recordHash,
      config: {
        schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
        version: oldConfig.version + 1,
      },
    });
    expect(await new ArcadeConfigStore(directory).load()).toEqual(next);
  });

  it('normalizes formerly valid v1 economics and post-game flags without breaking the hash chain', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory);
    const oldConfig = legacyConfig();
    oldConfig.coins.startingBalance = 0;
    oldConfig.coins.defaultGameCost = 2;
    oldConfig.coins.gameCosts = { racer: 2, monsters: 3, fighter: 4, trivia: 5 };
    oldConfig.postGame.enabled = true;
    oldConfig.postGame.includeScore = true;
    const oldRecord = legacyAuditRecord(oldConfig);
    await writeFile(store.cachePath, `${JSON.stringify(oldConfig, null, 2)}\n`, 'utf8');
    await writeFile(store.auditPath, `${JSON.stringify(oldRecord)}\n`, 'utf8');

    const migrated = await store.load();
    expect(migrated).toMatchObject({
      version: oldConfig.version,
      arcade: { mode: 'off' },
      coins: {
        startingBalance: 1,
        defaultGameCost: 1,
        gameCosts: { racer: 1, monsters: 1, fighter: 1, trivia: 1 },
      },
      postGame: { enabled: false, includeScore: true },
    });
    expect(store.getStatus().degraded).toBe(false);
    expect(await readFile(store.auditPath, 'utf8')).toBe(`${JSON.stringify(oldRecord)}\n`);

    const next = await store.update(updateRequest('normalized-v1-write', oldConfig.version, 'off'));
    const records = (await readFile(store.auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(records[0]).toEqual(oldRecord);
    expect(records[1]).toMatchObject({ previousHash: oldRecord.recordHash, config: { version: next.version } });
  });

  it.each([
    ['no delivery channels', (config: any) => { config.postGame.channels = []; }],
    ['a disabled selected channel', (config: any) => {
      config.postGame.channels = ['sms']; config.channels.sms = false;
    }],
  ])('safely disables valid v1 post-game delivery with %s', async (_label, configure) => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory);
    const oldConfig = legacyConfig();
    oldConfig.postGame.enabled = true;
    oldConfig.postGame.includeScore = false;
    configure(oldConfig);
    const oldRecord = legacyAuditRecord(oldConfig);
    await writeFile(store.cachePath, `${JSON.stringify(oldConfig, null, 2)}\n`, 'utf8');
    await writeFile(store.auditPath, `${JSON.stringify(oldRecord)}\n`, 'utf8');

    const migrated = await store.load();
    expect(migrated).toMatchObject({ arcade: { mode: 'off' }, postGame: { enabled: false } });
    expect(store.getStatus().degraded).toBe(false);
    expect(await readFile(store.auditPath, 'utf8')).toBe(`${JSON.stringify(oldRecord)}\n`);
  });

  it('loads schema 2 cache and audit bytes losslessly with empty locale voice numbers', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory);
    const oldConfig = schema2Config();
    const oldRecord = legacyAuditRecord(oldConfig);
    const cacheBytes = `${JSON.stringify(oldConfig, null, 2)}\n`;
    const auditBytes = `${JSON.stringify(oldRecord)}\n`;
    await writeFile(store.cachePath, cacheBytes, 'utf8');
    await writeFile(store.auditPath, auditBytes, 'utf8');

    const migrated = await store.load();
    expect(migrated).toMatchObject({
      schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
      version: 2,
      channels: { voiceNumbers: { 'en-US': null, 'pt-BR': null } },
    });
    expect(await readFile(store.cachePath, 'utf8')).toBe(cacheBytes);
    expect(await readFile(store.auditPath, 'utf8')).toBe(auditBytes);
    expect(store.getStatus().degraded).toBe(false);
    const next = await store.update(updateRequest('schema-2-to-3-write', 2, 'off'));
    expect(next).toMatchObject({ schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION, version: 3 });
    expect(await new ArcadeConfigStore(directory).load()).toEqual(next);
  });

  it('loads schema 3 challenge records losslessly and adds nullable custom messages', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory);
    const oldConfig = schema3Config();
    const oldRecord = legacyAuditRecord(oldConfig);
    const cacheBytes = `${JSON.stringify(oldConfig, null, 2)}\n`;
    const auditBytes = `${JSON.stringify(oldRecord)}\n`;
    await writeFile(store.cachePath, cacheBytes, 'utf8');
    await writeFile(store.auditPath, auditBytes, 'utf8');

    const migrated = await store.load();
    expect(migrated).toMatchObject({
      schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
      earning: { challenges: [{ id: 'voice-docs', message: null }] },
      postGame: { includeChallenges: false },
    });
    expect(await readFile(store.cachePath, 'utf8')).toBe(cacheBytes);
    expect(await readFile(store.auditPath, 'utf8')).toBe(auditBytes);
    expect(store.getStatus().degraded).toBe(false);
  });

  it('rejects a tampered v1 audit record using its original schema 1 hash shape', async () => {
    const directory = await temporaryDirectory();
    const store = new ArcadeConfigStore(directory);
    const oldConfig = legacyConfig();
    oldConfig.channels.sms = false;
    oldConfig.channels.whatsapp = false;
    const oldRecord = legacyAuditRecord(oldConfig);
    oldRecord.config.arcade.displayName = 'Tampered Arcade';
    await writeFile(store.cachePath, `${JSON.stringify(oldConfig, null, 2)}\n`, 'utf8');
    await writeFile(store.auditPath, `${JSON.stringify(oldRecord)}\n`, 'utf8');

    const recovered = await store.load();
    expect(recovered).toMatchObject({
      schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
      version: 1,
      arcade: { mode: 'off' },
    });
    expect(store.getStatus()).toMatchObject({ degraded: true, version: 1 });
    expect(store.getStatus().reason).toMatch(/record hash mismatch/);
    expect(await readFile(store.auditPath, 'utf8')).toBe('');
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
