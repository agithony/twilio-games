import { createHash } from 'node:crypto';
import {
  parseArcadeConfig,
  type ArcadeConfigSnapshot,
  type ArcadeGame,
} from '../shared/arcade-config';
import {
  availableBalance,
  claimChallengeReward,
  createPlayer,
  createWallet,
  deriveLedger,
  grantRegistrationCoins,
  grantOperatorCoins,
  redeemReservation,
  refundReservation,
  releaseReservation,
  reserveCoins,
  type LeadInput,
  type WalletReservation,
  type WalletState,
} from '../shared/arcade-domain';
import {
  expireCalledEntry,
  isTerminalQueueStatus,
  joinQueue as reduceJoinQueue,
  reduceQueueEntry,
  selectWaitingEntries,
  snoozeQueueEntry as reduceSnoozeQueueEntry,
  type QueueAction,
  type QueueEntry,
  type QueueReduction,
  type QueueStatus,
} from '../shared/arcade-queue';
import { isPlayableArcadeGame, type PlayableArcadeGame } from '../shared/arcade-games';
import {
  advanceStationResults as reduceAdvanceStationResults,
  closeStationRecruiting as reduceCloseStationRecruiting,
  completeStationMatch as reduceCompleteStationMatch,
  createArcadeStation,
  dropStationAdmittedEntry as reduceDropStationAdmittedEntry,
  failStationLaunch as reduceFailStationLaunch,
  insertStationCoin as reduceInsertStationCoin,
  leaveStationReadyEntry as reduceLeaveStationReadyEntry,
  markStationDisplayReady as reduceMarkStationDisplayReady,
  markStationMatchStarted as reduceMarkStationMatchStarted,
  recordStationGameChoice as reduceRecordStationGameChoice,
  requestStationLaunch as reduceRequestStationLaunch,
  resetArcadeStation as reduceResetArcadeStation,
  selectStationGame as reduceSelectStationGame,
  type ArcadeStation,
  type ArcadeStationAggregate,
  type RecruitingRound,
  type StationMatch,
  type StationEngineParticipantResult,
  type StationReadyEntry,
  type StationTimingPolicy,
} from '../shared/arcade-station';
import {
  ARCADE_STATE_MAX_FILE_BYTES,
  ARCADE_STATE_MAX_PLAYERS,
  ArcadeStateStore,
  type ArcadePlayerRecord,
  type ArcadeQueueEntryConfigSnapshot,
  type ArcadeMessagingChannel,
  type ArcadeMessagingDraftRecord,
  type ArcadeOutboundNotificationRecord,
  type ArcadeServiceIdempotencyRecord,
  type ArcadeState,
  type ArcadeStationNotificationKind,
} from './arcade-state-store';
import {
  ARCADE_CHALLENGE_TOKEN_MAX_BYTES,
  ARCADE_CHALLENGE_TOKEN_MAX_TTL_SECONDS,
  ARCADE_CHALLENGE_TOKEN_VERSION,
  authenticateArcadeChallengeToken,
  signArcadeChallengeToken,
  verifyArcadeChallengeToken,
  type ArcadeChallengeTokenPayload,
  type ArcadeChallengeTokenSecret,
} from './arcade-challenge-token';

export type ArcadeClockValue = Date | string | number;
export type ArcadeClock = () => ArcadeClockValue;
export type ArcadeIdGenerator = (kind: string) => string;

export interface ArcadeServiceOptions {
  readonly store: ArcadeStateStore;
  /** A function is preferred when configuration can change while the process is running. */
  readonly config: ArcadeConfigSnapshot | (() => ArcadeConfigSnapshot);
  readonly clock: ArcadeClock;
  readonly idGenerator: ArcadeIdGenerator;
  readonly challengeTokenSecret: ArcadeChallengeTokenSecret;
  readonly publicBaseUrl?: string;
  readonly operatorAuthorizer?: ArcadeOperatorAuthorizer;
  readonly stationUpdated?: (revision: number) => void;
  readonly stationNotifications?: ArcadeStationNotificationOptions;
  readonly newMutationsAllowed?: () => boolean;
  readonly messagingProtection?: ArcadeMessagingProtectionOptions;
}

export interface ArcadeMessagingProtectionOptions {
  readonly identityCapacity?: number;
  readonly retentionMs?: number;
  readonly pruneBatchSize?: number;
  readonly stateAdmissionMaxBytes?: number;
}

export interface ArcadeStationNotificationOptions {
  readonly enabled: (channel?: ArcadeMessagingChannel) => boolean;
  readonly callNumber?: (locale: 'en-US' | 'pt-BR') => string | null | undefined;
  readonly whatsappContentSid?: (
    kind: ArcadeStationNotificationKind,
    locale: 'en-US' | 'pt-BR',
  ) => string | null | undefined;
}

export interface TrustedArcadeOperatorPrincipal {
  readonly kind: 'operator' | 'system';
  readonly subject: string;
}

export type ArcadeOperatorAuthorizer = (authorization: unknown) => TrustedArcadeOperatorPrincipal | null;

export interface TrustedArcadeIdentity {
  readonly playerId: string;
  readonly destination?: string | null;
}

export interface IdentifyCoinOnlyInput extends TrustedArcadeIdentity {
  readonly idempotencyKey: string;
  readonly preferredLocale?: string | null;
}

export interface RegisterArcadePlayerInput extends TrustedArcadeIdentity {
  readonly idempotencyKey: string;
  readonly lead: LeadInput;
  readonly termsAccepted: boolean;
  readonly marketingConsent?: boolean;
  readonly preferredLocale?: string | null;
  readonly conversationProfileId?: string | null;
  readonly crmLeadId?: string | null;
}

export interface PlayerWalletResult {
  readonly player: ArcadePlayerRecord;
  readonly availableBalance: number;
}

export interface ArcadePlayerStatus {
  readonly registered: boolean;
  readonly firstName: string | null;
  readonly preferredLocale: string | null;
}

export interface ArcadeWalletStatus {
  readonly ledgerBalance: number;
  readonly reservedBalance: number;
  readonly availableBalance: number;
  readonly updatedAt: string;
}

export interface ArcadeQueueStatus {
  readonly queueEntryId: string;
  readonly status: QueueStatus;
  readonly preferredGame: string;
  readonly flexibleGame: boolean;
  readonly position: number | null;
  readonly joinedAt: string;
  readonly approachingConfirmedAt: string | null;
  readonly calledAt: string | null;
  readonly checkInExpiresAt: string | null;
  readonly deferredUntil: string | null;
  readonly checkedInAt: string | null;
  readonly reservation: Readonly<{ amount: number; status: WalletReservation['status'] }> | null;
}

export interface ArcadeChallengeStatus {
  readonly id: string;
  readonly title: string;
  readonly message: string | null;
  readonly rewardCoins: number;
  readonly displayOrder: number;
  readonly claimCount: number;
  readonly maxClaimsPerPlayer: number;
  readonly available: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

export interface ArcadeOperatorQueueStatus extends ArcadeQueueStatus {
  readonly playerId: string;
  readonly firstName: string | null;
  readonly assignedGame: string | null;
  readonly matchId: string | null;
}

export interface ClaimArcadeChallengeInput {
  readonly playerId: string;
  readonly challengeId: string;
  readonly idempotencyKey: string;
  readonly token: string;
  readonly requestMetadata?: Readonly<Record<string, unknown>>;
}

export interface ChallengeClaimResult {
  readonly challengeId: string;
  readonly claimId: string;
  readonly rewardCoins: number;
  readonly destinationUrl: string;
  readonly availableBalance: number;
}

export interface JoinArcadeQueueInput {
  readonly playerId: string;
  readonly preferredGame: ArcadeGame;
  readonly flexibleGame?: boolean;
  readonly idempotencyKey: string;
}

export interface QueueEntryActionInput {
  readonly playerId: string;
  readonly queueEntryId: string;
  readonly idempotencyKey: string;
  readonly reason?: string;
}

export interface CheckInArcadeQueueInput extends QueueEntryActionInput {
  readonly game: ArcadeGame;
}

export interface RefundArcadeQueueEntryInput extends Omit<QueueEntryActionInput, 'reason'> {
  readonly reason: string;
  readonly authorization: unknown;
}

export interface OperatorQueueEntryActionInput extends Omit<QueueEntryActionInput, 'reason'> {
  readonly reason: string;
  readonly authorization: unknown;
}

export interface QueueEntryResult {
  readonly entry: QueueEntry;
  readonly availableBalance: number;
  readonly reservation: WalletReservation | null;
}

export interface StartArcadeMatchInput {
  readonly queueEntryIds: readonly string[];
  readonly game: ArcadeGame;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly authorization: unknown;
}

export interface StartArcadeMatchResult {
  readonly matchId: string;
  readonly entries: readonly QueueEntry[];
}

export interface CompleteArcadeMatchInput {
  readonly queueEntryIds: readonly string[];
  readonly matchId: string;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly authorization: unknown;
}

export interface InsertStationCoinInput {
  readonly stationId: string;
  readonly playerId: string;
  readonly idempotencyKey: string;
}

export interface StationRevisionInput {
  readonly stationId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface StationControlInput extends StationRevisionInput {
  readonly authorization: unknown;
  readonly reason?: string;
  readonly occurredAt?: string;
}

export interface LeaveStationReadyEntryInput extends StationRevisionInput {
  readonly playerId: string;
  readonly readyEntryId: string;
}

export interface RecordStationGameChoiceInput {
  readonly stationId: string;
  readonly playerId: string;
  readonly game: PlayableArcadeGame;
  readonly idempotencyKey: string;
}

export interface GrantStationPlayerCoinsInput {
  readonly stationId: string;
  readonly readyEntryId: string;
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly authorization: unknown;
  readonly reason: string;
}

export interface RestorePlayerStartingBalanceInput {
  readonly playerId: string;
  readonly expectedConfigVersion: number;
  readonly idempotencyKey: string;
  readonly authorization: unknown;
  readonly reason: string;
}

export interface OperatorPlayerRecoveryItem {
  readonly playerId: string;
  readonly displayName: string;
  readonly identities: readonly Readonly<{ channel: ArcadeMessagingChannel | 'browser'; maskedAddress: string }>[];
  readonly availableBalance: number;
  readonly lastActivityAt: string;
  readonly lastReadyStatus: StationReadyEntry['status'] | null;
}

export interface OperatorPlayerRecoveryPage {
  readonly configVersion: number;
  readonly startingBalance: number;
  readonly players: readonly OperatorPlayerRecoveryItem[];
  readonly nextCursor: string | null;
}

export interface DropStationAdmittedEntryInput extends StationRevisionInput {
  readonly readyEntryId: string;
  readonly authorization: unknown;
  readonly reason: string;
}

export interface ResetTestPlayerInput extends StationRevisionInput {
  readonly readyEntryId: string;
  readonly authorization: unknown;
  readonly reason: string;
  readonly deleteMemoryProfile?: (profileId: string) => Promise<void>;
}

export interface SelectStationGameInput extends StationControlInput {
  readonly game: PlayableArcadeGame;
  readonly engineRoomCode: string;
}

export interface StationDisplayReadyInput extends StationControlInput {
  readonly matchId: string;
  readonly launchGeneration: number;
}

export interface StartStationMatchInput extends StationControlInput {
  readonly enginePlayerIdsByReadyEntryId?: Readonly<Record<string, string>>;
}

export interface CompleteStationMatchInput extends StationControlInput {
  readonly engineResults?: readonly StationEngineParticipantResult[];
  readonly resultSource?: 'ENGINE' | 'RECOVERY' | 'LEGACY_UNAVAILABLE';
}

export interface StationMutationResult {
  readonly station: ArcadeStation;
  readonly round: RecruitingRound | null;
  readonly match: StationMatch | null;
}

export interface StationReadyResult extends StationMutationResult {
  readonly readyEntry: StationReadyEntry;
  readonly reservation: WalletReservation | null;
  readonly availableBalance: number;
}

export interface StationGameChoiceResult {
  readonly gameChoice: PlayableArcadeGame;
}

export interface ProcessInboundStationMessageInput {
  readonly channel: ArcadeMessagingChannel;
  readonly normalizedAddress: string;
  readonly providerAddress: string;
  readonly providerMessageId: string;
  readonly body: string;
  readonly stationId: string;
  readonly preferredLocale: string;
  readonly idempotencyKey: string;
  readonly conversationProfileId?: string | null;
  readonly conversationId?: string | null;
}

export interface ProcessInboundStationMessageResult {
  readonly reply: string;
  readonly playerId: string | null;
  readonly command: string;
  readonly locale: string;
  readonly stationRevision: number | null;
}

export interface ArcadeMessagingStorageStatus {
  readonly players: number;
  readonly messagingIdentities: number;
  readonly identityCapacity: number;
  readonly remainingIdentityCapacity: number;
  readonly channelAddresses: number;
  readonly drafts: number;
  readonly cleanupEligible: number;
  readonly retentionDays: number;
  readonly pruneBatchSize: number;
}

export class ArcadeServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArcadeServiceError';
  }
}

const LEAD_KEYS = [
  'firstName', 'lastName', 'workEmail', 'companyName', 'phoneNumber', 'countryCode',
] as const;
const GAMES = new Set<ArcadeGame>(['racer', 'monsters', 'fighter', 'trivia']);
const FORBIDDEN_RECORD_KEYS = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  '__proto__',
  'prototype',
  'constructor',
]);
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_REASON_LENGTH = 500;
const MAX_OPERATOR_REASON_LENGTH = 200;
const MAX_AUDIT_REASON_LENGTH = 512;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_JSON_DEPTH = 10;
const MAX_CANONICAL_JSON_DEPTH = 24;
const MAX_MATCH_ENTRIES = 64;
const STATION_COIN_COST = 1;
const STATION_MAX_PENDING_PLAYERS = 64;
export const ARCADE_MESSAGING_IDENTITY_CAPACITY = 90_000;
export const ARCADE_MESSAGING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ARCADE_MESSAGING_PRUNE_BATCH_SIZE = 100;
export const ARCADE_MESSAGING_STATE_ADMISSION_MAX_BYTES = ARCADE_STATE_MAX_FILE_BYTES - (1024 * 1024);
const ARCADE_MESSAGING_MAX_INBOUND_RECEIPTS = 5_000;
const ARCADE_MESSAGING_CAPACITY_MAX_INBOUND_RECEIPTS = 100;
const ARCADE_MESSAGING_CAPACITY_RESPONSE_HEADROOM = 64 * 1024;
const ARCADE_MUTATION_MAX_STATE_BYTES = ARCADE_STATE_MAX_FILE_BYTES - (8 * 1024 * 1024);
const ARCADE_MUTATION_MAX_GLOBAL_IDEMPOTENCY = 200_000;
const ARCADE_MUTATION_MAX_STATION_HISTORY = 80_000;
const ARCADE_MUTATION_MAX_QUEUE_HISTORY = 400_000;
const ARCADE_MUTATION_MAX_PLAYER_SERVICE_HISTORY = 5_000;
const ARCADE_MUTATION_MAX_PLAYER_WALLET_HISTORY = 10_000;
const DEGRADED_CLEANUP_OPERATIONS = new Set([
  'COMPLETE_MATCH',
  'RELEASE_QUEUE_ENTRY',
  'LEAVE_QUEUE',
  'REFUND_QUEUE_ENTRY',
  'EXPIRE_QUEUE_ENTRY',
  'LEAVE_STATION_READY_ENTRY',
  'COMPLETE_STATION_MATCH',
  'ADVANCE_STATION_RESULTS',
  'FAIL_STATION_LAUNCH',
  'RECOVER_STATION_RESTART',
  'RESET_STATION',
  'RESET_TEST_PLAYER',
]);

interface ArcadeMutationStorageLimits {
  readonly stateBytes: number;
  readonly globalIdempotency: number;
  readonly stationHistory: number;
  readonly queueHistory: number;
  readonly playerServiceHistory: number;
  readonly playerWalletHistory: number;
}

const DEFAULT_MUTATION_STORAGE_LIMITS: ArcadeMutationStorageLimits = {
  stateBytes: ARCADE_MUTATION_MAX_STATE_BYTES,
  globalIdempotency: ARCADE_MUTATION_MAX_GLOBAL_IDEMPOTENCY,
  stationHistory: ARCADE_MUTATION_MAX_STATION_HISTORY,
  queueHistory: ARCADE_MUTATION_MAX_QUEUE_HISTORY,
  playerServiceHistory: ARCADE_MUTATION_MAX_PLAYER_SERVICE_HISTORY,
  playerWalletHistory: ARCADE_MUTATION_MAX_PLAYER_WALLET_HISTORY,
};

export function assertArcadeMutationCapacity(
  state: ArcadeState,
  playerId: string | null,
  limits: ArcadeMutationStorageLimits = DEFAULT_MUTATION_STORAGE_LIMITS,
): void {
  const stateBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  const stationHistory = Object.keys(state.stationRounds).length
    + Object.keys(state.stationReadyEntries).length
    + Object.keys(state.stationMatches).length;
  const queueHistory = Object.keys(state.queueEntries).length + state.queueEvents.length;
  const playerServiceHistory = playerId === null ? 0 : Object.values(state.idempotencyRecords)
    .filter(record => record.playerId === playerId).length;
  const wallet = playerId === null ? undefined : state.wallets[playerId];
  const playerWalletHistory = wallet
    ? wallet.transactions.length + wallet.reservations.length + wallet.idempotencyRecords.length
    : 0;
  const exhausted = stateBytes >= limits.stateBytes
    || Object.keys(state.idempotencyRecords).length >= limits.globalIdempotency
    || stationHistory >= limits.stationHistory
    || queueHistory >= limits.queueHistory
    || playerServiceHistory >= limits.playerServiceHistory
    || playerWalletHistory >= limits.playerWalletHistory;
  if (exhausted) {
    throw new ArcadeServiceError(
      'STATE_CAPACITY_EXHAUSTED',
      'Twilio Games history reached its safe operating quota; cleanup and recovery remain available, but new activity requires archival or a fresh station state file',
    );
  }
}

function requireIdentifier(value: unknown, field: string, maximum = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new ArcadeServiceError('INVALID_INPUT', `${field} must be a non-empty bounded string`);
  }
  if (FORBIDDEN_RECORD_KEYS.has(value)) {
    throw new ArcadeServiceError('INVALID_INPUT', `${field} is not a safe record key`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ArcadeServiceError('INVALID_INPUT', `${field} must be a positive integer`);
  }
  return value as number;
}

function stationOccurredAt(value: string | undefined, now: string): string {
  if (value === undefined) return now;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis > Date.parse(now)) {
    throw new ArcadeServiceError('INVALID_INPUT', 'station occurredAt must be a valid non-future timestamp');
  }
  return new Date(millis).toISOString();
}

function own<Value>(record: Record<string, Value>, key: string): Value | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function resetPhoneNumber(state: ArcadeState, tombstoneId: string): string {
  for (let salt = 0; salt < 100; salt++) {
    const digest = createHash('sha256').update(`${tombstoneId}:${salt}`).digest('hex');
    const suffix = BigInt(`0x${digest.slice(0, 16)}`).toString().padStart(12, '0').slice(-12);
    const candidate = `+999${suffix}`;
    if (!Object.values(state.channelAddresses).some(address => address.normalizedAddress === candidate)) {
      return candidate;
    }
  }
  throw new ArcadeServiceError('TEST_PLAYER_RESET_FAILED', 'could not allocate an anonymous history identity');
}

