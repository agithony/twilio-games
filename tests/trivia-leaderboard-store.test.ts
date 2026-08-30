import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TRIVIA_CATEGORY_IDS,
  normalizeTriviaScore,
  type TriviaRoundCategoryId,
} from '../shared/trivia';
import type { TriviaResult } from '../shared/trivia-protocol';
import {
  TriviaLeaderboardStore,
  anonymizeTriviaPlayer,
  emptyTriviaLeaderboard,
  parseTriviaLeaderboardStrict,
  serializeTriviaLeaderboard,
  type TriviaLeaderboardFileSystem,
  type TriviaLeaderboardRound,
} from '../shared/trivia-leaderboard-store';

const directories: string[] = [];
const SALT = 'test-only-trivia-leaderboard-salt';

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function leaderboardFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'trivia-leaderboard-'));
  directories.push(directory);
  return path.join(directory, 'nested', 'leaderboard.json');
}

function triviaResult(options: {
  resultId?: string;
  category?: TriviaRoundCategoryId;
  playedAt?: number;
  namePrefix?: string;
  playerCount?: number;
  rawScores?: readonly number[];
} = {}): TriviaResult {
  const playerCount = options.playerCount ?? 4;
  const rawScores = options.rawScores ?? [4_000, 3_000, 2_000, 1_000];
  const players = Array.from({ length: playerCount }, (_, index) => {
    const rawScore = rawScores[index] ?? 0;
    const correctCount = Math.max(1, Math.min(8, playerCount - index));
    return Object.freeze({
      playerId: `t${index + 1}`,
      name: `${options.namePrefix ?? 'Player'} ${index + 1}`,
      playerOrder: index,
      rank: index + 1,
      rawScore,
      normalizedScore: normalizeTriviaScore(rawScore),
      correctCount,
      bestStreak: Math.min(2, correctCount),
      cumulativeCorrectTimeMs: correctCount * 1_000,
    });
  });
  return Object.freeze({
    resultId: options.resultId ?? 'engine-round-1',
    generation: 1,
    category: options.category ?? 'science',
    contentRevision: 'test-v1',
    players: Object.freeze(players),
    completedAtMs: options.playedAt ?? 1_000,
  });
}

function round(
  uniqueResultId: string,
  identityNamespace: string,
  result = triviaResult(),
): TriviaLeaderboardRound {
  return { uniqueResultId, identityNamespace, result };
}

describe('TriviaLeaderboardStore round persistence', () => {
  it('atomically appends all four players and makes a replay idempotent', async () => {
    const file = await leaderboardFile();
    const store = await TriviaLeaderboardStore.open(file, SALT);
    const completedRound = round('global-result-1', 'ROOM-A');

    const first = await store.appendRound(completedRound);
    const replay = await store.appendRound(completedRound);
    await store.flush();

    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(first.entries).toHaveLength(4);
    const persisted = parseTriviaLeaderboardStrict(await readFile(file, 'utf8'));
    expect(persisted?.entries).toHaveLength(4);
    expect(new Set(persisted?.entries.map(entry => entry.resultId))).toEqual(new Set(['global-result-1']));
    expect(new Set(persisted?.entries.map(entry => entry.playerIdentityHash)).size).toBe(4);
  });

  it('binds common local player IDs to room and result context', () => {
    const roomA = anonymizeTriviaPlayer('t1', SALT, 'ROOM-A', 'global-result-1');
    const roomB = anonymizeTriviaPlayer('t1', SALT, 'ROOM-B', 'global-result-1');
    const nextRound = anonymizeTriviaPlayer('t1', SALT, 'ROOM-A', 'global-result-2');

    expect(roomA).not.toBe(roomB);
    expect(roomA).not.toBe(nextRound);
  });

  it('uses the caller-supplied unique result ID across process restart', async () => {
    const file = await leaderboardFile();
    const completedRound = round('durable-global-result', 'ROOM-A');
    const first = await TriviaLeaderboardStore.open(file, SALT);
    await first.appendRound(completedRound);
    await first.flush();

    const restarted = await TriviaLeaderboardStore.open(file, SALT);
    expect((await restarted.appendRound(completedRound)).duplicate).toBe(true);
    expect(await restarted.entries('all-time')).toHaveLength(4);
    expect(parseTriviaLeaderboardStrict(await readFile(file, 'utf8'))?.entries).toHaveLength(4);
  });

  it('refuses a unique result ID collision with different data', async () => {
    const file = await leaderboardFile();
    const store = await TriviaLeaderboardStore.open(file, SALT);
    await store.appendRound(round('global-result-1', 'ROOM-A'));

    await expect(store.appendRound(round(
      'global-result-1',
      'ROOM-A',
      triviaResult({ resultId: 'engine-round-2' }),
    ))).rejects.toThrow(/different round data/);
    expect(await store.entries('all-time')).toHaveLength(4);
  });

  it('strictly refuses malformed rows and incomplete persisted rounds without overwriting them', async () => {
    const file = await leaderboardFile();
    const store = await TriviaLeaderboardStore.open(file, SALT);
    await store.appendRound(round('global-result-1', 'ROOM-A'));
    const parsed = parseTriviaLeaderboardStrict(await readFile(file, 'utf8'))!;
    const incomplete = JSON.stringify({ ...parsed, entries: parsed.entries.slice(0, 3) });
    await writeFile(file, incomplete, 'utf8');

    expect(parseTriviaLeaderboardStrict(incomplete)).toBeNull();
    const restarted = new TriviaLeaderboardStore(file, SALT);
    await expect(restarted.load()).rejects.toMatchObject({ code: 'CORRUPT_STORAGE' });
    expect(restarted.getStatus().state).toBe('corrupt');
    await expect(restarted.appendRound(round('global-result-2', 'ROOM-A'))).rejects.toThrow(/corrupt/);
    expect(await readFile(file, 'utf8')).toBe(incomplete);

    expect(parseTriviaLeaderboardStrict(JSON.stringify({
      version: 1,
      entries: [{ resultId: 'only-an-id' }],
    }))).toBeNull();
  });
});

