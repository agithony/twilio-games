import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  TRIVIA_ANSWER_WINDOW_MS,
  TRIVIA_CATEGORY_IDS,
  TRIVIA_MAX_NORMALIZED_SCORE,
  TRIVIA_MAX_PLAYERS,
  TRIVIA_MAX_RAW_SCORE,
  TRIVIA_ROUND_CATEGORY_IDS,
  TRIVIA_ROUND_QUESTION_COUNT,
  isSafeTriviaId,
  normalizeTriviaScore,
  type TriviaRoundCategoryId,
} from './trivia';
import type { TriviaResult, TriviaResultPlayer } from './trivia-protocol';

export const TRIVIA_LEADERBOARD_VERSION = 1;
export const TRIVIA_ALL_TIME_BOARD_ID = 'all-time' as const;
export const TRIVIA_BOARD_IDS = [TRIVIA_ALL_TIME_BOARD_ID, ...TRIVIA_CATEGORY_IDS] as const;
export type TriviaBoardId = typeof TRIVIA_BOARD_IDS[number];
export const MAX_TRIVIA_LEADERBOARD_ENTRIES_PER_BOARD = 1_000;
export const MAX_TRIVIA_LEADERBOARD_FILE_BYTES = 4 * 1024 * 1024;

/** Stored form. IDs and tie-break fields never belong in an HTTP response. */
export interface StoredTriviaLeaderboardEntry {
  readonly resultId: string;
  readonly engineResultId: string;
  readonly resultPlayerCount: number;
  readonly playerIdentityHash: string;
  readonly displayName: string;
  readonly score: number;
  readonly correctCount: number;
  readonly cumulativeCorrectTimeMs: number;
  readonly playerOrder: number;
  readonly category: TriviaRoundCategoryId;
  readonly playedAt: number;
}

export interface TriviaLeaderboardFile {
  readonly version: typeof TRIVIA_LEADERBOARD_VERSION;
  readonly entries: readonly StoredTriviaLeaderboardEntry[];
}

/** The only leaderboard row shape safe to return from a public endpoint. */
export interface PublicTriviaLeaderboardEntry {
  readonly rank: number;
  readonly displayName: string;
  readonly score: number;
  readonly category: TriviaRoundCategoryId;
  readonly playedAt: number;
}

/**
 * A complete-round append. `uniqueResultId` must be globally unique and stable for retries. If the
 * engine resultId has that guarantee, pass it through; otherwise the integrating server must
 * supply its own durable match/result ID. The store deliberately never guesses one.
 */
export interface TriviaLeaderboardRound {
  readonly uniqueResultId: string;
  readonly identityNamespace: string;
  readonly result: TriviaResult;
}

export type AppendTriviaLeaderboardResult =
  | { readonly ok: true; readonly file: TriviaLeaderboardFile; readonly duplicate: boolean }
  | { readonly ok: false; readonly error: string };

export interface TriviaLeaderboardStoreStatus {
  readonly state: 'unloaded' | 'ready' | 'corrupt' | 'durability-error' | 'reload-required';
  readonly pendingOperations: number;
  readonly entryCount: number | null;
  readonly lastError: string | null;
}

