import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
import {
  assertStationInvariants,
  type ArcadeStation,
  type ArcadeStationAggregate,
  type RecruitingRound,
  type StationMatch,
  type StationReadyEntry,
} from '../shared/arcade-station';

export const ARCADE_STATE_SCHEMA_VERSION = 6 as const;
export const ARCADE_STATE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const ARCADE_STATE_MAX_PLAYERS = 100_000;
export const ARCADE_STATE_MAX_QUEUE_ENTRIES = 100_000;
export const ARCADE_STATE_MAX_QUEUE_EVENTS = 500_000;
export const ARCADE_STATE_MAX_IDEMPOTENCY_RECORDS = 250_000;
export const ARCADE_STATE_MAX_OUTBOUND_NOTIFICATIONS = 50_000;
export const ARCADE_STATE_MAX_MESSAGING_AUDIT_EVENTS = 10_000;
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

export type ArcadeMessagingChannel = 'sms' | 'whatsapp';
export type ArcadeMessagingRegistrationStep = 'FIRST_NAME' | 'LAST_NAME' | 'WORK_EMAIL' | 'COMPANY' | 'COUNTRY' | 'TERMS' | 'COMPLETE';

export interface ArcadeChannelAddressRecord {
  readonly id: string;
  readonly playerId: string;
  readonly channel: ArcadeMessagingChannel;
  readonly normalizedAddress: string;
  readonly providerAddress: string;
  readonly preferredLocale: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface ArcadeMessagingDraftRecord {
  readonly playerId: string;
  readonly stationId: string;
  readonly step: ArcadeMessagingRegistrationStep;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly workEmail: string | null;
  readonly companyName: string | null;
  readonly countryCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArcadeInboundMessageRecord {
  readonly id: string;
  readonly providerMessageId: string;
  readonly channelAddressId: string | null;
  readonly requestFingerprint: string;
  readonly command: string;
  readonly reply: string;
  readonly receivedAt: string;
  readonly configVersion: number;
}

export const ARCADE_STATION_NOTIFICATION_KINDS = [
  'STATION_ADMITTED',
  'STATION_OVERFLOW',
  'STATION_CALL_NOW',
  'STATION_RESULTS',
  'STATION_NEXT_GAME',
] as const;
export type ArcadeStationNotificationKind = typeof ARCADE_STATION_NOTIFICATION_KINDS[number];

export const ARCADE_OUTBOUND_NOTIFICATION_STATUSES = [
  'PENDING', 'SENDING', 'RETRY_WAIT', 'ACCEPTED', 'DELIVERED',
  'FAILED', 'EXPIRED', 'SUPPRESSED',
] as const;
export type ArcadeOutboundNotificationStatus = typeof ARCADE_OUTBOUND_NOTIFICATION_STATUSES[number];

export const ARCADE_PROVIDER_MESSAGE_STATUSES = [
  'accepted', 'scheduled', 'queued', 'sending', 'sent', 'delivered', 'read',
  'failed', 'undelivered', 'canceled',
] as const;
export type ArcadeProviderMessageStatus = typeof ARCADE_PROVIDER_MESSAGE_STATUSES[number];

export interface ArcadeStationReadyChannelRecord {
  readonly readyEntryId: string;
  readonly channelAddressId: string;
  readonly consentedAt: ArcadeTimestamp;
}

export interface ArcadeOutboundAttemptRecord {
  readonly id: string;
  readonly ordinal: number;
  readonly providerMessageId: string | null;
  readonly providerStatus: ArcadeProviderMessageStatus | null;
  readonly startedAt: ArcadeTimestamp;
  readonly finishedAt: ArcadeTimestamp | null;
  readonly callbackAt: ArcadeTimestamp | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface ArcadeOutboundNotificationRecord {
  readonly id: string;
  readonly kind: ArcadeStationNotificationKind;
  readonly playerId: string;
  readonly stationId: string;
  readonly roundId: string;
  readonly matchId: string;
  readonly readyEntryId: string;
  readonly channelAddressId: string;
  readonly channel: ArcadeMessagingChannel;
  readonly to: string;
  readonly locale: string;
  readonly body: string;
  readonly templateContentSid: string | null;
  readonly templateVariables: Readonly<Record<string, string>>;
  readonly configVersion: number;
  readonly status: ArcadeOutboundNotificationStatus;
  readonly nextAttemptAt: ArcadeTimestamp | null;
  readonly expiresAt: ArcadeTimestamp;
  readonly attempts: readonly ArcadeOutboundAttemptRecord[];
  readonly terminalReason: string | null;
  readonly createdAt: ArcadeTimestamp;
  readonly updatedAt: ArcadeTimestamp;
  readonly terminalAt: ArcadeTimestamp | null;
}

export interface ArcadeMessagingAuditEvent {
  readonly id: string;
  readonly action: 'RETRY_OUTBOUND_NOTIFICATION';
  readonly notificationId: string;
  readonly actorSubject: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly fromStatus: 'FAILED';
  readonly attemptCount: number;
  readonly occurredAt: ArcadeTimestamp;
}

export interface ArcadeStationControlEvent {
  readonly id: string;
  readonly stationId: string;
  readonly action: string;
  readonly actorKind: 'operator' | 'system';
  readonly actorSubject: string;
  readonly reason: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly roundId: string | null;
  readonly matchId: string | null;
  readonly occurredAt: ArcadeTimestamp;
  readonly configVersion: number;
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
  stations: Record<string, ArcadeStation>;
  stationRounds: Record<string, RecruitingRound>;
  stationReadyEntries: Record<string, StationReadyEntry>;
  stationMatches: Record<string, StationMatch>;
  channelAddresses: Record<string, ArcadeChannelAddressRecord>;
  messagingDrafts: Record<string, ArcadeMessagingDraftRecord>;
  inboundMessages: Record<string, ArcadeInboundMessageRecord>;
  stationReadyChannels: Record<string, ArcadeStationReadyChannelRecord>;
  outboundNotifications: Record<string, ArcadeOutboundNotificationRecord>;
  messagingAuditEvents: Record<string, ArcadeMessagingAuditEvent>;
  stationControlEvents: ArcadeStationControlEvent[];
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
  'REGISTRATION_GRANT', 'CHALLENGE_REWARD', 'OPERATOR_GRANT', 'RESERVE', 'RELEASE', 'REDEEM', 'REFUND',
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
  'INSERT_STATION_COIN', 'LEAVE_STATION_READY_ENTRY', 'CLOSE_STATION_RECRUITING',
  'SELECT_STATION_GAME', 'REQUEST_STATION_LAUNCH', 'MARK_STATION_DISPLAY_READY',
  'START_STATION_MATCH', 'COMPLETE_STATION_MATCH', 'ADVANCE_STATION_RESULTS',
  'FAIL_STATION_LAUNCH', 'RECOVER_STATION_RESTART', 'RESET_STATION',
  'PROCESS_STATION_MESSAGE', 'GRANT_STATION_COINS', 'DROP_STATION_ADMITTED_ENTRY',
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
    stations: Object.create(null) as Record<string, ArcadeStation>,
    stationRounds: Object.create(null) as Record<string, RecruitingRound>,
    stationReadyEntries: Object.create(null) as Record<string, StationReadyEntry>,
    stationMatches: Object.create(null) as Record<string, StationMatch>,
    channelAddresses: Object.create(null) as Record<string, ArcadeChannelAddressRecord>,
    messagingDrafts: Object.create(null) as Record<string, ArcadeMessagingDraftRecord>,
    inboundMessages: Object.create(null) as Record<string, ArcadeInboundMessageRecord>,
    stationReadyChannels: Object.create(null) as Record<string, ArcadeStationReadyChannelRecord>,
    outboundNotifications: Object.create(null) as Record<string, ArcadeOutboundNotificationRecord>,
    messagingAuditEvents: Object.create(null) as Record<string, ArcadeMessagingAuditEvent>,
    stationControlEvents: [],
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

function requireNullableFiniteNumber(value: unknown, field: string, minimum?: number): void {
  if (value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    throw new ArcadeStateStoreError('INVALID_STATE', `${field} must be null or a finite number`);
  }
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

function assertStationShape(value: ArcadeStation, key: string): void {
  requireExactRecord(value, [
    'id', 'phase', 'activeRoundId', 'nextRoundId', 'activeGame', 'activeMatchId',
    'revision', 'updatedAt',
  ], `stations.${key}`);
  requireSafeKey(key, `stations.${key}`);
  if (value.id !== key) throw new ArcadeStateStoreError('INVALID_STATE', `station key ${key} does not match ID`);
  requireString(value.phase, `stations.${key}.phase`);
  requireNullableString(value.activeRoundId, `stations.${key}.activeRoundId`);
  requireNullableString(value.nextRoundId, `stations.${key}.nextRoundId`);
  requireNullableString(value.activeGame, `stations.${key}.activeGame`);
  requireNullableString(value.activeMatchId, `stations.${key}.activeMatchId`);
  requireInteger(value.revision, `stations.${key}.revision`, 1);
  requireTimestamp(value.updatedAt, `stations.${key}.updatedAt`);
}

function assertStationRoundShape(value: RecruitingRound, key: string): void {
  requireExactRecord(value, [
    'id', 'stationId', 'phase', 'firstCoinAt', 'recruitingEndsAt', 'hardEndsAt',
    'selectionEndsAt', 'selectionStartedAt', 'lockedEndsAt', 'lockedAt', 'selectedGame',
    'startedAt', 'resultsAt', 'closedAt', 'configVersion',
  ], `stationRounds.${key}`);
  requireSafeKey(key, `stationRounds.${key}`);
  if (value.id !== key) throw new ArcadeStateStoreError('INVALID_STATE', `station round key ${key} does not match ID`);
  requireString(value.stationId, `stationRounds.${key}.stationId`);
  requireString(value.phase, `stationRounds.${key}.phase`);
  requireTimestamp(value.firstCoinAt, `stationRounds.${key}.firstCoinAt`);
  for (const field of ['recruitingEndsAt', 'hardEndsAt', 'selectionEndsAt', 'selectionStartedAt',
    'lockedEndsAt', 'lockedAt', 'startedAt', 'resultsAt', 'closedAt'] as const) {
    requireTimestamp(value[field], `stationRounds.${key}.${field}`, true);
  }
  requireNullableString(value.selectedGame, `stationRounds.${key}.selectedGame`);
  requireInteger(value.configVersion, `stationRounds.${key}.configVersion`, 1);
}

function assertStationReadyShape(value: StationReadyEntry, key: string): void {
  requireExactRecord(value, [
    'id', 'roundId', 'stationId', 'playerId', 'originalReadyAt', 'readyAt', 'status',
    'reservationId', 'overflowOrdinal',
  ], `stationReadyEntries.${key}`);
  requireSafeKey(key, `stationReadyEntries.${key}`);
  if (value.id !== key) throw new ArcadeStateStoreError('INVALID_STATE', `station ready key ${key} does not match ID`);
  for (const field of ['roundId', 'stationId', 'playerId', 'status'] as const) {
    requireString(value[field], `stationReadyEntries.${key}.${field}`);
  }
  requireNullableString(value.reservationId, `stationReadyEntries.${key}.reservationId`);
  requireTimestamp(value.originalReadyAt, `stationReadyEntries.${key}.originalReadyAt`);
  requireTimestamp(value.readyAt, `stationReadyEntries.${key}.readyAt`);
  if (value.overflowOrdinal !== null) requireInteger(value.overflowOrdinal, `stationReadyEntries.${key}.overflowOrdinal`, 1);
}

function assertStationMatchShape(value: StationMatch, key: string): void {
  requireExactRecord(value, [
    'id', 'stationId', 'roundId', 'game', 'phase', 'participantReadyEntryIds',
    'overflowReadyEntryIds', 'engineRoomCode', 'launchGeneration', 'launchRequestedAt',
    'displayReadyAt', 'startedAt', 'completedAt', 'enginePlayerIdsByReadyEntryId', 'result', 'configVersion',
  ], `stationMatches.${key}`);
  requireSafeKey(key, `stationMatches.${key}`);
  if (value.id !== key) throw new ArcadeStateStoreError('INVALID_STATE', `station match key ${key} does not match ID`);
  for (const field of ['stationId', 'roundId', 'game', 'phase'] as const) {
    requireString(value[field], `stationMatches.${key}.${field}`);
  }
  requireString(value.engineRoomCode, `stationMatches.${key}.engineRoomCode`);
  for (const [field, ids] of [
    ['participantReadyEntryIds', value.participantReadyEntryIds],
    ['overflowReadyEntryIds', value.overflowReadyEntryIds],
  ] as const) {
    if (!Array.isArray(ids) || ids.length > 64) {
      throw new ArcadeStateStoreError('INVALID_STATE', `stationMatches.${key}.${field} is invalid`);
    }
    ids.forEach((id, index) => requireString(id, `stationMatches.${key}.${field}[${index}]`));
  }
  requireInteger(value.launchGeneration, `stationMatches.${key}.launchGeneration`, 1);
  requireInteger(value.configVersion, `stationMatches.${key}.configVersion`, 1);
  for (const field of ['launchRequestedAt', 'displayReadyAt', 'startedAt', 'completedAt'] as const) {
    requireTimestamp(value[field], `stationMatches.${key}.${field}`, true);
  }
  const bindings = requireRecord(value.enginePlayerIdsByReadyEntryId, `stationMatches.${key}.enginePlayerIdsByReadyEntryId`);
  for (const [readyEntryId, enginePlayerId] of Object.entries(bindings)) {
    requireString(readyEntryId, `stationMatches.${key}.enginePlayerIdsByReadyEntryId key`);
    requireString(enginePlayerId, `stationMatches.${key}.enginePlayerIdsByReadyEntryId.${readyEntryId}`);
  }
  if (value.result !== null) {
    assertBoundedJson(value.result, `stationMatches.${key}.result`, MAX_RESULT_BYTES);
    const result = requireExactRecord(value.result, ['source', 'participants'], `stationMatches.${key}.result`);
    if (!['ENGINE', 'RECOVERY', 'LEGACY_UNAVAILABLE'].includes(String(result.source))) {
      throw new ArcadeStateStoreError('INVALID_STATE', `stationMatches.${key}.result.source is invalid`);
    }
    if (!Array.isArray(result.participants) || result.participants.length > 64) {
      throw new ArcadeStateStoreError('INVALID_STATE', `stationMatches.${key}.result.participants is invalid`);
    }
    result.participants.forEach((participant, index) => {
      const item = requireExactRecord(participant, [
        'enginePlayerId', 'rank', 'completed', 'won', 'score', 'durationSeconds', 'readyEntryId',
      ], `stationMatches.${key}.result.participants[${index}]`);
      requireString(item.enginePlayerId, `stationMatches.${key}.result.participants[${index}].enginePlayerId`);
      requireString(item.readyEntryId, `stationMatches.${key}.result.participants[${index}].readyEntryId`);
      if (item.rank !== null) requireInteger(item.rank, `stationMatches.${key}.result.participants[${index}].rank`, 1);
      requireBoolean(item.completed, `stationMatches.${key}.result.participants[${index}].completed`);
      if (item.won !== null) requireBoolean(item.won, `stationMatches.${key}.result.participants[${index}].won`);
      requireNullableFiniteNumber(item.score, `stationMatches.${key}.result.participants[${index}].score`);
      requireNullableFiniteNumber(item.durationSeconds, `stationMatches.${key}.result.participants[${index}].durationSeconds`, 0);
    });
  }
}

function assertChannelAddressShape(value: ArcadeChannelAddressRecord, key: string): void {
  requireExactRecord(value, [
    'id', 'playerId', 'channel', 'normalizedAddress', 'providerAddress', 'preferredLocale',
    'firstSeenAt', 'lastSeenAt',
  ], `channelAddresses.${key}`);
  requireSafeKey(key, `channelAddresses.${key}`);
  if (value.id !== key) throw new ArcadeStateStoreError('INVALID_STATE', `channel address key ${key} does not match ID`);
  for (const field of ['playerId', 'channel', 'normalizedAddress', 'providerAddress', 'preferredLocale'] as const) {
    requireString(value[field], `channelAddresses.${key}.${field}`, false, 256);
  }
  requireTimestamp(value.firstSeenAt, `channelAddresses.${key}.firstSeenAt`);
  requireTimestamp(value.lastSeenAt, `channelAddresses.${key}.lastSeenAt`);
}

function assertMessagingDraftShape(value: ArcadeMessagingDraftRecord, key: string): void {
  requireExactRecord(value, [
    'playerId', 'stationId', 'step', 'firstName', 'lastName', 'workEmail', 'companyName',
    'countryCode', 'createdAt', 'updatedAt',
  ], `messagingDrafts.${key}`);
  requireSafeKey(key, `messagingDrafts.${key}`);
  if (value.playerId !== key) throw new ArcadeStateStoreError('INVALID_STATE', `messaging draft key ${key} does not match player`);
  requireString(value.stationId, `messagingDrafts.${key}.stationId`);
  requireString(value.step, `messagingDrafts.${key}.step`);
  for (const field of ['firstName', 'lastName', 'workEmail', 'companyName', 'countryCode'] as const) {
    requireNullableString(value[field], `messagingDrafts.${key}.${field}`, 254);
  }
  requireTimestamp(value.createdAt, `messagingDrafts.${key}.createdAt`);
  requireTimestamp(value.updatedAt, `messagingDrafts.${key}.updatedAt`);
}

function assertInboundMessageShape(value: ArcadeInboundMessageRecord, key: string): void {
  requireExactRecord(value, [
    'id', 'providerMessageId', 'channelAddressId', 'requestFingerprint', 'command', 'reply',
    'receivedAt', 'configVersion',
  ], `inboundMessages.${key}`);
  requireSafeKey(key, `inboundMessages.${key}`);
  if (value.id !== key) throw new ArcadeStateStoreError('INVALID_STATE', `inbound message key ${key} does not match ID`);
  requireString(value.providerMessageId, `inboundMessages.${key}.providerMessageId`, false, 256);
  requireNullableString(value.channelAddressId, `inboundMessages.${key}.channelAddressId`, 256);
  requireString(value.requestFingerprint, `inboundMessages.${key}.requestFingerprint`, false, 64);
  requireString(value.command, `inboundMessages.${key}.command`, false, 64);
  requireString(value.reply, `inboundMessages.${key}.reply`, false, 2_000);
  requireTimestamp(value.receivedAt, `inboundMessages.${key}.receivedAt`);
  requireInteger(value.configVersion, `inboundMessages.${key}.configVersion`, 1);
}

function assertStationControlEventShape(value: ArcadeStationControlEvent, index: number): void {
  requireExactRecord(value, [
    'id', 'stationId', 'action', 'actorKind', 'actorSubject', 'reason', 'fromRevision',
    'toRevision', 'roundId', 'matchId', 'occurredAt', 'configVersion',
  ], `stationControlEvents[${index}]`);
  for (const field of ['id', 'stationId', 'action', 'actorKind', 'actorSubject', 'reason'] as const) {
    requireString(value[field], `stationControlEvents[${index}].${field}`, false, field === 'reason' ? 512 : 256);
  }
  requireInteger(value.fromRevision, `stationControlEvents[${index}].fromRevision`, 1);
  requireInteger(value.toRevision, `stationControlEvents[${index}].toRevision`, 2);
  requireNullableString(value.roundId, `stationControlEvents[${index}].roundId`);
  requireNullableString(value.matchId, `stationControlEvents[${index}].matchId`);
  requireTimestamp(value.occurredAt, `stationControlEvents[${index}].occurredAt`);
  requireInteger(value.configVersion, `stationControlEvents[${index}].configVersion`, 1);
}

function assertStationReadyChannelShape(value: ArcadeStationReadyChannelRecord, key: string): void {
  requireExactRecord(value, [
    'readyEntryId', 'channelAddressId', 'consentedAt',
  ], `stationReadyChannels.${key}`);
  requireSafeKey(key, `stationReadyChannels.${key}`);
  if (value.readyEntryId !== key) {
    throw new ArcadeStateStoreError('INVALID_STATE', `station ready channel key ${key} does not match entry`);
  }
  requireString(value.channelAddressId, `stationReadyChannels.${key}.channelAddressId`);
  requireTimestamp(value.consentedAt, `stationReadyChannels.${key}.consentedAt`);
}

function assertOutboundNotificationShape(value: ArcadeOutboundNotificationRecord, key: string): void {
  requireExactRecord(value, [
    'id', 'kind', 'playerId', 'stationId', 'roundId', 'matchId', 'readyEntryId',
    'channelAddressId', 'channel', 'to', 'locale', 'body', 'templateContentSid',
    'templateVariables', 'configVersion', 'status', 'nextAttemptAt', 'expiresAt',
    'attempts', 'terminalReason', 'createdAt', 'updatedAt', 'terminalAt',
  ], `outboundNotifications.${key}`);
  requireSafeKey(key, `outboundNotifications.${key}`);
  if (value.id !== key || !/^outbound:[a-f0-9]{64}$/.test(value.id)) {
    throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification key ${key} is invalid`);
  }
  for (const field of [
    'kind', 'playerId', 'stationId', 'roundId', 'matchId', 'readyEntryId',
    'channelAddressId', 'channel', 'to', 'locale', 'body', 'status',
  ] as const) {
    requireString(value[field], `outboundNotifications.${key}.${field}`, false, field === 'body' ? 1_600 : 256);
  }
  if (!(ARCADE_STATION_NOTIFICATION_KINDS as readonly string[]).includes(value.kind)
    || !(ARCADE_OUTBOUND_NOTIFICATION_STATUSES as readonly string[]).includes(value.status)
    || (value.channel !== 'sms' && value.channel !== 'whatsapp')) {
    throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} has invalid enums`);
  }
  requireNullableString(value.templateContentSid, `outboundNotifications.${key}.templateContentSid`, 34);
  if (value.templateContentSid !== null && !/^HX[a-fA-F0-9]{32}$/.test(value.templateContentSid)) {
    throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} has invalid Content SID`);
  }
  const variables = requireRecord(value.templateVariables, `outboundNotifications.${key}.templateVariables`);
  requireCollectionSize(variables, 16, `outboundNotifications.${key}.templateVariables`);
  for (const [name, variable] of Object.entries(variables)) {
    if (!/^[1-9][0-9]?$/.test(name)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} has invalid template variable`);
    }
    requireString(variable, `outboundNotifications.${key}.templateVariables.${name}`, false, 500);
  }
  requireInteger(value.configVersion, `outboundNotifications.${key}.configVersion`, 1);
  requireTimestamp(value.nextAttemptAt, `outboundNotifications.${key}.nextAttemptAt`, true);
  requireTimestamp(value.expiresAt, `outboundNotifications.${key}.expiresAt`);
  requireNullableString(value.terminalReason, `outboundNotifications.${key}.terminalReason`, 512);
  requireTimestamp(value.createdAt, `outboundNotifications.${key}.createdAt`);
  requireTimestamp(value.updatedAt, `outboundNotifications.${key}.updatedAt`);
  requireTimestamp(value.terminalAt, `outboundNotifications.${key}.terminalAt`, true);
  if (!Array.isArray(value.attempts) || value.attempts.length > 5) {
    throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} has invalid attempts`);
  }
  for (const [index, attempt] of value.attempts.entries()) {
    requireExactRecord(attempt, [
      'id', 'ordinal', 'providerMessageId', 'providerStatus', 'startedAt', 'finishedAt',
      'callbackAt', 'errorCode', 'errorMessage',
    ], `outboundNotifications.${key}.attempts[${index}]`);
    requireString(attempt.id, `outboundNotifications.${key}.attempts[${index}].id`);
    if (attempt.id !== `${value.id}:attempt:${index + 1}` || attempt.ordinal !== index + 1) {
      throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} has unordered attempts`);
    }
    requireInteger(attempt.ordinal, `outboundNotifications.${key}.attempts[${index}].ordinal`, 1);
    requireNullableString(attempt.providerMessageId, `outboundNotifications.${key}.attempts[${index}].providerMessageId`, 34);
    if (attempt.providerMessageId !== null && !/^(?:SM|MM)[a-fA-F0-9]{32}$/.test(attempt.providerMessageId)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} has invalid provider SID`);
    }
    if (attempt.providerStatus !== null
      && !(ARCADE_PROVIDER_MESSAGE_STATUSES as readonly string[]).includes(attempt.providerStatus)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} has invalid provider status`);
    }
    requireTimestamp(attempt.startedAt, `outboundNotifications.${key}.attempts[${index}].startedAt`);
    requireTimestamp(attempt.finishedAt, `outboundNotifications.${key}.attempts[${index}].finishedAt`, true);
    requireTimestamp(attempt.callbackAt, `outboundNotifications.${key}.attempts[${index}].callbackAt`, true);
    requireNullableString(attempt.errorCode, `outboundNotifications.${key}.attempts[${index}].errorCode`, 64);
    requireNullableString(attempt.errorMessage, `outboundNotifications.${key}.attempts[${index}].errorMessage`, 512);
  }
  const terminal = ['DELIVERED', 'FAILED', 'EXPIRED', 'SUPPRESSED'].includes(value.status);
  if (terminal !== (value.terminalAt !== null) || (terminal && value.nextAttemptAt !== null)) {
    throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} has inconsistent terminal state`);
  }
  if (value.status === 'SENDING' && value.attempts.length === 0) {
    throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} is sending without an attempt`);
  }
}

