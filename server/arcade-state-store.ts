import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import {
  assertWalletInvariants,
  normalizeLead,
  type ArcadeTimestamp,
  type Lead,
  type WalletState,
} from '../shared/arcade-domain';
import {
  assertQueueEventInvariants,
  assertQueueEntryInvariants,
  isTerminalQueueStatus,
  QUEUE_STATUSES,
  type QueueEntry,
  type QueueEvent,
} from '../shared/arcade-queue';

export const ARCADE_STATE_SCHEMA_VERSION = 1 as const;
export const ARCADE_STATE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const ARCADE_STATE_MAX_PLAYERS = 100_000;
export const ARCADE_STATE_MAX_QUEUE_ENTRIES = 100_000;
export const ARCADE_STATE_MAX_QUEUE_EVENTS = 500_000;
export const ARCADE_STATE_MAX_IDEMPOTENCY_RECORDS = 250_000;
const MAX_AGGREGATE_ITEMS = 100_000;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_QUEUE_REASON_LENGTH = 512;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 12;
const MAX_RESULT_JSON_DEPTH = 24;

export interface ArcadePlayerRecord {
  readonly id: string;
  readonly createdAt: ArcadeTimestamp;
  readonly updatedAt: ArcadeTimestamp;
  readonly lead: Lead | null;
  readonly preferredLocale: string | null;
  readonly conversationProfileId: string | null;
  readonly crmLeadId: string | null;
  readonly termsAcceptedAt: ArcadeTimestamp | null;
  readonly marketingConsent: boolean;
  /** A server-authenticated address. Callers must never populate this from an untrusted claim request. */
  readonly trustedDestination: string | null;
}

export interface ArcadeServiceIdempotencyRecord {
  readonly key: string;
  readonly operation: string;
  readonly playerId: string | null;
  readonly fingerprint: string;
  readonly result: unknown;
  readonly configVersion: number;
  readonly createdAt: ArcadeTimestamp;
}

export interface ArcadeQueueEntryConfigSnapshot {
  readonly queueEntryId: string;
  readonly cabinetId: string;
  readonly configVersion: number;
  readonly chargePolicy: 'per_player' | 'free';
  readonly gameCost: number;
  readonly refundOnLobbyTimeout: boolean;
  readonly capturedAt: ArcadeTimestamp;
  readonly assignedGame: 'racer' | 'monsters' | 'fighter' | 'trivia' | null;
  readonly matchId: string | null;
}

export interface ArcadeState {
  readonly schemaVersion: typeof ARCADE_STATE_SCHEMA_VERSION;
  players: Record<string, ArcadePlayerRecord>;
  wallets: Record<string, WalletState>;
  queueEntries: Record<string, QueueEntry>;
  queueEntryConfigs: Record<string, ArcadeQueueEntryConfigSnapshot>;
  queueEvents: QueueEvent[];
  idempotencyRecords: Record<string, ArcadeServiceIdempotencyRecord>;
}

export interface ArcadeStateFileHandle {
  writeFile(data: string, encoding: BufferEncoding): Promise<unknown>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ArcadeStateFileSystem {
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  readFile(file: string, encoding: BufferEncoding): Promise<string>;
  open(file: string, flags: string, mode: number): Promise<ArcadeStateFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
}

export interface ArcadeStateStoreOptions {
  readonly fileSystem?: ArcadeStateFileSystem;
  readonly temporaryId?: () => string;
}

export class ArcadeStateStoreError extends Error {
  constructor(readonly code: string, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ArcadeStateStoreError';
  }
}

const FORBIDDEN_RECORD_KEYS = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  '__proto__',
  'prototype',
  'constructor',
]);
const WALLET_TRANSACTION_TYPES = new Set([
  'registration_grant', 'challenge_reward', 'operator_grant', 'reservation', 'redemption',
  'reservation_release', 'refund', 'adjustment',
]);
const RESERVATION_STATUSES = new Set(['ACTIVE', 'RELEASED', 'REDEEMED', 'REFUNDED']);
const IDEMPOTENT_OPERATIONS = new Set([
  'REGISTRATION_GRANT', 'CHALLENGE_REWARD', 'RESERVE', 'RELEASE', 'REDEEM', 'REFUND',
]);
const QUEUE_EVENT_TYPES = new Set([
  'QUEUE_JOINED', 'MARKED_APPROACHING', 'PRESENCE_CONFIRMED', 'CALLED', 'CHECKED_IN',
  'ENTERED_ACTIVE_LOBBY', 'STARTED_PLAYING', 'COMPLETED', 'DEFERRED', 'RETURNED_TO_WAITING',
  'MARKED_NO_SHOW', 'LEFT_QUEUE', 'RELEASED',
]);
const ARCADE_GAMES = new Set(['racer', 'monsters', 'fighter', 'trivia']);
const SERVICE_OPERATIONS = new Set([
  'IDENTIFY_COIN_ONLY', 'REGISTER_PLAYER', 'CLAIM_CHALLENGE', 'JOIN_QUEUE', 'MARK_APPROACHING',
  'CONFIRM_PRESENCE', 'CALL_QUEUE_ENTRY', 'SNOOZE_QUEUE_ENTRY', 'EXPIRE_QUEUE_ENTRY',
  'REQUEUE_ENTRY', 'CHECK_IN_QUEUE_ENTRY', 'ACTIVATE_LOBBY', 'START_MATCH', 'COMPLETE_MATCH',
  'RELEASE_QUEUE_ENTRY', 'LEAVE_QUEUE', 'REFUND_QUEUE_ENTRY',
]);

