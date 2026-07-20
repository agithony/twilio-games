export type ArcadeTimestamp = string;

export const LEAD_FIELD_LIMITS = {
  firstName: 100,
  lastName: 100,
  workEmail: 254,
  companyName: 200,
} as const;

export interface Lead {
  firstName: string;
  lastName: string;
  workEmail: string;
  companyName: string;
  phoneNumber: string;
  countryCode: string;
}

export type LeadInput = { [K in keyof Lead]: string };

export interface Player extends Lead {
  id: string;
  createdAt: ArcadeTimestamp;
  preferredLocale: string | null;
  conversationProfileId: string | null;
  crmLeadId: string | null;
  termsAcceptedAt: ArcadeTimestamp | null;
  marketingConsent: boolean;
}

export interface CreatePlayerInput {
  id: string;
  createdAt: ArcadeTimestamp;
  lead: LeadInput;
  preferredLocale?: string | null;
  conversationProfileId?: string | null;
  crmLeadId?: string | null;
  termsAcceptedAt?: ArcadeTimestamp | null;
  marketingConsent?: boolean;
}

export class ArcadeDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArcadeDomainError';
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ArcadeDomainError('INVALID_IDENTIFIER', `${field} must be a non-empty string`);
  }
  return value;
}

function normalizeUnicodeText(value: string, field: keyof typeof LEAD_FIELD_LIMITS): string {
  if (typeof value !== 'string') {
    throw new ArcadeDomainError('INVALID_LEAD', `${field} must be a string`);
  }
  const normalized = value.normalize('NFC').trim();
  if (normalized === '') {
    throw new ArcadeDomainError('INVALID_LEAD', `${field} is required`);
  }
  if (/\p{Cc}/u.test(normalized)) {
    throw new ArcadeDomainError('INVALID_LEAD', `${field} contains control characters`);
  }
  if (Array.from(normalized).length > LEAD_FIELD_LIMITS[field]) {
    throw new ArcadeDomainError('INVALID_LEAD', `${field} exceeds ${LEAD_FIELD_LIMITS[field]} characters`);
  }
  return normalized;
}

function normalizeWorkEmail(value: string): string {
  if (typeof value !== 'string') {
    throw new ArcadeDomainError('INVALID_LEAD', 'workEmail must be a string');
  }
  const email = value.normalize('NFKC').trim().toLowerCase();
  if (email.length === 0 || email.length > LEAD_FIELD_LIMITS.workEmail || !email.includes('@')) {
    throw new ArcadeDomainError('INVALID_LEAD', 'workEmail is invalid');
  }

  const [local, domain, ...extra] = email.split('@');
  if (extra.length > 0 || !local || !domain || local.length > 64 || local.startsWith('.')
    || local.endsWith('.') || local.includes('..')) {
    throw new ArcadeDomainError('INVALID_LEAD', 'workEmail is invalid');
  }
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) {
    throw new ArcadeDomainError('INVALID_LEAD', 'workEmail is invalid');
  }
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label => label.length === 0 || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new ArcadeDomainError('INVALID_LEAD', 'workEmail is invalid');
  }
  return email;
}

function normalizePhoneNumber(value: string): string {
  if (typeof value !== 'string') {
    throw new ArcadeDomainError('INVALID_LEAD', 'phoneNumber must be a string');
  }
  let phone = value.normalize('NFKC').trim();
  if (!/^(?:\+|00)[0-9\s().-]+$/.test(phone)) {
    throw new ArcadeDomainError('INVALID_LEAD', 'phoneNumber must be an international E.164 number');
  }
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  phone = `+${phone.slice(1).replace(/[\s().-]/g, '')}`;
  if (!/^\+[1-9][0-9]{0,14}$/.test(phone)) {
    throw new ArcadeDomainError('INVALID_LEAD', 'phoneNumber must be an international E.164 number');
  }
  return phone;
}

function normalizeCountryCode(value: string): string {
  if (typeof value !== 'string') {
    throw new ArcadeDomainError('INVALID_LEAD', 'countryCode must be a string');
  }
  const countryCode = value.normalize('NFKC').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new ArcadeDomainError('INVALID_LEAD', 'countryCode must contain exactly two letters');
  }
  return countryCode;
}

/** Normalizes all six lead fields or rejects the whole lead without partially accepting it. */
export function normalizeLead(input: LeadInput): Lead {
  if (!isPlainRecord(input) || !hasExactKeys(input, [
    'firstName', 'lastName', 'workEmail', 'companyName', 'phoneNumber', 'countryCode',
  ])) {
    throw new ArcadeDomainError('INVALID_LEAD', 'lead must contain exactly the six supported fields');
  }
  return Object.freeze({
    firstName: normalizeUnicodeText(input.firstName, 'firstName'),
    lastName: normalizeUnicodeText(input.lastName, 'lastName'),
    workEmail: normalizeWorkEmail(input.workEmail),
    companyName: normalizeUnicodeText(input.companyName, 'companyName'),
    phoneNumber: normalizePhoneNumber(input.phoneNumber),
    // UK is intentionally preserved; ISO conversion belongs at an integration boundary.
    countryCode: normalizeCountryCode(input.countryCode),
  });
}

export function createPlayer(input: CreatePlayerInput): Player {
  return Object.freeze({
    id: requireIdentifier(input.id, 'player id'),
    createdAt: requireIdentifier(input.createdAt, 'createdAt'),
    ...normalizeLead(input.lead),
    preferredLocale: input.preferredLocale ?? null,
    conversationProfileId: input.conversationProfileId ?? null,
    crmLeadId: input.crmLeadId ?? null,
    termsAcceptedAt: input.termsAcceptedAt ?? null,
    marketingConsent: input.marketingConsent ?? false,
  });
}