describe('Trivia leaderboard reads and privacy', () => {
  it('reads all-time and every category with deterministic ties and limits', async () => {
    const file = await leaderboardFile();
    const store = await TriviaLeaderboardStore.open(file, SALT);
    for (const [index, category] of TRIVIA_CATEGORY_IDS.entries()) {
      await store.appendRound(round(
        `global-category-${String(index).padStart(2, '0')}`,
        `ROOM-${index}`,
        triviaResult({
          resultId: `engine-category-${index}`,
          category,
          playedAt: 2_000 + index,
          namePrefix: category,
          playerCount: 1,
          rawScores: [2_000 + index],
        }),
      ));
      expect(await store.entries(category, 1)).toMatchObject([{
        rank: 1,
        category,
      }]);
    }
    expect(await store.entries('all-time', 3)).toHaveLength(3);

    const tiedFile = await leaderboardFile();
    const tied = await TriviaLeaderboardStore.open(tiedFile, SALT);
    await tied.appendRound(round('global-b', 'ROOM-B', triviaResult({
      resultId: 'engine-b', playedAt: 5_000, namePrefix: 'Lexically later', playerCount: 1, rawScores: [3_000],
    })));
    await tied.appendRound(round('global-a', 'ROOM-A', triviaResult({
      resultId: 'engine-a', playedAt: 5_000, namePrefix: 'Lexically first', playerCount: 1, rawScores: [3_000],
    })));
    expect((await tied.entries('science')).map(entry => entry.displayName))
      .toEqual(['Lexically first 1', 'Lexically later 1']);
    await expect(tied.entries('all-time', 101)).rejects.toThrow(/limit/);
  });

  it('returns only rank, displayName, score, category, and playedAt', async () => {
    const file = await leaderboardFile();
    const store = await TriviaLeaderboardStore.open(file, SALT);
    await store.appendRound(round('secret-global-result', 'SECRET-ROOM', triviaResult({ playerCount: 1 })));

    const rows = await store.entries('all-time');
    expect(Object.keys(rows[0]!)).toEqual(['rank', 'displayName', 'score', 'category', 'playedAt']);
    const response = JSON.stringify(rows);
    expect(response).not.toContain('resultId');
    expect(response).not.toContain('engineResultId');
    expect(response).not.toContain('playerIdentityHash');
    expect(response).not.toContain('secret-global-result');
    expect(response).not.toContain('SECRET-ROOM');
    expect(response).not.toContain('t1');
  });

  it('anonymizes only the matching room identity across all of its retained rounds', async () => {
    const file = await leaderboardFile();
    const store = await TriviaLeaderboardStore.open(file, SALT);
    await store.appendRound(round('room-a-result-1', 'ROOM-A', triviaResult({ namePrefix: 'Ada' })));
    await store.appendRound(round('room-a-result-2', 'ROOM-A', triviaResult({
      resultId: 'engine-round-2', playedAt: 2_000, namePrefix: 'Ada Again',
    })));
    await store.appendRound(round('room-b-result-1', 'ROOM-B', triviaResult({
      resultId: 'engine-round-3', playedAt: 3_000, namePrefix: 'Other Room',
    })));

    expect(await store.anonymizePlayer({ identityNamespace: 'ROOM-A', playerId: 't1' }))
      .toEqual({ updated: 2 });
    const names = (await store.entries('all-time', 100)).map(entry => entry.displayName);
    expect(names.filter(name => name === 'PLAYER')).toHaveLength(2);
    expect(names).toContain('Other Room 1');
    expect(await store.anonymizePlayer({ identityNamespace: 'ROOM-A', playerId: 't1' }))
      .toEqual({ updated: 0 });
  });
});