function assertMessagingAuditEventShape(value: ArcadeMessagingAuditEvent, key: string): void {
  requireExactRecord(value, [
    'id', 'action', 'notificationId', 'actorSubject', 'reason', 'idempotencyKey',
    'requestFingerprint', 'fromStatus', 'attemptCount', 'occurredAt',
  ], `messagingAuditEvents.${key}`);
  requireSafeKey(key, `messagingAuditEvents.${key}`);
  if (value.id !== key || !/^messaging-audit:[a-f0-9]{64}$/.test(value.id)
    || value.action !== 'RETRY_OUTBOUND_NOTIFICATION' || value.fromStatus !== 'FAILED') {
    throw new ArcadeStateStoreError('INVALID_STATE', `messaging audit event ${key} has invalid identity`);
  }
  if (!/^outbound:[a-f0-9]{64}$/.test(value.notificationId)) {
    throw new ArcadeStateStoreError('INVALID_STATE', `messaging audit event ${key} has invalid notification`);
  }
  requireString(value.actorSubject, `messagingAuditEvents.${key}.actorSubject`, false, 256);
  requireString(value.reason, `messagingAuditEvents.${key}.reason`, false, 200);
  requireString(value.idempotencyKey, `messagingAuditEvents.${key}.idempotencyKey`, false, 128);
  requireString(value.requestFingerprint, `messagingAuditEvents.${key}.requestFingerprint`, false, 64);
  if (!/^[a-f0-9]{64}$/.test(value.requestFingerprint)) {
    throw new ArcadeStateStoreError('INVALID_STATE', `messaging audit event ${key} has invalid fingerprint`);
  }
  requireInteger(value.attemptCount, `messagingAuditEvents.${key}.attemptCount`);
  requireTimestamp(value.occurredAt, `messagingAuditEvents.${key}.occurredAt`);
}