export const WALLET_TRANSACTION_TYPES = [
  'registration_grant',
  'challenge_reward',
  'operator_grant',
  'reservation',
  'redemption',
  'reservation_release',
  'refund',
  'adjustment',
] as const;

export type WalletTransactionType = typeof WALLET_TRANSACTION_TYPES[number];

export interface Wallet {
  playerId: string;
  cachedBalance: number;
  createdAt: ArcadeTimestamp;
  updatedAt: ArcadeTimestamp;
}

export interface WalletTransaction {
  readonly id: string;
  readonly playerId: string;
  readonly type: WalletTransactionType;
  readonly delta: number;
  readonly reservationId: string | null;
  readonly challengeId: string | null;
  readonly matchId: string | null;
  readonly idempotencyKey: string;
  readonly configVersion: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: ArcadeTimestamp;
}

export const RESERVATION_STATUSES = ['ACTIVE', 'RELEASED', 'REDEEMED', 'REFUNDED'] as const;

export type ReservationStatus = typeof RESERVATION_STATUSES[number];

export interface WalletReservation {
  readonly id: string;
  readonly playerId: string;
  readonly queueEntryId: string;
  readonly amount: number;
  readonly status: ReservationStatus;
  readonly createdAt: ArcadeTimestamp;
  readonly releasedAt: ArcadeTimestamp | null;
  readonly redeemedAt: ArcadeTimestamp | null;
  readonly refundedAt: ArcadeTimestamp | null;
  readonly matchId: string | null;
  readonly configVersion: number;
}

export type Reservation = WalletReservation;

export interface ChallengeClaim {
  readonly id: string;
  readonly challengeId: string;
  readonly playerId: string;
  readonly rewardCoins: number;
  readonly configVersion: number;
  readonly requestMetadata: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly transactionId: string;
  readonly claimedAt: ArcadeTimestamp;
}

export const IDEMPOTENT_OPERATIONS = [
  'REGISTRATION_GRANT',
  'CHALLENGE_REWARD',
  'OPERATOR_GRANT',
  'ADJUSTMENT',
  'RESERVE',
  'RELEASE',
  'REDEEM',
  'REFUND',
] as const;

export type IdempotentOperation = typeof IDEMPOTENT_OPERATIONS[number];

export interface IdempotencyRecord {
  readonly key: string;
  readonly playerId: string;
  readonly operation: IdempotentOperation;
  readonly resourceId: string;
  readonly fingerprint: string;
  readonly resultTransactionId: string;
  readonly createdAt: ArcadeTimestamp;
}

export interface WalletState {
  readonly wallet: Wallet;
  readonly transactions: readonly WalletTransaction[];
  readonly reservations: readonly WalletReservation[];
  readonly challengeClaims: readonly ChallengeClaim[];
  readonly idempotencyRecords: readonly IdempotencyRecord[];
}

export interface LedgerSnapshot {
  ledgerBalance: number;
  reservedBalance: number;
  availableBalance: number;
}