const nodeFileSystem: ArcadeStateFileSystem = {
  mkdir,
  readFile,
  open: (file, flags, mode) => open(file, flags, mode) as Promise<FileHandle>,
  rename,
  unlink,
  syncDirectory: syncDirectoryIfSupported,
};

export function createEmptyArcadeState(): ArcadeState {
  return {
    schemaVersion: ARCADE_STATE_SCHEMA_VERSION,
    players: Object.create(null) as Record<string, ArcadePlayerRecord>,
    wallets: Object.create(null) as Record<string, WalletState>,
    queueEntries: Object.create(null) as Record<string, QueueEntry>,
    queueEntryConfigs: Object.create(null) as Record<string, ArcadeQueueEntryConfigSnapshot>,
    queueEvents: [],
    idempotencyRecords: Object.create(null) as Record<string, ArcadeServiceIdempotencyRecord>,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ArcadeStateStoreError('INVALID_STATE', `${field} must be an object`);
  return value;
}

function own<Value>(record: Record<string, Value>, key: string): Value | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function requireExactRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const record = requireRecord(value, field);
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    throw new ArcadeStateStoreError('INVALID_STATE', `${field} has malformed fields`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `${field}.${key} is required`);
    }
  }
  return record;
}

function requireSafeKey(value: string, field: string): void {
  if (FORBIDDEN_RECORD_KEYS.has(value) || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new ArcadeStateStoreError('INVALID_STATE', `${field} is not a safe bounded key`);
  }
}

function requireCollectionSize(value: Record<string, unknown> | unknown[], maximum: number, field: string): void {
  const size = Array.isArray(value) ? value.length : Object.keys(value).length;
  if (size > maximum) throw new ArcadeStateStoreError('STATE_LIMIT_EXCEEDED', `${field} exceeds ${maximum} items`);
}

function requireString(value: unknown, field: string, nullable = false, maximum = MAX_IDENTIFIER_LENGTH): void {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new ArcadeStateStoreError('INVALID_STATE', `${field} must be a non-empty bounded string`);
  }
}

function requireTimestamp(value: unknown, field: string, nullable = false): void {
  if (nullable && value === null) return;
  requireString(value, field);
  if (!Number.isFinite(Date.parse(value as string))) {
    throw new ArcadeStateStoreError('INVALID_STATE', `${field} must be a valid timestamp`);
  }
}

function requireInteger(value: unknown, field: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ArcadeStateStoreError('INVALID_STATE', `${field} must be an integer of at least ${minimum}`);
  }
}

function requireBoolean(value: unknown, field: string): void {
  if (typeof value !== 'boolean') throw new ArcadeStateStoreError('INVALID_STATE', `${field} must be boolean`);
}

function requireNullableString(value: unknown, field: string, maximum = MAX_IDENTIFIER_LENGTH): void {
  if (value !== null) requireString(value, field, false, maximum);
}

function assertBoundedJson(
  value: unknown,
  field: string,
  maximumBytes: number,
  maximumDepth = MAX_JSON_DEPTH,
): void {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number, itemPath: string): void => {
    nodes += 1;
    if (nodes > 100_000 || depth > maximumDepth) {
      throw new ArcadeStateStoreError('STATE_LIMIT_EXCEEDED', `${field} exceeds JSON depth or node limits`);
    }
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') {
      throw new ArcadeStateStoreError('INVALID_STATE', `${itemPath} is not a JSON value`);
    }
    if (seen.has(item)) throw new ArcadeStateStoreError('INVALID_STATE', `${field} contains a cycle`);
    seen.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) visit(item[index], depth + 1, `${itemPath}[${index}]`);
    } else {
      for (const [key, child] of Object.entries(item)) {
        if (FORBIDDEN_RECORD_KEYS.has(key)) {
          throw new ArcadeStateStoreError('INVALID_STATE', `${itemPath}.${key} is an unsafe JSON key`);
        }
        visit(child, depth + 1, `${itemPath}.${key}`);
      }
    }
    seen.delete(item);
  };
  visit(value, 0, field);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new ArcadeStateStoreError('INVALID_STATE', `${field} is not serializable`, error);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new ArcadeStateStoreError('STATE_LIMIT_EXCEEDED', `${field} exceeds ${maximumBytes} bytes`);
  }
}