function scrubResetValue(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    let scrubbed = value;
    const ordered = [...replacements].sort((left, right) => right[0].length - left[0].length);
    for (const [sensitive, replacement] of ordered) {
      if (sensitive.length >= 3) scrubbed = scrubbed.replaceAll(sensitive, replacement);
      else scrubbed = scrubbed.replace(new RegExp(`\\b${sensitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), replacement);
    }
    return scrubbed;
  }
  if (Array.isArray(value)) return value.map(item => scrubResetValue(item, replacements));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubResetValue(item, replacements)]));
}

function containsResetPlayer(value: unknown, playerId: string): boolean {
  if (value === playerId) return true;
  if (Array.isArray(value)) return value.some(item => containsResetPlayer(item, playerId));
  return Boolean(value && typeof value === 'object'
    && Object.values(value).some(item => containsResetPlayer(item, playerId)));
}

function retiredPlayerHash(playerId: string): string {
  return createHash('sha256').update(`retired-player:${playerId}`).digest('hex');
}

function isRetiredPlayer(state: ArcadeState, playerId: string): boolean {
  const hash = retiredPlayerHash(playerId);
  return Object.values(state.idempotencyRecords).some(record => (
    record.operation === 'RESET_TEST_PLAYER'
    && (record.result as { retiredPlayerHash?: unknown } | null)?.retiredPlayerHash === hash
  ));
}

function isRetiredProfile(state: ArcadeState, profileId: string): boolean {
  const hash = createHash('sha256').update(`retired-profile:${profileId}`).digest('hex');
  return Object.values(state.idempotencyRecords).some(record => (
    record.operation === 'RESET_TEST_PLAYER'
    && (record.result as { retiredProfileHash?: unknown } | null)?.retiredProfileHash === hash
  ));
}

function requireReason(value: unknown): string {
  return requireIdentifier(value, 'reason', MAX_REASON_LENGTH).trim();
}

function operatorAuditReason(principal: TrustedArcadeOperatorPrincipal, value: unknown): string {
  const reason = requireIdentifier(value, 'operator reason', MAX_OPERATOR_REASON_LENGTH).trim();
  const encoded = JSON.stringify({ operator: principal.subject, reason });
  if (encoded.length > MAX_AUDIT_REASON_LENGTH) {
    throw new ArcadeServiceError('INVALID_INPUT', 'operator audit reason exceeds the persisted limit');
  }
  return encoded;
}

function copyChallengeTokenSecret(secret: ArcadeChallengeTokenSecret | undefined): Buffer {
  if (secret === undefined) {
    throw new ArcadeServiceError('INVALID_DEPENDENCY', 'challenge token secret is required');
  }
  const copied = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (copied.byteLength < 32) {
    throw new ArcadeServiceError('INVALID_DEPENDENCY', 'challenge token secret must be at least 32 bytes');
  }
  return copied;
}

function normalizeDestination(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return requireIdentifier(value, 'trusted destination').trim();
}

function stableJson(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
  maximumDepth = MAX_CANONICAL_JSON_DEPTH,
): string {
  budget.nodes += 1;
  if (depth > maximumDepth || budget.nodes > 100_000) {
    throw new ArcadeServiceError('INPUT_TOO_LARGE', 'request exceeds JSON depth or node limits');
  }
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new ArcadeServiceError('INVALID_INPUT', 'request contains a non-JSON value');
    return encoded;
  }
  if (seen.has(value)) throw new ArcadeServiceError('INVALID_INPUT', 'request contains a cyclic value');
  seen.add(value);
  let encoded: string;
  if (Array.isArray(value)) {
    encoded = `[${value.map(item => stableJson(item, seen, depth + 1, budget, maximumDepth)).join(',')}]`;
  } else {
    const object = value as Record<string, unknown>;
    const properties = Object.keys(object).sort().map(key => {
      if (FORBIDDEN_RECORD_KEYS.has(key)) {
        throw new ArcadeServiceError('INVALID_INPUT', `request contains unsafe key ${key}`);
      }
      return `${JSON.stringify(key)}:${stableJson(object[key], seen, depth + 1, budget, maximumDepth)}`;
    });
    encoded = `{${properties.join(',')}}`;
  }
  seen.delete(value);
  return encoded;
}

function copyMetadata(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new ArcadeServiceError('INVALID_INPUT', 'request metadata must be an object');
  }
  const copied = copyJson(value ?? {});
  const serialized = stableJson(copied, new Set(), 0, { nodes: 0 }, MAX_JSON_DEPTH);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
    throw new ArcadeServiceError('INPUT_TOO_LARGE', `request metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  return copied;
}

function copyJson<T>(value: T): T {
  return JSON.parse(stableJson(value)) as T;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function exactLead(input: LeadInput): LeadInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ArcadeServiceError('INVALID_REGISTRATION', 'lead must be an object with exactly six fields');
  }
  const keys = Object.keys(input).sort();
  const expected = [...LEAD_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ArcadeServiceError('INVALID_REGISTRATION', 'lead must contain exactly the approved six fields');
  }
  return input;
}

function findReservation(wallet: WalletState, queueEntryId: string): WalletReservation | null {
  return wallet.reservations.find(reservation => reservation.queueEntryId === queueEntryId) ?? null;
}

function queueResult(state: ArcadeState, entry: QueueEntry): QueueEntryResult {
  const wallet = own(state.wallets, entry.playerId);
  if (!wallet) throw new ArcadeServiceError('WALLET_NOT_FOUND', `wallet for ${entry.playerId} was not found`);
  return {
    entry,
    availableBalance: availableBalance(wallet),
    reservation: findReservation(wallet, entry.id),
  };
}

function stationResult(aggregate: ArcadeStationAggregate): StationMutationResult {
  return {
    station: aggregate.station,
    round: aggregate.station.activeRoundId
      ? aggregate.rounds[aggregate.station.activeRoundId] ?? null
      : null,
    match: aggregate.station.activeMatchId
      ? aggregate.matches[aggregate.station.activeMatchId] ?? null
      : null,
  };
}

type MessagingCopyKey = 'wrongStation' | 'joinFirst' | 'joined' | 'help' | 'status'
  | 'finishRegistration' | 'notReady' | 'registered' | 'cannotLeave' | 'left'
  | 'alreadyReady' | 'noCoins' | 'poolFull' | 'coinUnavailable' | 'coin'
  | 'joinedFree' | 'helpFree' | 'statusFree' | 'finishRegistrationFree'
  | 'registeredFree' | 'leftFree' | 'poolFullFree' | 'readyFree' | 'continueInBrowser'
  | 'coinScreen' | 'readyFreeScreen' | 'notReadyFree' | 'capacity' | 'gameChoice' | 'gameChoiceInvalid'
  | 'gameChoiceUnavailable' | 'gameChoiceClosed' | 'alreadyReadyVote' | 'moreNone' | 'morePage'
  | 'named' | 'namedFree';

const MESSAGING_COPY: Record<'en-US' | 'pt-BR', Record<MessagingCopyKey, string>> = {
  'en-US': {
    wrongStation: 'That station code is stale. Scan the QR again or reply JOIN.',
    joinFirst: 'Reply JOIN to start',
    joined: 'You are in Twilio Games with {balance} coins.\n\nReply COIN when you are ready at the screen.\nHELP lists commands.',
    help: 'Commands:\nCOIN or 🪙 to get ready\nMORE for coin challenge links\nSTATUS for your place and balance\nLEAVE to exit\nHELP for this list\n\nDuring game selection, reply with a game name or number.',
    status: 'Balance: {balance} coins.\nStation status: {status}.\n\n{next}',
    finishRegistration: 'Finish the quick intro first, then reply COIN.',
    notReady: 'You are not currently in the ready pool. Reply COIN when you are ready at the screen.',
    registered: 'Registration complete!\n\nYou have {balance} coins.\n\nReply COIN when you are at the screen.',
    cannotLeave: 'Your match is locked or playing. Ask the booth operator for help.',
    left: 'You left the ready pool.\nYour held coin is available again.\nReply COIN when you are ready to join again.',
    alreadyReady: 'You are already ready.\nWatch for game selection, then reply with the game name or number.\nReply STATUS for your place.',
    noCoins: 'You do not have an available coin. Reply MORE for coin challenge links or ask the booth operator.',
    poolFull: 'The ready pool is full right now. Try COIN again after the next game starts.',
    coinUnavailable: 'Coin insertion is not available under the current station policy.',
    coin: 'Coin inserted.\n\nYou are position {position}.\n\nBalance available: {balance}.\n\nWhen game voting opens, reply with: {choices}.\n\nStay near the screen; we will text assignment and call updates.',
    coinScreen: 'Coin inserted. You are position {position}. Balance available: {balance}.\nWhen game voting opens, reply with: {choices}.\nWatch the screen for assignment and call instructions, and keep this number handy.',
    joinedFree: 'You are in Twilio Games.\nReply READY when you are at the screen. HELP lists commands.',
    helpFree: 'Commands:\nREADY or 🪙 to join the ready pool\nSTATUS for your place\nLEAVE to exit\nHELP for this list\nDuring game selection, reply with a game name or number.',
    statusFree: 'Station status: {status}.\n{next}',
    finishRegistrationFree: 'Finish the quick intro first, then reply READY.',
    registeredFree: 'Registration complete.\nReply READY when you are at the screen.',
    leftFree: 'You left the ready pool.\nReply READY when you want to join again.',
    poolFullFree: 'The ready pool is full right now. Try READY again after the next game starts.',
    readyFree: 'You are ready in position {position}.\nWhen game voting opens, reply with: {choices}.\nStay near the screen; we will text assignment and call updates.',
    readyFreeScreen: 'You are ready in position {position}.\nWhen game voting opens, reply with: {choices}.\nWatch the screen for assignment and call instructions, and keep this number handy.',
    notReadyFree: 'You are not currently in the ready pool. Reply READY when you are at the screen.',
    continueInBrowser: 'This phone is already registered in a browser. Continue in that browser session to join the ready pool; a separate messaging player was not created.',
    capacity: 'Twilio Games messaging is temporarily at capacity. Please try again later.',
    gameChoice: 'Choice saved: {game}.\nValid choices: {choices}.\nReply with a game name or number to change it.',
    gameChoiceInvalid: 'That is not a valid game choice.\nReply with one of: {choices}.',
    gameChoiceUnavailable: 'Game selection opens after recruiting for players who are ready.\nWhen the screen asks you to choose, reply with one of: {choices}.',
    gameChoiceClosed: 'Game selection is closed.\nWatch the screen for the chosen game and your next instruction.',
    alreadyReadyVote: 'You are already ready. Vote now by replying with: {choices}.\nReply STATUS for your place.',
    moreNone: 'No coin challenges are available right now. Ask the booth operator for help.',
    morePage: 'More challenges are available. Reply MORE {page} for the next link.',
    named: 'Thanks, {name}. You have {balance} coins.\nReply COIN when you are ready at the screen.',
    namedFree: 'Thanks, {name}.\nReply READY when you are at the screen.',
  },
  'pt-BR': {
    wrongStation: 'Esse codigo de estacao expirou. Escaneie o QR novamente ou responda ENTRAR.',
    joinFirst: 'Responda ENTRAR para comecar',
    joined: 'Você entrou no Twilio Games com {balance} moedas.\n\nResponda MOEDA quando estiver na tela.\nAJUDA mostra os comandos.',
    help: 'Comandos:\nMOEDA ou 🪙 para ficar pronto\nMAIS para links de desafios\nSTATUS para posicao e saldo\nSAIR para sair\nAJUDA para esta lista\n\nDurante a selecao de jogo, responda com o nome ou numero do jogo.',
    status: 'Saldo: {balance} moedas.\nStatus na estacao: {status}.\n\n{next}',
    finishRegistration: 'Termine a apresentação rápida e depois responda MOEDA.',
    notReady: 'Voce nao esta na fila de jogadores prontos. Responda MOEDA quando estiver pronto na tela.',
    registered: 'Cadastro concluído.\n\nVocê tem {balance} moedas.\n\nResponda MOEDA quando estiver na tela.',
    cannotLeave: 'Sua partida está bloqueada ou em andamento. Fale com a equipe do estande.',
    left: 'Voce saiu da fila.\nSua moeda reservada esta disponivel novamente.\nResponda MOEDA quando quiser entrar de novo.',
    alreadyReady: 'Voce ja esta pronto.\nAguarde a selecao de jogo e responda com o nome ou numero do jogo.\nResponda STATUS para ver sua posicao.',
    noCoins: 'Você não tem uma moeda disponível. Responda MAIS para receber links de desafios ou fale com a equipe.',
    poolFull: 'A fila está cheia agora. Tente MOEDA novamente quando a próxima partida começar.',
    coinUnavailable: 'A inserção de moeda não está disponível na política atual da estação.',
    coin: 'Moeda inserida.\n\nVoce esta na posicao {position}.\n\nSaldo disponivel: {balance}.\n\nQuando a votacao abrir, responda com: {choices}.\n\nFique perto da tela; enviaremos atualizacoes de selecao e chamada.',
    coinScreen: 'Moeda inserida. Voce esta na posicao {position}. Saldo disponivel: {balance}.\nQuando a votacao abrir, responda com: {choices}.\nAcompanhe a tela para selecao e chamada e mantenha este numero por perto.',
    joinedFree: 'Você entrou no Twilio Games.\nResponda PRONTO quando estiver na tela. AJUDA mostra os comandos.',
    helpFree: 'Comandos:\nPRONTO ou 🪙 para entrar na fila\nSTATUS para ver sua posicao\nSAIR para sair\nAJUDA para esta lista\nDurante a selecao de jogo, responda com o nome ou numero do jogo.',
    statusFree: 'Status na estacao: {status}.\n{next}',
    finishRegistrationFree: 'Termine a apresentação rápida e depois responda PRONTO.',
    registeredFree: 'Cadastro concluído.\nResponda PRONTO quando estiver na tela.',
    leftFree: 'Voce saiu da fila de jogadores prontos.\nResponda PRONTO quando quiser entrar de novo.',
    poolFullFree: 'A fila está cheia agora. Tente PRONTO novamente quando a próxima partida começar.',
    readyFree: 'Voce esta pronto na posicao {position}.\nQuando a votacao abrir, responda com: {choices}.\nFique perto da tela; enviaremos atualizacoes de selecao e chamada.',
    readyFreeScreen: 'Voce esta pronto na posicao {position}.\nQuando a votacao abrir, responda com: {choices}.\nAcompanhe a tela para selecao e chamada e mantenha este numero por perto.',
    notReadyFree: 'Voce nao esta na fila de jogadores prontos. Responda PRONTO quando estiver na tela.',
    continueInBrowser: 'Este telefone já está cadastrado em um navegador. Continue nessa sessão do navegador para entrar na fila; nenhum jogador separado foi criado por mensagem.',
    capacity: 'As mensagens do Twilio Games estão temporariamente no limite. Tente novamente mais tarde.',
    gameChoice: 'Escolha salva: {game}.\nOpcoes validas: {choices}.\nResponda com o nome ou numero do jogo para mudar.',
    gameChoiceInvalid: 'Essa escolha de jogo nao e valida.\nResponda com uma destas opcoes: {choices}.',
    gameChoiceUnavailable: 'A escolha do jogo abre depois do recrutamento para quem esta pronto.\nQuando a tela pedir sua escolha, responda com uma destas opcoes: {choices}.',
    gameChoiceClosed: 'A escolha do jogo ja terminou.\nAcompanhe a tela para ver o jogo escolhido e a proxima instrucao.',
    alreadyReadyVote: 'Voce ja esta pronto. Vote agora respondendo com: {choices}.\nResponda STATUS para ver sua posicao.',
    moreNone: 'Nenhum desafio de moedas esta disponivel agora. Fale com a equipe do estande.',
    morePage: 'Ha mais desafios disponiveis. Responda MAIS {page} para receber o proximo link.',
    named: 'Obrigado, {name}. Voce tem {balance} moedas.\nResponda MOEDA quando estiver pronto na tela.',
    namedFree: 'Obrigado, {name}.\nResponda PRONTO quando estiver na tela.',
  },
};

function messagingCopy(
  locale: string,
  key: MessagingCopyKey,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return Object.entries(values).reduce(
    (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
    MESSAGING_COPY[normalizeMessagingLocale(locale)][key],
  );
}

function normalizeMessagingLocale(value: unknown): 'en-US' | 'pt-BR' {
  return typeof value === 'string' && value.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en-US';
}

function normalizeMessagingText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function parseJoinCommand(value: string): {
  stationId: string | null;
  locale: string | null;
  inferredLocale: 'en-US' | 'pt-BR' | null;
} | null {
  const match = /^(JOIN|ENTRAR)(?:\s+([A-Z0-9](?:[A-Z0-9:._-]{0,127})))?(?:\s+LANG\s+([A-Z]{2}(?:-[A-Z]{2})?))?$/.exec(value);
  if (!match) return null;
  return {
    stationId: match[2] ?? null,
    locale: match[3] ?? null,
    inferredLocale: match[3] === undefined ? match[1] === 'ENTRAR' ? 'pt-BR' : 'en-US' : null,
  };
}

function parseMessagingGameChoice(value: string): PlayableArcadeGame | null {
  if (value === '1' || value === 'RACER' || value === 'VOICE RACER' || value === 'CORRIDA' || value === 'CORRIDA POR VOZ') return 'racer';
  if (value === '2' || value === 'MONSTERS' || value === 'VOICE MONSTERS' || value === 'MONSTROS' || value === 'MONSTROS POR VOZ') return 'monsters';
  if (value === '3' || value === 'FIGHTER' || value === 'VOICE FIGHTER' || value === 'LUTA' || value === 'LUTA POR VOZ') return 'fighter';
  return null;
}

const MESSAGING_GAME_CHOICE_NAMES: Record<'en-US' | 'pt-BR', Record<PlayableArcadeGame, string>> = {
  'en-US': { racer: 'Voice Racer', monsters: 'Voice Monsters', fighter: 'Voice Fighter' },
  'pt-BR': { racer: 'Corrida por Voz', monsters: 'Monstros por Voz', fighter: 'Luta por Voz' },
};
const MESSAGING_GAME_CHOICE_NUMBERS: Record<PlayableArcadeGame, string> = {
  racer: '1', monsters: '2', fighter: '3',
};

function messagingGameChoiceOptions(config: ArcadeConfigSnapshot, locale: string): string {
  const names = MESSAGING_GAME_CHOICE_NAMES[normalizeMessagingLocale(locale)];
  return (['racer', 'monsters', 'fighter'] as const)
    .filter(game => config.station.games[game].enabled)
    .map(game => `${MESSAGING_GAME_CHOICE_NUMBERS[game]} = ${names[game]}`)
    .join(', ');
}

function messagingMorePage(value: string): number | null {
  const match = /^(?:MORE|MAIS)(?:\s+([1-9][0-9]{0,2}))?$/.exec(value);
  return match ? Number(match[1] ?? 1) : null;
}

function messagingCommand(value: string): 'COIN' | 'READY' | 'STATUS' | 'LEAVE' | 'HELP' | 'MORE' | 'TEXT' {
  if (value === 'COIN' || value === 'MOEDA') return 'COIN';
  const emoji = value.replace(/[\uFE0E\uFE0F]/gu, '');
  if (/^(?:🪙|💰|💵|💴|💶|💷|💸)+$/u.test(emoji)) return 'COIN';
  if (value === 'READY' || value === 'PRONTO') return 'READY';
  if (value === 'STATUS' || value === 'ESTADO') return 'STATUS';
  if (value === 'LEAVE' || value === 'SAIR') return 'LEAVE';
  if (value === 'HELP' || value === 'AJUDA') return 'HELP';
  if (messagingMorePage(value) !== null) return 'MORE';
  return 'TEXT';
}

function createMessagingDraft(playerId: string, stationId: string, at: string): ArcadeMessagingDraftRecord {
  return {
    playerId, stationId, step: 'FIRST_NAME', firstName: null, lastName: null,
    workEmail: null, companyName: null, countryCode: null, createdAt: at, updatedAt: at,
  };
}

function isLeadCaptureDraft(draft: ArcadeMessagingDraftRecord): boolean {
  if (['FIRST_NAME', 'LAST_NAME', 'WORK_EMAIL', 'COMPANY', 'COUNTRY'].includes(draft.step)) return true;
  return draft.firstName !== null && draft.lastName !== null && draft.workEmail !== null
    && draft.companyName !== null && draft.countryCode !== null;
}

function messagingPrompt(locale: string, draft: ArcadeMessagingDraftRecord): string {
  const portuguese = normalizeMessagingLocale(locale) === 'pt-BR';
  const prompts: Record<ArcadeMessagingDraftRecord['step'], string> = portuguese ? {
    FIRST_NAME: 'Qual e o seu primeiro nome? Responda somente com o primeiro nome.',
    LAST_NAME: 'Qual e o seu sobrenome? Responda somente com o sobrenome.',
    WORK_EMAIL: 'Qual e o seu email profissional? Responda no formato nome@empresa.com.',
    COMPANY: 'Em qual empresa voce trabalha? Responda com o nome da empresa.',
    COUNTRY: 'Qual e o codigo de duas letras do seu pais? Responda com duas letras, por exemplo BR.',
    TERMS: 'Responda SIM para aceitar os termos de participacao exibidos na pagina de entrada.',
    COMPLETE: 'Cadastro concluido. Responda MOEDA quando estiver na tela.',
  } : {
    FIRST_NAME: 'What is your first name? Reply with your first name only.',
    LAST_NAME: 'What is your last name? Reply with your last name only.',
    WORK_EMAIL: 'What is your work email? Reply in the format name@company.com.',
    COMPANY: 'What company do you work for? Reply with the company name.',
    COUNTRY: 'What is your two-letter country code? Reply with two letters, for example US.',
    TERMS: 'Reply YES to accept the participation terms shown on the join page.',
    COMPLETE: 'Registration complete. Reply COIN when you are at the screen.',
  };
  return prompts[draft.step];
}

function advanceMessagingDraft(
  draft: ArcadeMessagingDraftRecord,
  body: string,
  at: string,
  locale: string,
  requireTerms = true,
): { draft: ArcadeMessagingDraftRecord; completed: boolean; reply: string } {
  const value = body.trim();
  let next = draft;
  if (draft.step === 'FIRST_NAME' && validMessagingText(value, 50)) {
    next = { ...draft, firstName: value, step: 'LAST_NAME', updatedAt: at };
  } else if (draft.step === 'LAST_NAME' && validMessagingText(value, 50)) {
    next = { ...draft, lastName: value, step: 'WORK_EMAIL', updatedAt: at };
  } else if (draft.step === 'WORK_EMAIL' && value.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    next = { ...draft, workEmail: value.toLowerCase(), step: 'COMPANY', updatedAt: at };
  } else if (draft.step === 'COMPANY' && validMessagingText(value, 100)) {
    next = { ...draft, companyName: value, step: 'COUNTRY', updatedAt: at };
  } else if (draft.step === 'COUNTRY' && /^[A-Za-z]{2}$/.test(value)) {
    next = {
      ...draft,
      countryCode: value.toUpperCase(),
      step: requireTerms ? 'TERMS' : 'COMPLETE',
      updatedAt: at,
    };
  } else if (draft.step === 'TERMS' && ['YES', 'SIM'].includes(normalizeMessagingText(value))) {
    next = { ...draft, step: 'COMPLETE', updatedAt: at };
  }
  return { draft: next, completed: next.step === 'COMPLETE', reply: messagingPrompt(locale, next) };
}

function validMessagingText(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);
}

function stationReadyPosition(aggregate: ArcadeStationAggregate, readyEntryId: string): number {
  const target = aggregate.readyEntries[readyEntryId]!;
  return Object.values(aggregate.readyEntries)
    .filter(entry => entry.roundId === target.roundId && !['COMPLETED', 'LEFT'].includes(entry.status))
    .sort((left, right) => Date.parse(left.originalReadyAt) - Date.parse(right.originalReadyAt)
      || left.id.localeCompare(right.id))
    .findIndex(entry => entry.id === readyEntryId) + 1;
}

function messagingStatusNext(
  locale: string,
  freePlay: boolean,
  aggregate: ArcadeStationAggregate | null,
  entry: StationReadyEntry | undefined,
  choices: string,
): string {
  const portuguese = normalizeMessagingLocale(locale) === 'pt-BR';
  if (!entry) {
    if (portuguese) return `Responda ${freePlay ? 'PRONTO' : 'MOEDA'} quando estiver na tela.`;
    return `Reply ${freePlay ? 'READY' : 'COIN'} when you are at the screen.`;
  }
  if (entry.status === 'READY' && aggregate?.station.phase === 'GAME_SELECTION'
    && aggregate.station.activeRoundId === entry.roundId) {
    return portuguese
      ? `Responda com o nome ou numero do jogo: ${choices}.`
      : `Reply with a game name or number: ${choices}.`;
  }
  if (entry.status === 'READY') {
    return portuguese
      ? 'Aguarde a selecao de jogo e responda com o nome ou numero do jogo.'
      : 'Watch for game selection, then reply with the game name or number.';
  }
  return portuguese ? 'Acompanhe a tela para a proxima instrucao.' : 'Watch the screen for the next instruction.';
}

function pruneInboundMessages(state: ArcadeState, maximum = ARCADE_MESSAGING_MAX_INBOUND_RECEIPTS): void {
  const entries = Object.values(state.inboundMessages);
  if (entries.length < maximum) return;
  entries.sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt)
    || left.id.localeCompare(right.id));
  for (const message of entries.slice(0, Math.max(1_000, entries.length - maximum + 1))) {
    delete state.inboundMessages[message.id];
    delete state.idempotencyRecords[message.id];
  }
}