describe('Trivia leaderboard serialized administration and durability', () => {
  it('serializes category/all resets with appends so no concurrent write is lost', async () => {
    const file = await leaderboardFile();
    const store = await TriviaLeaderboardStore.open(file, SALT);

    await Promise.all([
      store.appendRound(round('science-before-reset', 'ROOM-A')),
      store.reset('science'),
      store.appendRound(round('history-after-reset', 'ROOM-B', triviaResult({
        resultId: 'engine-history', category: 'history', playedAt: 2_000, namePrefix: 'History',
      }))),
    ]);
    expect(await store.entries('science')).toEqual([]);
    expect(await store.entries('history')).toHaveLength(4);

    await Promise.all([
      store.appendRound(round('science-before-all-reset', 'ROOM-C', triviaResult({
        resultId: 'engine-science-2', playedAt: 3_000,
      }))),
      store.reset('all-time'),
      store.appendRound(round('science-after-all-reset', 'ROOM-D', triviaResult({
        resultId: 'engine-science-3', playedAt: 4_000, namePrefix: 'Survivor',
      }))),
    ]);
    expect((await store.entries('all-time', 100)).map(entry => entry.displayName))
      .toEqual(['Survivor 1', 'Survivor 2', 'Survivor 3', 'Survivor 4']);
    expect((await TriviaLeaderboardStore.open(file, SALT)).getStatus()).toMatchObject({
      state: 'ready', entryCount: 4,
    });
  });

  it('fsyncs the temporary file before rename and the directory after rename', async () => {
    const file = await leaderboardFile();
    const operations: string[] = [];
    const fs: TriviaLeaderboardFileSystem = {
      mkdir,
      readFile,
      open: async (target, flags, mode) => {
        const handle = await open(target, flags, mode);
        return {
          writeFile: async (data, encoding) => { operations.push('write'); await handle.writeFile(data, encoding); },
          sync: async () => { operations.push('file-sync'); await handle.sync(); },
          close: async () => { operations.push('close'); await handle.close(); },
        };
      },
      rename: async (from, to) => { operations.push('rename'); await rename(from, to); },
      unlink,
      syncDirectory: async () => { operations.push('directory-sync'); },
    };
    const store = await TriviaLeaderboardStore.open(file, SALT, {
      fileSystem: fs,
      temporaryId: () => 'fixed-test-id',
    });
    await store.appendRound(round('global-result-1', 'ROOM-A'));
    await store.flush();

    expect(operations).toEqual(['write', 'file-sync', 'close', 'rename', 'directory-sync']);
    expect(store.getStatus()).toMatchObject({ state: 'ready', pendingOperations: 0, entryCount: 4 });
  });

  it('reports an unconfirmed directory sync through append, status, and flush', async () => {
    const file = await leaderboardFile();
    const fs: TriviaLeaderboardFileSystem = {
      mkdir,
      readFile,
      open: async (target, flags, mode) => open(target, flags, mode),
      rename,
      unlink,
      syncDirectory: async () => { throw new Error('injected directory sync failure'); },
    };
    const store = await TriviaLeaderboardStore.open(file, SALT, {
      fileSystem: fs,
      temporaryId: () => 'fixed-test-id',
    });

    await expect(store.appendRound(round('global-result-1', 'ROOM-A')))
      .rejects.toMatchObject({ code: 'DIRECTORY_SYNC_FAILED' });
    expect(store.getStatus()).toMatchObject({
      state: 'reload-required',
      entryCount: null,
      lastError: expect.stringContaining('could not be synced'),
    });
    await expect(store.flush()).rejects.toMatchObject({ code: 'DIRECTORY_SYNC_FAILED' });
    expect((await TriviaLeaderboardStore.open(file, SALT)).getStatus()).toMatchObject({
      state: 'ready', entryCount: 4,
    });
  });

  it('treats a missing file as empty but a blank file as corruption', async () => {
    const file = await leaderboardFile();
    expect(serializeTriviaLeaderboard(emptyTriviaLeaderboard())).toContain('"entries":[]');
    expect((await TriviaLeaderboardStore.open(file, SALT)).getStatus().entryCount).toBe(0);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '', 'utf8');
    await expect(TriviaLeaderboardStore.open(file, SALT)).rejects.toMatchObject({ code: 'CORRUPT_STORAGE' });
  });
});