/** Validates persisted aggregate invariants and all global identity relationships. */
export function assertArcadeState(state: unknown): asserts state is ArcadeState {
  const root = requireExactRecord(state, [
    'schemaVersion', 'players', 'wallets', 'queueEntries', 'queueEntryConfigs',
    'queueEvents', 'idempotencyRecords', 'stations', 'stationRounds',
    'stationReadyEntries', 'stationMatches', 'channelAddresses', 'messagingDrafts',
    'inboundMessages', 'stationReadyChannels', 'outboundNotifications', 'messagingAuditEvents',
    'stationControlEvents',
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
  const stations = requireRecord(root.stations, 'stations') as Record<string, ArcadeStation>;
  const stationRounds = requireRecord(root.stationRounds, 'stationRounds') as Record<string, RecruitingRound>;
  const stationReadyEntries = requireRecord(
    root.stationReadyEntries, 'stationReadyEntries',
  ) as Record<string, StationReadyEntry>;
  const stationMatches = requireRecord(root.stationMatches, 'stationMatches') as Record<string, StationMatch>;
  const channelAddresses = requireRecord(
    root.channelAddresses, 'channelAddresses',
  ) as Record<string, ArcadeChannelAddressRecord>;
  const messagingDrafts = requireRecord(
    root.messagingDrafts, 'messagingDrafts',
  ) as Record<string, ArcadeMessagingDraftRecord>;
  const inboundMessages = requireRecord(
    root.inboundMessages, 'inboundMessages',
  ) as Record<string, ArcadeInboundMessageRecord>;
  const stationReadyChannels = requireRecord(
    root.stationReadyChannels, 'stationReadyChannels',
  ) as Record<string, ArcadeStationReadyChannelRecord>;
  const outboundNotifications = requireRecord(
    root.outboundNotifications, 'outboundNotifications',
  ) as Record<string, ArcadeOutboundNotificationRecord>;
  const messagingAuditEvents = requireRecord(
    root.messagingAuditEvents, 'messagingAuditEvents',
  ) as Record<string, ArcadeMessagingAuditEvent>;
  if (!Array.isArray(root.queueEvents)) {
    throw new ArcadeStateStoreError('INVALID_STATE', 'queueEvents must be an array');
  }
  if (!Array.isArray(root.stationControlEvents)) {
    throw new ArcadeStateStoreError('INVALID_STATE', 'stationControlEvents must be an array');
  }
  requireCollectionSize(players, ARCADE_STATE_MAX_PLAYERS, 'players');
  requireCollectionSize(wallets, ARCADE_STATE_MAX_PLAYERS, 'wallets');
  requireCollectionSize(queueEntries, ARCADE_STATE_MAX_QUEUE_ENTRIES, 'queueEntries');
  requireCollectionSize(queueEntryConfigs, ARCADE_STATE_MAX_QUEUE_ENTRIES, 'queueEntryConfigs');
  requireCollectionSize(root.queueEvents, ARCADE_STATE_MAX_QUEUE_EVENTS, 'queueEvents');
  requireCollectionSize(records, ARCADE_STATE_MAX_IDEMPOTENCY_RECORDS, 'idempotencyRecords');
  requireCollectionSize(stations, ARCADE_STATE_MAX_QUEUE_ENTRIES, 'stations');
  requireCollectionSize(stationRounds, ARCADE_STATE_MAX_QUEUE_ENTRIES, 'stationRounds');
  requireCollectionSize(stationReadyEntries, ARCADE_STATE_MAX_QUEUE_ENTRIES, 'stationReadyEntries');
  requireCollectionSize(stationMatches, ARCADE_STATE_MAX_QUEUE_ENTRIES, 'stationMatches');
  requireCollectionSize(channelAddresses, ARCADE_STATE_MAX_PLAYERS * 2, 'channelAddresses');
  requireCollectionSize(messagingDrafts, ARCADE_STATE_MAX_PLAYERS, 'messagingDrafts');
  requireCollectionSize(inboundMessages, ARCADE_STATE_MAX_IDEMPOTENCY_RECORDS, 'inboundMessages');
  requireCollectionSize(stationReadyChannels, ARCADE_STATE_MAX_QUEUE_ENTRIES, 'stationReadyChannels');
  requireCollectionSize(
    outboundNotifications,
    ARCADE_STATE_MAX_OUTBOUND_NOTIFICATIONS,
    'outboundNotifications',
  );
  requireCollectionSize(
    messagingAuditEvents,
    ARCADE_STATE_MAX_MESSAGING_AUDIT_EVENTS,
    'messagingAuditEvents',
  );
  requireCollectionSize(root.stationControlEvents, ARCADE_STATE_MAX_QUEUE_EVENTS, 'stationControlEvents');

  const transactionIds = new Set<string>();
  const reservationIds = new Set<string>();
  const reservationsById = new Map<string, WalletState['reservations'][number]>();
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
      reservationsById.set(reservation.id, reservation);
      if (reservationsByQueueEntry.has(reservation.queueEntryId)) {
        throw new ArcadeStateStoreError(
          'INVALID_STATE',
          `queue entry ${reservation.queueEntryId} has multiple reservation histories`,
        );
      }
      reservationsByQueueEntry.set(reservation.queueEntryId, reservation);
      const entry = own(queueEntries, reservation.queueEntryId);
      const readyEntry = own(stationReadyEntries, reservation.queueEntryId);
      if ((entry ? 1 : 0) + (readyEntry ? 1 : 0) !== 1
        || (entry?.playerId ?? readyEntry?.playerId) !== key) {
        throw new ArcadeStateStoreError(
          'INVALID_STATE',
          `reservation ${reservation.id} does not match admission ${reservation.queueEntryId}`,
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

  for (const [key, station] of Object.entries(stations)) assertStationShape(station, key);
  for (const [key, round] of Object.entries(stationRounds)) {
    assertStationRoundShape(round, key);
    if (!own(stations, round.stationId)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `station round ${key} has no station`);
    }
  }
  for (const [key, entry] of Object.entries(stationReadyEntries)) {
    assertStationReadyShape(entry, key);
    if (!own(stations, entry.stationId) || !own(stationRounds, entry.roundId)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `station ready entry ${key} has invalid station or round`);
    }
    if (stationRounds[entry.roundId]?.stationId !== entry.stationId || !own(players, entry.playerId)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `station ready entry ${key} has invalid ownership`);
    }
    const reservation = entry.reservationId === null ? null : reservationsById.get(entry.reservationId);
    if (entry.reservationId !== null) {
      if (!reservation || reservation.queueEntryId !== key || reservation.playerId !== entry.playerId) {
        throw new ArcadeStateStoreError('INVALID_STATE', `station ready entry ${key} has invalid reservation`);
      }
      if (reservation.amount !== 1) {
        throw new ArcadeStateStoreError('INVALID_STATE', `station ready entry ${key} reservation must hold one coin`);
      }
      const expectedStatuses = entry.status === 'PLAYING'
        ? ['REDEEMED']
        : entry.status === 'COMPLETED' ? ['REDEEMED', 'REFUNDED']
        : entry.status === 'LEFT' ? ['RELEASED', 'REFUNDED'] : ['ACTIVE'];
      if (!expectedStatuses.includes(reservation.status)) {
        throw new ArcadeStateStoreError('INVALID_STATE', `station ready entry ${key} reservation has invalid status`);
      }
    }
    if (entry.status === 'ADMITTED' || entry.status === 'OVERFLOW') {
      const activeMatchId = stations[entry.stationId]?.activeMatchId;
      const activeMatch = activeMatchId ? own(stationMatches, activeMatchId) : undefined;
      const expectedEntries = entry.status === 'ADMITTED'
        ? activeMatch?.participantReadyEntryIds
        : activeMatch?.overflowReadyEntryIds;
      if (!expectedEntries?.includes(key)) {
        throw new ArcadeStateStoreError('INVALID_STATE', `station ready entry ${key} has no active match binding`);
      }
    }
    if (entry.status === 'PLAYING' || entry.status === 'COMPLETED') {
      const match = reservation?.matchId
        ? own(stationMatches, reservation.matchId)
        : Object.values(stationMatches).find(candidate => candidate.stationId === entry.stationId
          && candidate.participantReadyEntryIds.includes(key)
          && (entry.status === 'PLAYING' ? candidate.phase === 'PLAYING' : candidate.phase === 'COMPLETED'));
      if (!match || match.stationId !== entry.stationId || !match.participantReadyEntryIds.includes(key)) {
        throw new ArcadeStateStoreError('INVALID_STATE', `station ready entry ${key} has invalid match redemption`);
      }
    } else if (reservation?.matchId !== null && reservation?.matchId !== undefined
      && !(entry.status === 'LEFT' && reservation?.status === 'REFUNDED')) {
      throw new ArcadeStateStoreError('INVALID_STATE', `station ready entry ${key} has an unexpected match binding`);
    }
  }
  for (const [key, match] of Object.entries(stationMatches)) {
    assertStationMatchShape(match, key);
    if (!own(stations, match.stationId) || stationRounds[match.roundId]?.stationId !== match.stationId) {
      throw new ArcadeStateStoreError('INVALID_STATE', `station match ${key} has invalid station or round`);
    }
  }
  for (const station of Object.values(stations)) {
    try {
      assertStationInvariants({
        station,
        rounds: Object.fromEntries(Object.entries(stationRounds).filter(([, round]) => round.stationId === station.id)),
        readyEntries: Object.fromEntries(Object.entries(stationReadyEntries).filter(([, entry]) => entry.stationId === station.id)),
        matches: Object.fromEntries(Object.entries(stationMatches).filter(([, match]) => match.stationId === station.id)),
      });
    } catch (error) {
      throw new ArcadeStateStoreError(
        'INVALID_STATE',
        `station ${station.id} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }
  const channelIdentities = new Map<string, string>();
  const normalizedPlayers = new Map<string, string>();
  for (const [key, address] of Object.entries(channelAddresses)) {
    assertChannelAddressShape(address, key);
    if (!own(players, address.playerId) || !['sms', 'whatsapp'].includes(address.channel)
      || !/^\+[1-9][0-9]{7,14}$/.test(address.normalizedAddress)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `channel address ${key} has invalid identity`);
    }
    const identity = `${address.channel}\0${address.normalizedAddress}`;
    if (channelIdentities.has(identity)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `duplicate channel address ${identity}`);
    }
    channelIdentities.set(identity, address.playerId);
    const existingPlayer = normalizedPlayers.get(address.normalizedAddress);
    if (existingPlayer && existingPlayer !== address.playerId) {
      throw new ArcadeStateStoreError('INVALID_STATE', `channel address ${key} splits one phone identity`);
    }
    normalizedPlayers.set(address.normalizedAddress, address.playerId);
  }
  const registrationSteps = new Set([
    'FIRST_NAME', 'LAST_NAME', 'WORK_EMAIL', 'COMPANY', 'COUNTRY', 'TERMS', 'COMPLETE',
  ]);
  for (const [key, draft] of Object.entries(messagingDrafts)) {
    assertMessagingDraftShape(draft, key);
    if (!own(players, draft.playerId) || !registrationSteps.has(draft.step)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `messaging draft ${key} has invalid player or step`);
    }
  }
  const providerMessageIds = new Set<string>();
  for (const [key, message] of Object.entries(inboundMessages)) {
    assertInboundMessageShape(message, key);
    if (!/^[a-f0-9]{64}$/.test(message.requestFingerprint)
      || (message.channelAddressId !== null && !own(channelAddresses, message.channelAddressId))) {
      throw new ArcadeStateStoreError('INVALID_STATE', `inbound message ${key} has invalid binding`);
    }
    const expectedKey = `provider:${createHash('sha256').update(message.providerMessageId).digest('hex')}`;
    const idempotency = own(records, key);
    if (key !== expectedKey || idempotency?.operation !== 'PROCESS_STATION_MESSAGE'
      || idempotency.fingerprint !== message.requestFingerprint) {
      throw new ArcadeStateStoreError('INVALID_STATE', `inbound message ${key} has invalid idempotency linkage`);
    }
    if (providerMessageIds.has(message.providerMessageId)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `duplicate provider message ${message.providerMessageId}`);
    }
    providerMessageIds.add(message.providerMessageId);
  }

  for (const [key, binding] of Object.entries(stationReadyChannels)) {
    assertStationReadyChannelShape(binding, key);
    const entry = own(stationReadyEntries, key);
    const address = own(channelAddresses, binding.channelAddressId);
    if (!entry || !address || entry.playerId !== address.playerId) {
      throw new ArcadeStateStoreError('INVALID_STATE', `station ready channel ${key} has invalid ownership`);
    }
    if (Date.parse(binding.consentedAt) < Date.parse(address.firstSeenAt)
      || Date.parse(binding.consentedAt) > Date.parse(address.lastSeenAt)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `station ready channel ${key} has invalid consent chronology`);
    }
  }

  const outboundProviderMessageIds = new Set<string>();
  for (const [key, notification] of Object.entries(outboundNotifications)) {
    assertOutboundNotificationShape(notification, key);
    const player = own(players, notification.playerId);
    const station = own(stations, notification.stationId);
    const round = own(stationRounds, notification.roundId);
    const match = own(stationMatches, notification.matchId);
    const entry = own(stationReadyEntries, notification.readyEntryId);
    const address = own(channelAddresses, notification.channelAddressId);
    if (!player || !station || round?.stationId !== station.id || match?.stationId !== station.id
      || match.roundId !== round.id || !entry || entry.playerId !== player.id
      || entry.stationId !== station.id || !address || address.playerId !== player.id
      || address.channel !== notification.channel || address.providerAddress !== notification.to) {
      throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} has invalid ownership`);
    }
    if (notification.channel === 'sms' && !/^\+[1-9][0-9]{7,14}$/.test(notification.to)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} has invalid SMS destination`);
    }
    if (notification.channel === 'whatsapp'
      && !/^whatsapp:\+[1-9][0-9]{7,14}$/i.test(notification.to)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `outbound notification ${key} has invalid WhatsApp destination`);
    }
    for (const attempt of notification.attempts) {
      if (attempt.providerMessageId === null) continue;
      if (outboundProviderMessageIds.has(attempt.providerMessageId)) {
        throw new ArcadeStateStoreError(
          'INVALID_STATE',
          `duplicate outbound provider message ${attempt.providerMessageId}`,
        );
      }
      outboundProviderMessageIds.add(attempt.providerMessageId);
    }
  }
  const messagingAuditIdempotencyKeys = new Set<string>();
  for (const [key, event] of Object.entries(messagingAuditEvents)) {
    assertMessagingAuditEventShape(event, key);
    if (messagingAuditIdempotencyKeys.has(event.idempotencyKey)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `duplicate messaging audit idempotency key ${event.idempotencyKey}`);
    }
    messagingAuditIdempotencyKeys.add(event.idempotencyKey);
  }
  const controlEventIds = new Set<string>();
  for (const [index, event] of root.stationControlEvents.entries()) {
    const controlEvent = event as ArcadeStationControlEvent;
    assertStationControlEventShape(controlEvent, index);
    if (!own(stations, controlEvent.stationId)
      || !['operator', 'system'].includes(controlEvent.actorKind)
      || controlEvent.toRevision <= controlEvent.fromRevision
      || controlEventIds.has(controlEvent.id)) {
      throw new ArcadeStateStoreError('INVALID_STATE', `station control event ${index} is invalid`);
    }
    controlEventIds.add(controlEvent.id);
  }
}

function migrateArcadeState(state: unknown): unknown {
  let current = state;
  if (isRecord(current) && current.schemaVersion === 1) {
    const legacy = requireExactRecord(current, [
      'schemaVersion', 'players', 'wallets', 'queueEntries', 'queueEntryConfigs',
      'queueEvents', 'idempotencyRecords',
    ], '$');
    current = {
      ...legacy,
      schemaVersion: 2,
      stations: {},
      stationRounds: {},
      stationReadyEntries: {},
      stationMatches: {},
    };
  }
  if (isRecord(current) && current.schemaVersion === 2) {
    const stationState = requireExactRecord(current, [
      'schemaVersion', 'players', 'wallets', 'queueEntries', 'queueEntryConfigs',
      'queueEvents', 'idempotencyRecords', 'stations', 'stationRounds',
      'stationReadyEntries', 'stationMatches',
    ], '$');
    current = {
      ...stationState,
      schemaVersion: 3,
      channelAddresses: {},
      messagingDrafts: {},
      inboundMessages: {},
    };
  }
  if (isRecord(current) && current.schemaVersion === 4
    && !Object.prototype.hasOwnProperty.call(current, 'stationControlEvents')) {
    const earlyV4 = requireExactRecord(current, [
      'schemaVersion', 'players', 'wallets', 'queueEntries', 'queueEntryConfigs',
      'queueEvents', 'idempotencyRecords', 'stations', 'stationRounds', 'stationReadyEntries',
      'stationMatches', 'channelAddresses', 'messagingDrafts', 'inboundMessages',
      'stationReadyChannels', 'outboundNotifications',
    ], '$');
    current = { ...earlyV4, stationControlEvents: [] };
  }
  if (isRecord(current) && current.schemaVersion === 4) {
    const outboxState = requireExactRecord(current, [
      'schemaVersion', 'players', 'wallets', 'queueEntries', 'queueEntryConfigs',
      'queueEvents', 'idempotencyRecords', 'stations', 'stationRounds', 'stationReadyEntries',
      'stationMatches', 'channelAddresses', 'messagingDrafts', 'inboundMessages',
      'stationReadyChannels', 'outboundNotifications', 'stationControlEvents',
    ], '$');
    current = {
      ...outboxState,
      schemaVersion: 5,
      messagingAuditEvents: {},
    };
  }
  if (isRecord(current) && current.schemaVersion === 3) {
    const messagingState = requireExactRecord(current, [
      'schemaVersion', 'players', 'wallets', 'queueEntries', 'queueEntryConfigs',
      'queueEvents', 'idempotencyRecords', 'stations', 'stationRounds',
      'stationReadyEntries', 'stationMatches', 'channelAddresses', 'messagingDrafts',
      'inboundMessages',
    ], '$');
    current = {
      ...messagingState,
      schemaVersion: 5,
      stationReadyChannels: {},
      outboundNotifications: {},
      messagingAuditEvents: {},
      stationControlEvents: [],
    };
  }
  if (!isRecord(current) || current.schemaVersion !== 5) return current;
  const schemaFive = requireExactRecord(current, [
    'schemaVersion', 'players', 'wallets', 'queueEntries', 'queueEntryConfigs',
    'queueEvents', 'idempotencyRecords', 'stations', 'stationRounds', 'stationReadyEntries',
    'stationMatches', 'channelAddresses', 'messagingDrafts', 'inboundMessages',
    'stationReadyChannels', 'outboundNotifications', 'messagingAuditEvents', 'stationControlEvents',
  ], '$');
  const stationMatches = Object.fromEntries(Object.entries(requireRecord(schemaFive.stationMatches, 'stationMatches'))
    .map(([id, match]) => {
      const value = match as Record<string, unknown>;
      const participantIds = Array.isArray(value.participantReadyEntryIds)
        ? value.participantReadyEntryIds.filter((participantId): participantId is string => typeof participantId === 'string')
        : [];
      const bindings = ['PLAYING', 'COMPLETED'].includes(String(value.phase))
        ? Object.fromEntries(participantIds.map(readyEntryId => [
          readyEntryId,
          `legacy:${createHash('sha256').update(readyEntryId).digest('hex').slice(0, 32)}`,
        ]))
        : {};
      return [id, {
        ...value,
        enginePlayerIdsByReadyEntryId: bindings,
        result: value.phase === 'COMPLETED'
          ? { source: 'LEGACY_UNAVAILABLE', participants: [] }
          : null,
      }];
    }));
  return { ...schemaFive, schemaVersion: ARCADE_STATE_SCHEMA_VERSION, stationMatches };
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
      const migrated = migrateArcadeState(next);
      assertArcadeState(migrated);
      this.state = cloneJson(migrated);
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

  runExclusive<Result>(operation: (snapshot: ArcadeState) => Result | Promise<Result>): Promise<Result> {
    const task = this.transactionQueue.catch(() => undefined).then(async () => {
      this.requireInitialized();
      return operation(this.snapshot());
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