export interface TriviaLeaderboardFileHandle {
  writeFile(data: string, encoding: BufferEncoding): Promise<unknown>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface TriviaLeaderboardFileSystem {
  mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readFile(file: string, encoding: BufferEncoding): Promise<string>;
  open(file: string, flags: string, mode: number): Promise<TriviaLeaderboardFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
}

export interface TriviaLeaderboardStoreOptions {
  readonly fileSystem?: TriviaLeaderboardFileSystem;
  readonly temporaryId?: () => string;
}

export class TriviaLeaderboardStoreError extends Error {
  constructor(readonly code: string, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TriviaLeaderboardStoreError';
  }
}

const FILE_KEYS = ['version', 'entries'] as const;
const ENTRY_KEYS = [
  'resultId', 'engineResultId', 'resultPlayerCount', 'playerIdentityHash', 'displayName', 'score',
  'correctCount', 'cumulativeCorrectTimeMs', 'playerOrder', 'category', 'playedAt',
] as const;

const nodeFileSystem: TriviaLeaderboardFileSystem = {
  mkdir,
  readFile,
  open: (file, flags, mode) => open(file, flags, mode) as Promise<FileHandle>,
  rename,
  unlink,
  syncDirectory: syncDirectoryIfSupported,
};

export function isTriviaBoardId(value: unknown): value is TriviaBoardId {
  return typeof value === 'string' && TRIVIA_BOARD_IDS.includes(value as TriviaBoardId);
}

export function emptyTriviaLeaderboard(): TriviaLeaderboardFile {
  return freezeFile([]);
}

/** Returns null for any malformed byte, row, duplicate player, or incomplete round. */
export function parseTriviaLeaderboardStrict(json: string): TriviaLeaderboardFile | null {
  if (typeof json !== 'string' || !json.trim()
    || Buffer.byteLength(json, 'utf8') > MAX_TRIVIA_LEADERBOARD_FILE_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(json); } catch { return null; }
  if (!isPlainRecord(value) || !hasExactKeys(value, FILE_KEYS)
    || value.version !== TRIVIA_LEADERBOARD_VERSION || !Array.isArray(value.entries)
    || value.entries.length > MAX_TRIVIA_LEADERBOARD_ENTRIES_PER_BOARD) return null;

  const entries: StoredTriviaLeaderboardEntry[] = [];
  const rounds = new Map<string, StoredTriviaLeaderboardEntry[]>();
  for (const candidate of value.entries) {
    const entry = parseStoredEntry(candidate);
    if (!entry) return null;
    const round = rounds.get(entry.resultId) ?? [];
    if (round.some(existing => existing.playerIdentityHash === entry.playerIdentityHash)) return null;
    round.push(entry);
    rounds.set(entry.resultId, round);
    entries.push(entry);
  }
  for (const round of rounds.values()) {
    const first = round[0]!;
    if (round.length !== first.resultPlayerCount
      || round.some(entry => entry.resultPlayerCount !== first.resultPlayerCount
        || entry.engineResultId !== first.engineResultId || entry.category !== first.category
        || entry.playedAt !== first.playedAt)
      || new Set(round.map(entry => entry.playerOrder)).size !== round.length) return null;
  }
  return freezeFile(entries);
}

/** Strict convenience parser. Corruption is never converted into an empty board. */
export function parseTriviaLeaderboard(json: string): TriviaLeaderboardFile {
  const parsed = parseTriviaLeaderboardStrict(json);
  if (!parsed) throw new TriviaLeaderboardStoreError('CORRUPT_STORAGE', 'trivia leaderboard is corrupt');
  return parsed;
}

export function serializeTriviaLeaderboard(file: TriviaLeaderboardFile): string {
  const serialized = `${JSON.stringify(file)}\n`;
  const parsed = parseTriviaLeaderboardStrict(serialized);
  if (!parsed) throw new TriviaLeaderboardStoreError('INVALID_SNAPSHOT', 'invalid trivia leaderboard snapshot');
  return `${JSON.stringify(parsed)}\n`;
}

/** A keyed, context-bound identity that cannot collide merely because two rooms both use `t1`. */
export function anonymizeTriviaPlayer(
  playerId: string,
  salt: string,
  identityNamespace: string,
  uniqueResultId: string,
): string {
  if (!isSafeTriviaId(playerId) || !validSecret(salt) || !validOpaqueId(identityNamespace)
    || !validOpaqueId(uniqueResultId)) throw new Error('valid player, salt, namespace, and result IDs are required');
  return createHmac('sha256', salt)
    .update(JSON.stringify(['trivia-leaderboard-player-v1', identityNamespace, uniqueResultId, playerId]))
    .digest('hex');
}

/** Pure complete-round append used by the persistent store. */
export function appendTriviaLeaderboardResult(
  existingJson: string,
  round: TriviaLeaderboardRound,
  salt: string,
): AppendTriviaLeaderboardResult {
  const existing = parseTriviaLeaderboardStrict(existingJson);
  if (!existing) return { ok: false, error: 'existing trivia leaderboard is corrupt - refusing to overwrite' };
  const error = validateRound(round, salt);
  if (error) return { ok: false, error };

  const additions = round.result.players.map(player => storedEntry(round, player, salt));
  const prior = existing.entries.filter(entry => entry.resultId === round.uniqueResultId);
  if (prior.length) {
    if (!sameResult(prior, additions)) {
      return { ok: false, error: 'trivia result ID already exists with different round data' };
    }
    return { ok: true, file: existing, duplicate: true };
  }

  return {
    ok: true,
    duplicate: false,
    file: freezeFile(retainCompleteTopRounds([...additions, ...existing.entries])),
  };
}

/** Score desc, correct answers desc, answer time asc, then stable persisted tie-breakers. */
export function compareStoredTriviaLeaderboardEntries(
  a: StoredTriviaLeaderboardEntry,
  b: StoredTriviaLeaderboardEntry,
): number {
  return b.score - a.score
    || b.correctCount - a.correctCount
    || a.cumulativeCorrectTimeMs - b.cumulativeCorrectTimeMs
    || a.playedAt - b.playedAt
    || a.resultId.localeCompare(b.resultId)
    || a.playerOrder - b.playerOrder
    || a.playerIdentityHash.localeCompare(b.playerIdentityHash);
}

export function publicTriviaLeaderboard(
  file: TriviaLeaderboardFile,
  boardId: TriviaBoardId,
  limit = 10,
): readonly PublicTriviaLeaderboardEntry[] {
  if (!isTriviaBoardId(boardId)) throw new Error('invalid trivia board ID');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) {
    throw new Error('leaderboard limit must be from 0 to 100');
  }
  const rows = file.entries
    .filter(entry => boardId === TRIVIA_ALL_TIME_BOARD_ID || entry.category === boardId)
    .slice()
    .sort(compareStoredTriviaLeaderboardEntries)
    .slice(0, limit)
    .map((entry, index) => Object.freeze({
      rank: index + 1,
      displayName: entry.displayName,
      score: entry.score,
      category: entry.category,
      playedAt: entry.playedAt,
    }));
  return Object.freeze(rows);
}