function assertPlayer(player: ArcadePlayerRecord, key: string): void {
  requireSafeKey(key, `players.${key}`);
  const record = requireExactRecord(player, [
    'id', 'createdAt', 'updatedAt', 'lead', 'preferredLocale', 'conversationProfileId',
    'crmLeadId', 'termsAcceptedAt', 'marketingConsent', 'trustedDestination',
  ], `players.${key}`);
  if (record.id !== key) {
    throw new ArcadeStateStoreError('INVALID_STATE', `player key ${key} does not match its identity`);
  }
  requireString(player.id, `players.${key}.id`);
  requireTimestamp(player.createdAt, `players.${key}.createdAt`);
  requireTimestamp(player.updatedAt, `players.${key}.updatedAt`);
  requireTimestamp(player.termsAcceptedAt, `players.${key}.termsAcceptedAt`, true);
  requireString(player.trustedDestination, `players.${key}.trustedDestination`, true);
  requireNullableString(player.preferredLocale, `players.${key}.preferredLocale`);
  requireNullableString(player.conversationProfileId, `players.${key}.conversationProfileId`);
  requireNullableString(player.crmLeadId, `players.${key}.crmLeadId`);
  if (typeof player.marketingConsent !== 'boolean') {
    throw new ArcadeStateStoreError('INVALID_STATE', `players.${key}.marketingConsent must be boolean`);
  }
  if (player.lead !== null) {
    const lead = requireRecord(player.lead, `players.${key}.lead`);
    const leadFields = ['firstName', 'lastName', 'workEmail', 'companyName', 'phoneNumber', 'countryCode'] as const;
    if (Object.keys(lead).length !== leadFields.length
      || Object.keys(lead).some(field => !leadFields.includes(field as typeof leadFields[number]))) {
      throw new ArcadeStateStoreError('INVALID_STATE', `players.${key}.lead must contain exactly six fields`);
    }
    for (const field of leadFields) {
      requireString(lead[field], `players.${key}.lead.${field}`);
    }
    try {
      const normalized = normalizeLead(player.lead);
      if (leadFields.some(field => normalized[field] !== player.lead?.[field])) {
        throw new Error('lead fields are not normalized');
      }
    } catch (error) {
      throw new ArcadeStateStoreError(
        'INVALID_STATE',
        `players.${key}.lead is invalid: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }
}

function assertWalletShape(walletInput: unknown, key: string): asserts walletInput is WalletState {
  const state = requireExactRecord(walletInput, [
    'wallet', 'transactions', 'reservations', 'challengeClaims', 'idempotencyRecords',
  ], `wallets.${key}`);
  const aggregate = requireExactRecord(state.wallet, [
    'playerId', 'cachedBalance', 'createdAt', 'updatedAt',
  ], `wallets.${key}.wallet`);
  if (aggregate.playerId !== key) {
    throw new ArcadeStateStoreError('INVALID_STATE', `wallet key ${key} does not match its player`);
  }
  requireInteger(aggregate.cachedBalance, `wallets.${key}.wallet.cachedBalance`);
  requireTimestamp(aggregate.createdAt, `wallets.${key}.wallet.createdAt`);
  requireTimestamp(aggregate.updatedAt, `wallets.${key}.wallet.updatedAt`);

  for (const field of ['transactions', 'reservations', 'challengeClaims', 'idempotencyRecords'] as const) {
    if (!Array.isArray(state[field])) {
      throw new ArcadeStateStoreError('INVALID_STATE', `wallets.${key}.${field} must be an array`);
    }
    requireCollectionSize(state[field] as unknown[], MAX_AGGREGATE_ITEMS, `wallets.${key}.${field}`);
  }

  for (const [index, value] of (state.transactions as unknown[]).entries()) {
    const item = requireExactRecord(value, [
      'id', 'playerId', 'type', 'delta', 'reservationId', 'challengeId', 'matchId',
      'idempotencyKey', 'configVersion', 'metadata', 'createdAt',
    ], `wallets.${key}.transactions[${index}]`);
    requireString(item.id, `wallets.${key}.transactions[${index}].id`);
    if (item.playerId !== key || !WALLET_TRANSACTION_TYPES.has(item.type as string)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `wallets.${key}.transactions[${index}] has invalid enums or owner`);
    }
    requireInteger(Math.abs(item.delta as number), `wallets.${key}.transactions[${index}].delta`);
    if (!Number.isSafeInteger(item.delta)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `wallets.${key}.transactions[${index}].delta must be an integer`);
    }
    requireNullableString(item.reservationId, `wallets.${key}.transactions[${index}].reservationId`);
    requireNullableString(item.challengeId, `wallets.${key}.transactions[${index}].challengeId`);
    requireNullableString(item.matchId, `wallets.${key}.transactions[${index}].matchId`);
    requireString(item.idempotencyKey, `wallets.${key}.transactions[${index}].idempotencyKey`);
    requireInteger(item.configVersion, `wallets.${key}.transactions[${index}].configVersion`, 1);
    requireTimestamp(item.createdAt, `wallets.${key}.transactions[${index}].createdAt`);
    requireRecord(item.metadata, `wallets.${key}.transactions[${index}].metadata`);
    assertBoundedJson(item.metadata, `wallets.${key}.transactions[${index}].metadata`, MAX_METADATA_BYTES);
  }

  for (const [index, value] of (state.reservations as unknown[]).entries()) {
    const item = requireExactRecord(value, [
      'id', 'playerId', 'queueEntryId', 'amount', 'status', 'createdAt', 'releasedAt',
      'redeemedAt', 'refundedAt', 'matchId', 'configVersion',
    ], `wallets.${key}.reservations[${index}]`);
    requireString(item.id, `wallets.${key}.reservations[${index}].id`);
    requireString(item.queueEntryId, `wallets.${key}.reservations[${index}].queueEntryId`);
    if (item.playerId !== key || !RESERVATION_STATUSES.has(item.status as string)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `wallets.${key}.reservations[${index}] has invalid enums or owner`);
    }
    requireInteger(item.amount, `wallets.${key}.reservations[${index}].amount`, 1);
    requireTimestamp(item.createdAt, `wallets.${key}.reservations[${index}].createdAt`);
    requireTimestamp(item.releasedAt, `wallets.${key}.reservations[${index}].releasedAt`, true);
    requireTimestamp(item.redeemedAt, `wallets.${key}.reservations[${index}].redeemedAt`, true);
    requireTimestamp(item.refundedAt, `wallets.${key}.reservations[${index}].refundedAt`, true);
    requireNullableString(item.matchId, `wallets.${key}.reservations[${index}].matchId`);
    requireInteger(item.configVersion, `wallets.${key}.reservations[${index}].configVersion`, 1);
  }

  for (const [index, value] of (state.challengeClaims as unknown[]).entries()) {
    const item = requireExactRecord(value, [
      'id', 'challengeId', 'playerId', 'rewardCoins', 'configVersion', 'requestMetadata',
      'idempotencyKey', 'transactionId', 'claimedAt',
    ], `wallets.${key}.challengeClaims[${index}]`);
    requireString(item.id, `wallets.${key}.challengeClaims[${index}].id`);
    requireString(item.challengeId, `wallets.${key}.challengeClaims[${index}].challengeId`);
    if (item.playerId !== key) {
      throw new ArcadeStateStoreError('INVALID_STATE', `wallets.${key}.challengeClaims[${index}] has wrong owner`);
    }
    requireInteger(item.rewardCoins, `wallets.${key}.challengeClaims[${index}].rewardCoins`, 1);
    requireInteger(item.configVersion, `wallets.${key}.challengeClaims[${index}].configVersion`, 1);
    requireString(item.idempotencyKey, `wallets.${key}.challengeClaims[${index}].idempotencyKey`);
    requireString(item.transactionId, `wallets.${key}.challengeClaims[${index}].transactionId`);
    requireTimestamp(item.claimedAt, `wallets.${key}.challengeClaims[${index}].claimedAt`);
    requireRecord(item.requestMetadata, `wallets.${key}.challengeClaims[${index}].requestMetadata`);
    assertBoundedJson(item.requestMetadata, `wallets.${key}.challengeClaims[${index}].requestMetadata`, MAX_METADATA_BYTES);
  }

  for (const [index, value] of (state.idempotencyRecords as unknown[]).entries()) {
    const item = requireExactRecord(value, [
      'key', 'playerId', 'operation', 'resourceId', 'fingerprint', 'resultTransactionId', 'createdAt',
    ], `wallets.${key}.idempotencyRecords[${index}]`);
    requireString(item.key, `wallets.${key}.idempotencyRecords[${index}].key`);
    if (item.playerId !== key || !IDEMPOTENT_OPERATIONS.has(item.operation as string)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `wallets.${key}.idempotencyRecords[${index}] has invalid enums or owner`);
    }
    requireString(item.resourceId, `wallets.${key}.idempotencyRecords[${index}].resourceId`);
    requireString(item.fingerprint, `wallets.${key}.idempotencyRecords[${index}].fingerprint`);
    requireString(item.resultTransactionId, `wallets.${key}.idempotencyRecords[${index}].resultTransactionId`);
    requireTimestamp(item.createdAt, `wallets.${key}.idempotencyRecords[${index}].createdAt`);
  }
}

function assertQueueEntryShape(entry: QueueEntry, key: string): void {
  requireExactRecord(entry, [
    'id', 'cabinetId', 'playerId', 'preferredGame', 'flexibleGame', 'status', 'joinedAt',
    'originalJoinedAt', 'updatedAt', 'approachingConfirmedAt', 'calledAt', 'checkInExpiresAt',
    'deferredUntil', 'checkedInAt', 'deferralCount', 'automaticDeferralCount', 'snoozeCount',
    'missCount', 'configVersion',
  ], `queueEntries.${key}`);
  requireSafeKey(key, `queueEntries.${key}`);
  requireString(entry.id, `queueEntries.${key}.id`);
  requireString(entry.cabinetId, `queueEntries.${key}.cabinetId`);
  requireString(entry.playerId, `queueEntries.${key}.playerId`);
  requireString(entry.preferredGame, `queueEntries.${key}.preferredGame`);
  if (!ARCADE_GAMES.has(entry.preferredGame)) {
    throw new ArcadeStateStoreError('INVALID_STATE', `queueEntries.${key}.preferredGame is invalid`);
  }
  requireBoolean(entry.flexibleGame, `queueEntries.${key}.flexibleGame`);
  if (!(QUEUE_STATUSES as readonly string[]).includes(entry.status)) {
    throw new ArcadeStateStoreError('INVALID_STATE', `queueEntries.${key}.status is invalid`);
  }
  requireTimestamp(entry.joinedAt, `queueEntries.${key}.joinedAt`);
  requireTimestamp(entry.originalJoinedAt, `queueEntries.${key}.originalJoinedAt`);
  requireTimestamp(entry.updatedAt, `queueEntries.${key}.updatedAt`);
  requireTimestamp(entry.approachingConfirmedAt, `queueEntries.${key}.approachingConfirmedAt`, true);
  requireTimestamp(entry.calledAt, `queueEntries.${key}.calledAt`, true);
  requireTimestamp(entry.checkInExpiresAt, `queueEntries.${key}.checkInExpiresAt`, true);
  requireTimestamp(entry.deferredUntil, `queueEntries.${key}.deferredUntil`, true);
  requireTimestamp(entry.checkedInAt, `queueEntries.${key}.checkedInAt`, true);
  requireInteger(entry.deferralCount, `queueEntries.${key}.deferralCount`);
  requireInteger(entry.automaticDeferralCount, `queueEntries.${key}.automaticDeferralCount`);
  requireInteger(entry.snoozeCount, `queueEntries.${key}.snoozeCount`);
  requireInteger(entry.missCount, `queueEntries.${key}.missCount`);
  requireInteger(entry.configVersion, `queueEntries.${key}.configVersion`, 1);
}

function assertQueueConfigShape(value: ArcadeQueueEntryConfigSnapshot, key: string): void {
  requireExactRecord(value, [
    'queueEntryId', 'cabinetId', 'configVersion', 'chargePolicy', 'gameCost',
    'refundOnLobbyTimeout', 'capturedAt', 'assignedGame', 'matchId',
  ], `queueEntryConfigs.${key}`);
  if (value.queueEntryId !== key || (value.chargePolicy !== 'per_player' && value.chargePolicy !== 'free')) {
    throw new ArcadeStateStoreError('INVALID_STATE', `queueEntryConfigs.${key} has invalid identity or policy`);
  }
  requireString(value.cabinetId, `queueEntryConfigs.${key}.cabinetId`);
  requireInteger(value.configVersion, `queueEntryConfigs.${key}.configVersion`, 1);
  requireInteger(value.gameCost, `queueEntryConfigs.${key}.gameCost`);
  requireBoolean(value.refundOnLobbyTimeout, `queueEntryConfigs.${key}.refundOnLobbyTimeout`);
  requireTimestamp(value.capturedAt, `queueEntryConfigs.${key}.capturedAt`);
  if (value.assignedGame !== null && !ARCADE_GAMES.has(value.assignedGame)) {
    throw new ArcadeStateStoreError('INVALID_STATE', `queueEntryConfigs.${key}.assignedGame is invalid`);
  }
  requireNullableString(value.matchId, `queueEntryConfigs.${key}.matchId`);
  if (value.matchId !== null && value.assignedGame === null) {
    throw new ArcadeStateStoreError('INVALID_STATE', `queueEntryConfigs.${key} has an incomplete match binding`);
  }
}

/** Validates persisted aggregate invariants and all global identity relationships. */
export function assertArcadeState(state: unknown): asserts state is ArcadeState {
  const root = requireExactRecord(state, [
    'schemaVersion', 'players', 'wallets', 'queueEntries', 'queueEntryConfigs',
    'queueEvents', 'idempotencyRecords',
  ], '$');
  if (root.schemaVersion !== ARCADE_STATE_SCHEMA_VERSION) {
    throw new ArcadeStateStoreError('UNSUPPORTED_SCHEMA', `expected Arcade state schema version ${ARCADE_STATE_SCHEMA_VERSION}`);
  }

  const players = requireRecord(root.players, 'players') as Record<string, ArcadePlayerRecord>;
  const wallets = requireRecord(root.wallets, 'wallets') as Record<string, WalletState>;
  const queueEntries = requireRecord(root.queueEntries, 'queueEntries') as Record<string, QueueEntry>;
  const queueEntryConfigs = requireRecord(
    root.queueEntryConfigs,
    'queueEntryConfigs',
  ) as Record<string, ArcadeQueueEntryConfigSnapshot>;
  const records = requireRecord(
    root.idempotencyRecords,
    'idempotencyRecords',
  ) as Record<string, ArcadeServiceIdempotencyRecord>;
  if (!Array.isArray(root.queueEvents)) {
    throw new ArcadeStateStoreError('INVALID_STATE', 'queueEvents must be an array');
  }
  requireCollectionSize(players, ARCADE_STATE_MAX_PLAYERS, 'players');
  requireCollectionSize(wallets, ARCADE_STATE_MAX_PLAYERS, 'wallets');
  requireCollectionSize(queueEntries, ARCADE_STATE_MAX_QUEUE_ENTRIES, 'queueEntries');
  requireCollectionSize(queueEntryConfigs, ARCADE_STATE_MAX_QUEUE_ENTRIES, 'queueEntryConfigs');
  requireCollectionSize(root.queueEvents, ARCADE_STATE_MAX_QUEUE_EVENTS, 'queueEvents');
  requireCollectionSize(records, ARCADE_STATE_MAX_IDEMPOTENCY_RECORDS, 'idempotencyRecords');

  const transactionIds = new Set<string>();
  const reservationIds = new Set<string>();
  const reservationsByQueueEntry = new Map<string, WalletState['reservations'][number]>();
  const claimIds = new Set<string>();
  const walletIdempotencyKeys = new Set<string>();
  for (const [key, player] of Object.entries(players)) assertPlayer(player, key);
  for (const [key, wallet] of Object.entries(wallets)) {
    requireSafeKey(key, `wallets.${key}`);
    if (!own(players, key)) throw new ArcadeStateStoreError('INVALID_STATE', `wallet ${key} has no player`);
    assertWalletShape(wallet, key);
    try {
      assertWalletInvariants(wallet);
    } catch (error) {
      throw new ArcadeStateStoreError(
        'INVALID_STATE',
        `wallet ${key} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    for (const transaction of wallet.transactions) {
      if (transactionIds.has(transaction.id)) {
        throw new ArcadeStateStoreError('INVALID_STATE', `duplicate global transaction id ${transaction.id}`);
      }
      transactionIds.add(transaction.id);
      if (walletIdempotencyKeys.has(transaction.idempotencyKey)) {
        throw new ArcadeStateStoreError(
          'INVALID_STATE',
          `duplicate global wallet idempotency key ${transaction.idempotencyKey}`,
        );
      }
      walletIdempotencyKeys.add(transaction.idempotencyKey);
    }
    for (const reservation of wallet.reservations) {
      if (reservationIds.has(reservation.id)) {
        throw new ArcadeStateStoreError('INVALID_STATE', `duplicate global reservation id ${reservation.id}`);
      }
      reservationIds.add(reservation.id);
      if (reservationsByQueueEntry.has(reservation.queueEntryId)) {
        throw new ArcadeStateStoreError(
          'INVALID_STATE',
          `queue entry ${reservation.queueEntryId} has multiple reservation histories`,
        );
      }
      reservationsByQueueEntry.set(reservation.queueEntryId, reservation);
      const entry = own(queueEntries, reservation.queueEntryId);
      if (!entry || entry.playerId !== key) {
        throw new ArcadeStateStoreError(
          'INVALID_STATE',
          `reservation ${reservation.id} does not match queue entry ${reservation.queueEntryId}`,
        );
      }
    }
    for (const claim of wallet.challengeClaims) {
      if (claimIds.has(claim.id)) {
        throw new ArcadeStateStoreError('INVALID_STATE', `duplicate global challenge claim id ${claim.id}`);
      }
      claimIds.add(claim.id);
    }
  }
  for (const key of Object.keys(players)) {
    if (!own(wallets, key)) throw new ArcadeStateStoreError('INVALID_STATE', `player ${key} has no wallet`);
  }

  const queueEventIds = new Set<string>();
  const livePlayerCabinets = new Set<string>();
  for (const [key, entry] of Object.entries(queueEntries)) {
    assertQueueEntryShape(entry, key);
    if (!own(players, entry.playerId)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `queue entry ${key} has no player`);
    }
    if (entry.id !== key) throw new ArcadeStateStoreError('INVALID_STATE', `queue entry key ${key} does not match its id`);
    try {
      assertQueueEntryInvariants(entry);
    } catch (error) {
      throw new ArcadeStateStoreError(
        'INVALID_STATE',
        `queue entry ${key} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    if (!isTerminalQueueStatus(entry.status)) {
      const identity = `${entry.cabinetId}\u0000${entry.playerId}`;
      if (livePlayerCabinets.has(identity)) {
        throw new ArcadeStateStoreError(
          'INVALID_STATE',
          `player ${entry.playerId} has multiple live entries for cabinet ${entry.cabinetId}`,
        );
      }
      livePlayerCabinets.add(identity);
    }
  }
  for (const [key, snapshot] of Object.entries(queueEntryConfigs)) {
    requireSafeKey(key, `queueEntryConfigs.${key}`);
    assertQueueConfigShape(snapshot, key);
    const entry = own(queueEntries, key);
    if (!entry || entry.cabinetId !== snapshot.cabinetId) {
      throw new ArcadeStateStoreError('INVALID_STATE', `queueEntryConfigs.${key} does not match its entry`);
    }
    const reservation = reservationsByQueueEntry.get(key);
    if (snapshot.chargePolicy === 'free' && reservation) {
      throw new ArcadeStateStoreError('INVALID_STATE', `free queue entry ${key} must not have a reservation`);
    }
    if (snapshot.chargePolicy === 'per_player') {
      if (snapshot.gameCost > 0 && (!reservation || reservation.amount !== snapshot.gameCost)) {
        throw new ArcadeStateStoreError('INVALID_STATE', `queue entry ${key} reservation does not match captured cost`);
      }
      if (snapshot.gameCost === 0 && reservation) {
        throw new ArcadeStateStoreError('INVALID_STATE', `zero-cost queue entry ${key} must not have a reservation`);
      }
    }
    const requiresMatch = entry.status === 'PLAYING' || entry.status === 'COMPLETED';
    if (requiresMatch !== (snapshot.matchId !== null)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `queue entry ${key} has an invalid match binding`);
    }
    if (snapshot.assignedGame === null) {
      throw new ArcadeStateStoreError('INVALID_STATE', `queue entry ${key} has no assigned game`);
    }
    if (reservation && (entry.status === 'CHECKED_IN' || entry.status === 'ACTIVE_LOBBY')
      && reservation.status !== 'ACTIVE') {
      throw new ArcadeStateStoreError('INVALID_STATE', `queue entry ${key} must have an active reservation`);
    }
    if (reservation && requiresMatch) {
      if ((reservation.status !== 'REDEEMED' && reservation.status !== 'REFUNDED')
        || reservation.matchId !== snapshot.matchId) {
        throw new ArcadeStateStoreError(
          'INVALID_STATE',
          `queue entry ${key} reservation does not match its active match`,
        );
      }
    }
    if (reservation && entry.status === 'RELEASED' && reservation.status !== 'RELEASED') {
      throw new ArcadeStateStoreError('INVALID_STATE', `released queue entry ${key} must release its reservation`);
    }
    if (reservation?.status === 'ACTIVE' && isTerminalQueueStatus(entry.status)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `terminal queue entry ${key} cannot retain an active reservation`);
    }
  }
  for (const [key, entry] of Object.entries(queueEntries)) {
    const needsSnapshot = ['CHECKED_IN', 'ACTIVE_LOBBY', 'PLAYING', 'COMPLETED', 'RELEASED'].includes(entry.status);
    if (needsSnapshot && !own(queueEntryConfigs, key)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `queue entry ${key} is missing its captured config`);
    }
  }
  for (const event of root.queueEvents as QueueEvent[]) {
    const eventRecord = requireExactRecord(event, [
      'id', 'type', 'queueEntryId', 'cabinetId', 'playerId', 'fromStatus', 'toStatus',
      'occurredAt', 'reason', 'configVersion',
    ], 'queueEvents[]');
    requireString(event.id, 'queueEvents[].id');
    requireSafeKey(event.id, 'queueEvents[].id');
    if (!QUEUE_EVENT_TYPES.has(event.type)
      || (event.fromStatus !== null && !(QUEUE_STATUSES as readonly string[]).includes(event.fromStatus))
      || !(QUEUE_STATUSES as readonly string[]).includes(event.toStatus)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `queue event ${event.id} has an invalid enum`);
    }
    requireString(event.queueEntryId, 'queueEvents[].queueEntryId');
    requireString(event.cabinetId, 'queueEvents[].cabinetId');
    requireString(event.playerId, 'queueEvents[].playerId');
    requireTimestamp(event.occurredAt, 'queueEvents[].occurredAt');
    requireNullableString(event.reason, 'queueEvents[].reason', MAX_QUEUE_REASON_LENGTH);
    requireInteger(event.configVersion, 'queueEvents[].configVersion', 1);
    void eventRecord;
    try {
      assertQueueEventInvariants(event);
    } catch (error) {
      throw new ArcadeStateStoreError(
        'INVALID_STATE',
        `queue event ${event.id} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    if (queueEventIds.has(event.id)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `duplicate queue event id ${event.id}`);
    }
    queueEventIds.add(event.id);
    const entry = own(queueEntries, event.queueEntryId);
    if (!entry || entry.playerId !== event.playerId || entry.cabinetId !== event.cabinetId) {
      throw new ArcadeStateStoreError('INVALID_STATE', `queue event ${event.id} does not match its entry`);
    }
  }

  for (const [key, record] of Object.entries(records)) {
    requireSafeKey(key, `idempotencyRecords.${key}`);
    const recordObject = requireExactRecord(record, [
      'key', 'operation', 'playerId', 'fingerprint', 'result', 'configVersion', 'createdAt',
    ], `idempotencyRecords.${key}`);
    if (record.key !== key) {
      throw new ArcadeStateStoreError('INVALID_STATE', `idempotency record key ${key} does not match`);
    }
    requireString(record.operation, `idempotencyRecords.${key}.operation`);
    requireString(record.fingerprint, `idempotencyRecords.${key}.fingerprint`);
    if (!SERVICE_OPERATIONS.has(record.operation) || !/^[a-f0-9]{64}$/.test(record.fingerprint)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `idempotency record ${key} has invalid enums or fingerprint`);
    }
    requireTimestamp(record.createdAt, `idempotencyRecords.${key}.createdAt`);
    requireNullableString(record.playerId, `idempotencyRecords.${key}.playerId`);
    if (record.playerId !== null && !own(players, record.playerId)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `idempotency record ${key} has no player`);
    }
    if (!Number.isSafeInteger(record.configVersion) || record.configVersion < 1) {
      throw new ArcadeStateStoreError('INVALID_STATE', `idempotency record ${key} has invalid configVersion`);
    }
    assertBoundedJson(
      recordObject.result,
      `idempotencyRecords.${key}.result`,
      MAX_RESULT_BYTES,
      MAX_RESULT_JSON_DEPTH,
    );
  }
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (error) {
    throw new ArcadeStateStoreError('NON_JSON_STATE', 'Arcade state must contain only JSON values', error);
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/**
 * Single-replica JSON store. Transactions are serialized in-process; this class intentionally does
 * not claim cross-process locking and must have exactly one writer for a given file.
 */
export class ArcadeStateStore {
  private state: ArcadeState = createEmptyArcadeState();
  private transactionQueue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private durabilityFailure: unknown = null;
  private readonly fs: ArcadeStateFileSystem;
  private readonly temporaryId: () => string;

  constructor(readonly file: string, options: ArcadeStateStoreOptions = {}) {
    this.fs = options.fileSystem ?? nodeFileSystem;
    this.temporaryId = options.temporaryId ?? randomUUID;
  }

  static async open(file: string, options: ArcadeStateStoreOptions = {}): Promise<ArcadeStateStore> {
    const store = new ArcadeStateStore(file, options);
    await store.load();
    return store;
  }

  async load(): Promise<ArcadeState> {
    this.initialized = false;
    const task = this.transactionQueue.catch(() => undefined).then(async () => {
      let next: unknown;
      try {
        const serialized = await this.fs.readFile(this.file, 'utf8');
        if (Buffer.byteLength(serialized, 'utf8') > ARCADE_STATE_MAX_FILE_BYTES) {
          throw new ArcadeStateStoreError('STATE_LIMIT_EXCEEDED', 'Arcade state file exceeds the maximum size');
        }
        next = JSON.parse(serialized) as unknown;
      } catch (error) {
        if (isMissingFile(error)) next = createEmptyArcadeState();
        else if (error instanceof SyntaxError) {
          throw new ArcadeStateStoreError('INVALID_JSON', 'Arcade state file is not valid JSON', error);
        } else throw error;
      }
      assertArcadeState(next);
      this.state = cloneJson(next);
      this.initialized = true;
      this.durabilityFailure = null;
      return freezeDeep(cloneJson(this.state));
    });
    this.transactionQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  snapshot(): ArcadeState {
    this.requireInitialized();
    return freezeDeep(cloneJson(this.state));
  }

  async read(): Promise<ArcadeState> {
    await this.transactionQueue;
    return this.snapshot();
  }

  async transaction<Result>(mutate: (draft: ArcadeState) => Result | Promise<Result>): Promise<Result> {
    const task = this.transactionQueue.catch(() => undefined).then(async () => {
      this.requireInitialized();
      const draft = cloneJson(this.state);
      const result = await mutate(draft);
      const serializable = cloneJson(draft);
      assertArcadeState(serializable);
      try {
        await this.persist(serializable);
        this.durabilityFailure = null;
      } catch (error) {
        this.durabilityFailure = error;
        throw error;
      }
      this.state = serializable;
      return cloneJson(result);
    });
    this.transactionQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  transact<Result>(mutate: (draft: ArcadeState) => Result | Promise<Result>): Promise<Result> {
    return this.transaction(mutate);
  }

  async flush(): Promise<void> {
    await this.transactionQueue;
    if (this.durabilityFailure) throw this.durabilityFailure;
  }

  private async persist(next: ArcadeState): Promise<void> {
    const directory = path.dirname(this.file);
    await this.fs.mkdir(directory, { recursive: true });
    const temporaryId = this.temporaryId();
    if (typeof temporaryId !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/.test(temporaryId)) {
      throw new ArcadeStateStoreError('INVALID_TEMPORARY_ID', 'temporaryId must be a safe value of at most 128 characters');
    }
    const temporary = path.join(
      directory,
      `.${path.basename(this.file)}.${process.pid}.${temporaryId}.tmp`,
    );
    let handle: ArcadeStateFileHandle | null = null;
    let renamed = false;
    try {
      const serialized = `${JSON.stringify(next)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > ARCADE_STATE_MAX_FILE_BYTES) {
        throw new ArcadeStateStoreError('STATE_LIMIT_EXCEEDED', 'Arcade state file exceeds the maximum size');
      }
      handle = await this.fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fs.rename(temporary, this.file);
      renamed = true;
      try {
        await this.fs.syncDirectory(directory);
      } catch (error) {
        this.initialized = false;
        throw new ArcadeStateStoreError(
          'DIRECTORY_SYNC_FAILED',
          'Arcade state was renamed but its directory could not be synced; reload is required',
          error,
        );
      }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (!renamed) await this.fs.unlink(temporary).catch(() => undefined);
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new ArcadeStateStoreError(
        'STORE_NOT_INITIALIZED',
        'Arcade state store must be loaded successfully before use',
      );
    }
  }
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