function pruneCapacityInboundMessages(state: ArcadeState): void {
  const entries = Object.values(state.inboundMessages)
    .filter(message => message.command === 'CAPACITY');
  if (entries.length < ARCADE_MESSAGING_CAPACITY_MAX_INBOUND_RECEIPTS) return;
  entries.sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt)
    || left.id.localeCompare(right.id));
  for (const message of entries.slice(
    0,
    entries.length - ARCADE_MESSAGING_CAPACITY_MAX_INBOUND_RECEIPTS + 1,
  )) {
    delete state.inboundMessages[message.id];
    delete state.idempotencyRecords[message.id];
  }
}

function inactiveMessagingPlayerIds(state: ArcadeState, cutoff: number): string[] {
  const addressesByPlayer = new Map<string, typeof state.channelAddresses[string][]>();
  for (const address of Object.values(state.channelAddresses)) {
    const addresses = addressesByPlayer.get(address.playerId) ?? [];
    addresses.push(address);
    addressesByPlayer.set(address.playerId, addresses);
  }
  const playersWithQueueHistory = new Set(Object.values(state.queueEntries).map(entry => entry.playerId));
  const playersWithReadyHistory = new Set(Object.values(state.stationReadyEntries).map(entry => entry.playerId));
  const playersWithOutbox = new Set(Object.values(state.outboundNotifications).map(entry => entry.playerId));
  const playersWithOtherIdempotency = new Set(Object.values(state.idempotencyRecords)
    .filter(record => record.playerId !== null)
    .map(record => record.playerId!));
  const candidates: { playerId: string; lastActiveAt: number }[] = [];

  for (const player of Object.values(state.players)) {
    const addresses = addressesByPlayer.get(player.id) ?? [];
    const draft = state.messagingDrafts[player.id];
    const wallet = state.wallets[player.id];
    if (addresses.length === 0 || !draft || !wallet || player.lead !== null
      || player.conversationProfileId !== null || player.crmLeadId !== null
      || player.marketingConsent || wallet.wallet.cachedBalance !== 0
      || wallet.transactions.length > 0 || wallet.reservations.length > 0
      || wallet.challengeClaims.length > 0 || wallet.idempotencyRecords.length > 0
      || playersWithQueueHistory.has(player.id) || playersWithReadyHistory.has(player.id)
      || playersWithOutbox.has(player.id) || playersWithOtherIdempotency.has(player.id)) {
      continue;
    }
    const lastActiveAt = Math.max(
      Date.parse(player.updatedAt),
      Date.parse(draft.updatedAt),
      ...addresses.map(address => Date.parse(address.lastSeenAt)),
    );
    if (lastActiveAt <= cutoff) candidates.push({ playerId: player.id, lastActiveAt });
  }
  return candidates
    .sort((left, right) => left.lastActiveAt - right.lastActiveAt
      || left.playerId.localeCompare(right.playerId))
    .map(candidate => candidate.playerId);
}

function pruneInactiveMessagingPlayers(
  state: ArcadeState,
  cutoff: number,
  maximum: number,
): number {
  const playerIds = inactiveMessagingPlayerIds(state, cutoff).slice(0, maximum);
  if (playerIds.length === 0) return 0;
  const selected = new Set(playerIds);
  const addressIds = new Set(Object.values(state.channelAddresses)
    .filter(address => selected.has(address.playerId))
    .map(address => address.id));
  for (const message of Object.values(state.inboundMessages)) {
    if (message.channelAddressId !== null && addressIds.has(message.channelAddressId)) {
      delete state.inboundMessages[message.id];
      delete state.idempotencyRecords[message.id];
    }
  }
  for (const addressId of addressIds) delete state.channelAddresses[addressId];
  for (const playerId of playerIds) {
    delete state.messagingDrafts[playerId];
    delete state.wallets[playerId];
    delete state.players[playerId];
  }
  return playerIds.length;
}

const STATION_NOTIFICATION_TTL_MS: Record<ArcadeStationNotificationKind, number> = {
  STATION_ADMITTED: 10 * 60 * 1000,
  STATION_OVERFLOW: 2 * 60 * 60 * 1000,
  STATION_CALL_NOW: 5 * 60 * 1000,
  STATION_RESULTS: 24 * 60 * 60 * 1000,
  STATION_NEXT_GAME: 10 * 60 * 1000,
};

const STATION_GAME_NAMES: Record<'en-US' | 'pt-BR', Record<PlayableArcadeGame, string>> = {
  'en-US': { racer: 'Voice Racer', monsters: 'Voice Monsters', fighter: 'Voice Fighter' },
  'pt-BR': { racer: 'Corrida por Voz', monsters: 'Monstros por Voz', fighter: 'Luta por Voz' },
};

function stationNotificationId(
  kind: ArcadeStationNotificationKind,
  matchId: string,
  readyEntryId: string,
): string {
  return `outbound:${createHash('sha256').update(JSON.stringify([kind, matchId, readyEntryId])).digest('hex')}`;
}

function stationNotificationContent(input: {
  kind: ArcadeStationNotificationKind;
  locale: 'en-US' | 'pt-BR';
  game: PlayableArcadeGame;
  overflowOrdinal: number | null;
  callNumber: string | null;
  balance: number | null;
  offerChallenges: boolean;
  rank: number | null;
  won: boolean | null;
}): { body: string; templateVariables: Readonly<Record<string, string>> } {
  const game = STATION_GAME_NAMES[input.locale][input.game];
  const position = String(input.overflowOrdinal ?? 1);
  const callNumber = input.callNumber ?? (input.locale === 'pt-BR' ? 'o número exibido na tela' : 'the number on screen');
  if (input.locale === 'pt-BR') {
    if (input.kind === 'STATION_ADMITTED') {
      return { body: `Você entrou na próxima partida de ${game}.\nFique perto da tela.`, templateVariables: { '1': game } };
    }
    if (input.kind === 'STATION_OVERFLOW') {
      return { body: `Esta partida está cheia.\nSua moeda continua reservada e você é o número ${position} para o próximo jogo.`, templateVariables: { '1': position } };
    }
    if (input.kind === 'STATION_CALL_NOW') {
      return { body: `Ligue agora para ${callNumber} para entrar em ${game}.`, templateVariables: { '1': callNumber, '2': game } };
    }
    if (input.kind === 'STATION_RESULTS') {
      const balance = input.balance === null ? '' : `\nSaldo disponível: ${input.balance}.`;
      const challenges = input.offerChallenges ? '\nSeu saldo acabou. Responda MAIS para receber links de desafios e ganhar mais moedas.' : '';
      const result = input.rank === null ? '\nOs resultados estão na tela.'
        : input.won ? '\nVocê venceu!' : `\nVocê terminou em ${input.rank}º lugar.`;
      return {
        body: `Sua partida de ${game} terminou.${result}${balance}${challenges}`,
        templateVariables: { '1': game, ...(input.balance === null ? {} : { '2': String(input.balance) }) },
      };
    }
    return { body: 'Você foi promovido para o próximo jogo.\nFique perto da tela e aguarde a seleção.', templateVariables: {} };
  }
  if (input.kind === 'STATION_ADMITTED') {
    return { body: `You're admitted to the next ${game} match.\nStay near the screen.`, templateVariables: { '1': game } };
  }
  if (input.kind === 'STATION_OVERFLOW') {
    return { body: `This match is full.\nYour coin is still held and you are number ${position} for the next game.`, templateVariables: { '1': position } };
  }
  if (input.kind === 'STATION_CALL_NOW') {
    return { body: `Call ${callNumber} now to join ${game}.`, templateVariables: { '1': callNumber, '2': game } };
  }
  if (input.kind === 'STATION_RESULTS') {
    const balance = input.balance === null ? '' : `\nAvailable balance: ${input.balance}.`;
    const challenges = input.offerChallenges ? '\nYou used your last coin. Reply MORE for challenge links and earn more coins.' : '';
    const result = input.rank === null ? '\nResults are on the screen.'
      : input.won ? '\nYou won!' : `\nYou finished in place ${input.rank}.`;
    return {
      body: `Your ${game} match is complete.${result}${balance}${challenges}`,
      templateVariables: { '1': game, ...(input.balance === null ? {} : { '2': String(input.balance) }) },
    };
  }
  return { body: "You're promoted for the next game.\nStay near the screen and wait for selection.", templateVariables: {} };
}

function availableEarningChallenges(config: ArcadeConfigSnapshot, wallet: WalletState, at: string) {
  if (!config.earning.enabled || config.coins.chargePolicy === 'free') return [];
  const now = Date.parse(at);
  return config.earning.challenges
    .filter(challenge => challenge.enabled
      && (challenge.startsAt === null || Date.parse(challenge.startsAt) <= now)
      && (challenge.endsAt === null || now < Date.parse(challenge.endsAt))
      && wallet.challengeClaims.filter(claim => claim.challengeId === challenge.id).length
        < challenge.maxClaimsPerPlayer)
    .slice()
    .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id));
}

export class ArcadeService {
  private readonly store: ArcadeStateStore;
  private readonly configSource: ArcadeConfigSnapshot | (() => ArcadeConfigSnapshot);
  private readonly clock: ArcadeClock;
  private readonly idGenerator: ArcadeIdGenerator;
  private readonly challengeTokenSecret: Buffer;
  private readonly publicBaseUrl: string;
  private readonly operatorAuthorizer: ArcadeOperatorAuthorizer;
  private readonly stationUpdated?: (revision: number) => void;
  private readonly stationNotifications?: ArcadeStationNotificationOptions;
  private readonly newMutationsAllowed: () => boolean;
  private readonly messagingIdentityCapacity: number;
  private readonly messagingRetentionMs: number;
  private readonly messagingPruneBatchSize: number;
  private readonly messagingStateAdmissionMaxBytes: number;

  constructor(options: ArcadeServiceOptions);
  constructor(
    store: ArcadeStateStore,
    config: ArcadeConfigSnapshot | (() => ArcadeConfigSnapshot),
    clock: ArcadeClock,
    idGenerator: ArcadeIdGenerator,
    challengeTokenSecret: ArcadeChallengeTokenSecret,
    operatorAuthorizer?: ArcadeOperatorAuthorizer,
  );
  constructor(
    optionsOrStore: ArcadeServiceOptions | ArcadeStateStore,
    config?: ArcadeConfigSnapshot | (() => ArcadeConfigSnapshot),
    clock?: ArcadeClock,
    idGenerator?: ArcadeIdGenerator,
    challengeTokenSecret?: ArcadeChallengeTokenSecret,
    operatorAuthorizer?: ArcadeOperatorAuthorizer,
  ) {
    if (optionsOrStore instanceof ArcadeStateStore) {
      if (!config || !clock || !idGenerator || !challengeTokenSecret) {
        throw new ArcadeServiceError(
          'INVALID_DEPENDENCY',
          'config, clock, ID generator, and challenge token secret are required',
        );
      }
      this.store = optionsOrStore;
      this.configSource = config;
      this.clock = clock;
      this.idGenerator = idGenerator;
      this.challengeTokenSecret = copyChallengeTokenSecret(challengeTokenSecret);
      this.publicBaseUrl = 'http://localhost';
      this.operatorAuthorizer = operatorAuthorizer ?? (() => null);
      this.stationUpdated = undefined;
      this.stationNotifications = undefined;
      this.newMutationsAllowed = () => true;
    } else {
      this.store = optionsOrStore.store;
      this.configSource = optionsOrStore.config;
      this.clock = optionsOrStore.clock;
      this.idGenerator = optionsOrStore.idGenerator;
      this.challengeTokenSecret = copyChallengeTokenSecret(optionsOrStore.challengeTokenSecret);
      try { this.publicBaseUrl = new URL(optionsOrStore.publicBaseUrl ?? 'http://localhost').origin; }
      catch { throw new ArcadeServiceError('INVALID_DEPENDENCY', 'publicBaseUrl must be an absolute URL'); }
      this.operatorAuthorizer = optionsOrStore.operatorAuthorizer ?? (() => null);
      this.stationUpdated = optionsOrStore.stationUpdated;
      this.stationNotifications = optionsOrStore.stationNotifications;
      this.newMutationsAllowed = optionsOrStore.newMutationsAllowed ?? (() => true);
    }
    const messagingProtection = optionsOrStore instanceof ArcadeStateStore
      ? undefined
      : optionsOrStore.messagingProtection;
    this.messagingIdentityCapacity = messagingProtection?.identityCapacity
      ?? ARCADE_MESSAGING_IDENTITY_CAPACITY;
    this.messagingRetentionMs = messagingProtection?.retentionMs ?? ARCADE_MESSAGING_RETENTION_MS;
    this.messagingPruneBatchSize = messagingProtection?.pruneBatchSize
      ?? ARCADE_MESSAGING_PRUNE_BATCH_SIZE;
    this.messagingStateAdmissionMaxBytes = messagingProtection?.stateAdmissionMaxBytes
      ?? ARCADE_MESSAGING_STATE_ADMISSION_MAX_BYTES;
    if (!Number.isSafeInteger(this.messagingIdentityCapacity) || this.messagingIdentityCapacity < 1
      || this.messagingIdentityCapacity > ARCADE_STATE_MAX_PLAYERS
      || !Number.isSafeInteger(this.messagingRetentionMs) || this.messagingRetentionMs < 1
      || !Number.isSafeInteger(this.messagingPruneBatchSize) || this.messagingPruneBatchSize < 1
      || this.messagingPruneBatchSize > 1_000
      || !Number.isSafeInteger(this.messagingStateAdmissionMaxBytes)
      || this.messagingStateAdmissionMaxBytes < 1
      || this.messagingStateAdmissionMaxBytes >= ARCADE_STATE_MAX_FILE_BYTES) {
      throw new ArcadeServiceError('INVALID_DEPENDENCY', 'messaging protection limits are invalid');
    }
  }

  async getMessagingStorageStatus(): Promise<ArcadeMessagingStorageStatus> {
    const state = await this.store.read();
    const players = Object.keys(state.players).length;
    const messagingIdentities = new Set(Object.values(state.channelAddresses)
      .map(address => address.playerId)).size;
    const cutoff = Date.parse(this.now()) - this.messagingRetentionMs;
    return Object.freeze({
      players,
      messagingIdentities,
      identityCapacity: this.messagingIdentityCapacity,
      remainingIdentityCapacity: Math.max(0, this.messagingIdentityCapacity - players),
      channelAddresses: Object.keys(state.channelAddresses).length,
      drafts: Object.keys(state.messagingDrafts).length,
      cleanupEligible: inactiveMessagingPlayerIds(state, cutoff).length,
      retentionDays: this.messagingRetentionMs / (24 * 60 * 60 * 1000),
      pruneBatchSize: this.messagingPruneBatchSize,
    });
  }