/** Single-writer JSON store with serialized mutations and fsync-backed atomic replacement. */
export class TriviaLeaderboardStore {
  private snapshotValue: TriviaLeaderboardFile | null = null;
  private initialized = false;
  private corrupt = false;
  private durabilityFailure: unknown = null;
  private queue: Promise<void> = Promise.resolve();
  private pendingOperations = 0;
  private readonly fs: TriviaLeaderboardFileSystem;
  private readonly temporaryId: () => string;

  constructor(
    private readonly filePath: string,
    private readonly anonymizationSalt: string,
    options: TriviaLeaderboardStoreOptions = {},
  ) {
    if (!filePath || !validSecret(anonymizationSalt)) throw new Error('file path and anonymization salt are required');
    this.fs = options.fileSystem ?? nodeFileSystem;
    this.temporaryId = options.temporaryId ?? randomUUID;
  }

  static async open(
    filePath: string,
    anonymizationSalt: string,
    options: TriviaLeaderboardStoreOptions = {},
  ): Promise<TriviaLeaderboardStore> {
    const store = new TriviaLeaderboardStore(filePath, anonymizationSalt, options);
    await store.load();
    return store;
  }

  async load(): Promise<void> {
    await this.enqueue(async () => { await this.loadUnlocked(); });
  }