interface MutationContext {
  transactionId: string;
  idempotencyKey: string;
  createdAt: ArcadeTimestamp;
  configVersion: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RegistrationGrantInput extends MutationContext {
  amount: number;
}

export interface ChallengeRewardInput extends MutationContext {
  claimId: string;
  challengeId: string;
  rewardCoins: number;
  maxClaimsPerPlayer: number;
  enabled: boolean;
  startsAt?: ArcadeTimestamp | null;
  endsAt?: ArcadeTimestamp | null;
  requestMetadata?: Readonly<Record<string, unknown>>;
}

export interface ReserveCoinsInput extends MutationContext {
  reservationId: string;
  queueEntryId: string;
  amount: number;
}

export interface ReservationMutationInput extends MutationContext {
  reservationId: string;
}

export interface RedeemReservationInput extends ReservationMutationInput {
  matchId: string;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ArcadeDomainError('INVALID_AMOUNT', `${field} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ArcadeDomainError('INVALID_VALUE', `${field} must be a non-negative integer`);
  }
  return value;
}

function validateContext(input: MutationContext): void {
  requireIdentifier(input.transactionId, 'transaction id');
  requireIdentifier(input.idempotencyKey, 'idempotency key');
  requireIdentifier(input.createdAt, 'createdAt');
  requireNonNegativeInteger(input.configVersion, 'configVersion');
}

function timestampMillis(value: ArcadeTimestamp, field: string): number {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ArcadeDomainError('INVALID_TIMESTAMP', `${field} must be a valid timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new ArcadeDomainError('INVALID_TIMESTAMP', `${field} must be a valid timestamp`);
  }
  return millis;
}

const WALLET_KEYS = ['playerId', 'cachedBalance', 'createdAt', 'updatedAt'] as const;
const TRANSACTION_KEYS = [
  'id', 'playerId', 'type', 'delta', 'reservationId', 'challengeId', 'matchId',
  'idempotencyKey', 'configVersion', 'metadata', 'createdAt',
] as const;
const RESERVATION_KEYS = [
  'id', 'playerId', 'queueEntryId', 'amount', 'status', 'createdAt', 'releasedAt',
  'redeemedAt', 'refundedAt', 'matchId', 'configVersion',
] as const;
const CLAIM_KEYS = [
  'id', 'challengeId', 'playerId', 'rewardCoins', 'configVersion', 'requestMetadata',
  'idempotencyKey', 'transactionId', 'claimedAt',
] as const;
const IDEMPOTENCY_KEYS = [
  'key', 'playerId', 'operation', 'resourceId', 'fingerprint', 'resultTransactionId', 'createdAt',
] as const;
const WALLET_STATE_KEYS = [
  'wallet', 'transactions', 'reservations', 'challengeClaims', 'idempotencyRecords',
] as const;
const FORBIDDEN_METADATA_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function optionalIdentifierViolation(value: unknown, field: string): string | null {
  return value === null || (typeof value === 'string' && value.trim() !== '')
    ? null
    : `${field} must be a non-empty string or null`;
}

function cloneMetadataValue(value: unknown, path: string, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ArcadeDomainError('INVALID_METADATA', `${path} must be finite`);
    return value;
  }
  if (!value || typeof value !== 'object') {
    throw new ArcadeDomainError('INVALID_METADATA', `${path} must be JSON-compatible`);
  }
  if (seen.has(value)) throw new ArcadeDomainError('INVALID_METADATA', `${path} must not be cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    const clone = value.map((item, index) => cloneMetadataValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return Object.freeze(clone);
  }
  if (!isPlainRecord(value)) {
    throw new ArcadeDomainError('INVALID_METADATA', `${path} must contain only plain objects`);
  }
  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) {
      throw new ArcadeDomainError('INVALID_METADATA', `${path}.${key} is forbidden`);
    }
    clone[key] = cloneMetadataValue(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return Object.freeze(clone);
}

function cloneAndFreezeMetadata(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw new ArcadeDomainError('INVALID_METADATA', `${field} must be a plain object`);
  }
  return cloneMetadataValue(value, field, new WeakSet()) as Readonly<Record<string, unknown>>;
}

function metadataViolation(value: unknown, field: string): string | null {
  try {
    cloneAndFreezeMetadata(value, field);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : `${field} is invalid`;
  }
}

function walletViolation(value: unknown): string | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, WALLET_KEYS)) return 'wallet has an invalid shape';
  if (typeof value.playerId !== 'string' || value.playerId.trim() === '') return 'wallet has an invalid playerId';
  if (!Number.isInteger(value.cachedBalance) || (value.cachedBalance as number) < 0) return 'wallet has an invalid cachedBalance';
  try {
    const created = timestampMillis(value.createdAt as string, 'wallet.createdAt');
    const updated = timestampMillis(value.updatedAt as string, 'wallet.updatedAt');
    if (updated < created) return 'wallet updatedAt precedes createdAt';
  } catch (error) {
    return error instanceof Error ? error.message : 'wallet timestamp is invalid';
  }
  return null;
}

function freezeWalletState(state: WalletState): WalletState {
  const wallet = Object.freeze({ ...state.wallet });
  const transactions = Object.freeze(state.transactions.map(transaction => Object.freeze({
    ...transaction,
    metadata: cloneAndFreezeMetadata(transaction.metadata, `transaction ${transaction.id} metadata`),
  })));
  const reservations = Object.freeze(state.reservations.map(reservation => Object.freeze({ ...reservation })));
  const challengeClaims = Object.freeze(state.challengeClaims.map(claim => Object.freeze({
    ...claim,
    requestMetadata: cloneAndFreezeMetadata(claim.requestMetadata, `claim ${claim.id} requestMetadata`),
  })));
  const idempotencyRecords = Object.freeze(state.idempotencyRecords.map(record => Object.freeze({ ...record })));
  return Object.freeze({ wallet, transactions, reservations, challengeClaims, idempotencyRecords });
}

export function createWallet(playerId: string, createdAt: ArcadeTimestamp): WalletState {
  const id = requireIdentifier(playerId, 'player id');
  const at = requireIdentifier(createdAt, 'createdAt');
  timestampMillis(at, 'createdAt');
  return freezeWalletState({
    wallet: { playerId: id, cachedBalance: 0, createdAt: at, updatedAt: at },
    transactions: [],
    reservations: [],
    challengeClaims: [],
    idempotencyRecords: [],
  });
}

function transactionViolation(transaction: unknown): string | null {
  if (!isPlainRecord(transaction) || !hasExactKeys(transaction, TRANSACTION_KEYS)) {
    return 'wallet transaction has an invalid shape';
  }
  if (typeof transaction.id !== 'string' || transaction.id.trim() === '') return 'transaction has an invalid id';
  if (typeof transaction.playerId !== 'string' || transaction.playerId.trim() === '') {
    return `transaction ${transaction.id} has an invalid playerId`;
  }
  if (!(WALLET_TRANSACTION_TYPES as readonly unknown[]).includes(transaction.type)) {
    return `transaction ${transaction.id} has unknown type ${String(transaction.type)}`;
  }
  if (typeof transaction.delta !== 'number' || !Number.isInteger(transaction.delta)) {
    return `transaction ${transaction.id} has a non-integer delta`;
  }
  if (typeof transaction.configVersion !== 'number' || !Number.isInteger(transaction.configVersion)
    || transaction.configVersion < 0) {
    return `transaction ${transaction.id} has an invalid configVersion`;
  }
  for (const [field, value] of [
    ['reservationId', transaction.reservationId],
    ['challengeId', transaction.challengeId],
    ['matchId', transaction.matchId],
  ] as const) {
    const violation = optionalIdentifierViolation(value, `transaction ${transaction.id} ${field}`);
    if (violation) return violation;
  }
  if (typeof transaction.idempotencyKey !== 'string' || transaction.idempotencyKey.trim() === '') {
    return `transaction ${transaction.id} has an invalid idempotencyKey`;
  }
  const metadataError = metadataViolation(transaction.metadata, `transaction ${transaction.id} metadata`);
  if (metadataError) return metadataError;
  try {
    timestampMillis(transaction.createdAt as string, `transaction ${transaction.id} createdAt`);
  } catch (error) {
    return error instanceof Error ? error.message : `transaction ${transaction.id} has an invalid timestamp`;
  }
  const type = transaction.type as WalletTransactionType;
  switch (type) {
    case 'registration_grant':
    case 'operator_grant':
      if (transaction.reservationId || transaction.challengeId || transaction.matchId) return `${type} has unexpected references`;
      return transaction.delta > 0 ? null : `${type} must have a positive delta`;
    case 'challenge_reward':
      if (!transaction.challengeId) return 'challenge_reward requires challengeId';
      if (transaction.reservationId || transaction.matchId) return 'challenge_reward has unexpected references';
      return transaction.delta > 0 ? null : 'challenge_reward must have a positive delta';
    case 'reservation':
    case 'reservation_release':
      if (!transaction.reservationId) return `${transaction.type} requires reservationId`;
      if (transaction.challengeId || transaction.matchId) return `${type} has unexpected references`;
      return transaction.delta === 0 ? null : `${transaction.type} must have a zero delta`;
    case 'redemption':
      if (!transaction.reservationId || !transaction.matchId) return 'redemption requires reservationId and matchId';
      if (transaction.challengeId) return 'redemption has unexpected challengeId';
      return transaction.delta < 0 ? null : 'redemption must have a negative delta';
    case 'refund':
      if (!transaction.reservationId || !transaction.matchId) return 'refund requires reservationId and matchId';
      if (transaction.challengeId) return 'refund has unexpected challengeId';
      return transaction.delta > 0 ? null : 'refund must have a positive delta';
    case 'adjustment':
      if (transaction.reservationId || transaction.challengeId || transaction.matchId) return 'adjustment has unexpected references';
      return transaction.delta !== 0 ? null : 'adjustment must have a non-zero delta';
  }
}

function reservationViolation(reservation: unknown): string | null {
  if (!isPlainRecord(reservation) || !hasExactKeys(reservation, RESERVATION_KEYS)) {
    return 'wallet reservation has an invalid shape';
  }
  for (const field of ['id', 'playerId', 'queueEntryId'] as const) {
    if (typeof reservation[field] !== 'string' || reservation[field].trim() === '') {
      return `reservation has an invalid ${field}`;
    }
  }
  if (typeof reservation.amount !== 'number' || !Number.isInteger(reservation.amount) || reservation.amount <= 0) {
    return `reservation ${reservation.id} has an invalid amount`;
  }
  if (!(RESERVATION_STATUSES as readonly unknown[]).includes(reservation.status)) {
    return `reservation ${reservation.id} has unknown status ${String(reservation.status)}`;
  }
  if (typeof reservation.configVersion !== 'number' || !Number.isInteger(reservation.configVersion)
    || reservation.configVersion < 0) {
    return `reservation ${reservation.id} has an invalid configVersion`;
  }
  for (const field of ['releasedAt', 'redeemedAt', 'refundedAt', 'matchId'] as const) {
    const violation = optionalIdentifierViolation(reservation[field], `reservation ${reservation.id} ${field}`);
    if (violation) return violation;
  }
  try {
    const created = timestampMillis(reservation.createdAt as string, `reservation ${reservation.id} createdAt`);
    for (const field of ['releasedAt', 'redeemedAt', 'refundedAt'] as const) {
      const value = reservation[field];
      if (value && timestampMillis(value as string, `reservation ${reservation.id} ${field}`) < created) {
        return `reservation ${reservation.id} ${field} precedes createdAt`;
      }
    }
    if (reservation.redeemedAt && reservation.refundedAt
      && timestampMillis(reservation.refundedAt as string, `reservation ${reservation.id} refundedAt`)
        < timestampMillis(reservation.redeemedAt as string, `reservation ${reservation.id} redeemedAt`)) {
      return `reservation ${reservation.id} refundedAt precedes redeemedAt`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : `reservation ${reservation.id} has an invalid timestamp`;
  }
  const status = reservation.status as ReservationStatus;
  if (status === 'ACTIVE' && (reservation.releasedAt || reservation.redeemedAt || reservation.refundedAt || reservation.matchId)) {
    return `active reservation ${reservation.id} has terminal fields`;
  }
  if (status === 'RELEASED' && (!reservation.releasedAt || reservation.redeemedAt || reservation.refundedAt || reservation.matchId)) {
    return `released reservation ${reservation.id} has invalid terminal fields`;
  }
  if (status === 'REDEEMED' && (reservation.releasedAt || !reservation.redeemedAt || reservation.refundedAt || !reservation.matchId)) {
    return `redeemed reservation ${reservation.id} has invalid terminal fields`;
  }
  if (status === 'REFUNDED' && (reservation.releasedAt || !reservation.redeemedAt || !reservation.refundedAt || !reservation.matchId)) {
    return `refunded reservation ${reservation.id} has invalid terminal fields`;
  }
  return null;
}

function claimViolation(claim: unknown): string | null {
  if (!isPlainRecord(claim) || !hasExactKeys(claim, CLAIM_KEYS)) return 'challenge claim has an invalid shape';
  for (const field of ['id', 'challengeId', 'playerId', 'idempotencyKey', 'transactionId'] as const) {
    if (typeof claim[field] !== 'string' || claim[field].trim() === '') return `challenge claim has an invalid ${field}`;
  }
  if (typeof claim.rewardCoins !== 'number' || !Number.isInteger(claim.rewardCoins) || claim.rewardCoins <= 0) {
    return `challenge claim ${claim.id} has an invalid reward`;
  }
  if (typeof claim.configVersion !== 'number' || !Number.isInteger(claim.configVersion)
    || claim.configVersion < 0) return `challenge claim ${claim.id} has an invalid configVersion`;
  const metadataError = metadataViolation(claim.requestMetadata, `claim ${claim.id} requestMetadata`);
  if (metadataError) return metadataError;
  try {
    timestampMillis(claim.claimedAt as string, `claim ${claim.id} claimedAt`);
  } catch (error) {
    return error instanceof Error ? error.message : `challenge claim ${claim.id} has an invalid timestamp`;
  }
  return null;
}

function idempotencyViolation(record: unknown): string | null {
  if (!isPlainRecord(record) || !hasExactKeys(record, IDEMPOTENCY_KEYS)) {
    return 'idempotency record has an invalid shape';
  }
  for (const field of ['key', 'playerId', 'resourceId', 'fingerprint', 'resultTransactionId'] as const) {
    if (typeof record[field] !== 'string' || record[field].trim() === '') return `idempotency record has an invalid ${field}`;
  }
  if (!(IDEMPOTENT_OPERATIONS as readonly unknown[]).includes(record.operation)) {
    return `idempotency record ${record.key} has unknown operation ${String(record.operation)}`;
  }
  try {
    timestampMillis(record.createdAt as string, `idempotency record ${record.key} createdAt`);
  } catch (error) {
    return error instanceof Error ? error.message : `idempotency record ${record.key} has an invalid timestamp`;
  }
  return null;
}

function operationMatchesTransaction(operation: IdempotentOperation, type: WalletTransactionType): boolean {
  return (operation === 'REGISTRATION_GRANT' && type === 'registration_grant')
    || (operation === 'CHALLENGE_REWARD' && type === 'challenge_reward')
    || (operation === 'OPERATOR_GRANT' && type === 'operator_grant')
    || (operation === 'ADJUSTMENT' && type === 'adjustment')
    || (operation === 'RESERVE' && type === 'reservation')
    || (operation === 'RELEASE' && type === 'reservation_release')
    || (operation === 'REDEEM' && type === 'redemption')
    || (operation === 'REFUND' && type === 'refund');
}

/** Derives exact balances; no mutable balance is trusted as an input. */
export function deriveLedger(
  transactions: readonly WalletTransaction[],
  reservations: readonly WalletReservation[] = [],
): LedgerSnapshot {
  if (!Array.isArray(transactions) || !Array.isArray(reservations)) {
    throw new ArcadeDomainError('INVALID_LEDGER', 'ledger transactions and reservations must be arrays');
  }
  let ledgerBalance = 0;
  for (const transaction of transactions) {
    const violation = transactionViolation(transaction);
    if (violation) throw new ArcadeDomainError('INVALID_LEDGER', violation);
    ledgerBalance += transaction.delta;
    if (ledgerBalance < 0) {
      throw new ArcadeDomainError('INVALID_LEDGER', `transaction ${transaction.id} makes the ledger negative`);
    }
  }
  for (const reservation of reservations) {
    const violation = reservationViolation(reservation);
    if (violation) throw new ArcadeDomainError('INVALID_LEDGER', violation);
  }
  const reservedBalance = reservations
    .filter(reservation => reservation.status === 'ACTIVE')
    .reduce((sum, reservation) => sum + reservation.amount, 0);
  const balance = ledgerBalance - reservedBalance;
  if (balance < 0) throw new ArcadeDomainError('INVALID_LEDGER', 'active reservations exceed ledger balance');
  return { ledgerBalance, reservedBalance, availableBalance: balance };
}

export function availableBalance(state: WalletState): number {
  assertWalletInvariants(state);
  return deriveLedger(state.transactions, state.reservations).availableBalance;
}

/** Returns every detected invariant violation, allowing stores to fail closed before writing. */
export function walletInvariantViolations(state: WalletState): string[] {
  const violations: string[] = [];
  if (!isPlainRecord(state) || !hasExactKeys(state, WALLET_STATE_KEYS)) return ['wallet state has an invalid shape'];
  const walletError = walletViolation(state.wallet);
  if (walletError) violations.push(walletError);
  for (const [field, value] of [
    ['transactions', state.transactions],
    ['reservations', state.reservations],
    ['challengeClaims', state.challengeClaims],
    ['idempotencyRecords', state.idempotencyRecords],
  ] as const) {
    if (!Array.isArray(value)) violations.push(`wallet state ${field} must be an array`);
  }
  if (violations.length > 0) return violations;

  const playerId = state.wallet.playerId;
  const transactionIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const walletCreatedAt = Date.parse(state.wallet.createdAt);
  const walletUpdatedAt = Date.parse(state.wallet.updatedAt);
  let previousTransactionAt = walletCreatedAt;

  for (const transaction of state.transactions) {
    const violation = transactionViolation(transaction);
    if (violation) {
      violations.push(violation);
      continue;
    }
    if (transactionIds.has(transaction.id)) violations.push(`duplicate transaction id ${transaction.id}`);
    transactionIds.add(transaction.id);
    if (idempotencyKeys.has(transaction.idempotencyKey)) {
      violations.push(`duplicate transaction idempotency key ${transaction.idempotencyKey}`);
    }
    idempotencyKeys.add(transaction.idempotencyKey);
    if (transaction.playerId !== playerId) violations.push(`transaction ${transaction.id} belongs to another player`);
    const transactionAt = Date.parse(transaction.createdAt);
    if (transactionAt < previousTransactionAt) {
      violations.push(`transaction ${transaction.id} precedes the prior wallet mutation`);
    }
    if (transactionAt < walletCreatedAt || transactionAt > walletUpdatedAt) {
      violations.push(`transaction ${transaction.id} falls outside the wallet lifetime`);
    }
    previousTransactionAt = transactionAt;
  }

  if (state.transactions.length === 0 && walletUpdatedAt !== walletCreatedAt) {
    violations.push('empty wallet updatedAt must equal createdAt');
  } else if (state.transactions.length > 0 && walletUpdatedAt !== previousTransactionAt) {
    violations.push('wallet updatedAt must equal the latest transaction timestamp');
  }

  if (violations.length > 0) return violations;

  if (state.transactions.filter(transaction => transaction.type === 'registration_grant').length > 1) {
    violations.push('wallet has more than one registration grant');
  }

  const reservationIds = new Set<string>();
  const activePlayers = new Set<string>();
  const activeQueueEntries = new Set<string>();
  for (const reservation of state.reservations) {
    const reservationError = reservationViolation(reservation);
    if (reservationError) {
      violations.push(reservationError);
      continue;
    }
    if (reservationIds.has(reservation.id)) violations.push(`duplicate reservation id ${reservation.id}`);
    reservationIds.add(reservation.id);
    if (reservation.playerId !== playerId) violations.push(`reservation ${reservation.id} belongs to another player`);
    if (!Number.isInteger(reservation.amount) || reservation.amount <= 0) {
      violations.push(`reservation ${reservation.id} has an invalid amount`);
    }
    if (reservation.status === 'ACTIVE') {
      if (activePlayers.has(reservation.playerId)) violations.push(`player ${reservation.playerId} has multiple active reservations`);
      if (activeQueueEntries.has(reservation.queueEntryId)) {
        violations.push(`queue entry ${reservation.queueEntryId} has multiple active reservations`);
      }
      activePlayers.add(reservation.playerId);
      activeQueueEntries.add(reservation.queueEntryId);
    }

    const lifecycle = state.transactions.filter(transaction => transaction.reservationId === reservation.id);
    const reserved = lifecycle.filter(transaction => transaction.type === 'reservation');
    const released = lifecycle.filter(transaction => transaction.type === 'reservation_release');
    const redeemed = lifecycle.filter(transaction => transaction.type === 'redemption');
    const refunded = lifecycle.filter(transaction => transaction.type === 'refund');
    if (reserved.length !== 1) violations.push(`reservation ${reservation.id} must have one reservation transaction`);
    if (reservation.status === 'ACTIVE' && (released.length || redeemed.length || refunded.length)) {
      violations.push(`active reservation ${reservation.id} has a terminal transaction`);
    }
    if (reservation.status === 'RELEASED' && (released.length !== 1 || redeemed.length || refunded.length)) {
      violations.push(`released reservation ${reservation.id} has an invalid lifecycle`);
    }
    if (reservation.status === 'REDEEMED' && (released.length || redeemed.length !== 1 || refunded.length)) {
      violations.push(`redeemed reservation ${reservation.id} has an invalid lifecycle`);
    }
    if (reservation.status === 'REFUNDED' && (released.length || redeemed.length !== 1 || refunded.length !== 1)) {
      violations.push(`refunded reservation ${reservation.id} has an invalid lifecycle`);
    }
    if (redeemed[0] && redeemed[0].delta !== -reservation.amount) {
      violations.push(`reservation ${reservation.id} redemption amount does not match its hold`);
    }
    if (refunded[0] && refunded[0].delta !== reservation.amount) {
      violations.push(`reservation ${reservation.id} refund amount does not match its redemption`);
    }
    if (reserved[0]?.createdAt !== reservation.createdAt) {
      violations.push(`reservation ${reservation.id} creation timestamp does not match its transaction`);
    }
    if (released[0] && released[0].createdAt !== reservation.releasedAt) {
      violations.push(`reservation ${reservation.id} release timestamp does not match its transaction`);
    }
    if (redeemed[0] && redeemed[0].createdAt !== reservation.redeemedAt) {
      violations.push(`reservation ${reservation.id} redemption timestamp does not match its transaction`);
    }
    if (refunded[0] && refunded[0].createdAt !== reservation.refundedAt) {
      violations.push(`reservation ${reservation.id} refund timestamp does not match its transaction`);
    }
  }

  if (violations.length > 0) return violations;

  for (const transaction of state.transactions) {
    if (transaction.reservationId && !reservationIds.has(transaction.reservationId)) {
      violations.push(`transaction ${transaction.id} references an unknown reservation`);
    }
  }

  const claimIds = new Set<string>();
  for (const claim of state.challengeClaims) {
    const claimError = claimViolation(claim);
    if (claimError) {
      violations.push(claimError);
      continue;
    }
    if (claimIds.has(claim.id)) violations.push(`duplicate challenge claim id ${claim.id}`);
    claimIds.add(claim.id);
    if (claim.playerId !== playerId) violations.push(`challenge claim ${claim.id} belongs to another player`);
    const transaction = state.transactions.find(candidate => candidate.id === claim.transactionId);
    if (!transaction || transaction.type !== 'challenge_reward' || transaction.challengeId !== claim.challengeId
      || transaction.delta !== claim.rewardCoins) {
      violations.push(`challenge claim ${claim.id} does not match its reward transaction`);
    }
  }

  if (violations.length > 0) return violations;

  const recordKeys = new Set<string>();
  for (const record of state.idempotencyRecords) {
    const recordError = idempotencyViolation(record);
    if (recordError) {
      violations.push(recordError);
      continue;
    }
    if (recordKeys.has(record.key)) violations.push(`duplicate idempotency record ${record.key}`);
    recordKeys.add(record.key);
    if (record.playerId !== playerId) violations.push(`idempotency record ${record.key} belongs to another player`);
    const transaction = state.transactions.find(candidate => candidate.id === record.resultTransactionId);
    if (!transaction || transaction.idempotencyKey !== record.key) {
      violations.push(`idempotency record ${record.key} does not match a transaction`);
    } else if (!operationMatchesTransaction(record.operation, transaction.type)) {
      violations.push(`idempotency record ${record.key} operation does not match its transaction`);
    }
  }
  for (const transaction of state.transactions) {
    if (!recordKeys.has(transaction.idempotencyKey)) {
      violations.push(`transaction ${transaction.id} has no idempotency record`);
    }
  }

  try {
    const derived = deriveLedger(state.transactions, state.reservations);
    if (state.wallet.cachedBalance !== derived.ledgerBalance) {
      violations.push('cached balance does not match the ledger');
    }
  } catch (error) {
    violations.push(error instanceof Error ? error.message : 'ledger is invalid');
  }
  return violations;
}

export function assertWalletInvariants(state: WalletState): void {
  const violations = walletInvariantViolations(state);
  if (violations.length > 0) throw new ArcadeDomainError('INVALID_WALLET', violations.join('; '));
}

function idempotentReplay(
  state: WalletState,
  key: string,
  operation: IdempotentOperation,
  fingerprint: string,
): boolean {
  const existing = state.idempotencyRecords.find(record => record.key === key);
  if (!existing) return false;
  if (existing.operation !== operation || existing.fingerprint !== fingerprint) {
    throw new ArcadeDomainError('IDEMPOTENCY_CONFLICT', `idempotency key ${key} was used for a different request`);
  }
  return true;
}

function appendMutation(
  state: WalletState,
  transaction: WalletTransaction,
  operation: IdempotentOperation,
  resourceId: string,
  fingerprint: string,
  changes: Pick<Partial<WalletState>, 'reservations' | 'challengeClaims'> = {},
): WalletState {
  if (state.transactions.some(existing => existing.id === transaction.id)) {
    throw new ArcadeDomainError('DUPLICATE_TRANSACTION', `transaction ${transaction.id} already exists`);
  }
  const next: WalletState = {
    wallet: {
      ...state.wallet,
      cachedBalance: state.wallet.cachedBalance + transaction.delta,
      updatedAt: transaction.createdAt,
    },
    transactions: [...state.transactions, transaction],
    reservations: changes.reservations ?? state.reservations,
    challengeClaims: changes.challengeClaims ?? state.challengeClaims,
    idempotencyRecords: [...state.idempotencyRecords, {
      key: transaction.idempotencyKey,
      playerId: state.wallet.playerId,
      operation,
      resourceId,
      fingerprint,
      resultTransactionId: transaction.id,
      createdAt: transaction.createdAt,
    }],
  };
  assertWalletInvariants(next);
  return freezeWalletState(next);
}

function makeTransaction(
  state: WalletState,
  input: MutationContext,
  type: WalletTransactionType,
  delta: number,
  references: { reservationId?: string; challengeId?: string; matchId?: string } = {},
): WalletTransaction {
  return {
    id: input.transactionId,
    playerId: state.wallet.playerId,
    type,
    delta,
    reservationId: references.reservationId ?? null,
    challengeId: references.challengeId ?? null,
    matchId: references.matchId ?? null,
    idempotencyKey: input.idempotencyKey,
    configVersion: input.configVersion,
    metadata: cloneAndFreezeMetadata(input.metadata ?? {}, 'transaction metadata'),
    createdAt: input.createdAt,
  };
}

export function grantRegistrationCoins(state: WalletState, input: RegistrationGrantInput): WalletState {
  assertWalletInvariants(state);
  validateContext(input);
  requirePositiveInteger(input.amount, 'registration grant amount');
  const fingerprint = JSON.stringify([state.wallet.playerId, input.amount]);
  if (idempotentReplay(state, input.idempotencyKey, 'REGISTRATION_GRANT', fingerprint)) return freezeWalletState(state);
  if (state.transactions.some(transaction => transaction.type === 'registration_grant')) {
    throw new ArcadeDomainError('REGISTRATION_ALREADY_GRANTED', 'registration grant may be applied only once');
  }
  return appendMutation(
    state,
    makeTransaction(state, input, 'registration_grant', input.amount),
    'REGISTRATION_GRANT',
    state.wallet.playerId,
    fingerprint,
  );
}

export function claimChallengeReward(state: WalletState, input: ChallengeRewardInput): WalletState {
  assertWalletInvariants(state);
  validateContext(input);
  requireIdentifier(input.claimId, 'claim id');
  requireIdentifier(input.challengeId, 'challenge id');
  requirePositiveInteger(input.rewardCoins, 'challenge reward');
  requirePositiveInteger(input.maxClaimsPerPlayer, 'maxClaimsPerPlayer');
  const fingerprint = JSON.stringify([
    input.challengeId, input.rewardCoins, input.maxClaimsPerPlayer,
  ]);
  if (idempotentReplay(state, input.idempotencyKey, 'CHALLENGE_REWARD', fingerprint)) return freezeWalletState(state);
  if (!input.enabled) throw new ArcadeDomainError('CHALLENGE_UNAVAILABLE', 'challenge is disabled');
  const claimedAt = timestampMillis(input.createdAt, 'createdAt');
  if (input.startsAt && claimedAt < timestampMillis(input.startsAt, 'startsAt')) {
    throw new ArcadeDomainError('CHALLENGE_UNAVAILABLE', 'challenge has not started');
  }
  if (input.endsAt && claimedAt >= timestampMillis(input.endsAt, 'endsAt')) {
    throw new ArcadeDomainError('CHALLENGE_UNAVAILABLE', 'challenge has ended');
  }
  const priorClaims = state.challengeClaims.filter(claim => claim.challengeId === input.challengeId).length;
  if (priorClaims >= input.maxClaimsPerPlayer) {
    throw new ArcadeDomainError('CHALLENGE_CLAIM_LIMIT', 'challenge claim limit reached');
  }
  if (state.challengeClaims.some(claim => claim.id === input.claimId)) {
    throw new ArcadeDomainError('DUPLICATE_CLAIM', `claim ${input.claimId} already exists`);
  }
  const claim: ChallengeClaim = {
    id: input.claimId,
    challengeId: input.challengeId,
    playerId: state.wallet.playerId,
    rewardCoins: input.rewardCoins,
    configVersion: input.configVersion,
    requestMetadata: cloneAndFreezeMetadata(input.requestMetadata ?? {}, 'challenge requestMetadata'),
    idempotencyKey: input.idempotencyKey,
    transactionId: input.transactionId,
    claimedAt: input.createdAt,
  };
  return appendMutation(
    state,
    makeTransaction(state, input, 'challenge_reward', input.rewardCoins, { challengeId: input.challengeId }),
    'CHALLENGE_REWARD',
    input.challengeId,
    fingerprint,
    { challengeClaims: [...state.challengeClaims, claim] },
  );
}

export function reserveCoins(state: WalletState, input: ReserveCoinsInput): WalletState {
  assertWalletInvariants(state);
  validateContext(input);
  requireIdentifier(input.reservationId, 'reservation id');
  requireIdentifier(input.queueEntryId, 'queue entry id');
  requirePositiveInteger(input.amount, 'reservation amount');
  const fingerprint = JSON.stringify([input.reservationId, input.queueEntryId, input.amount]);
  if (idempotentReplay(state, input.idempotencyKey, 'RESERVE', fingerprint)) return freezeWalletState(state);
  if (state.reservations.some(reservation => reservation.id === input.reservationId)) {
    throw new ArcadeDomainError('DUPLICATE_RESERVATION', `reservation ${input.reservationId} already exists`);
  }
  if (state.reservations.some(reservation => reservation.status === 'ACTIVE'
    && (reservation.playerId === state.wallet.playerId || reservation.queueEntryId === input.queueEntryId))) {
    throw new ArcadeDomainError('ACTIVE_RESERVATION_EXISTS', 'player or queue entry already has an active reservation');
  }
  if (availableBalance(state) < input.amount) {
    throw new ArcadeDomainError('INSUFFICIENT_BALANCE', 'available balance is too low');
  }
  const reservation: WalletReservation = {
    id: input.reservationId,
    playerId: state.wallet.playerId,
    queueEntryId: input.queueEntryId,
    amount: input.amount,
    status: 'ACTIVE',
    createdAt: input.createdAt,
    releasedAt: null,
    redeemedAt: null,
    refundedAt: null,
    matchId: null,
    configVersion: input.configVersion,
  };
  return appendMutation(
    state,
    makeTransaction(state, input, 'reservation', 0, { reservationId: input.reservationId }),
    'RESERVE',
    input.reservationId,
    fingerprint,
    { reservations: [...state.reservations, reservation] },
  );
}

export function releaseReservation(state: WalletState, input: ReservationMutationInput): WalletState {
  assertWalletInvariants(state);
  validateContext(input);
  requireIdentifier(input.reservationId, 'reservation id');
  const fingerprint = JSON.stringify([input.reservationId]);
  if (idempotentReplay(state, input.idempotencyKey, 'RELEASE', fingerprint)) return freezeWalletState(state);
  const reservation = state.reservations.find(candidate => candidate.id === input.reservationId);
  if (!reservation) throw new ArcadeDomainError('RESERVATION_NOT_FOUND', 'reservation was not found');
  if (reservation.status !== 'ACTIVE') {
    throw new ArcadeDomainError('ILLEGAL_RESERVATION_TRANSITION', `cannot release ${reservation.status} reservation`);
  }
  const reservations = state.reservations.map(candidate => candidate.id === reservation.id
    ? { ...candidate, status: 'RELEASED' as const, releasedAt: input.createdAt }
    : candidate);
  return appendMutation(
    state,
    makeTransaction(state, input, 'reservation_release', 0, { reservationId: input.reservationId }),
    'RELEASE',
    input.reservationId,
    fingerprint,
    { reservations },
  );
}

export function redeemReservation(state: WalletState, input: RedeemReservationInput): WalletState {
  assertWalletInvariants(state);
  validateContext(input);
  requireIdentifier(input.reservationId, 'reservation id');
  requireIdentifier(input.matchId, 'match id');
  const fingerprint = JSON.stringify([input.reservationId, input.matchId]);
  if (idempotentReplay(state, input.idempotencyKey, 'REDEEM', fingerprint)) return freezeWalletState(state);
  const reservation = state.reservations.find(candidate => candidate.id === input.reservationId);
  if (!reservation) throw new ArcadeDomainError('RESERVATION_NOT_FOUND', 'reservation was not found');
  if (reservation.status !== 'ACTIVE') {
    throw new ArcadeDomainError('ILLEGAL_RESERVATION_TRANSITION', `cannot redeem ${reservation.status} reservation`);
  }
  const reservations = state.reservations.map(candidate => candidate.id === reservation.id
    ? { ...candidate, status: 'REDEEMED' as const, redeemedAt: input.createdAt, matchId: input.matchId }
    : candidate);
  return appendMutation(
    state,
    makeTransaction(state, input, 'redemption', -reservation.amount, {
      reservationId: input.reservationId,
      matchId: input.matchId,
    }),
    'REDEEM',
    input.reservationId,
    fingerprint,
    { reservations },
  );
}

export function refundReservation(state: WalletState, input: ReservationMutationInput): WalletState {
  assertWalletInvariants(state);
  validateContext(input);
  requireIdentifier(input.reservationId, 'reservation id');
  const fingerprint = JSON.stringify([input.reservationId]);
  if (idempotentReplay(state, input.idempotencyKey, 'REFUND', fingerprint)) return freezeWalletState(state);
  const reservation = state.reservations.find(candidate => candidate.id === input.reservationId);
  if (!reservation) throw new ArcadeDomainError('RESERVATION_NOT_FOUND', 'reservation was not found');
  if (reservation.status !== 'REDEEMED' || !reservation.matchId) {
    throw new ArcadeDomainError('ILLEGAL_RESERVATION_TRANSITION', `cannot refund ${reservation.status} reservation`);
  }
  const reservations = state.reservations.map(candidate => candidate.id === reservation.id
    ? { ...candidate, status: 'REFUNDED' as const, refundedAt: input.createdAt }
    : candidate);
  return appendMutation(
    state,
    makeTransaction(state, input, 'refund', reservation.amount, {
      reservationId: input.reservationId,
      matchId: reservation.matchId,
    }),
    'REFUND',
    input.reservationId,
    fingerprint,
    { reservations },
  );
}