  async listPlayersNeedingCoins(limitInput = 100, cursorInput: string | null = null): Promise<OperatorPlayerRecoveryPage> {
    if (!Number.isSafeInteger(limitInput) || limitInput < 1 || limitInput > 100) {
      throw new ArcadeServiceError('INVALID_INPUT', 'player recovery limit must be from 1 to 100');
    }
    let cursor: { lastActivityAt: string; playerId: string } | null = null;
    if (cursorInput !== null) {
      try {
        const decoded = JSON.parse(Buffer.from(requireIdentifier(cursorInput, 'cursor', 512), 'base64url').toString('utf8')) as unknown;
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid cursor');
        const value = decoded as Record<string, unknown>;
        cursor = {
          lastActivityAt: requireIdentifier(value.lastActivityAt, 'cursor activity'),
          playerId: requireIdentifier(value.playerId, 'cursor player'),
        };
        if (!Number.isFinite(Date.parse(cursor.lastActivityAt))) throw new Error('invalid cursor timestamp');
      } catch {
        throw new ArcadeServiceError('INVALID_INPUT', 'player recovery cursor is invalid');
      }
    }
    const state = await this.store.read();
    const config = this.config();
    if (config.coins.chargePolicy === 'free') {
      return { configVersion: config.version, startingBalance: 0, players: [], nextCursor: null };
    }
    const addressesByPlayer = new Map<string, typeof state.channelAddresses[string][]>();
    for (const address of Object.values(state.channelAddresses)) {
      const addresses = addressesByPlayer.get(address.playerId) ?? [];
      addresses.push(address);addressesByPlayer.set(address.playerId, addresses);
    }
    const readyByPlayer = new Map<string, StationReadyEntry[]>(), activeReadyPlayers = new Set<string>();
    for (const entry of Object.values(state.stationReadyEntries)) {
      const entries = readyByPlayer.get(entry.playerId) ?? [];
      entries.push(entry);readyByPlayer.set(entry.playerId, entries);
      if (!['COMPLETED', 'LEFT'].includes(entry.status)) activeReadyPlayers.add(entry.playerId);
    }
    const activeQueuePlayers = new Set<string>(), queueActivityByPlayer = new Map<string, string>();
    for (const entry of Object.values(state.queueEntries)) {
      if (!isTerminalQueueStatus(entry.status)) activeQueuePlayers.add(entry.playerId);
      const prior = queueActivityByPlayer.get(entry.playerId);
      if (!prior || Date.parse(entry.updatedAt) > Date.parse(prior)) queueActivityByPlayer.set(entry.playerId, entry.updatedAt);
    }
    const retiredHashes = new Set(Object.values(state.idempotencyRecords)
      .filter(record => record.operation === 'RESET_TEST_PLAYER')
      .map(record => (record.result as { retiredPlayerHash?: unknown } | null)?.retiredPlayerHash)
      .filter((hash): hash is string => typeof hash === 'string'));
    const items: OperatorPlayerRecoveryItem[] = [];
    const compareItems = (left: OperatorPlayerRecoveryItem, right: OperatorPlayerRecoveryItem): number => (
      Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) || left.playerId.localeCompare(right.playerId)
    );
    const cursorActivity = cursor === null ? null : Date.parse(cursor.lastActivityAt);
    for (const player of Object.values(state.players)) {
      if (player.id.startsWith('reset-player:') || retiredHashes.has(retiredPlayerHash(player.id))) continue;
      const wallet = own(state.wallets, player.id);
      if (!wallet || !wallet.transactions.some(transaction => transaction.type === 'registration_grant')) continue;
      const ledger = deriveLedger(wallet.transactions, wallet.reservations);
      if (ledger.availableBalance !== 0 || ledger.reservedBalance !== 0
        || wallet.reservations.some(reservation => reservation.status === 'ACTIVE')
        || activeReadyPlayers.has(player.id) || activeQueuePlayers.has(player.id)) continue;
      const addresses = addressesByPlayer.get(player.id) ?? [];
      const draft = own(state.messagingDrafts, player.id);
      if (!player.lead && draft?.step !== 'COMPLETE') continue;
      const readyEntries = readyByPlayer.get(player.id) ?? [];
      const activity = [player.updatedAt, wallet.wallet.updatedAt, draft?.updatedAt,
        queueActivityByPlayer.get(player.id), ...addresses.map(address => address.lastSeenAt), ...readyEntries.map(entry => entry.readyAt)]
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? player.updatedAt;
      const activityTime = Date.parse(activity);
      if (cursor !== null && cursorActivity !== null
        && (activityTime > cursorActivity || (activityTime === cursorActivity && player.id <= cursor.playerId))) continue;
      const identities: OperatorPlayerRecoveryItem['identities'][number][] = addresses.map(address => ({
        channel: address.channel,
        maskedAddress: `•••• ${address.normalizedAddress.slice(-4)}`,
      }));
      if (!identities.length && player.lead) identities.push({
        channel: 'browser', maskedAddress: `•••• ${player.lead.phoneNumber.slice(-4)}`,
      });
      let lastReadyStatus: StationReadyEntry['status'] | null = null;
      let lastReadyAt = Number.NEGATIVE_INFINITY;
      for (const entry of readyEntries) {
        const readyAt = Date.parse(entry.readyAt);
        if (readyAt > lastReadyAt) {
          lastReadyAt = readyAt;
          lastReadyStatus = entry.status;
        }
      }
      const item = {
        playerId: player.id,
        displayName: player.lead?.firstName.trim() || draft?.firstName?.trim() || 'Unnamed player',
        identities,
        availableBalance: ledger.availableBalance,
        lastActivityAt: activity,
        lastReadyStatus,
      } satisfies OperatorPlayerRecoveryItem;
      let low = 0, high = items.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compareItems(item, items[middle]!) < 0) high = middle;
        else low = middle + 1;
      }
      items.splice(low, 0, item);
      if (items.length > limitInput + 1) items.pop();
    }
    const players = items.slice(0, limitInput);
    const last = players.at(-1);
    return {
      configVersion: config.version,
      startingBalance: config.coins.startingBalance,
      players,
      nextCursor: items.length > limitInput && last
        ? Buffer.from(JSON.stringify({ lastActivityAt: last.lastActivityAt, playerId: last.playerId }), 'utf8').toString('base64url')
        : null,
    };
  }

  async isRetiredPlayer(playerIdInput: string): Promise<boolean> {
    const playerId = requireIdentifier(playerIdInput, 'playerId');
    return isRetiredPlayer(await this.store.read(), playerId);
  }

  async getPlayerStatus(playerIdInput: string): Promise<ArcadePlayerStatus | null> {
    const playerId = requireIdentifier(playerIdInput, 'playerId');
    const state = await this.store.read();
    const player = own(state.players, playerId);
    if (!player) return null;
    return Object.freeze({
      registered: player.lead !== null,
      firstName: player.lead?.firstName ?? null,
      preferredLocale: player.preferredLocale,
    });
  }

  async getWalletStatus(playerIdInput: string): Promise<ArcadeWalletStatus | null> {
    const playerId = requireIdentifier(playerIdInput, 'playerId');
    const wallet = own((await this.store.read()).wallets, playerId);
    if (!wallet) return null;
    const ledger = deriveLedger(wallet.transactions, wallet.reservations);
    return Object.freeze({
      ...ledger,
      updatedAt: wallet.wallet.updatedAt,
    });
  }

  async getQueueStatus(playerIdInput: string): Promise<ArcadeQueueStatus | null> {
    const playerId = requireIdentifier(playerIdInput, 'playerId');
    const config = this.config();
    const state = await this.store.read();
    const entries = Object.values(state.queueEntries);
    const entry = entries.find(candidate => (
      candidate.playerId === playerId
      && candidate.cabinetId === config.arcade.cabinetId
      && !isTerminalQueueStatus(candidate.status)
    ));
    if (!entry) return null;
    const waiting = selectWaitingEntries(entries, {
      cabinetId: config.arcade.cabinetId,
      limit: entries.length,
    });
    const positionIndex = waiting.findIndex(candidate => candidate.id === entry.id);
    const wallet = own(state.wallets, playerId);
    const reservation = wallet ? findReservation(wallet, entry.id) : null;
    return Object.freeze({
      queueEntryId: entry.id,
      status: entry.status,
      preferredGame: entry.preferredGame,
      flexibleGame: entry.flexibleGame,
      position: positionIndex < 0 ? null : positionIndex + 1,
      joinedAt: entry.joinedAt,
      approachingConfirmedAt: entry.approachingConfirmedAt,
      calledAt: entry.calledAt,
      checkInExpiresAt: entry.checkInExpiresAt,
      deferredUntil: entry.deferredUntil,
      checkedInAt: entry.checkedInAt,
      reservation: reservation ? Object.freeze({ amount: reservation.amount, status: reservation.status }) : null,
    });
  }

  async listOperatorQueue(): Promise<readonly ArcadeOperatorQueueStatus[]> {
    const config = this.config();
    const state = await this.store.read();
    const entries = Object.values(state.queueEntries)
      .filter(entry => entry.cabinetId === config.arcade.cabinetId && !isTerminalQueueStatus(entry.status))
      .sort((a, b) => (
        Date.parse(a.originalJoinedAt) - Date.parse(b.originalJoinedAt) || a.id.localeCompare(b.id)
      ));
    const waiting = selectWaitingEntries(Object.values(state.queueEntries), {
      cabinetId: config.arcade.cabinetId,
      limit: Object.keys(state.queueEntries).length,
    });
    return Object.freeze(entries.map(entry => {
      const wallet = own(state.wallets, entry.playerId);
      const reservation = wallet ? findReservation(wallet, entry.id) : null;
      const positionIndex = waiting.findIndex(candidate => candidate.id === entry.id);
      const captured = own(state.queueEntryConfigs, entry.id);
      return Object.freeze({
        queueEntryId: entry.id,
        playerId: entry.playerId,
        firstName: own(state.players, entry.playerId)?.lead?.firstName
          ?? own(state.messagingDrafts, entry.playerId)?.firstName ?? null,
        assignedGame: captured?.assignedGame ?? null,
        matchId: captured?.matchId ?? null,
        status: entry.status,
        preferredGame: entry.preferredGame,
        flexibleGame: entry.flexibleGame,
        position: positionIndex < 0 ? null : positionIndex + 1,
        joinedAt: entry.joinedAt,
        approachingConfirmedAt: entry.approachingConfirmedAt,
        calledAt: entry.calledAt,
        checkInExpiresAt: entry.checkInExpiresAt,
        deferredUntil: entry.deferredUntil,
        checkedInAt: entry.checkedInAt,
        reservation: reservation ? Object.freeze({ amount: reservation.amount, status: reservation.status }) : null,
      });
    }));
  }

  async getOperatorQueueEntry(queueEntryIdInput: string): Promise<ArcadeOperatorQueueStatus | null> {
    const queueEntryId = requireIdentifier(queueEntryIdInput, 'queueEntryId');
    const config = this.config();
    const state = await this.store.read();
    const entry = own(state.queueEntries, queueEntryId);
    if (!entry || entry.cabinetId !== config.arcade.cabinetId) return null;
    const entries = Object.values(state.queueEntries);
    const waiting = selectWaitingEntries(entries, {
      cabinetId: config.arcade.cabinetId,
      limit: entries.length,
    });
    const wallet = own(state.wallets, entry.playerId);
    const reservation = wallet ? findReservation(wallet, entry.id) : null;
    const positionIndex = waiting.findIndex(candidate => candidate.id === entry.id);
    const captured = own(state.queueEntryConfigs, entry.id);
    return Object.freeze({
      queueEntryId: entry.id,
      playerId: entry.playerId,
      firstName: own(state.players, entry.playerId)?.lead?.firstName
        ?? own(state.messagingDrafts, entry.playerId)?.firstName ?? null,
      assignedGame: captured?.assignedGame ?? null,
      matchId: captured?.matchId ?? null,
      status: entry.status,
      preferredGame: entry.preferredGame,
      flexibleGame: entry.flexibleGame,
      position: positionIndex < 0 ? null : positionIndex + 1,
      joinedAt: entry.joinedAt,
      approachingConfirmedAt: entry.approachingConfirmedAt,
      calledAt: entry.calledAt,
      checkInExpiresAt: entry.checkInExpiresAt,
      deferredUntil: entry.deferredUntil,
      checkedInAt: entry.checkedInAt,
      reservation: reservation ? Object.freeze({ amount: reservation.amount, status: reservation.status }) : null,
    });
  }

  async listChallenges(playerIdInput: string): Promise<readonly ArcadeChallengeStatus[]> {
    const playerId = requireIdentifier(playerIdInput, 'playerId');
    const config = this.config();
    this.requireOn(config);
    const state = await this.store.read();
    this.requirePlayer(state, playerId);
    if (!config.earning.enabled || config.coins.chargePolicy === 'free') return Object.freeze([]);
    const wallet = this.requireWallet(state, playerId);
    const now = Date.parse(this.now());
    return Object.freeze(config.earning.challenges
      .filter(challenge => challenge.enabled)
      .slice()
      .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id))
      .map(challenge => {
        const claimCount = wallet.challengeClaims.filter(claim => claim.challengeId === challenge.id).length;
        const started = challenge.startsAt === null || Date.parse(challenge.startsAt) <= now;
        const notEnded = challenge.endsAt === null || now < Date.parse(challenge.endsAt);
        return Object.freeze({
          id: challenge.id,
          title: challenge.title,
          message: challenge.message,
          rewardCoins: challenge.rewardCoins,
          displayOrder: challenge.displayOrder,
          claimCount,
          maxClaimsPerPlayer: challenge.maxClaimsPerPlayer,
          available: started && notEnded && claimCount < challenge.maxClaimsPerPlayer,
          startsAt: challenge.startsAt,
          endsAt: challenge.endsAt,
        });
      }));
  }

  async identifyCoinOnly(input: IdentifyCoinOnlyInput): Promise<PlayerWalletResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    return this.execute('IDENTIFY_COIN_ONLY', input.idempotencyKey, playerId, {
      playerId,
      destination: input.destination ?? null,
      preferredLocale: input.preferredLocale ?? null,
    }, (state, config, at) => {
      if (config.arcade.mode !== 'coin_only') {
        throw new ArcadeServiceError('MODE_DISABLED', 'coin-only identification is not enabled');
      }
      const existing = own(state.players, playerId);
      const destination = normalizeDestination(input.destination) ?? existing?.trustedDestination ?? null;
      const player: ArcadePlayerRecord = existing ? {
        ...existing,
        updatedAt: at,
        preferredLocale: input.preferredLocale ?? existing.preferredLocale,
        trustedDestination: destination,
      } : {
        id: playerId,
        createdAt: at,
        updatedAt: at,
        lead: null,
        preferredLocale: input.preferredLocale ?? null,
        conversationProfileId: null,
        crmLeadId: null,
        termsAcceptedAt: null,
        marketingConsent: false,
        trustedDestination: destination,
      };
      state.players[playerId] = player;
      const wallet = this.ensureWalletAndStartingGrant(state, playerId, input.idempotencyKey, config, at);
      return { player, availableBalance: availableBalance(wallet) };
    });
  }

  identifyPlayer(input: IdentifyCoinOnlyInput): Promise<PlayerWalletResult> {
    return this.identifyCoinOnly(input);
  }

  async registerPlayer(input: RegisterArcadePlayerInput): Promise<PlayerWalletResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    exactLead(input.lead);
    if (typeof input.termsAccepted !== 'boolean' || (input.marketingConsent !== undefined
      && typeof input.marketingConsent !== 'boolean')) {
      throw new ArcadeServiceError('INVALID_REGISTRATION', 'consent values must be boolean');
    }
    return this.execute('REGISTER_PLAYER', input.idempotencyKey, null, {
      playerId,
      destination: input.destination ?? null,
      lead: input.lead,
      termsAccepted: input.termsAccepted,
      marketingConsent: input.marketingConsent ?? false,
      preferredLocale: input.preferredLocale ?? null,
      conversationProfileId: input.conversationProfileId ?? null,
      crmLeadId: input.crmLeadId ?? null,
    }, (state, config, at) => {
      if (config.arcade.mode !== 'lead_capture') {
        throw new ArcadeServiceError('MODE_DISABLED', 'lead-capture registration is not enabled');
      }
      if (config.registration.termsAcknowledgementRequired && !input.termsAccepted) {
        throw new ArcadeServiceError('TERMS_REQUIRED', 'terms acknowledgement is required');
      }
      const candidate = createPlayer({
        id: playerId,
        createdAt: own(state.players, playerId)?.createdAt ?? at,
        lead: exactLead(input.lead),
        preferredLocale: input.preferredLocale,
        conversationProfileId: input.conversationProfileId,
        crmLeadId: input.crmLeadId,
        termsAcceptedAt: input.termsAccepted ? at : own(state.players, playerId)?.termsAcceptedAt ?? null,
        marketingConsent: input.marketingConsent,
      });
      const phoneOwner = Object.values(state.players).find(existingPlayer => (
        existingPlayer.id !== playerId && existingPlayer.lead?.phoneNumber === candidate.phoneNumber
      ));
      const channelOwner = Object.values(state.channelAddresses).find(address => (
        address.normalizedAddress === candidate.phoneNumber && address.playerId !== playerId
      ));
      if (phoneOwner || channelOwner) {
        throw new ArcadeServiceError('PHONE_ALREADY_LINKED', 'phone number already belongs to another Twilio Games player');
      }
      const existing = own(state.players, playerId);
      if (existing?.lead?.phoneNumber && existing.lead.phoneNumber !== candidate.phoneNumber
        && Object.values(state.channelAddresses).some(address => address.playerId === playerId)) {
        throw new ArcadeServiceError(
          'PHONE_CHANGE_REQUIRES_RELINK',
          'a messaging-linked phone number cannot be changed through browser registration',
        );
      }
      const normalized = createPlayer({
        id: playerId,
        createdAt: existing?.createdAt ?? at,
        lead: exactLead(input.lead),
        preferredLocale: input.preferredLocale,
        conversationProfileId: input.conversationProfileId ?? existing?.conversationProfileId,
        crmLeadId: input.crmLeadId ?? existing?.crmLeadId,
        termsAcceptedAt: input.termsAccepted ? at : existing?.termsAcceptedAt ?? null,
        marketingConsent: input.marketingConsent,
      });
      const player: ArcadePlayerRecord = {
        id: playerId,
        createdAt: normalized.createdAt,
        updatedAt: at,
        lead: {
          firstName: normalized.firstName,
          lastName: normalized.lastName,
          workEmail: normalized.workEmail,
          companyName: normalized.companyName,
          phoneNumber: normalized.phoneNumber,
          countryCode: normalized.countryCode,
        },
        preferredLocale: normalized.preferredLocale,
        conversationProfileId: normalized.conversationProfileId,
        crmLeadId: normalized.crmLeadId,
        termsAcceptedAt: normalized.termsAcceptedAt,
        marketingConsent: normalized.marketingConsent,
        trustedDestination: normalizeDestination(input.destination)
          ?? existing?.trustedDestination
          ?? null,
      };
      state.players[playerId] = player;
      const wallet = this.ensureWalletAndStartingGrant(state, playerId, input.idempotencyKey, config, at);
      return { player, availableBalance: availableBalance(wallet) };
    });
  }

  register(input: RegisterArcadePlayerInput): Promise<PlayerWalletResult> {
    return this.registerPlayer(input);
  }

  async claimChallenge(input: ClaimArcadeChallengeInput): Promise<ChallengeClaimResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    const challengeId = requireIdentifier(input.challengeId, 'challengeId');
    if (typeof input.token !== 'string' || input.token.length === 0
      || Buffer.byteLength(input.token, 'utf8') > ARCADE_CHALLENGE_TOKEN_MAX_BYTES) {
      throw new ArcadeServiceError('INVALID_CHALLENGE_TOKEN', 'a bounded signed challenge token is required');
    }
    const metadata = copyMetadata(input.requestMetadata);
    let verifiedToken: ArcadeChallengeTokenPayload | null = null;
    return this.execute('CLAIM_CHALLENGE', input.idempotencyKey, playerId, {
      playerId,
      challengeId,
      tokenHash: createHash('sha256').update(input.token).digest('hex'),
      requestMetadata: metadata,
    }, (state, config, at) => {
      if (!verifiedToken) throw new ArcadeServiceError('INVALID_CHALLENGE_TOKEN', 'challenge token was not verified');
      const token = verifiedToken;
      this.requireOn(config);
      if (config.coins.chargePolicy === 'free') {
        throw new ArcadeServiceError('CHALLENGE_UNAVAILABLE', 'coin challenges are disabled in free play');
      }
      if (!config.earning.enabled) {
        throw new ArcadeServiceError('CHALLENGE_UNAVAILABLE', 'challenge earning is disabled');
      }
      const challenge = config.earning.challenges.find(candidate => candidate.id === challengeId);
      if (!challenge) throw new ArcadeServiceError('CHALLENGE_UNAVAILABLE', 'challenge was not found');
      this.requirePlayer(state, playerId);
      const current = this.requireWallet(state, playerId);
      if (current.challengeClaims.some(claim => claim.requestMetadata.tokenJti === token.jti)) {
        throw new ArcadeServiceError('CHALLENGE_TOKEN_REPLAYED', 'challenge token has already been consumed');
      }
      const claimId = this.id('challenge-claim');
      const wallet = claimChallengeReward(current, {
        claimId,
        challengeId,
        rewardCoins: challenge.rewardCoins,
        maxClaimsPerPlayer: challenge.maxClaimsPerPlayer,
        enabled: challenge.enabled,
        startsAt: challenge.startsAt,
        endsAt: challenge.endsAt,
        transactionId: this.id('wallet-transaction'),
        idempotencyKey: `${input.idempotencyKey}:challenge-reward`,
        createdAt: at,
        configVersion: config.version,
        requestMetadata: { ...metadata, tokenJti: token.jti },
      });
      state.wallets[playerId] = wallet;
      return {
        challengeId,
        claimId,
        rewardCoins: challenge.rewardCoins,
        destinationUrl: challenge.url,
        availableBalance: availableBalance(wallet),
      };
    }, (config, at) => {
      try {
        verifiedToken = verifyArcadeChallengeToken(input.token, this.challengeTokenSecret, {
          player: playerId,
          challenge: challengeId,
          audience: config.arcade.cabinetId,
          now: Date.parse(at) / 1000,
        });
      } catch (error) {
        throw new ArcadeServiceError(
          'INVALID_CHALLENGE_TOKEN',
          error instanceof Error ? error.message : 'challenge token verification failed',
        );
      }
    });
  }

  claimChallengeReward(input: ClaimArcadeChallengeInput): Promise<ChallengeClaimResult> {
    return this.claimChallenge(input);
  }

  async claimChallengeFromLink(token: string): Promise<ChallengeClaimResult> {
    if (typeof token !== 'string' || !token || Buffer.byteLength(token, 'utf8') > ARCADE_CHALLENGE_TOKEN_MAX_BYTES) {
      throw new ArcadeServiceError('INVALID_CHALLENGE_TOKEN', 'a bounded signed challenge token is required');
    }
    let payload: ArcadeChallengeTokenPayload;
    try {
      payload = authenticateArcadeChallengeToken(token, this.challengeTokenSecret, {
        audience: this.config().arcade.cabinetId,
        now: Date.parse(this.now()) / 1000,
      });
    } catch (error) {
      throw new ArcadeServiceError(
        'INVALID_CHALLENGE_TOKEN',
        error instanceof Error ? error.message : 'challenge token verification failed',
      );
    }
    return this.claimChallenge({
      playerId: payload.player,
      challengeId: payload.challenge,
      token,
      idempotencyKey: `challenge-link:${createHash('sha256').update(token).digest('hex')}`,
      requestMetadata: { source: 'messaging-link' },
    });
  }

  async joinQueue(input: JoinArcadeQueueInput): Promise<QueueEntryResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    if (!GAMES.has(input.preferredGame)) {
      throw new ArcadeServiceError('INVALID_GAME', 'preferredGame is not a Twilio Games game');
    }
    return this.execute('JOIN_QUEUE', input.idempotencyKey, playerId, {
      playerId,
      preferredGame: input.preferredGame,
      flexibleGame: input.flexibleGame ?? false,
    }, (state, config, at) => {
      this.requireQueueOn(config);
      this.requireSupportedChargePolicy(config);
      this.requirePlayer(state, playerId);
      const liveEntries = Object.values(state.queueEntries).filter(entry => (
        entry.cabinetId === config.arcade.cabinetId && !isTerminalQueueStatus(entry.status)
      ));
      if (liveEntries.length >= config.queue.maximumWaitingPlayers) {
        throw new ArcadeServiceError('QUEUE_FULL', 'station queue is full');
      }
      const reduction = reduceJoinQueue(Object.values(state.queueEntries), {
        id: this.id('queue-entry'),
        eventId: this.id('queue-event'),
        cabinetId: config.arcade.cabinetId,
        playerId,
        preferredGame: input.preferredGame,
        flexibleGame: input.flexibleGame ?? false,
        joinedAt: at,
        configVersion: config.version,
      });
      state.queueEntries[reduction.entry.id] = reduction.entry;
      state.queueEvents.push(reduction.event);
      return queueResult(state, reduction.entry);
    });
  }

  markApproaching(input: OperatorQueueEntryActionInput): Promise<QueueEntryResult> {
    return this.operatorQueueAction('MARK_APPROACHING', input, (_entry, eventId, at) => ({
      type: 'MARK_APPROACHING', eventId, at, reason: input.reason,
    }));
  }

  confirmPresence(input: QueueEntryActionInput): Promise<QueueEntryResult> {
    return this.queueAction('CONFIRM_PRESENCE', input, (_entry, eventId, at) => ({
      type: 'CONFIRM_PRESENCE', eventId, at, reason: input.reason,
    }));
  }

  callQueueEntry(input: OperatorQueueEntryActionInput): Promise<QueueEntryResult> {
    return this.operatorQueueAction('CALL_QUEUE_ENTRY', input, (_entry, eventId, at, config) => ({
      type: 'CALL',
      eventId,
      at,
      checkInExpiresAt: new Date(Date.parse(at) + config.queue.checkInWindowSeconds * 1000).toISOString(),
      reason: input.reason,
    }));
  }

  snoozeQueueEntry(input: QueueEntryActionInput): Promise<QueueEntryResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    const queueEntryId = requireIdentifier(input.queueEntryId, 'queueEntryId');
    return this.execute('SNOOZE_QUEUE_ENTRY', input.idempotencyKey, playerId, {
      playerId, queueEntryId, reason: input.reason ?? null,
    }, (state, config, at) => {
      this.requireQueueOn(config);
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
      this.requireCurrentCabinet(entry, config);
      const reduction = reduceSnoozeQueueEntry(entry, {
        eventId: this.id('queue-event'), at, reason: input.reason,
      }, this.queuePolicy(config));
      this.applyQueueReduction(state, reduction);
      return queueResult(state, reduction.entry);
    });
  }

  expireQueueEntry(input: OperatorQueueEntryActionInput): Promise<QueueEntryResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    const queueEntryId = requireIdentifier(input.queueEntryId, 'queueEntryId');
    const principal = this.authorizeOperator(input.authorization, 'QUEUE_ACTION_UNAUTHORIZED');
    const reason = operatorAuditReason(principal, input.reason);
    return this.execute('EXPIRE_QUEUE_ENTRY', input.idempotencyKey, playerId, {
      playerId, queueEntryId, reason, authorizedBy: principal,
    }, (state, config, at) => {
      this.requireQueueOn(config);
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
      this.requireCurrentCabinet(entry, config);
      const reduction = expireCalledEntry(
        entry,
        { eventId: this.id('queue-event'), at, reason },
        this.queuePolicy(config),
      );
      this.applyQueueReduction(state, reduction);
      if (reduction.entry.status === 'NO_SHOW') {
        this.releaseActiveReservation(state, reduction.entry, input.idempotencyKey, config, at);
      }
      return queueResult(state, reduction.entry);
    });
  }

  requeueEntry(input: OperatorQueueEntryActionInput): Promise<QueueEntryResult> {
    return this.operatorQueueAction('REQUEUE_ENTRY', input, (_entry, eventId, at) => ({
      type: 'RETURN_TO_WAITING', eventId, at, reason: input.reason,
    }));
  }

  checkInQueueEntry(input: CheckInArcadeQueueInput): Promise<QueueEntryResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    const queueEntryId = requireIdentifier(input.queueEntryId, 'queueEntryId');
    if (!GAMES.has(input.game)) throw new ArcadeServiceError('INVALID_GAME', 'check-in game is not a Twilio Games game');
    return this.execute('CHECK_IN_QUEUE_ENTRY', input.idempotencyKey, playerId, {
      playerId, queueEntryId, game: input.game, reason: input.reason ?? null,
    }, (state, config, at) => {
      this.requireQueueOn(config);
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
      this.requireCurrentCabinet(entry, config);
      if (entry.preferredGame !== input.game && !entry.flexibleGame) {
        throw new ArcadeServiceError('GAME_NOT_ELIGIBLE', `queue entry ${entry.id} is not eligible for ${input.game}`);
      }
      const reduction = reduceQueueEntry(entry, {
        type: 'CHECK_IN', eventId: this.id('queue-event'), at, reason: input.reason,
      });
      const amount = config.coins.chargePolicy === 'free'
        ? 0
        : config.coins.gameCosts[input.game] ?? config.coins.defaultGameCost;
      if (amount > 0) {
        state.wallets[playerId] = reserveCoins(this.requireWallet(state, playerId), {
          reservationId: this.id('wallet-reservation'),
          queueEntryId,
          amount,
          transactionId: this.id('wallet-transaction'),
          idempotencyKey: `${input.idempotencyKey}:reserve`,
          createdAt: at,
          configVersion: config.version,
        });
      }
      const entryConfig: ArcadeQueueEntryConfigSnapshot = {
        queueEntryId,
        cabinetId: entry.cabinetId,
        configVersion: config.version,
        chargePolicy: config.coins.chargePolicy === 'free' ? 'free' : 'per_player',
        gameCost: amount,
        refundOnLobbyTimeout: config.coins.refundOnLobbyTimeout,
        capturedAt: at,
        assignedGame: input.game,
        matchId: null,
      };
      state.queueEntryConfigs[queueEntryId] = entryConfig;
      this.applyQueueReduction(state, reduction);
      return queueResult(state, reduction.entry);
    });
  }

  activateLobby(input: OperatorQueueEntryActionInput): Promise<QueueEntryResult> {
    return this.operatorQueueAction('ACTIVATE_LOBBY', input, (_entry, eventId, at) => ({
      type: 'ENTER_ACTIVE_LOBBY', eventId, at, reason: input.reason,
    }));
  }

  async startMatch(input: StartArcadeMatchInput): Promise<StartArcadeMatchResult> {
    const queueEntryIds = this.requireEntryIds(input.queueEntryIds);
    if (!GAMES.has(input.game)) throw new ArcadeServiceError('INVALID_GAME', 'match game is not a Twilio Games game');
    const principal = this.authorizeOperator(input.authorization, 'MATCH_UNAUTHORIZED');
    const reason = operatorAuditReason(principal, input.reason);
    return this.execute('START_MATCH', input.idempotencyKey, null, {
      queueEntryIds, game: input.game, reason, authorizedBy: principal,
    }, (state, config, at) => {
      this.requireQueueOn(config);
      const entries = queueEntryIds.map(id => this.requireEntry(state, id));
      for (const entry of entries) {
        if (entry.status !== 'ACTIVE_LOBBY') {
          throw new ArcadeServiceError('MATCH_NOT_READY', `queue entry ${entry.id} is not in the active lobby`);
        }
        this.requireCurrentCabinet(entry, config);
      }
      const snapshots = entries.map(entry => {
        const snapshot = own(state.queueEntryConfigs, entry.id);
        if (!snapshot) {
          throw new ArcadeServiceError('MATCH_NOT_READY', `queue entry ${entry.id} has no captured check-in config`);
        }
        return snapshot;
      });
      if (new Set(snapshots.map(snapshot => snapshot.cabinetId)).size !== 1) {
        throw new ArcadeServiceError('MATCH_NOT_READY', 'all match entries must belong to one cabinet');
      }
      if (snapshots.some(snapshot => snapshot.assignedGame !== input.game)) {
        throw new ArcadeServiceError('MATCH_NOT_READY', `all match entries must be checked in for ${input.game}`);
      }
      for (const entry of entries) {
        const snapshot = own(state.queueEntryConfigs, entry.id)!;
        const reservation = findReservation(this.requireWallet(state, entry.playerId), entry.id);
        if (snapshot.chargePolicy === 'per_player' && snapshot.gameCost > 0
          && (!reservation || reservation.status !== 'ACTIVE')) {
          throw new ArcadeServiceError('MATCH_NOT_READY', `queue entry ${entry.id} has no active reservation`);
        }
      }

      const matchId = this.id('match');
      const playing: QueueEntry[] = [];
      for (const entry of entries) {
        const snapshot = own(state.queueEntryConfigs, entry.id)!;
        const wallet = this.requireWallet(state, entry.playerId);
        const reservation = findReservation(wallet, entry.id);
        if (reservation?.status === 'ACTIVE') {
          state.wallets[entry.playerId] = redeemReservation(wallet, {
            reservationId: reservation.id,
            matchId,
            transactionId: this.id('wallet-transaction'),
            idempotencyKey: `${input.idempotencyKey}:redeem:${entry.id}`,
            createdAt: at,
            configVersion: snapshot.configVersion,
          });
        }
        const reduction = reduceQueueEntry(entry, {
          type: 'START_PLAYING', eventId: this.id('queue-event'), at, reason,
        });
        state.queueEntryConfigs[entry.id] = {
          ...snapshot,
          matchId,
        };
        this.applyQueueReduction(state, reduction);
        playing.push(reduction.entry);
      }
      return { matchId, entries: playing };
    });
  }

  async completeMatch(input: CompleteArcadeMatchInput): Promise<readonly QueueEntry[]> {
    const queueEntryIds = this.requireEntryIds(input.queueEntryIds);
    const matchId = requireIdentifier(input.matchId, 'matchId');
    const principal = this.authorizeOperator(input.authorization, 'MATCH_UNAUTHORIZED');
    const reason = operatorAuditReason(principal, input.reason);
    return this.execute('COMPLETE_MATCH', input.idempotencyKey, null, {
      queueEntryIds, matchId, reason, authorizedBy: principal,
    }, (state, _config, at) => {
      const suppliedIds = [...queueEntryIds].sort();
      const expectedIds = Object.values(state.queueEntryConfigs)
        .filter(snapshot => snapshot.matchId === matchId)
        .map(snapshot => snapshot.queueEntryId)
        .sort();
      if (expectedIds.length === 0 || expectedIds.length !== suppliedIds.length
        || expectedIds.some((id, index) => id !== suppliedIds[index])) {
        throw new ArcadeServiceError(
          'MATCH_PARTICIPANTS_MISMATCH',
          'match completion must include every persisted participant',
        );
      }
      const completed: QueueEntry[] = [];
      for (const id of queueEntryIds) {
        const entry = this.requireEntry(state, id);
        const snapshot = own(state.queueEntryConfigs, id);
        if (entry.status !== 'PLAYING' || snapshot?.matchId !== matchId) {
          throw new ArcadeServiceError('MATCH_NOT_ACTIVE', `queue entry ${id} is not playing in match ${matchId}`);
        }
        const reduction = reduceQueueEntry(entry, {
          type: 'COMPLETE', eventId: this.id('queue-event'), at, reason,
        });
        this.applyQueueReduction(state, reduction);
        completed.push(reduction.entry);
      }
      return completed;
    });
  }

  async releaseQueueEntry(input: OperatorQueueEntryActionInput): Promise<QueueEntryResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    const queueEntryId = requireIdentifier(input.queueEntryId, 'queueEntryId');
    const principal = this.authorizeOperator(input.authorization, 'QUEUE_ACTION_UNAUTHORIZED');
    const reason = operatorAuditReason(principal, input.reason);
    return this.execute('RELEASE_QUEUE_ENTRY', input.idempotencyKey, playerId, {
      playerId, queueEntryId, reason, authorizedBy: principal,
    }, (state, config, at) => {
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
      const reduction = reduceQueueEntry(entry, {
        type: 'RELEASE', eventId: this.id('queue-event'), at, reason,
      });
      this.applyQueueReduction(state, reduction);
      this.releaseActiveReservation(state, reduction.entry, input.idempotencyKey, config, at);
      return queueResult(state, reduction.entry);
    });
  }

  async leaveQueue(input: QueueEntryActionInput): Promise<QueueEntryResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    const queueEntryId = requireIdentifier(input.queueEntryId, 'queueEntryId');
    return this.execute('LEAVE_QUEUE', input.idempotencyKey, playerId, {
      playerId, queueEntryId, reason: input.reason ?? null,
    }, (state, config, at) => {
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
      const reduction = reduceQueueEntry(entry, {
        type: 'LEAVE', eventId: this.id('queue-event'), at, reason: input.reason,
      });
      this.applyQueueReduction(state, reduction);
      this.releaseActiveReservation(state, reduction.entry, input.idempotencyKey, config, at);
      return queueResult(state, reduction.entry);
    });
  }

  async refundQueueEntry(input: RefundArcadeQueueEntryInput): Promise<QueueEntryResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    const queueEntryId = requireIdentifier(input.queueEntryId, 'queueEntryId');
    const reason = requireReason(input.reason);
    const principal = this.authorizeOperator(input.authorization, 'REFUND_UNAUTHORIZED');
    const principalKind = principal.kind;
    const subject = principal.subject;
    return this.execute('REFUND_QUEUE_ENTRY', input.idempotencyKey, playerId, {
      playerId, queueEntryId, reason, authorizedBy: { kind: principalKind, subject },
    }, (state, _config, at) => {
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
      const captured = own(state.queueEntryConfigs, queueEntryId);
      if (!captured?.refundOnLobbyTimeout || (entry.status !== 'PLAYING' && entry.status !== 'COMPLETED')) {
        throw new ArcadeServiceError('REFUND_NOT_ELIGIBLE', 'captured policy does not permit this refund');
      }
      const current = this.requireWallet(state, playerId);
      const reservation = findReservation(current, queueEntryId);
      if (!reservation) throw new ArcadeServiceError('RESERVATION_NOT_FOUND', 'queue entry has no reservation');
      const wallet = refundReservation(current, {
        reservationId: reservation.id,
        transactionId: this.id('wallet-transaction'),
        idempotencyKey: `${input.idempotencyKey}:refund`,
        createdAt: at,
        configVersion: captured.configVersion,
        metadata: { reason, authorizedBy: { kind: principalKind, subject } },
      });
      state.wallets[playerId] = wallet;
      return queueResult(state, entry);
    });
  }

  processInboundStationMessage(
    input: ProcessInboundStationMessageInput,
  ): Promise<ProcessInboundStationMessageResult> {
    if (input.channel !== 'sms' && input.channel !== 'whatsapp') {
      throw new ArcadeServiceError('INVALID_INPUT', 'messaging channel is invalid');
    }
    const normalizedAddress = requireIdentifier(input.normalizedAddress, 'normalizedAddress');
    const providerAddress = requireIdentifier(input.providerAddress, 'providerAddress');
    const providerMessageId = requireIdentifier(input.providerMessageId, 'providerMessageId');
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const conversationProfileId = input.conversationProfileId
      ? requireIdentifier(input.conversationProfileId, 'conversationProfileId')
      : null;
    const conversationId = input.conversationId
      ? requireIdentifier(input.conversationId, 'conversationId')
      : null;
    if (!/^\+[1-9][0-9]{7,14}$/.test(normalizedAddress)) {
      throw new ArcadeServiceError('INVALID_INPUT', 'normalizedAddress must be E.164');
    }
    if (typeof input.body !== 'string' || Buffer.byteLength(input.body, 'utf8') > 2_000) {
      throw new ArcadeServiceError('INVALID_INPUT', 'message body is invalid');
    }
    const body = input.body.trim();
    const normalizedCommand = normalizeMessagingText(body);
    const requestedLocale = normalizeMessagingLocale(input.preferredLocale);
    const parsedJoin = parseJoinCommand(normalizedCommand);
    const fallbackLocale = normalizeMessagingLocale(
      parsedJoin?.locale ?? parsedJoin?.inferredLocale ?? requestedLocale,
    );
    const payload = {
      body, channel: input.channel, normalizedAddress, providerAddress, providerMessageId,
      ...(conversationProfileId ? { conversationProfileId } : {}),
      ...(conversationId ? { conversationId } : {}),
    };
    const requestFingerprint = fingerprint(payload);
    const pending = this.execute<ProcessInboundStationMessageResult>(
      'PROCESS_STATION_MESSAGE', input.idempotencyKey, null, payload,
      (state, config, at) => {
        this.requireOn(config);
        pruneInactiveMessagingPlayers(
          state,
          Date.parse(at) - this.messagingRetentionMs,
          this.messagingPruneBatchSize,
        );
        const join = parsedJoin;
        let address = Object.values(state.channelAddresses).find(candidate => (
          candidate.channel === input.channel && candidate.normalizedAddress === normalizedAddress
        ));
        const linked = Object.values(state.channelAddresses).find(candidate => (
          candidate.normalizedAddress === normalizedAddress
        ));
        const activeProfileId = conversationProfileId && !isRetiredProfile(state, conversationProfileId)
          ? conversationProfileId
          : null;
        const profilePlayers = activeProfileId
          ? Object.values(state.players).filter(candidate => candidate.conversationProfileId === activeProfileId)
          : [];
        if (profilePlayers.length > 1) {
          throw new ArcadeServiceError('CONVERSATION_PROFILE_CONFLICT', 'Conversation Memory profile is linked to multiple players');
        }
        const profilePlayerId = profilePlayers[0]?.id ?? null;
        const addressPlayerId = address?.playerId ?? linked?.playerId ?? null;
        if (profilePlayerId && addressPlayerId && profilePlayerId !== addressPlayerId) {
          throw new ArcadeServiceError('CONVERSATION_PROFILE_CONFLICT', 'messaging address and Conversation Memory profile identify different players');
        }
        let playerId = addressPlayerId ?? profilePlayerId;
        let locale = normalizeMessagingLocale(
          join?.locale ?? join?.inferredLocale ?? address?.preferredLocale
          ?? (playerId ? state.players[playerId]?.preferredLocale : null)
          ?? requestedLocale,
        );
        const finish = (
          command: string,
          reply: string,
          stationRevision: number | null = null,
        ): ProcessInboundStationMessageResult => {
          if (command === 'CAPACITY') pruneCapacityInboundMessages(state);
          else pruneInboundMessages(state);
          if (address) {
            address = { ...address, preferredLocale: locale, lastSeenAt: at };
            state.channelAddresses[address.id] = address;
          }
          state.inboundMessages[input.idempotencyKey] = {
            id: input.idempotencyKey,
            providerMessageId,
            channelAddressId: address?.id ?? null,
            requestFingerprint,
            command,
            reply,
            receivedAt: at,
            configVersion: config.version,
          };
          return { reply, playerId, command, locale, stationRevision };
        };

        if (join && join.stationId !== null && join.stationId !== stationId.toUpperCase()) {
          return finish('JOIN', messagingCopy(locale, 'wrongStation', { station: stationId }));
        }
        if (!playerId && !join) {
          return finish('UNKNOWN', messagingCopy(locale, 'joinFirst', { station: stationId }));
        }
        if (!playerId && join) {
          const browserLeads = Object.values(state.players).filter(player => (
            player.lead?.phoneNumber === normalizedAddress
            && player.trustedDestination === null
            && !Object.values(state.channelAddresses).some(candidate => candidate.playerId === player.id)
          ));
          if (browserLeads.length === 1) {
            playerId = browserLeads[0]!.id;
          }
        }
        if (!playerId) {
          const stateBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
          if (Object.keys(state.players).length >= this.messagingIdentityCapacity
            || stateBytes >= this.messagingStateAdmissionMaxBytes) {
            if (stateBytes >= ARCADE_STATE_MAX_FILE_BYTES - ARCADE_MESSAGING_CAPACITY_RESPONSE_HEADROOM) {
              throw new ArcadeServiceError(
                'MESSAGING_CAPACITY_EXHAUSTED',
                'messaging capacity response cannot be persisted safely',
              );
            }
            return finish(
              'CAPACITY',
              messagingCopy(locale, 'capacity'),
            );
          }
          playerId = this.id('channel-player');
          state.players[playerId] = {
            id: playerId, createdAt: at, updatedAt: at, lead: null,
            preferredLocale: locale, conversationProfileId: activeProfileId, crmLeadId: null,
            termsAcceptedAt: null, marketingConsent: false, trustedDestination: providerAddress,
          };
          state.wallets[playerId] = createWallet(playerId, at);
        }
        if (!address) {
          address = {
            id: this.id('channel-address'), playerId, channel: input.channel,
            normalizedAddress, providerAddress, preferredLocale: locale,
            firstSeenAt: at, lastSeenAt: at,
          };
          state.channelAddresses[address.id] = address;
        }
        let player = own(state.players, playerId)!;
        if (activeProfileId && player.conversationProfileId
          && player.conversationProfileId !== activeProfileId) {
          throw new ArcadeServiceError(
            'CONVERSATION_PROFILE_CONFLICT',
            'messaging identity is linked to another Conversation Memory profile',
          );
        }
        if (activeProfileId && player.conversationProfileId !== activeProfileId) {
          player = { ...player, conversationProfileId: activeProfileId, updatedAt: at };
          state.players[playerId] = player;
        }
        if (player.trustedDestination !== providerAddress) {
          player = { ...player, trustedDestination: providerAddress, updatedAt: at };
          state.players[playerId] = player;
        }
        let draft = own(state.messagingDrafts, playerId);
        const draftStationId = join ? stationId : draft?.stationId ?? stationId;
        const freePlay = config.coins.chargePolicy === 'free';

        if (config.arcade.mode === 'coin_only') {
          const firstName = draft?.firstName?.trim() || player.lead?.firstName.trim() || null;
          const legacyTermsPending = draft?.step === 'TERMS' && firstName === null
            && config.registration.termsAcknowledgementRequired && !player.termsAcceptedAt;
          draft = {
            ...(draft ?? createMessagingDraft(playerId, draftStationId, at)),
            stationId: draftStationId,
            firstName,
            step: legacyTermsPending
              ? 'TERMS'
              : firstName === null
              ? 'FIRST_NAME'
              : config.registration.termsAcknowledgementRequired && !player.termsAcceptedAt
                ? 'TERMS'
                : 'COMPLETE',
            updatedAt: at,
          };
          state.messagingDrafts[playerId] = draft;
          if (draft.step === 'COMPLETE' && !freePlay) {
            this.ensureWalletAndStartingGrant(state, playerId, `${input.idempotencyKey}:grant`, config, at);
          }
        } else if (!player.lead && (!draft || !isLeadCaptureDraft(draft))) {
          draft = createMessagingDraft(playerId, draftStationId, at);
          state.messagingDrafts[playerId] = draft;
        }

        if (join) {
          const currentDraft = state.messagingDrafts[playerId];
          if (currentDraft) {
            draft = { ...currentDraft, stationId, updatedAt: at };
          } else if (config.arcade.mode === 'coin_only') {
            draft = { ...createMessagingDraft(playerId, stationId, at), step: 'COMPLETE' };
          }
          if (draft) state.messagingDrafts[playerId] = draft;
          if (config.arcade.mode === 'coin_only' && draft && draft.step !== 'COMPLETE') {
            return finish('JOIN', messagingPrompt(locale, draft));
          }
          if (config.arcade.mode === 'lead_capture' && !own(state.players, playerId)?.lead) {
            return finish('JOIN', messagingPrompt(locale, state.messagingDrafts[playerId]!));
          }
          if (freePlay) return finish('JOIN', messagingCopy(locale, 'joinedFree'));
          const balance = availableBalance(this.requireWallet(state, playerId));
          return finish('JOIN', messagingCopy(locale, 'joined', { balance }));
        }

        const command = messagingCommand(normalizedCommand);
        const gameChoice = parseMessagingGameChoice(normalizedCommand);
        if (config.arcade.mode === 'coin_only' && draft?.step === 'FIRST_NAME') {
          const firstName = body.trim();
          if (command === 'LEAVE') {
            // Legacy unnamed players must still be able to release an existing reservation.
          } else if (command !== 'TEXT' || gameChoice !== null || !validMessagingText(firstName, 50)) {
            return finish(command, messagingPrompt(locale, draft));
          } else {
            draft = {
              ...draft,
              firstName,
              step: config.registration.termsAcknowledgementRequired && !player.termsAcceptedAt
                ? 'TERMS'
                : 'COMPLETE',
              updatedAt: at,
            };
            state.messagingDrafts[playerId] = draft;
            if (draft.step === 'TERMS') return finish('REGISTER', messagingPrompt(locale, draft));
            if (freePlay) return finish('REGISTER', messagingCopy(locale, 'namedFree', { name: firstName }));
            const wallet = this.ensureWalletAndStartingGrant(state, playerId, `${input.idempotencyKey}:grant`, config, at);
            return finish('REGISTER', messagingCopy(locale, 'named', {
              name: firstName,
              balance: availableBalance(wallet),
            }));
          }
        }
        if (config.arcade.mode === 'coin_only' && draft?.step === 'TERMS') {
          if (!['YES', 'SIM'].includes(normalizedCommand)) {
            return finish(command, messagingPrompt(locale, draft));
          }
          state.players[playerId] = { ...player, termsAcceptedAt: at, updatedAt: at };
          if (draft.firstName === null) {
            const nameDraft = { ...draft, step: 'FIRST_NAME' as const, updatedAt: at };
            state.messagingDrafts[playerId] = nameDraft;
            return finish('REGISTER', messagingPrompt(locale, nameDraft));
          }
          state.messagingDrafts[playerId] = { ...draft, step: 'COMPLETE', updatedAt: at };
          if (freePlay) return finish('REGISTER', messagingCopy(locale, 'namedFree', { name: draft.firstName! }));
          const wallet = this.ensureWalletAndStartingGrant(state, playerId, `${input.idempotencyKey}:grant`, config, at);
          return finish('REGISTER', messagingCopy(locale, 'named', {
            name: draft.firstName!,
            balance: availableBalance(wallet),
          }));
        }

        if (config.arcade.mode === 'lead_capture' && !own(state.players, playerId)?.lead) {
          draft = state.messagingDrafts[playerId] ?? createMessagingDraft(playerId, stationId, at);
          if (command !== 'TEXT') {
            return finish(command, messagingPrompt(locale, draft));
          }
          const advanced = advanceMessagingDraft(
            draft, body, at, locale, config.registration.termsAcknowledgementRequired,
          );
          state.messagingDrafts[playerId] = advanced.draft;
          if (advanced.completed) {
            const normalized = createPlayer({
              id: playerId,
              createdAt: own(state.players, playerId)?.createdAt ?? at,
              lead: {
                firstName: advanced.draft.firstName!, lastName: advanced.draft.lastName!,
                workEmail: advanced.draft.workEmail!, companyName: advanced.draft.companyName!,
                phoneNumber: normalizedAddress, countryCode: advanced.draft.countryCode!,
              },
              preferredLocale: locale,
              termsAcceptedAt: config.registration.termsAcknowledgementRequired
                ? at
                : own(state.players, playerId)?.termsAcceptedAt ?? null,
              marketingConsent: false,
            });
            state.players[playerId] = {
              id: playerId, createdAt: normalized.createdAt, updatedAt: at,
              lead: {
                firstName: normalized.firstName, lastName: normalized.lastName,
                workEmail: normalized.workEmail, companyName: normalized.companyName,
                phoneNumber: normalized.phoneNumber, countryCode: normalized.countryCode,
              },
              preferredLocale: normalized.preferredLocale,
              conversationProfileId: activeProfileId ?? own(state.players, playerId)?.conversationProfileId ?? null,
              crmLeadId: null,
              termsAcceptedAt: config.registration.termsAcknowledgementRequired
                ? at
                : own(state.players, playerId)?.termsAcceptedAt ?? null,
              marketingConsent: false, trustedDestination: providerAddress,
            };
            if (freePlay) return finish('REGISTER', messagingCopy(locale, 'registeredFree'));
            const wallet = this.ensureWalletAndStartingGrant(state, playerId, `${input.idempotencyKey}:grant`, config, at);
            return finish('REGISTER', messagingCopy(locale, 'registered', { balance: availableBalance(wallet) }));
          }
          return finish('REGISTER', advanced.reply);
        }

        if ((['COIN', 'READY', 'STATUS', 'LEAVE', 'MORE'].includes(command) || gameChoice !== null)
          && state.messagingDrafts[playerId]?.stationId !== stationId) {
          return finish(command, messagingCopy(locale, 'joinFirst'));
        }

        if (command === 'HELP') return finish(command, messagingCopy(locale, freePlay ? 'helpFree' : 'help'));
        if (command === 'MORE') {
          const wallet = this.requireWallet(state, playerId);
          const available = availableEarningChallenges(config, wallet, at);
          const page = messagingMorePage(normalizedCommand) ?? 1;
          const challenge = available[page - 1];
          if (!challenge) return finish(command, messagingCopy(locale, 'moreNone'));
          const portuguese = normalizeMessagingLocale(locale) === 'pt-BR';
          const custom = challenge.message ?? (portuguese
            ? `Visite ${challenge.title} para ganhar ${challenge.rewardCoins} moeda${challenge.rewardCoins === 1 ? '' : 's'}.`
            : `Visit ${challenge.title} to earn ${challenge.rewardCoins} coin${challenge.rewardCoins === 1 ? '' : 's'}.`);
          const link = this.challengeClaimLink(playerId, challenge.id, config.arcade.cabinetId, at, normalizeMessagingLocale(locale));
          const next = page < available.length
            ? `\n\n${messagingCopy(locale, 'morePage', { page: page + 1 })}`
            : '';
          return finish(command, `${custom}\n\nClaim +${challenge.rewardCoins}: ${link}${next}`);
        }
        const entry = Object.values(state.stationReadyEntries)
          .find(candidate => candidate.playerId === playerId && !['COMPLETED', 'LEFT'].includes(candidate.status));
        const aggregate = entry ? this.stationAggregate(state, entry.stationId) : this.stationAggregate(state, stationId);
        const choiceOptions = messagingGameChoiceOptions(config, locale);
        if (command === 'STATUS') {
          const wallet = this.requireWallet(state, playerId);
          return finish(command, messagingCopy(locale, freePlay ? 'statusFree' : 'status', {
            balance: availableBalance(wallet),
            status: entry?.status ?? 'NOT READY',
            next: messagingStatusNext(locale, freePlay, aggregate, entry, choiceOptions),
          }));
        }

        const entryRound = entry && aggregate ? aggregate.rounds[entry.roundId] : undefined;
        const selectionDeadline = entryRound?.selectionEndsAt
          ? Date.parse(entryRound.selectionEndsAt)
          : Number.NaN;
        const selectionIsOpen = Boolean(entry && aggregate
          && entry.status === 'READY'
          && aggregate.station.phase === 'GAME_SELECTION'
          && aggregate.station.activeRoundId === entry.roundId
          && Number.isFinite(selectionDeadline)
          && Date.parse(at) < selectionDeadline);
        const selectionHasClosed = Boolean(entry && aggregate
          && aggregate.station.activeRoundId === entry.roundId
          && entryRound?.selectionStartedAt
          && Number.isFinite(selectionDeadline)
          && Date.parse(at) >= selectionDeadline);
        if (gameChoice !== null) {
          if (selectionHasClosed) {
            return finish('GAME_CHOICE', messagingCopy(locale, 'gameChoiceClosed'));
          }
          if (!selectionIsOpen) {
            return finish('GAME_CHOICE', messagingCopy(locale, 'gameChoiceUnavailable', { choices: choiceOptions }));
          }
          if (!config.station.games[gameChoice].enabled) {
            return finish('GAME_CHOICE', messagingCopy(locale, 'gameChoiceInvalid', { choices: choiceOptions }));
          }
          const updated = reduceRecordStationGameChoice(aggregate!, {
            readyEntryId: entry!.id,
            roundId: entry!.roundId,
            game: gameChoice,
            at,
            expectedRevision: aggregate!.station.revision,
          });
          this.persistStationAggregate(state, updated);
          return finish('GAME_CHOICE', messagingCopy(locale, 'gameChoice', {
            game: MESSAGING_GAME_CHOICE_NAMES[normalizeMessagingLocale(locale)][gameChoice],
            choices: choiceOptions,
          }), updated.station.revision);
        }
        if (command === 'TEXT' && selectionIsOpen) {
          return finish('GAME_CHOICE', messagingCopy(locale, 'gameChoiceInvalid', { choices: choiceOptions }));
        }

        if (command === 'LEAVE') {
          if (!entry) return finish(command, messagingCopy(locale, freePlay ? 'notReadyFree' : 'notReady'));
          if (entry.status === 'ADMITTED' || entry.status === 'PLAYING') {
            return finish(command, messagingCopy(locale, 'cannotLeave'));
          }
          const aggregate = this.requireStationAggregate(state, entry.stationId);
          const wallet = this.requireWallet(state, playerId);
          const reservation = entry.reservationId === null
            ? null
            : wallet.reservations.find(candidate => candidate.id === entry.reservationId);
          if (entry.reservationId !== null && (!reservation || reservation.status !== 'ACTIVE')) {
            return finish(command, messagingCopy(locale, freePlay ? 'notReadyFree' : 'notReady'));
          }
          const updated = reduceLeaveStationReadyEntry(aggregate, {
            readyEntryId: entry.id, at, expectedRevision: aggregate.station.revision,
          }, this.stationTiming(config));
          if (reservation) state.wallets[playerId] = releaseReservation(wallet, {
            reservationId: reservation.id, transactionId: this.id('wallet-transaction'),
            idempotencyKey: `${input.idempotencyKey}:release`, createdAt: at,
            configVersion: reservation.configVersion,
          });
          this.persistStationAggregate(state, updated);
          delete state.stationReadyChannels[entry.id];
          return finish(command, messagingCopy(locale, freePlay ? 'leftFree' : 'left'), updated.station.revision);
        }

        if (command === 'COIN' || command === 'READY') {
          let wallet = this.requireWallet(state, playerId);
          if (entry) {
            return finish(command, selectionIsOpen
              ? messagingCopy(locale, 'alreadyReadyVote', { choices: choiceOptions })
              : messagingCopy(locale, 'alreadyReady'));
          }
          if (!freePlay && availableBalance(wallet) < STATION_COIN_COST) {
            return finish(command, messagingCopy(locale, 'noCoins'));
          }
          const aggregate = this.stationAggregate(state, stationId) ?? createArcadeStation(stationId, at);
          try {
            this.requireStationReadyCapacity(aggregate);
          } catch (error) {
            if (error instanceof ArcadeServiceError && error.code === 'READY_POOL_FULL') {
              return finish(command, messagingCopy(locale, freePlay ? 'poolFullFree' : 'poolFull'));
            }
            throw error;
          }
          const readyEntryId = this.id('station-ready-entry');
          const reservationId = freePlay ? null : this.id('wallet-reservation');
          const reserved = reservationId === null ? wallet : reserveCoins(wallet, {
            reservationId, queueEntryId: readyEntryId, amount: STATION_COIN_COST,
            transactionId: this.id('wallet-transaction'), idempotencyKey: `${input.idempotencyKey}:reserve`,
            createdAt: at, configVersion: config.version,
          });
          const updated = reduceInsertStationCoin(aggregate, {
            readyEntryId, roundId: this.id('station-round'), playerId, reservationId,
            at, configVersion: config.version, expectedRevision: aggregate.station.revision,
          }, this.stationTiming(config));
          state.wallets[playerId] = reserved;
          this.persistStationAggregate(state, updated);
          state.stationReadyChannels[readyEntryId] = {
            readyEntryId,
            channelAddressId: address!.id,
            consentedAt: at,
          };
          const position = stationReadyPosition(updated, readyEntryId);
          const proactiveNotices = this.notificationsEnabled(address!.channel)
            && config.channels[address!.channel]
            && config.channels.voice
            && this.notificationCallNumber(config, normalizeMessagingLocale(locale)) !== null;
          return finish(command, freePlay
            ? messagingCopy(locale, proactiveNotices ? 'readyFree' : 'readyFreeScreen', {
              choices: choiceOptions, position,
            })
            : messagingCopy(locale, proactiveNotices ? 'coin' : 'coinScreen', {
              balance: availableBalance(reserved), choices: choiceOptions, position,
            }),
          updated.station.revision);
        }

        return finish(command, messagingCopy(locale, freePlay ? 'helpFree' : 'help'));
      },
      undefined,
      messagingCommand(normalizedCommand) === 'LEAVE',
    );
    return pending.then(result => {
      if (result.stationRevision !== null) this.stationUpdated?.(result.stationRevision);
      return result;
    }).catch(error => {
      if (error instanceof ArcadeServiceError && error.code === 'MESSAGING_CAPACITY_EXHAUSTED') {
        return {
          reply: messagingCopy(fallbackLocale, 'capacity'),
          playerId: null,
          command: 'CAPACITY',
          locale: fallbackLocale,
          stationRevision: null,
        };
      }
      throw error;
    });
  }

  async getStation(stationIdInput: string): Promise<ArcadeStationAggregate | null> {
    const stationId = requireIdentifier(stationIdInput, 'stationId');
    return this.stationAggregate(await this.store.read(), stationId);
  }

  insertStationCoin(input: InsertStationCoinInput): Promise<StationReadyResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const playerId = requireIdentifier(input.playerId, 'playerId');
    return this.publishStation(this.execute('INSERT_STATION_COIN', input.idempotencyKey, playerId, {
      stationId, playerId,
    }, (state, config, at) => {
      this.requireOn(config);
      this.requirePlayer(state, playerId);
      const aggregate = this.stationAggregate(state, stationId) ?? createArcadeStation(stationId, at);
      this.requireStationReadyCapacity(aggregate);
      const readyEntryId = this.id('station-ready-entry');
      const reservationId = config.coins.chargePolicy === 'free' ? null : this.id('wallet-reservation');
      const currentWallet = this.requireWallet(state, playerId);
      const wallet = reservationId === null ? currentWallet : reserveCoins(currentWallet, {
        reservationId, queueEntryId: readyEntryId, amount: STATION_COIN_COST,
        transactionId: this.id('wallet-transaction'), idempotencyKey: `${input.idempotencyKey}:reserve`,
        createdAt: at, configVersion: config.version,
      });
      const updated = reduceInsertStationCoin(aggregate, {
        readyEntryId,
        roundId: this.id('station-round'),
        playerId,
        reservationId,
        at,
        configVersion: config.version,
        expectedRevision: aggregate.station.revision,
      }, this.stationTiming(config));
      state.wallets[playerId] = wallet;
      this.persistStationAggregate(state, updated);
      delete state.stationReadyChannels[readyEntryId];
      return {
        ...stationResult(updated),
        readyEntry: updated.readyEntries[readyEntryId]!,
        reservation: reservationId === null
          ? null
          : wallet.reservations.find(candidate => candidate.id === reservationId)!,
        availableBalance: availableBalance(wallet),
      };
    }));
  }

  recordStationGameChoice(input: RecordStationGameChoiceInput): Promise<StationGameChoiceResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const playerId = requireIdentifier(input.playerId, 'playerId');
    if (!isPlayableArcadeGame(input.game)) {
      throw new ArcadeServiceError('INVALID_GAME', 'game is not station-playable');
    }
    let updatedRevision: number | null = null;
    const pending = this.execute<StationGameChoiceResult>(
      'RECORD_STATION_GAME_CHOICE',
      input.idempotencyKey,
      playerId,
      { stationId, playerId, game: input.game },
      (state, config, at) => {
        this.requireOn(config);
        this.requirePlayer(state, playerId);
        if (!config.station.games[input.game].enabled) {
          throw new ArcadeServiceError('GAME_DISABLED', `${input.game} is disabled for this station`);
        }
        const aggregate = this.requireStationAggregate(state, stationId);
        if (aggregate.station.phase !== 'GAME_SELECTION' || !aggregate.station.activeRoundId) {
          throw new ArcadeServiceError('SELECTION_NOT_ACTIVE', 'game selection is not active');
        }
        const entry = Object.values(aggregate.readyEntries).find(candidate => (
          candidate.playerId === playerId
          && candidate.roundId === aggregate.station.activeRoundId
          && candidate.status === 'READY'
        ));
        if (!entry) {
          throw new ArcadeServiceError('READY_ENTRY_NOT_READY', 'player has no current ready entry');
        }
        const updated = reduceRecordStationGameChoice(aggregate, {
          readyEntryId: entry.id,
          roundId: entry.roundId,
          game: input.game,
          at,
          expectedRevision: aggregate.station.revision,
        });
        this.persistStationAggregate(state, updated);
        updatedRevision = updated.station.revision;
        return Object.freeze({ gameChoice: input.game });
      },
    );
    return pending.then(result => {
      if (updatedRevision !== null) this.stationUpdated?.(updatedRevision);
      return result;
    });
  }

  leaveStationReadyEntry(input: LeaveStationReadyEntryInput): Promise<StationReadyResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const playerId = requireIdentifier(input.playerId, 'playerId');
    const readyEntryId = requireIdentifier(input.readyEntryId, 'readyEntryId');
    const expectedRevision = requirePositiveInteger(input.expectedRevision, 'expectedRevision');
    return this.publishStation(this.execute('LEAVE_STATION_READY_ENTRY', input.idempotencyKey, playerId, {
      stationId, playerId, readyEntryId, expectedRevision,
    }, (state, config, at) => {
      const aggregate = this.requireStationAggregate(state, stationId);
      const entry = own(aggregate.readyEntries, readyEntryId);
      if (!entry) throw new ArcadeServiceError('READY_ENTRY_NOT_FOUND', `ready entry ${readyEntryId} was not found`);
      if (entry.playerId !== playerId) {
        throw new ArcadeServiceError('READY_ENTRY_FORBIDDEN', 'ready entry belongs to another player');
      }
      const currentWallet = this.requireWallet(state, playerId);
      const reservation = entry.reservationId === null
        ? null
        : currentWallet.reservations.find(candidate => candidate.id === entry.reservationId);
      if (entry.reservationId !== null && (!reservation || reservation.status !== 'ACTIVE')) {
        throw new ArcadeServiceError('RESERVATION_NOT_ACTIVE', 'ready entry has no active reservation');
      }
      const activeReservation = reservation ?? null;
      const updated = reduceLeaveStationReadyEntry(
        aggregate, { readyEntryId, at, expectedRevision }, this.stationTiming(config),
      );
      const wallet = activeReservation === null ? currentWallet : releaseReservation(currentWallet, {
        reservationId: activeReservation.id,
        transactionId: this.id('wallet-transaction'),
        idempotencyKey: `${input.idempotencyKey}:release`,
        createdAt: at,
        configVersion: activeReservation.configVersion,
      });
      state.wallets[playerId] = wallet;
      this.persistStationAggregate(state, updated);
      return {
        ...stationResult(updated),
        readyEntry: updated.readyEntries[readyEntryId]!,
        reservation: activeReservation === null
          ? null
          : wallet.reservations.find(candidate => candidate.id === activeReservation.id)!,
        availableBalance: availableBalance(wallet),
      };
    }));
  }

  grantStationPlayerCoins(input: GrantStationPlayerCoinsInput): Promise<{
    playerId: string;
    readyEntryId: string;
    availableBalance: number;
  }> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const readyEntryId = requireIdentifier(input.readyEntryId, 'readyEntryId');
    const amount = requirePositiveInteger(input.amount, 'amount');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    const reason = requireReason(input.reason);
    let stationRevision = 0;
    const pending = this.execute('GRANT_STATION_COINS', input.idempotencyKey, null, {
      stationId, readyEntryId, amount, reason, authorizedBy: principal,
    }, (state, config, at) => {
      const entry = own(state.stationReadyEntries, readyEntryId);
      if (!entry || entry.stationId !== stationId || entry.status === 'LEFT') {
        throw new ArcadeServiceError('READY_ENTRY_NOT_FOUND', 'active player entry was not found');
      }
      const wallet = grantOperatorCoins(this.requireWallet(state, entry.playerId), {
        amount,
        transactionId: this.id('wallet-transaction'),
        idempotencyKey: `${input.idempotencyKey}:grant`,
        createdAt: at,
        configVersion: config.version,
        metadata: {
          source: 'operator',
          reason,
          readyEntryId,
          stationId,
          authorizedBy: principal,
        },
      });
      state.wallets[entry.playerId] = wallet;
      stationRevision = state.stations[stationId]?.revision ?? 0;
      return {
        playerId: entry.playerId,
        readyEntryId,
        availableBalance: availableBalance(wallet),
      };
    });
    return pending.then(result => {
      if (stationRevision > 0) this.stationUpdated?.(stationRevision);
      return result;
    });
  }

  restorePlayerStartingBalance(input: RestorePlayerStartingBalanceInput): Promise<{
    restored: boolean;
    amountGranted: number;
    targetBalance: number;
    availableBalance: number;
  }> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    const expectedConfigVersion = requirePositiveInteger(input.expectedConfigVersion, 'expectedConfigVersion');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    const reason = requireReason(input.reason);
    return this.execute('RESTORE_PLAYER_STARTING_BALANCE', input.idempotencyKey, null, {
      playerId, expectedConfigVersion, reason, authorizedBy: principal,
    }, (state, config, at) => {
      if (config.version !== expectedConfigVersion) {
        throw new ArcadeServiceError('STALE_CONFIG_VERSION', 'configuration version changed');
      }
      if (config.coins.chargePolicy !== 'per_player' || config.coins.startingBalance < 1) {
        throw new ArcadeServiceError('PLAYER_BALANCE_RESTORE_UNAVAILABLE', 'starting balance restoration requires paid per-player play');
      }
      const player = this.requirePlayer(state, playerId);
      if (player.id.startsWith('reset-player:') || isRetiredPlayer(state, playerId)) {
        throw new ArcadeServiceError('PLAYER_NOT_FOUND', 'player was reset');
      }
      const draft = own(state.messagingDrafts, playerId);
      if (!player.lead && draft?.step !== 'COMPLETE') {
        throw new ArcadeServiceError('PLAYER_NOT_FOUND', 'completed messaging player was not found');
      }
      const current = this.requireWallet(state, playerId);
      if (!current.transactions.some(transaction => transaction.type === 'registration_grant')) {
        throw new ArcadeServiceError('PLAYER_BALANCE_RESTORE_UNAVAILABLE', 'player has no paid registration grant');
      }
      const before = deriveLedger(current.transactions, current.reservations);
      if (before.reservedBalance !== 0 || current.reservations.some(reservation => reservation.status === 'ACTIVE')
        || Object.values(state.stationReadyEntries).some(entry => entry.playerId === playerId
          && !['COMPLETED', 'LEFT'].includes(entry.status))
        || Object.values(state.queueEntries).some(entry => entry.playerId === playerId
          && !isTerminalQueueStatus(entry.status))) {
        throw new ArcadeServiceError('PLAYER_ACTIVE_ADMISSION', 'player has an active game or coin hold');
      }
      if (before.availableBalance !== 0) {
        throw new ArcadeServiceError('PLAYER_BALANCE_CHANGED', 'player balance is no longer zero');
      }
      const amount = Math.max(0, config.coins.startingBalance - before.availableBalance);
      const wallet = grantOperatorCoins(current, {
        amount,
        transactionId: this.id('wallet-transaction'),
        idempotencyKey: `${input.idempotencyKey}:restore`,
        createdAt: at,
        configVersion: config.version,
        metadata: {
          source: 'operator', action: 'restore_starting_balance', reason,
          authorizedBy: principal, configuredStartingBalance: config.coins.startingBalance,
          previousAvailableBalance: before.availableBalance,
        },
      });
      state.wallets[playerId] = wallet;
      return {
        restored: true, amountGranted: amount, targetBalance: config.coins.startingBalance,
        availableBalance: availableBalance(wallet),
      };
    });
  }

  dropStationAdmittedEntry(input: DropStationAdmittedEntryInput): Promise<StationMutationResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const readyEntryId = requireIdentifier(input.readyEntryId, 'readyEntryId');
    const expectedRevision = requirePositiveInteger(input.expectedRevision, 'expectedRevision');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    const reason = requireReason(input.reason);
    return this.publishStation(this.execute('DROP_STATION_ADMITTED_ENTRY', input.idempotencyKey, null, {
      stationId, readyEntryId, expectedRevision, reason, authorizedBy: principal,
    }, (state, config, at) => {
      if (config.arcade.mode === 'off' && principal.kind === 'operator') {
        throw new ArcadeServiceError(
          'PAUSED_EVENT_RESET_REQUIRED',
          'the paused event flow must be reset before removing a player',
        );
      }
      const aggregate = this.requireStationAggregate(state, stationId);
      const beforeMatch = aggregate.station.activeMatchId
        ? aggregate.matches[aggregate.station.activeMatchId]
        : undefined;
      const entry = aggregate.readyEntries[readyEntryId];
      if (!entry || !beforeMatch) throw new ArcadeServiceError('READY_ENTRY_NOT_FOUND', 'admitted player was not found');
      const updated = reduceDropStationAdmittedEntry(aggregate, { readyEntryId, at, expectedRevision });
      const wallet = this.requireWallet(state, entry.playerId);
      const reservation = entry.reservationId
        ? wallet.reservations.find(candidate => candidate.id === entry.reservationId)
        : undefined;
      if (reservation?.status === 'ACTIVE') {
        state.wallets[entry.playerId] = releaseReservation(wallet, {
          reservationId: reservation.id,
          transactionId: this.id('wallet-transaction'),
          idempotencyKey: `${input.idempotencyKey}:release`,
          createdAt: at,
          configVersion: reservation.configVersion,
          metadata: { reason, authorizedBy: principal },
        });
      }
      delete state.stationReadyChannels[readyEntryId];
      this.persistStationAggregate(state, updated);
      this.recordStationControlEvent(
        state, 'DROP_STATION_ADMITTED_ENTRY', aggregate, updated, principal, reason, at, config.version,
      );
      const afterMatch = updated.matches[beforeMatch.id]!;
      for (const promotedId of afterMatch.participantReadyEntryIds
        .filter(id => !beforeMatch.participantReadyEntryIds.includes(id))) {
        const promoted = afterMatch && updated.readyEntries[promotedId];
        if (!promoted) continue;
        this.enqueueStationNotification(state, config, 'STATION_ADMITTED', afterMatch, promoted, at);
        if (updated.station.phase === 'LAUNCHING') {
          this.enqueueStationNotification(state, config, 'STATION_CALL_NOW', afterMatch, promoted, at);
        }
      }
      return stationResult(updated);
    }));
  }

  resetTestPlayer(input: ResetTestPlayerInput): Promise<{ reset: true; stationRevision: number }> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const readyEntryId = requireIdentifier(input.readyEntryId, 'readyEntryId');
    const expectedRevision = requirePositiveInteger(input.expectedRevision, 'expectedRevision');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    const reason = requireReason(input.reason);
    let publishedRevision = 0;
    const pending = this.execute('RESET_TEST_PLAYER', input.idempotencyKey, null, {
      stationId, readyEntryId, expectedRevision, reason, authorizedBy: principal,
    }, async (state, config, at) => {
      const before = this.requireStationAggregate(state, stationId);
      if (before.station.revision !== expectedRevision) {
        throw new ArcadeServiceError('STALE_STATION_REVISION', 'station revision changed');
      }
      const entry = own(before.readyEntries, readyEntryId);
      if (!entry || entry.status === 'LEFT') {
        throw new ArcadeServiceError('READY_ENTRY_NOT_FOUND', 'test player entry was not found');
      }
      if (!['READY', 'OVERFLOW', 'COMPLETED'].includes(entry.status)) {
        throw new ArcadeServiceError(
          'TEST_PLAYER_RESET_UNSAFE',
          'test player can be reset only while waiting or after the game completes',
        );
      }
      const player = this.requirePlayer(state, entry.playerId);
      const playerEntries = Object.values(state.stationReadyEntries).filter(candidate => candidate.playerId === player.id);
      if (playerEntries.some(candidate => candidate.id !== readyEntryId
        && ['READY', 'OVERFLOW', 'ADMITTED', 'PLAYING'].includes(candidate.status))
        || Object.values(state.queueEntries).some(candidate => (
          candidate.playerId === player.id && !isTerminalQueueStatus(candidate.status)
        ))) {
        throw new ArcadeServiceError(
          'TEST_PLAYER_RESET_UNSAFE',
          'test player has another active game entry',
        );
      }
      const wallet = this.requireWallet(state, entry.playerId);
      const addressIds = new Set(Object.values(state.channelAddresses)
        .filter(address => address.playerId === player.id).map(address => address.id));
      const targetNotifications = Object.values(state.outboundNotifications)
        .filter(notification => notification.playerId === player.id || addressIds.has(notification.channelAddressId));
      if (targetNotifications.some(notification => ['PENDING', 'SENDING', 'RETRY_WAIT', 'ACCEPTED'].includes(notification.status))) {
        throw new ArcadeServiceError(
          'TEST_PLAYER_RESET_MESSAGES_PENDING',
          'wait for pending player messages to finish before resetting',
        );
      }

      if (player.conversationProfileId) {
        if (!input.deleteMemoryProfile) {
          throw new ArcadeServiceError(
            'CONVERSATION_MEMORY_RESET_UNAVAILABLE',
            'Conversation Memory profile deletion is unavailable',
          );
        }
        try {
          await input.deleteMemoryProfile(player.conversationProfileId);
        } catch {
          throw new ArcadeServiceError(
            'CONVERSATION_MEMORY_RESET_FAILED',
            'Conversation Memory profile deletion failed',
          );
        }
      }

      let updated = before;
      let settledWallet = wallet;
      if (entry.status === 'READY' || entry.status === 'OVERFLOW') {
        updated = reduceLeaveStationReadyEntry(
          before, { readyEntryId, at, expectedRevision }, this.stationTiming(config),
        );
        const reservation = entry.reservationId === null
          ? null
          : wallet.reservations.find(candidate => candidate.id === entry.reservationId) ?? null;
        if (reservation?.status === 'ACTIVE') {
          settledWallet = releaseReservation(wallet, {
            reservationId: reservation.id,
            transactionId: this.id('wallet-transaction'),
            idempotencyKey: `${input.idempotencyKey}:release`,
            createdAt: at,
            configVersion: reservation.configVersion,
            metadata: { reason, authorizedBy: principal },
          });
        }
      } else {
        updated = {
          ...before,
          station: Object.freeze({
            ...before.station,
            revision: before.station.revision + 1,
            updatedAt: at,
          }),
        };
      }
      state.wallets[player.id] = settledWallet;
      this.persistStationAggregate(state, updated);

      const tombstoneId = this.id('reset-player');
      const draft = own(state.messagingDrafts, player.id);
      const replacements = new Map<string, string>([[player.id, tombstoneId]]);
      for (const value of [
        player.conversationProfileId, player.crmLeadId, player.trustedDestination,
        ...(player.lead ? Object.values(player.lead) : []),
        ...(draft ? [draft.firstName, draft.lastName, draft.workEmail, draft.companyName] : []),
      ]) if (value) replacements.set(value, '[reset]');

      state.players[tombstoneId] = {
        id: tombstoneId,
        createdAt: player.createdAt,
        updatedAt: at,
        lead: null,
        preferredLocale: null,
        conversationProfileId: null,
        crmLeadId: null,
        termsAcceptedAt: null,
        marketingConsent: false,
        trustedDestination: null,
      };
      delete state.players[player.id];
      state.wallets[tombstoneId] = {
        wallet: { ...settledWallet.wallet, playerId: tombstoneId, updatedAt: at },
        transactions: settledWallet.transactions.map(transaction => ({ ...transaction, playerId: tombstoneId })),
        reservations: settledWallet.reservations.map(reservation => ({ ...reservation, playerId: tombstoneId })),
        challengeClaims: settledWallet.challengeClaims.map(claim => ({ ...claim, playerId: tombstoneId })),
        idempotencyRecords: settledWallet.idempotencyRecords.map(record => ({ ...record, playerId: tombstoneId })),
      };
      delete state.wallets[player.id];
      delete state.messagingDrafts[player.id];

      for (const [id, queueEntry] of Object.entries(state.queueEntries)) {
        if (queueEntry.playerId === player.id) state.queueEntries[id] = { ...queueEntry, playerId: tombstoneId };
      }
      state.queueEvents = state.queueEvents.map(event => (
        event.playerId === player.id ? { ...event, playerId: tombstoneId } : event
      ));
      for (const [id, readyEntry] of Object.entries(state.stationReadyEntries)) {
        if (readyEntry.playerId === player.id) state.stationReadyEntries[id] = { ...readyEntry, playerId: tombstoneId };
      }
      for (const [id, address] of Object.entries(state.channelAddresses)) {
        if (address.playerId !== player.id) continue;
        const addressPhone = resetPhoneNumber(state, `${tombstoneId}:${id}`);
        const providerAddress = address.channel === 'whatsapp' ? `whatsapp:${addressPhone}` : addressPhone;
        replacements.set(address.normalizedAddress, '[reset]');
        replacements.set(address.providerAddress, '[reset]');
        state.channelAddresses[id] = {
          ...address,
          playerId: tombstoneId,
          normalizedAddress: addressPhone,
          providerAddress,
          preferredLocale: 'en-US',
          lastSeenAt: at,
        };
      }
      const notificationIds = new Set(targetNotifications.map(notification => notification.id));
      for (const id of notificationIds) delete state.outboundNotifications[id];
      for (const [id, event] of Object.entries(state.messagingAuditEvents)) {
        if (notificationIds.has(event.notificationId)) delete state.messagingAuditEvents[id];
      }
      for (const [id, message] of Object.entries(state.inboundMessages)) {
        if (message.channelAddressId && addressIds.has(message.channelAddressId)) {
          state.inboundMessages[id] = {
            ...message,
            command: 'RESET',
            reply: 'Player reset by operator.',
          };
        }
      }
      for (const [id, record] of Object.entries(state.idempotencyRecords)) {
        if (record.playerId !== player.id && !containsResetPlayer(record.result, player.id)) continue;
        state.idempotencyRecords[id] = {
          ...record,
          playerId: record.playerId === player.id ? tombstoneId : record.playerId,
          result: scrubResetValue(record.result, replacements),
        };
      }
      this.recordStationControlEvent(
        state, 'RESET_TEST_PLAYER', before, updated, principal, reason, at, config.version,
      );
      publishedRevision = updated.station.revision;
      return {
        reset: true as const,
        stationRevision: updated.station.revision,
        resetReadyEntryId: readyEntryId,
        retiredPlayerHash: retiredPlayerHash(player.id),
        retiredProfileHash: player.conversationProfileId
          ? createHash('sha256').update(`retired-profile:${player.conversationProfileId}`).digest('hex')
          : null,
      };
    }, undefined, true);
    return pending.then(result => {
      if (publishedRevision > 0) this.stationUpdated?.(publishedRevision);
      return result;
    });
  }

  closeStationRecruiting(input: StationControlInput): Promise<StationMutationResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const expectedRevision = requirePositiveInteger(input.expectedRevision, 'expectedRevision');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    return this.publishStation(this.execute('CLOSE_STATION_RECRUITING', input.idempotencyKey, null, {
      stationId, expectedRevision, reason: input.reason ?? null,
      occurredAt: input.occurredAt ?? null, authorizedBy: principal,
    }, (state, config, at) => {
      this.requireOn(config);
      const occurredAt = stationOccurredAt(input.occurredAt, at);
      const before = this.requireStationAggregate(state, stationId);
      const updated = reduceCloseStationRecruiting(
        before, { at: occurredAt, expectedRevision },
        this.stationTiming(config),
      );
      this.persistStationAggregate(state, updated);
      this.recordStationControlEvent(state, 'CLOSE_STATION_RECRUITING', before, updated, principal, input.reason, occurredAt, config.version);
      return stationResult(updated);
    }));
  }

  selectStationGame(input: SelectStationGameInput): Promise<StationMutationResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const expectedRevision = requirePositiveInteger(input.expectedRevision, 'expectedRevision');
    const engineRoomCode = requireIdentifier(input.engineRoomCode, 'engineRoomCode');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    if (!isPlayableArcadeGame(input.game)) {
      throw new ArcadeServiceError('INVALID_GAME', 'game is not station-playable');
    }
    return this.publishStation(this.execute('SELECT_STATION_GAME', input.idempotencyKey, null, {
      stationId, expectedRevision, game: input.game, engineRoomCode,
      reason: input.reason ?? null, occurredAt: input.occurredAt ?? null, authorizedBy: principal,
    }, (state, config, at) => {
      this.requireOn(config);
      if (!config.station.games[input.game].enabled) {
        throw new ArcadeServiceError('GAME_DISABLED', `${input.game} is disabled for this station`);
      }
      const occurredAt = stationOccurredAt(input.occurredAt, at);
      const before = this.requireStationAggregate(state, stationId);
      const updated = reduceSelectStationGame(before, {
        game: input.game,
        matchId: this.id('station-match'),
        engineRoomCode,
        at: occurredAt,
        expectedRevision,
      }, this.stationTiming(config));
      this.persistStationAggregate(state, updated);
      this.recordStationControlEvent(state, 'SELECT_STATION_GAME', before, updated, principal, input.reason, occurredAt, config.version);
      const match = updated.matches[updated.station.activeMatchId!]!;
      for (const readyEntryId of match.participantReadyEntryIds) {
        this.enqueueStationNotification(state, config, 'STATION_ADMITTED', match, updated.readyEntries[readyEntryId]!, occurredAt);
      }
      for (const readyEntryId of match.overflowReadyEntryIds) {
        this.enqueueStationNotification(state, config, 'STATION_OVERFLOW', match, updated.readyEntries[readyEntryId]!, occurredAt);
      }
      return stationResult(updated);
    }));
  }

  requestStationLaunch(input: StationControlInput): Promise<StationMutationResult> {
    return this.stationRevisionCommand('REQUEST_STATION_LAUNCH', input, (aggregate, at, revision) => (
      reduceRequestStationLaunch(aggregate, { at, expectedRevision: revision })
    ), false, (state, config, _before, updated, at) => {
      const match = updated.matches[updated.station.activeMatchId!]!;
      for (const readyEntryId of match.participantReadyEntryIds) {
        this.enqueueStationNotification(state, config, 'STATION_CALL_NOW', match, updated.readyEntries[readyEntryId]!, at);
      }
    });
  }

  markStationDisplayReady(input: StationDisplayReadyInput): Promise<StationMutationResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const matchId = requireIdentifier(input.matchId, 'matchId');
    const launchGeneration = requirePositiveInteger(input.launchGeneration, 'launchGeneration');
    const expectedRevision = requirePositiveInteger(input.expectedRevision, 'expectedRevision');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    return this.publishStation(this.execute('MARK_STATION_DISPLAY_READY', input.idempotencyKey, null, {
      stationId, matchId, launchGeneration, expectedRevision,
      reason: input.reason ?? null, authorizedBy: principal,
    }, (state, config, at) => {
      this.requireOn(config);
      const aggregate = this.requireStationAggregate(state, stationId);
      const activeMatch = aggregate.station.activeMatchId
        ? aggregate.matches[aggregate.station.activeMatchId]
        : undefined;
      if (!activeMatch || activeMatch.id !== matchId || activeMatch.launchGeneration !== launchGeneration) {
        throw new ArcadeServiceError('STALE_STATION_LAUNCH', 'display acknowledgement belongs to a stale launch');
      }
      const updated = reduceMarkStationDisplayReady(aggregate, { at, expectedRevision });
      this.persistStationAggregate(state, updated);
      this.recordStationControlEvent(state, 'MARK_STATION_DISPLAY_READY', aggregate, updated, principal, input.reason, at, config.version);
      return stationResult(updated);
    }));
  }

  startStationMatch(input: StartStationMatchInput): Promise<StationMutationResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const expectedRevision = requirePositiveInteger(input.expectedRevision, 'expectedRevision');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    return this.publishStation(this.execute('START_STATION_MATCH', input.idempotencyKey, null, {
      stationId, expectedRevision, reason: input.reason ?? null, authorizedBy: principal,
      enginePlayerIdsByReadyEntryId: input.enginePlayerIdsByReadyEntryId ?? null,
    }, (state, config, at) => {
      this.requireOn(config);
      const aggregate = this.requireStationAggregate(state, stationId);
      const match = aggregate.station.activeMatchId
        ? aggregate.matches[aggregate.station.activeMatchId]
        : undefined;
      if (!match) throw new ArcadeServiceError('MATCH_NOT_ACTIVE', 'station has no active match');
      const redemptions = match.participantReadyEntryIds.flatMap(readyEntryId => {
        const entry = aggregate.readyEntries[readyEntryId]!;
        if (entry.reservationId === null) return [];
        const wallet = this.requireWallet(state, entry.playerId);
        const reservation = wallet.reservations.find(candidate => candidate.id === entry.reservationId);
        if (!reservation || reservation.status !== 'ACTIVE' || reservation.queueEntryId !== readyEntryId
          || reservation.amount !== STATION_COIN_COST) {
          throw new ArcadeServiceError(
            'MATCH_NOT_READY', `ready entry ${readyEntryId} has no valid active reservation`,
          );
        }
        return [{ readyEntryId, entry, wallet, reservation }];
      });
      for (const redemption of redemptions) {
        state.wallets[redemption.entry.playerId] = redeemReservation(redemption.wallet, {
          reservationId: redemption.reservation.id,
          matchId: match.id,
          transactionId: this.id('wallet-transaction'),
          idempotencyKey: `${input.idempotencyKey}:redeem:${redemption.readyEntryId}`,
          createdAt: at,
          configVersion: redemption.reservation.configVersion,
        });
      }
      const updated = reduceMarkStationMatchStarted(aggregate, {
        at,
        expectedRevision,
        redeemedReservationIds: redemptions.map(redemption => redemption.reservation.id),
        enginePlayerIdsByReadyEntryId: input.enginePlayerIdsByReadyEntryId,
      });
      this.persistStationAggregate(state, updated);
      this.recordStationControlEvent(state, 'START_STATION_MATCH', aggregate, updated, principal, input.reason, at, config.version);
      return stationResult(updated);
    }));
  }

  completeStationMatch(input: CompleteStationMatchInput): Promise<StationMutationResult> {
    return this.stationRevisionCommand('COMPLETE_STATION_MATCH', input, (aggregate, at, revision) => (
      reduceCompleteStationMatch(aggregate, {
        at,
        expectedRevision: revision,
        engineResults: input.engineResults,
        resultSource: input.resultSource,
      })
    ), true, (state, config, _before, updated, at) => {
      const match = updated.matches[updated.station.activeMatchId!]!;
      for (const readyEntryId of match.participantReadyEntryIds) {
        this.enqueueStationNotification(state, config, 'STATION_RESULTS', match, updated.readyEntries[readyEntryId]!, at);
        delete state.stationReadyChannels[readyEntryId];
      }
    });
  }

  advanceStationResults(input: StationControlInput): Promise<StationMutationResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const expectedRevision = requirePositiveInteger(input.expectedRevision, 'expectedRevision');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    return this.publishStation(this.execute('ADVANCE_STATION_RESULTS', input.idempotencyKey, null, {
      stationId, expectedRevision, reason: input.reason ?? null,
      occurredAt: input.occurredAt ?? null, authorizedBy: principal,
    }, (state, config, at) => {
      if (config.arcade.mode === 'off' && principal.kind === 'operator') {
        throw new ArcadeServiceError(
          'PAUSED_EVENT_RESET_REQUIRED',
          'the paused event flow must be reset before another game-control action',
        );
      }
      const occurredAt = stationOccurredAt(input.occurredAt, at);
      const aggregate = this.requireStationAggregate(state, stationId);
      const match = aggregate.matches[aggregate.station.activeMatchId!]!;
      const promotedIds = match.overflowReadyEntryIds.filter(readyEntryId => (
        aggregate.readyEntries[readyEntryId]?.status === 'OVERFLOW'
      ));
      const updated = reduceAdvanceStationResults(aggregate, {
        nextRoundId: this.id('station-round'),
        at: occurredAt,
        configVersion: config.version,
        expectedRevision,
      }, this.stationTiming(config));
      this.persistStationAggregate(state, updated);
      this.recordStationControlEvent(state, 'ADVANCE_STATION_RESULTS', aggregate, updated, principal, input.reason, occurredAt, config.version);
      for (const readyEntryId of promotedIds) {
        const entry = updated.readyEntries[readyEntryId];
        if (entry?.status === 'READY') {
          this.enqueueStationNotification(state, config, 'STATION_NEXT_GAME', match, entry, occurredAt);
        }
      }
      return stationResult(updated);
    }));
  }

  failStationLaunch(input: StationControlInput): Promise<StationMutationResult> {
    return this.stationRevisionCommand('FAIL_STATION_LAUNCH', input, (aggregate, at, revision, config) => (
      reduceFailStationLaunch(aggregate, { at, expectedRevision: revision }, this.stationTiming(config))
    ), true);
  }

  recoverStationAfterRestart(input: StationControlInput): Promise<StationMutationResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const expectedRevision = requirePositiveInteger(input.expectedRevision, 'expectedRevision');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    return this.publishStation(this.execute('RECOVER_STATION_RESTART', input.idempotencyKey, null, {
      stationId, expectedRevision, reason: input.reason ?? null, authorizedBy: principal,
    }, (state, config, at) => {
      const aggregate = this.requireStationAggregate(state, stationId);
      if (aggregate.station.phase === 'LAUNCHING') {
        const updated = reduceFailStationLaunch(
          aggregate, { at, expectedRevision }, this.stationTiming(config),
        );
        this.persistStationAggregate(state, updated);
        this.recordStationControlEvent(state, 'RECOVER_STATION_RESTART', aggregate, updated, principal, input.reason, at, config.version);
        return stationResult(updated);
      }
      if (aggregate.station.phase !== 'PLAYING' || !aggregate.station.activeMatchId) {
        throw new ArcadeServiceError('MATCH_NOT_ACTIVE', 'station has no restart recovery match');
      }
      const match = aggregate.matches[aggregate.station.activeMatchId]!;
      const updated = reduceCompleteStationMatch(aggregate, { at, expectedRevision });
      for (const readyEntryId of match.participantReadyEntryIds) {
        const entry = aggregate.readyEntries[readyEntryId]!;
        if (entry.reservationId === null) continue;
        const wallet = this.requireWallet(state, entry.playerId);
        const reservation = wallet.reservations.find(candidate => candidate.id === entry.reservationId);
        if (!reservation || reservation.status !== 'REDEEMED' || reservation.matchId !== match.id) {
          throw new ArcadeServiceError('MATCH_NOT_ACTIVE', 'restart recovery reservation is invalid');
        }
        state.wallets[entry.playerId] = refundReservation(wallet, {
          reservationId: reservation.id,
          transactionId: this.id('wallet-transaction'),
          idempotencyKey: `${input.idempotencyKey}:refund:${readyEntryId}`,
          createdAt: at,
          configVersion: reservation.configVersion,
          metadata: { reason: 'process restart interrupted active match' },
        });
      }
      this.persistStationAggregate(state, updated);
      this.recordStationControlEvent(state, 'RECOVER_STATION_RESTART', aggregate, updated, principal, input.reason, at, config.version);
      for (const readyEntryId of match.participantReadyEntryIds) delete state.stationReadyChannels[readyEntryId];
      return stationResult(updated);
    }));
  }

  resetStation(input: StationControlInput): Promise<StationMutationResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const expectedRevision = requirePositiveInteger(input.expectedRevision, 'expectedRevision');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    if (principal.kind !== 'operator') {
      throw new ArcadeServiceError('STATION_ACTION_UNAUTHORIZED', 'authenticated operator authorization is required');
    }
    const reason = requireIdentifier(input.reason, 'operator reason', MAX_OPERATOR_REASON_LENGTH).trim();
    return this.publishStation(this.execute('RESET_STATION', input.idempotencyKey, null, {
      stationId, expectedRevision, reason,
      occurredAt: input.occurredAt ?? null, authorizedBy: principal,
    }, (state, config, at) => {
      const occurredAt = stationOccurredAt(input.occurredAt, at);
      const before = this.requireStationAggregate(state, stationId);
      const updated = reduceResetArcadeStation(before, { at: occurredAt, expectedRevision });
      const interruptedMatches = new Map(Object.values(before.matches)
        .filter(match => match.phase === 'PLAYING')
        .map(match => [match.id, match]));

      for (const entry of Object.values(before.readyEntries)) {
        if (entry.reservationId === null) continue;
        const wallet = this.requireWallet(state, entry.playerId);
        const reservation = wallet.reservations.find(candidate => candidate.id === entry.reservationId);
        if (!reservation || reservation.queueEntryId !== entry.id) {
          throw new ArcadeServiceError('RESERVATION_NOT_ACTIVE', 'station reset reservation is invalid');
        }
        if (reservation.status === 'ACTIVE') {
          state.wallets[entry.playerId] = releaseReservation(wallet, {
            reservationId: reservation.id,
            transactionId: this.id('wallet-transaction'),
            idempotencyKey: `${input.idempotencyKey}:release:${entry.id}`,
            createdAt: occurredAt,
            configVersion: reservation.configVersion,
          });
          continue;
        }
        const interruptedMatch = reservation.matchId
          ? interruptedMatches.get(reservation.matchId)
          : undefined;
        if (reservation.status === 'REDEEMED'
          && interruptedMatch?.participantReadyEntryIds.includes(entry.id)) {
          state.wallets[entry.playerId] = refundReservation(wallet, {
            reservationId: reservation.id,
            transactionId: this.id('wallet-transaction'),
            idempotencyKey: `${input.idempotencyKey}:refund:${entry.id}`,
            createdAt: occurredAt,
            configVersion: reservation.configVersion,
            metadata: { reason: 'emergency station reset interrupted active match' },
          });
        }
      }

      for (const readyEntryId of Object.keys(before.readyEntries)) {
        delete state.stationReadyChannels[readyEntryId];
      }
      this.persistStationAggregate(state, updated);
      this.recordStationControlEvent(
        state, 'RESET_STATION', before, updated, principal, reason, occurredAt, config.version,
      );
      return stationResult(updated);
    }));
  }

  private stationRevisionCommand(
    operation: string,
    input: StationControlInput,
    reduce: (
      aggregate: ArcadeStationAggregate,
      at: string,
      expectedRevision: number,
      config: ArcadeConfigSnapshot,
    ) => ArcadeStationAggregate,
    allowModeOff = false,
    afterReduce?: (
      state: ArcadeState,
      config: ArcadeConfigSnapshot,
      before: ArcadeStationAggregate,
      after: ArcadeStationAggregate,
      at: string,
    ) => void,
  ): Promise<StationMutationResult> {
    const stationId = requireIdentifier(input.stationId, 'stationId');
    const expectedRevision = requirePositiveInteger(input.expectedRevision, 'expectedRevision');
    const principal = this.authorizeOperator(input.authorization, 'STATION_ACTION_UNAUTHORIZED');
    const completion = input as CompleteStationMatchInput;
    return this.publishStation(this.execute(operation, input.idempotencyKey, null, {
      stationId, expectedRevision, reason: input.reason ?? null,
      occurredAt: input.occurredAt ?? null, authorizedBy: principal,
      engineResults: completion.engineResults ?? null,
      resultSource: completion.resultSource ?? null,
    }, (state, config, at) => {
      if (!allowModeOff) this.requireOn(config);
      if (allowModeOff && config.arcade.mode === 'off' && principal.kind === 'operator') {
        throw new ArcadeServiceError(
          'PAUSED_EVENT_RESET_REQUIRED',
          'the paused event flow must be reset before another game-control action',
        );
      }
      const before = this.requireStationAggregate(state, stationId);
      const occurredAt = stationOccurredAt(input.occurredAt, at);
      const updated = reduce(
        before,
        occurredAt,
        expectedRevision,
        config,
      );
      this.persistStationAggregate(state, updated);
      afterReduce?.(state, config, before, updated, occurredAt);
      this.recordStationControlEvent(
        state, operation, before, updated, principal, input.reason, occurredAt, config.version,
      );
      return stationResult(updated);
    }));
  }

  private publishStation<Result extends StationMutationResult>(pending: Promise<Result>): Promise<Result> {
    return pending.then(result => {
      this.stationUpdated?.(result.station.revision);
      return result;
    });
  }

  private operatorQueueAction(
    operation: string,
    input: OperatorQueueEntryActionInput,
    makeAction: (
      entry: QueueEntry,
      eventId: string,
      at: string,
      config: ArcadeConfigSnapshot,
    ) => QueueAction,
  ): Promise<QueueEntryResult> {
    const principal = this.authorizeOperator(input.authorization, 'QUEUE_ACTION_UNAUTHORIZED');
    return this.queueAction(
      operation,
      { ...input, reason: operatorAuditReason(principal, input.reason) },
      makeAction,
      principal,
    );
  }

  private queueAction(
    operation: string,
    input: QueueEntryActionInput,
    makeAction: (
      entry: QueueEntry,
      eventId: string,
      at: string,
      config: ArcadeConfigSnapshot,
    ) => QueueAction,
    authorizedBy?: TrustedArcadeOperatorPrincipal,
  ): Promise<QueueEntryResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    const queueEntryId = requireIdentifier(input.queueEntryId, 'queueEntryId');
    return this.execute(operation, input.idempotencyKey, playerId, {
      playerId, queueEntryId, reason: input.reason ?? null, authorizedBy: authorizedBy ?? null,
    }, (state, config, at) => {
      this.requireQueueOn(config);
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
      this.requireCurrentCabinet(entry, config);
      const action = makeAction(entry, this.id('queue-event'), at, config);
      const reduction = reduceQueueEntry(entry, authorizedBy ? { ...action, reason: input.reason } : action);
      this.applyQueueReduction(state, reduction);
      return queueResult(state, reduction.entry);
    });
  }

  private execute<Result>(
    operation: string,
    idempotencyKeyInput: string,
    playerId: string | null,
    payload: unknown,
    mutate: (state: ArcadeState, config: ArcadeConfigSnapshot, at: string) => Result | Promise<Result>,
    validateBeforeMutation?: (config: ArcadeConfigSnapshot, at: string) => void,
    allowWhenNewMutationsBlocked = false,
  ): Promise<Result> {
    const idempotencyKey = requireIdentifier(
      idempotencyKeyInput,
      'idempotencyKey',
      MAX_IDEMPOTENCY_KEY_LENGTH,
    );
    const requestFingerprint = fingerprint(payload);
    return this.store.transaction(async state => {
      const existing = own(state.idempotencyRecords, idempotencyKey);
      if (existing) {
        if (existing.operation !== operation || existing.fingerprint !== requestFingerprint) {
          throw new ArcadeServiceError(
            'IDEMPOTENCY_CONFLICT',
            `idempotency key ${idempotencyKey} was used for a different request`,
          );
        }
        return copyJson(existing.result) as Result;
      }
      if (!allowWhenNewMutationsBlocked && !DEGRADED_CLEANUP_OPERATIONS.has(operation)
        && !this.canStartNewMutations()) {
        throw new ArcadeServiceError(
          'CONFIG_DEGRADED',
          'arcade config integrity is degraded; new admissions, spending, and rewards are disabled',
        );
      }
      if (!allowWhenNewMutationsBlocked && !DEGRADED_CLEANUP_OPERATIONS.has(operation)) {
        assertArcadeMutationCapacity(state, playerId);
      }
      const config = this.config();
      const at = this.now();
      validateBeforeMutation?.(config, at);
      const requestPlayerId = playerId ?? (
        payload && typeof payload === 'object' && typeof (payload as { playerId?: unknown }).playerId === 'string'
          ? (payload as { playerId: string }).playerId
          : null
      );
      if (operation !== 'RESET_TEST_PLAYER' && requestPlayerId && isRetiredPlayer(state, requestPlayerId)) {
        throw new ArcadeServiceError('PLAYER_SESSION_RETIRED', 'player session was reset');
      }
      const result = await mutate(state, config, at);
      const record: ArcadeServiceIdempotencyRecord = {
        key: idempotencyKey,
        operation,
        playerId,
        fingerprint: requestFingerprint,
        result: copyJson(result),
        configVersion: config.version,
        createdAt: at,
      };
      state.idempotencyRecords[idempotencyKey] = record;
      return result;
    });
  }

  private config(): ArcadeConfigSnapshot {
    const value = typeof this.configSource === 'function' ? this.configSource() : this.configSource;
    const policy = (value as { coins?: { chargePolicy?: unknown } }).coins?.chargePolicy;
    if (policy === 'per_match' || policy === 'host_sponsors') {
      throw new ArcadeServiceError(
        'UNSUPPORTED_CHARGE_POLICY',
        `${policy} requires a future party/wave payer model`,
      );
    }
    return parseArcadeConfig(value);
  }

  private challengeClaimLink(playerId: string, challengeId: string, audience: string, at: string, locale: 'en-US' | 'pt-BR'): string {
    const issuedAt = Math.floor(Date.parse(at) / 1000);
    const token = signArcadeChallengeToken({
      v: ARCADE_CHALLENGE_TOKEN_VERSION,
      player: playerId,
      challenge: challengeId,
      audience,
      jti: this.id('challenge-link'),
      issuedAt,
      expiry: issuedAt + ARCADE_CHALLENGE_TOKEN_MAX_TTL_SECONDS,
    }, this.challengeTokenSecret);
    const link = new URL('/challenge/', this.publicBaseUrl);
    link.searchParams.set('locale', locale);
    link.hash = token;
    return link.toString();
  }

  private canStartNewMutations(): boolean {
    try {
      return this.newMutationsAllowed();
    } catch {
      return false;
    }
  }

  private now(): string {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new ArcadeServiceError('INVALID_CLOCK', 'clock returned an invalid time');
    return date.toISOString();
  }

  private id(kind: string): string {
    return requireIdentifier(this.idGenerator(kind), `${kind} ID`);
  }

  private requireOn(config: ArcadeConfigSnapshot): void {
    if (config.arcade.mode === 'off') throw new ArcadeServiceError('MODE_DISABLED', 'station mode is off');
  }

  private requireQueueOn(config: ArcadeConfigSnapshot): void {
    this.requireOn(config);
    if (!config.queue.enabled) throw new ArcadeServiceError('QUEUE_DISABLED', 'station queue is disabled');
  }

  private requireSupportedChargePolicy(config: ArcadeConfigSnapshot): void {
    if (config.coins.chargePolicy !== 'per_player' && config.coins.chargePolicy !== 'free') {
      throw new ArcadeServiceError(
        'UNSUPPORTED_CHARGE_POLICY',
        `${config.coins.chargePolicy} requires a future party/wave payer model`,
      );
    }
  }

  private stationTiming(config: ArcadeConfigSnapshot): StationTimingPolicy {
    const timing = config.station.timings;
    return {
      recruitingSeconds: timing.recruitingSeconds,
      hardDeadlineSeconds: timing.hardDeadlineSeconds,
      selectionSeconds: timing.selectionSeconds,
      lockedSeconds: timing.lockedSeconds,
      postGameRecruitingSeconds: timing.postGameRecruitingSeconds,
    };
  }

  private enqueueStationNotification(
    state: ArcadeState,
    config: ArcadeConfigSnapshot,
    kind: ArcadeStationNotificationKind,
    match: StationMatch,
    entry: StationReadyEntry,
    at: string,
  ): void {
    if (config.arcade.mode === 'off') return;
    const binding = own(state.stationReadyChannels, entry.id);
    const address = binding ? own(state.channelAddresses, binding.channelAddressId) : undefined;
    if (!binding || !address || address.playerId !== entry.playerId || !config.channels[address.channel]
      || !this.notificationsEnabled(address.channel)) return;
    const locale = normalizeMessagingLocale(address.preferredLocale);
    const callNumber = this.notificationCallNumber(config, locale);
    if (kind === 'STATION_CALL_NOW' && (!config.channels.voice || callNumber === null)) return;
    const wallet = own(state.wallets, entry.playerId);
    const actualBalance = kind === 'STATION_RESULTS' && wallet ? availableBalance(wallet) : null;
    const standardResultsDelivery = kind === 'STATION_RESULTS' && config.postGame.enabled
      && config.postGame.channels.includes(address.channel);
    const offerChallenges = kind === 'STATION_RESULTS' && config.postGame.includeChallenges
      && actualBalance === 0 && wallet !== undefined
      && availableEarningChallenges(config, wallet, at).length > 0;
    if (kind === 'STATION_RESULTS' && !standardResultsDelivery && !offerChallenges) return;
    const balance = standardResultsDelivery && config.postGame.includeCoinBalance
      ? actualBalance
      : null;
    const content = stationNotificationContent({
      kind,
      locale,
      game: match.game,
      overflowOrdinal: entry.overflowOrdinal,
      callNumber,
      balance,
      offerChallenges,
      rank: match.result?.participants.find(result => result.readyEntryId === entry.id)?.rank ?? null,
      won: match.result?.participants.find(result => result.readyEntryId === entry.id)?.won ?? null,
    });
    const id = stationNotificationId(kind, match.id, entry.id);
    if (own(state.outboundNotifications, id)) return;
    const templateContentSid = address.channel === 'whatsapp' && !offerChallenges
      ? this.notificationContentSid(kind, locale)
      : null;
    const record: ArcadeOutboundNotificationRecord = {
      id,
      kind,
      playerId: entry.playerId,
      stationId: entry.stationId,
      roundId: match.roundId,
      matchId: match.id,
      readyEntryId: entry.id,
      channelAddressId: address.id,
      channel: address.channel,
      to: address.providerAddress,
      locale,
      body: content.body,
      templateContentSid,
      templateVariables: content.templateVariables,
      configVersion: config.version,
      status: 'PENDING',
      nextAttemptAt: at,
      expiresAt: new Date(Date.parse(at) + STATION_NOTIFICATION_TTL_MS[kind]).toISOString(),
      attempts: [],
      terminalReason: null,
      createdAt: at,
      updatedAt: at,
      terminalAt: null,
    };
    state.outboundNotifications[id] = record;
  }

  private notificationsEnabled(channel?: ArcadeMessagingChannel): boolean {
    try {
      return this.stationNotifications?.enabled(channel) === true;
    } catch {
      return false;
    }
  }

  private notificationCallNumber(
    config: ArcadeConfigSnapshot,
    locale: 'en-US' | 'pt-BR',
  ): string | null {
    const configured = config.channels.voiceNumbers;
    if (configured['en-US'] !== null || configured['pt-BR'] !== null) return configured[locale];
    try {
      const value = this.stationNotifications?.callNumber?.(locale)?.trim() ?? '';
      return /^\+[1-9][0-9]{7,14}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  private notificationContentSid(
    kind: ArcadeStationNotificationKind,
    locale: 'en-US' | 'pt-BR',
  ): string | null {
    try {
      const value = this.stationNotifications?.whatsappContentSid?.(kind, locale)?.trim() ?? '';
      return /^HX[a-fA-F0-9]{32}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  private requireStationReadyCapacity(aggregate: ArcadeStationAggregate): void {
    const activeMatch = aggregate.station.activeMatchId
      ? aggregate.matches[aggregate.station.activeMatchId]
      : undefined;
    const pendingIds = activeMatch
      ? [
        ...activeMatch.overflowReadyEntryIds,
        ...Object.values(aggregate.readyEntries)
          .filter(entry => entry.roundId === aggregate.station.nextRoundId && entry.status === 'READY')
          .map(entry => entry.id),
      ]
      : Object.values(aggregate.readyEntries)
        .filter(entry => entry.status === 'READY'
          && (entry.roundId === aggregate.station.activeRoundId
            || entry.roundId === aggregate.station.nextRoundId))
        .map(entry => entry.id);
    if (new Set(pendingIds).size >= STATION_MAX_PENDING_PLAYERS) {
      throw new ArcadeServiceError('READY_POOL_FULL', 'station ready pool is full');
    }
  }

  private queuePolicy(config: ArcadeConfigSnapshot): {
    automaticDeferrals: number;
    removeAfterMisses: number;
    snoozeSeconds: number;
  } {
    return {
      automaticDeferrals: config.queue.automaticDeferrals,
      removeAfterMisses: config.queue.removeAfterMisses,
      snoozeSeconds: config.queue.snoozeSeconds,
    };
  }

  private requirePlayer(state: ArcadeState, playerId: string): ArcadePlayerRecord {
    const player = own(state.players, playerId);
    if (!player) throw new ArcadeServiceError('PLAYER_NOT_FOUND', `player ${playerId} was not found`);
    return player;
  }

  private requireWallet(state: ArcadeState, playerId: string): WalletState {
    const wallet = own(state.wallets, playerId);
    if (!wallet) throw new ArcadeServiceError('WALLET_NOT_FOUND', `wallet for ${playerId} was not found`);
    return wallet;
  }

  private stationAggregate(state: ArcadeState, stationId: string): ArcadeStationAggregate | null {
    const station = own(state.stations, stationId);
    if (!station) return null;
    return {
      station,
      rounds: Object.fromEntries(
        Object.entries(state.stationRounds).filter(([, round]) => round.stationId === stationId),
      ),
      readyEntries: Object.fromEntries(
        Object.entries(state.stationReadyEntries).filter(([, entry]) => entry.stationId === stationId),
      ),
      matches: Object.fromEntries(
        Object.entries(state.stationMatches).filter(([, match]) => match.stationId === stationId),
      ),
    };
  }

  private requireStationAggregate(state: ArcadeState, stationId: string): ArcadeStationAggregate {
    const aggregate = this.stationAggregate(state, stationId);
    if (!aggregate) throw new ArcadeServiceError('STATION_NOT_FOUND', `station ${stationId} was not found`);
    return aggregate;
  }

  private persistStationAggregate(state: ArcadeState, aggregate: ArcadeStationAggregate): void {
    const stationId = aggregate.station.id;
    state.stations[stationId] = aggregate.station;
    for (const [id, round] of Object.entries(state.stationRounds)) {
      if (round.stationId === stationId) delete state.stationRounds[id];
    }
    for (const [id, entry] of Object.entries(state.stationReadyEntries)) {
      if (entry.stationId === stationId) delete state.stationReadyEntries[id];
    }
    for (const [id, match] of Object.entries(state.stationMatches)) {
      if (match.stationId === stationId) delete state.stationMatches[id];
    }
    Object.assign(state.stationRounds, aggregate.rounds);
    Object.assign(state.stationReadyEntries, aggregate.readyEntries);
    Object.assign(state.stationMatches, aggregate.matches);
  }

  private recordStationControlEvent(
    state: ArcadeState,
    action: string,
    before: ArcadeStationAggregate,
    after: ArcadeStationAggregate,
    principal: TrustedArcadeOperatorPrincipal,
    reasonInput: string | undefined,
    occurredAt: string,
    configVersion: number,
  ): void {
    const reason = requireReason(reasonInput ?? 'system transition');
    state.stationControlEvents.push({
      id: this.id('station-control-event'),
      stationId: after.station.id,
      action,
      actorKind: principal.kind,
      actorSubject: principal.subject,
      reason,
      fromRevision: before.station.revision,
      toRevision: after.station.revision,
      roundId: after.station.activeRoundId ?? before.station.activeRoundId,
      matchId: after.station.activeMatchId ?? before.station.activeMatchId,
      occurredAt,
      configVersion,
    });
  }

  private requireEntry(state: ArcadeState, queueEntryId: string): QueueEntry {
    const entry = own(state.queueEntries, queueEntryId);
    if (!entry) throw new ArcadeServiceError('QUEUE_ENTRY_NOT_FOUND', `queue entry ${queueEntryId} was not found`);
    return entry;
  }

  private requireOwnedEntry(state: ArcadeState, playerId: string, queueEntryId: string): QueueEntry {
    const entry = this.requireEntry(state, queueEntryId);
    if (entry.playerId !== playerId) {
      throw new ArcadeServiceError('QUEUE_ENTRY_FORBIDDEN', 'queue entry belongs to another player');
    }
    return entry;
  }

  private requireCurrentCabinet(entry: QueueEntry, config: ArcadeConfigSnapshot): void {
    if (entry.cabinetId !== config.arcade.cabinetId) {
      throw new ArcadeServiceError('CABINET_CHANGED', 'queue entry belongs to another cabinet');
    }
  }

  private requireEntryIds(input: readonly string[]): string[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MATCH_ENTRIES) {
      throw new ArcadeServiceError('INVALID_MATCH', 'at least one queue entry is required');
    }
    const ids = input.map(id => requireIdentifier(id, 'queueEntryId'));
    if (new Set(ids).size !== ids.length) {
      throw new ArcadeServiceError('INVALID_MATCH', 'queue entry IDs must be unique');
    }
    return ids;
  }

  private authorizeOperator(authorization: unknown, code: string): TrustedArcadeOperatorPrincipal {
    let principal: TrustedArcadeOperatorPrincipal | null = null;
    try {
      principal = this.operatorAuthorizer(authorization);
    } catch {
      principal = null;
    }
    if (!principal || (principal.kind !== 'operator' && principal.kind !== 'system')) {
      throw new ArcadeServiceError(code, 'trusted operator or system authorization is required');
    }
    return {
      kind: principal.kind,
      subject: requireIdentifier(principal.subject, 'operator authorization subject'),
    };
  }

  private ensureWalletAndStartingGrant(
    state: ArcadeState,
    playerId: string,
    serviceIdempotencyKey: string,
    config: ArcadeConfigSnapshot,
    at: string,
  ): WalletState {
    const existing = own(state.wallets, playerId);
    let wallet = existing ?? createWallet(playerId, at);
    if (config.coins.chargePolicy !== 'free' && config.coins.startingBalance > 0
      && !wallet.transactions.some(transaction => transaction.type === 'registration_grant')) {
      wallet = grantRegistrationCoins(wallet, {
        amount: config.coins.startingBalance,
        transactionId: this.id('wallet-transaction'),
        idempotencyKey: `${serviceIdempotencyKey}:registration-grant`,
        createdAt: at,
        configVersion: config.version,
      });
    }
    state.wallets[playerId] = wallet;
    return wallet;
  }

  private applyQueueReduction(state: ArcadeState, reduction: QueueReduction): void {
    state.queueEntries[reduction.entry.id] = reduction.entry;
    state.queueEvents.push(reduction.event);
  }

  private releaseActiveReservation(
    state: ArcadeState,
    entry: QueueEntry,
    serviceIdempotencyKey: string,
    config: ArcadeConfigSnapshot,
    at: string,
  ): void {
    const current = this.requireWallet(state, entry.playerId);
    const reservation = findReservation(current, entry.id);
    if (!reservation || reservation.status !== 'ACTIVE') return;
    const captured = own(state.queueEntryConfigs, entry.id);
    state.wallets[entry.playerId] = releaseReservation(current, {
      reservationId: reservation.id,
      transactionId: this.id('wallet-transaction'),
      idempotencyKey: `${serviceIdempotencyKey}:release`,
      createdAt: at,
      configVersion: captured?.configVersion ?? config.version,
    });
  }
}