  async appendRound(
    round: TriviaLeaderboardRound,
  ): Promise<{ readonly duplicate: boolean; readonly entries: readonly PublicTriviaLeaderboardEntry[] }> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot();
      const appended = appendTriviaLeaderboardResult(serializeTriviaLeaderboard(snapshot), round, this.anonymizationSalt);
      if (!appended.ok) throw new TriviaLeaderboardStoreError('APPEND_REFUSED', appended.error);
      if (!appended.duplicate) await this.commit(appended.file);
      return Object.freeze({
        duplicate: appended.duplicate,
        entries: publicTriviaLeaderboard(appended.file, TRIVIA_ALL_TIME_BOARD_ID),
      });
    });
  }

  async entries(boardId: TriviaBoardId, limit = 10): Promise<readonly PublicTriviaLeaderboardEntry[]> {
    return this.enqueue(async () => publicTriviaLeaderboard(await this.requireSnapshot(), boardId, limit));
  }

  /** A category reset removes that category from both its board and all-time; all-time clears all. */
  async reset(boardId: TriviaBoardId): Promise<{ readonly deleted: number }> {
    if (!isTriviaBoardId(boardId)) throw new Error('invalid trivia board ID');
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot();
      const remaining = boardId === TRIVIA_ALL_TIME_BOARD_ID
        ? []
        : snapshot.entries.filter(entry => entry.category !== boardId);
      const deleted = snapshot.entries.length - remaining.length;
      if (deleted) await this.commit(freezeFile(remaining));
      return Object.freeze({ deleted });
    });
  }

  async anonymizePlayer(input: {
    readonly identityNamespace: string;
    readonly playerId: string;
  }): Promise<{ readonly updated: number }> {
    if (!input || !validOpaqueId(input.identityNamespace) || !isSafeTriviaId(input.playerId)) {
      throw new Error('valid identity namespace and player ID are required');
    }
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot();
      let updated = 0;
      const entries = snapshot.entries.map(entry => {
        const identity = anonymizeTriviaPlayer(
          input.playerId,
          this.anonymizationSalt,
          input.identityNamespace,
          entry.resultId,
        );
        if (identity !== entry.playerIdentityHash || entry.displayName === 'PLAYER') return entry;
        updated += 1;
        return freezeEntry({ ...entry, displayName: 'PLAYER' });
      });
      if (updated) await this.commit(freezeFile(entries));
      return Object.freeze({ updated });
    });
  }

  getStatus(): TriviaLeaderboardStoreStatus {
    const state = this.corrupt
      ? 'corrupt'
      : this.durabilityFailure && !this.initialized
        ? 'reload-required'
        : this.durabilityFailure
          ? 'durability-error'
          : this.initialized ? 'ready' : 'unloaded';
    return Object.freeze({
      state,
      pendingOperations: this.pendingOperations,
      entryCount: this.snapshotValue?.entries.length ?? null,
      lastError: this.durabilityFailure ? errorMessage(this.durabilityFailure) : null,
    });
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.durabilityFailure) throw this.durabilityFailure;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations += 1;
    const pending = this.queue.then(operation);
    const tracked = pending.then(
      value => { this.pendingOperations -= 1; return value; },
      error => { this.pendingOperations -= 1; throw error; },
    );
    this.queue = tracked.then(() => undefined, () => undefined);
    return tracked;
  }

  private async requireSnapshot(): Promise<TriviaLeaderboardFile> {
    await this.loadUnlocked();
    if (this.corrupt || !this.initialized || !this.snapshotValue) {
      throw new TriviaLeaderboardStoreError('CORRUPT_STORAGE', 'trivia leaderboard is corrupt - refusing to overwrite');
    }
    return this.snapshotValue;
  }

  private async loadUnlocked(): Promise<void> {
    if (this.initialized && this.snapshotValue) return;
    if (this.corrupt) {
      throw new TriviaLeaderboardStoreError('CORRUPT_STORAGE', 'trivia leaderboard is corrupt - refusing to overwrite');
    }
    let next: TriviaLeaderboardFile;
    try {
      const parsed = parseTriviaLeaderboardStrict(await this.fs.readFile(this.filePath, 'utf8'));
      if (!parsed) {
        this.corrupt = true;
        throw new TriviaLeaderboardStoreError('CORRUPT_STORAGE', 'trivia leaderboard is corrupt - refusing to overwrite');
      }
      next = parsed;
    } catch (error) {
      if (isMissingFile(error)) next = emptyTriviaLeaderboard();
      else throw error;
    }
    this.snapshotValue = next;
    this.initialized = true;
    this.durabilityFailure = null;
  }

  private async commit(next: TriviaLeaderboardFile): Promise<void> {
    try {
      await this.writeAtomic(next);
      this.snapshotValue = next;
      this.initialized = true;
      this.durabilityFailure = null;
    } catch (error) {
      this.durabilityFailure = error;
      if (error instanceof TriviaLeaderboardStoreError && error.code === 'DIRECTORY_SYNC_FAILED') {
        this.snapshotValue = null;
        this.initialized = false;
      }
      throw error;
    }
  }

  private async writeAtomic(snapshot: TriviaLeaderboardFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryId = this.temporaryId();
    if (!validTemporaryId(temporaryId)) {
      throw new TriviaLeaderboardStoreError(
        'INVALID_TEMPORARY_ID',
        'temporaryId must be a safe value of at most 128 characters',
      );
    }
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${temporaryId}.tmp`,
    );
    let handle: TriviaLeaderboardFileHandle | null = null;
    let renamed = false;
    try {
      handle = await this.fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(serializeTriviaLeaderboard(snapshot), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fs.rename(temporary, this.filePath);
      renamed = true;
      try {
        await this.fs.syncDirectory(directory);
      } catch (error) {
        throw new TriviaLeaderboardStoreError(
          'DIRECTORY_SYNC_FAILED',
          'trivia leaderboard was renamed but its directory could not be synced; reload is required',
          error,
        );
      }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (!renamed) await this.fs.unlink(temporary).catch(() => undefined);
    }
  }
}

function storedEntry(
  round: TriviaLeaderboardRound,
  player: TriviaResultPlayer,
  salt: string,
): StoredTriviaLeaderboardEntry {
  return freezeEntry({
    resultId: round.uniqueResultId,
    engineResultId: round.result.resultId,
    resultPlayerCount: round.result.players.length,
    playerIdentityHash: anonymizeTriviaPlayer(
      player.playerId,
      salt,
      round.identityNamespace,
      round.uniqueResultId,
    ),
    displayName: normalizeName(player.name),
    score: player.normalizedScore,
    correctCount: player.correctCount,
    cumulativeCorrectTimeMs: player.cumulativeCorrectTimeMs,
    playerOrder: player.playerOrder,
    category: round.result.category,
    playedAt: round.result.completedAtMs,
  });
}

function parseStoredEntry(value: unknown): StoredTriviaLeaderboardEntry | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ENTRY_KEYS) || !validOpaqueId(value.resultId)
    || !isSafeTriviaId(value.engineResultId)
    || !integer(value.resultPlayerCount, 1, TRIVIA_MAX_PLAYERS)
    || typeof value.playerIdentityHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.playerIdentityHash)
    || !validStoredName(value.displayName) || !integer(value.score, 0, TRIVIA_MAX_NORMALIZED_SCORE)
    || !integer(value.correctCount, 0, TRIVIA_ROUND_QUESTION_COUNT)
    || !integer(value.cumulativeCorrectTimeMs, 0, value.correctCount * TRIVIA_ANSWER_WINDOW_MS)
    || !integer(value.playerOrder, 0, Number.MAX_SAFE_INTEGER)
    || !TRIVIA_ROUND_CATEGORY_IDS.includes(value.category as TriviaRoundCategoryId)
    || !integer(value.playedAt, 0, Number.MAX_SAFE_INTEGER)) return null;
  return freezeEntry({
    resultId: value.resultId,
    engineResultId: value.engineResultId,
    resultPlayerCount: value.resultPlayerCount,
    playerIdentityHash: value.playerIdentityHash,
    displayName: value.displayName,
    score: value.score,
    correctCount: value.correctCount,
    cumulativeCorrectTimeMs: value.cumulativeCorrectTimeMs,
    playerOrder: value.playerOrder,
    category: value.category as TriviaRoundCategoryId,
    playedAt: value.playedAt,
  });
}

function validateRound(round: TriviaLeaderboardRound, salt: string): string | null {
  if (!isPlainRecord(round) || !validOpaqueId(round.uniqueResultId)
    || !validOpaqueId(round.identityNamespace) || !validSecret(salt)) {
    return 'globally unique result ID, identity namespace, and anonymization salt are required';
  }
  const result = round.result;
  if (!isPlainRecord(result) || !isSafeTriviaId(result.resultId)
    || !integer(result.generation, 1, Number.MAX_SAFE_INTEGER)
    || !TRIVIA_ROUND_CATEGORY_IDS.includes(result.category as TriviaRoundCategoryId)
    || !validRevision(result.contentRevision) || !Array.isArray(result.players)
    || result.players.length < 1 || result.players.length > TRIVIA_MAX_PLAYERS
    || !integer(result.completedAtMs, 0, Number.MAX_SAFE_INTEGER)) return 'invalid trivia round result';

  const playerIds = new Set<string>();
  const playerOrders = new Set<number>();
  const ranks = new Set<number>();
  for (const candidate of result.players) {
    if (!isPlainRecord(candidate) || !isSafeTriviaId(candidate.playerId) || playerIds.has(candidate.playerId)
      || !validInputName(candidate.name) || !integer(candidate.playerOrder, 0, Number.MAX_SAFE_INTEGER)
      || playerOrders.has(candidate.playerOrder) || !integer(candidate.rank, 1, result.players.length)
      || ranks.has(candidate.rank) || !integer(candidate.rawScore, 0, TRIVIA_MAX_RAW_SCORE)
      || candidate.normalizedScore !== normalizeTriviaScore(candidate.rawScore)
      || !integer(candidate.correctCount, 0, TRIVIA_ROUND_QUESTION_COUNT)
      || !integer(candidate.bestStreak, 0, candidate.correctCount)
      || !integer(candidate.cumulativeCorrectTimeMs, 0, candidate.correctCount * TRIVIA_ANSWER_WINDOW_MS)) {
      return 'invalid trivia result player';
    }
    playerIds.add(candidate.playerId);
    playerOrders.add(candidate.playerOrder);
    ranks.add(candidate.rank);
  }
  const ranked = result.players.slice().sort(compareResultPlayers);
  if (ranked.some((player, index) => player.rank !== index + 1)) return 'invalid trivia result ranking';
  return null;
}

function compareResultPlayers(a: TriviaResultPlayer, b: TriviaResultPlayer): number {
  return b.rawScore - a.rawScore
    || b.correctCount - a.correctCount
    || a.cumulativeCorrectTimeMs - b.cumulativeCorrectTimeMs
    || a.playerOrder - b.playerOrder;
}

function sameResult(
  existing: readonly StoredTriviaLeaderboardEntry[],
  additions: readonly StoredTriviaLeaderboardEntry[],
): boolean {
  if (existing.length !== additions.length) return false;
  const left = existing.slice().sort((a, b) => a.playerOrder - b.playerOrder);
  const right = additions.slice().sort((a, b) => a.playerOrder - b.playerOrder);
  return left.every((entry, index) => {
    const other = right[index]!;
    return entry.resultId === other.resultId
      && entry.engineResultId === other.engineResultId
      && entry.resultPlayerCount === other.resultPlayerCount
      && entry.playerIdentityHash === other.playerIdentityHash
      && entry.score === other.score
      && entry.correctCount === other.correctCount
      && entry.cumulativeCorrectTimeMs === other.cumulativeCorrectTimeMs
      && entry.playerOrder === other.playerOrder
      && entry.category === other.category
      && entry.playedAt === other.playedAt;
  });
}

/** Never splits a result while bounding storage; all rows from a retained round survive together. */
function retainCompleteTopRounds(
  entries: readonly StoredTriviaLeaderboardEntry[],
): StoredTriviaLeaderboardEntry[] {
  const sorted = entries.slice().sort(compareStoredTriviaLeaderboardEntries);
  const rounds = new Map<string, StoredTriviaLeaderboardEntry[]>();
  for (const entry of sorted) {
    const round = rounds.get(entry.resultId) ?? [];
    round.push(entry);
    rounds.set(entry.resultId, round);
  }
  const considered = new Set<string>();
  const retained = new Set<string>();
  let count = 0;
  for (const entry of sorted) {
    if (considered.has(entry.resultId)) continue;
    considered.add(entry.resultId);
    const round = rounds.get(entry.resultId)!;
    if (count + round.length > MAX_TRIVIA_LEADERBOARD_ENTRIES_PER_BOARD) continue;
    retained.add(entry.resultId);
    count += round.length;
  }
  return sorted.filter(entry => retained.has(entry.resultId));
}

function freezeEntry(entry: StoredTriviaLeaderboardEntry): StoredTriviaLeaderboardEntry {
  return Object.freeze(entry);
}

function freezeFile(entries: readonly StoredTriviaLeaderboardEntry[]): TriviaLeaderboardFile {
  return Object.freeze({
    version: TRIVIA_LEADERBOARD_VERSION,
    entries: Object.freeze(entries.map(entry => Object.isFrozen(entry) ? entry : freezeEntry(entry))),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/.test(value);
}

function validTemporaryId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/.test(value);
}

function validSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validRevision(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 128
    && !/\p{Cc}/u.test(value);
}

function validInputName(value: unknown): value is string {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) return false;
  const normalized = normalizeName(value);
  return Array.from(normalized).length >= 1 && Array.from(normalized).length <= 40;
}

function normalizeName(value: string): string {
  return value.normalize('NFC').trim();
}

function validStoredName(value: unknown): value is string {
  return validInputName(value) && value === normalizeName(value);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function syncDirectoryIfSupported(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code)) throw error;
  } finally {
    await handle?.close();
  }
}
