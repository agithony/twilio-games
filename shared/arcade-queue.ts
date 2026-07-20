import type { ArcadeTimestamp } from './arcade-domain';

export const QUEUE_STATUSES = [
  'WAITING',
  'APPROACHING',
  'CALLED',
  'CHECKED_IN',
  'ACTIVE_LOBBY',
  'PLAYING',
  'COMPLETED',
  'DEFERRED',
  'NO_SHOW',
  'LEFT_QUEUE',
  'RELEASED',
] as const;

export type QueueStatus = typeof QUEUE_STATUSES[number];

export interface QueueEntry {
  readonly id: string;
  readonly cabinetId: string;
  readonly playerId: string;
  readonly preferredGame: string;
  readonly flexibleGame: boolean;
  readonly status: QueueStatus;
  readonly joinedAt: ArcadeTimestamp;
  readonly originalJoinedAt: ArcadeTimestamp;
  readonly updatedAt: ArcadeTimestamp;
  readonly approachingConfirmedAt: ArcadeTimestamp | null;
  readonly calledAt: ArcadeTimestamp | null;
  readonly checkInExpiresAt: ArcadeTimestamp | null;
  readonly deferredUntil: ArcadeTimestamp | null;
  readonly checkedInAt: ArcadeTimestamp | null;
  readonly deferralCount: number;
  readonly automaticDeferralCount: number;
  readonly snoozeCount: number;
  readonly missCount: number;
  readonly configVersion: number;
}

export const QUEUE_EVENT_TYPES = [
  'QUEUE_JOINED',
  'MARKED_APPROACHING',
  'PRESENCE_CONFIRMED',
  'CALLED',
  'CHECKED_IN',
  'ENTERED_ACTIVE_LOBBY',
  'STARTED_PLAYING',
  'COMPLETED',
  'DEFERRED',
  'RETURNED_TO_WAITING',
  'MARKED_NO_SHOW',
  'LEFT_QUEUE',
  'RELEASED',
] as const;

export type QueueEventType = typeof QUEUE_EVENT_TYPES[number];

export interface QueueEvent {
  readonly id: string;
  readonly type: QueueEventType;
  readonly queueEntryId: string;
  readonly cabinetId: string;
  readonly playerId: string;
  readonly fromStatus: QueueStatus | null;
  readonly toStatus: QueueStatus;
  readonly occurredAt: ArcadeTimestamp;
  readonly reason: string | null;
  readonly configVersion: number;
}

export interface QueueReduction {
  readonly entry: QueueEntry;
  readonly event: QueueEvent;
}

export interface QueuePolicy {
  automaticDeferrals: number;
  removeAfterMisses: number;
  snoozeSeconds: number;
  maximumSnoozes?: number;
}

export interface JoinQueueInput {
  id: string;
  eventId: string;
  cabinetId: string;
  playerId: string;
  preferredGame: string;
  flexibleGame: boolean;
  joinedAt: ArcadeTimestamp;
  configVersion: number;
}

interface QueueActionBase {
  eventId: string;
  at: ArcadeTimestamp;
  reason?: string;
}

export type QueueAction =
  | (QueueActionBase & { type: 'MARK_APPROACHING' })
  | (QueueActionBase & { type: 'CONFIRM_PRESENCE' })
  | (QueueActionBase & { type: 'CALL'; checkInExpiresAt: ArcadeTimestamp })
  | (QueueActionBase & { type: 'CHECK_IN' })
  | (QueueActionBase & { type: 'ENTER_ACTIVE_LOBBY' })
  | (QueueActionBase & { type: 'START_PLAYING' })
  | (QueueActionBase & { type: 'COMPLETE' })
  | (QueueActionBase & { type: 'DEFER'; deferredUntil: ArcadeTimestamp })
  | (QueueActionBase & { type: 'RETURN_TO_WAITING' })
  | (QueueActionBase & { type: 'MARK_NO_SHOW' })
  | (QueueActionBase & { type: 'LEAVE' })
  | (QueueActionBase & { type: 'RELEASE' });

export class ArcadeQueueError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArcadeQueueError';
  }
}

const TERMINAL_STATUSES = new Set<QueueStatus>([
  'COMPLETED', 'NO_SHOW', 'LEFT_QUEUE', 'RELEASED',
]);

const LEGAL_TRANSITIONS: Readonly<Record<QueueStatus, readonly QueueStatus[]>> = {
  WAITING: ['APPROACHING', 'DEFERRED', 'LEFT_QUEUE'],
  APPROACHING: ['CALLED', 'DEFERRED', 'LEFT_QUEUE'],
  CALLED: ['CHECKED_IN', 'DEFERRED', 'NO_SHOW', 'LEFT_QUEUE'],
  CHECKED_IN: ['ACTIVE_LOBBY', 'RELEASED'],
  ACTIVE_LOBBY: ['PLAYING', 'RELEASED'],
  PLAYING: ['COMPLETED'],
  COMPLETED: [],
  DEFERRED: ['WAITING', 'LEFT_QUEUE'],
  NO_SHOW: [],
  LEFT_QUEUE: [],
  RELEASED: [],
};

const EVENT_TARGET_STATUS: Readonly<Record<
  Exclude<QueueEventType, 'QUEUE_JOINED' | 'PRESENCE_CONFIRMED'>,
  QueueStatus
>> = {
  MARKED_APPROACHING: 'APPROACHING',
  CALLED: 'CALLED',
  CHECKED_IN: 'CHECKED_IN',
  ENTERED_ACTIVE_LOBBY: 'ACTIVE_LOBBY',
  STARTED_PLAYING: 'PLAYING',
  COMPLETED: 'COMPLETED',
  DEFERRED: 'DEFERRED',
  RETURNED_TO_WAITING: 'WAITING',
  MARKED_NO_SHOW: 'NO_SHOW',
  LEFT_QUEUE: 'LEFT_QUEUE',
  RELEASED: 'RELEASED',
};

const QUEUE_ENTRY_KEYS = [
  'id', 'cabinetId', 'playerId', 'preferredGame', 'flexibleGame', 'status', 'joinedAt',
  'originalJoinedAt', 'updatedAt', 'approachingConfirmedAt', 'calledAt', 'checkInExpiresAt',
  'deferredUntil', 'checkedInAt', 'deferralCount', 'automaticDeferralCount', 'snoozeCount',
  'missCount', 'configVersion',
] as const;
const QUEUE_EVENT_KEYS = [
  'id', 'type', 'queueEntryId', 'cabinetId', 'playerId', 'fromStatus', 'toStatus',
  'occurredAt', 'reason', 'configVersion',
] as const;

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

function isQueueStatus(value: unknown): value is QueueStatus {
  return (QUEUE_STATUSES as readonly unknown[]).includes(value);
}

function isQueueEventType(value: unknown): value is QueueEventType {
  return (QUEUE_EVENT_TYPES as readonly unknown[]).includes(value);
}

function requireString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ArcadeQueueError('INVALID_QUEUE_VALUE', `${field} must be a non-empty string`);
  }
  return value;
}

function timestampMillis(value: ArcadeTimestamp, field: string): number {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ArcadeQueueError('INVALID_QUEUE_TIMESTAMP', `${field} must be a valid timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new ArcadeQueueError('INVALID_QUEUE_TIMESTAMP', `${field} must be a valid timestamp`);
  }
  return millis;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ArcadeQueueError('INVALID_QUEUE_POLICY', `${field} must be a non-negative integer`);
  }
  return value;
}

function validatePolicy(policy: QueuePolicy): void {
  if (!isPlainRecord(policy)) throw new ArcadeQueueError('INVALID_QUEUE_POLICY', 'policy must be an object');
  const keys = Object.keys(policy);
  const required = ['automaticDeferrals', 'removeAfterMisses', 'snoozeSeconds'];
  const allowed = [...required, 'maximumSnoozes'];
  if (required.some(key => !keys.includes(key)) || keys.some(key => !allowed.includes(key))) {
    throw new ArcadeQueueError('INVALID_QUEUE_POLICY', 'policy has an invalid shape');
  }
  requireNonNegativeInteger(policy.automaticDeferrals, 'automaticDeferrals');
  if (!Number.isInteger(policy.removeAfterMisses) || policy.removeAfterMisses <= 0) {
    throw new ArcadeQueueError('INVALID_QUEUE_POLICY', 'removeAfterMisses must be a positive integer');
  }
  if (!Number.isInteger(policy.snoozeSeconds) || policy.snoozeSeconds <= 0) {
    throw new ArcadeQueueError('INVALID_QUEUE_POLICY', 'snoozeSeconds must be a positive integer');
  }
  requireNonNegativeInteger(policy.maximumSnoozes ?? 1, 'maximumSnoozes');
}

function addSeconds(timestamp: ArcadeTimestamp, seconds: number): ArcadeTimestamp {
  return new Date(timestampMillis(timestamp, 'at') + seconds * 1000).toISOString();
}

function eventFor(
  entry: QueueEntry,
  action: QueueActionBase,
  type: QueueEventType,
  toStatus: QueueStatus,
): QueueEvent {
  return freezeQueueEvent({
    id: requireString(action.eventId, 'event id'),
    type,
    queueEntryId: entry.id,
    cabinetId: entry.cabinetId,
    playerId: entry.playerId,
    fromStatus: entry.status,
    toStatus,
    occurredAt: action.at,
    reason: action.reason ?? null,
    configVersion: entry.configVersion,
  });
}

export function isTerminalQueueStatus(status: QueueStatus): boolean {
  return isQueueStatus(status) && TERMINAL_STATUSES.has(status);
}

export function isLegalQueueTransition(from: QueueStatus, to: QueueStatus): boolean {
  return isQueueStatus(from) && isQueueStatus(to) && LEGAL_TRANSITIONS[from].includes(to);
}

function freezeQueueEntry(entry: QueueEntry): QueueEntry {
  return Object.freeze({ ...entry });
}

function freezeQueueEvent(event: QueueEvent): QueueEvent {
  assertQueueEventInvariants(event);
  return Object.freeze({ ...event });
}

function freezeReduction(entry: QueueEntry, event: QueueEvent): QueueReduction {
  return Object.freeze({ entry: freezeQueueEntry(entry), event: freezeQueueEvent(event) });
}

export function queueEntryInvariantViolations(entry: QueueEntry): string[] {
  const violations: string[] = [];
  if (!isPlainRecord(entry) || !hasExactKeys(entry, QUEUE_ENTRY_KEYS)) return ['queue entry has an invalid shape'];
  for (const field of ['id', 'cabinetId', 'playerId', 'preferredGame'] as const) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') violations.push(`invalid ${field}`);
  }
  if (typeof entry.flexibleGame !== 'boolean') violations.push('invalid flexibleGame');
  if (!isQueueStatus(entry.status)) violations.push(`unknown status ${String(entry.status)}`);
  if (!Number.isInteger(entry.deferralCount) || entry.deferralCount < 0) violations.push('invalid deferralCount');
  if (!Number.isInteger(entry.automaticDeferralCount) || entry.automaticDeferralCount < 0) {
    violations.push('invalid automaticDeferralCount');
  }
  if (!Number.isInteger(entry.snoozeCount) || entry.snoozeCount < 0) violations.push('invalid snoozeCount');
  if (Number.isInteger(entry.deferralCount) && Number.isInteger(entry.automaticDeferralCount)
    && Number.isInteger(entry.snoozeCount)
    && entry.automaticDeferralCount + entry.snoozeCount > entry.deferralCount) {
    violations.push('deferral counters are inconsistent');
  }
  if (!Number.isInteger(entry.missCount) || entry.missCount < 0) violations.push('invalid missCount');
  if (!Number.isInteger(entry.configVersion) || entry.configVersion < 0) violations.push('invalid configVersion');
  try {
    const original = timestampMillis(entry.originalJoinedAt, 'originalJoinedAt');
    const joined = timestampMillis(entry.joinedAt, 'joinedAt');
    const updated = timestampMillis(entry.updatedAt, 'updatedAt');
    if (joined < original) violations.push('joinedAt precedes originalJoinedAt');
    if (updated < joined) violations.push('updatedAt precedes joinedAt');
    if (entry.approachingConfirmedAt) {
      const confirmed = timestampMillis(entry.approachingConfirmedAt, 'approachingConfirmedAt');
      if (confirmed < joined || confirmed > updated) violations.push('presence confirmation is out of order');
    }
    if (entry.calledAt) {
      const called = timestampMillis(entry.calledAt, 'calledAt');
      if (called > updated) violations.push('calledAt follows updatedAt');
      if (entry.approachingConfirmedAt && called < timestampMillis(entry.approachingConfirmedAt, 'approachingConfirmedAt')) {
        violations.push('calledAt precedes presence confirmation');
      }
      if (entry.checkInExpiresAt && timestampMillis(entry.checkInExpiresAt, 'checkInExpiresAt') <= called) {
        violations.push('checkInExpiresAt must follow calledAt');
      }
    } else if (entry.checkInExpiresAt) {
      timestampMillis(entry.checkInExpiresAt, 'checkInExpiresAt');
      violations.push('checkInExpiresAt requires calledAt');
    }
    if (entry.deferredUntil) {
      const deferredUntil = timestampMillis(entry.deferredUntil, 'deferredUntil');
      if (entry.status === 'DEFERRED' && deferredUntil <= updated) violations.push('deferredUntil must follow updatedAt');
    }
    if (entry.checkedInAt) {
      const checkedIn = timestampMillis(entry.checkedInAt, 'checkedInAt');
      if (!entry.calledAt || checkedIn < timestampMillis(entry.calledAt, 'calledAt') || checkedIn > updated) {
        violations.push('checkedInAt is out of order');
      }
      if (entry.checkInExpiresAt && checkedIn >= timestampMillis(entry.checkInExpiresAt, 'checkInExpiresAt')) {
        violations.push('checkedInAt must precede checkInExpiresAt');
      }
    }
  } catch (error) {
    violations.push(error instanceof Error ? error.message : 'invalid timestamp');
  }
  if (['CALLED', 'CHECKED_IN', 'ACTIVE_LOBBY', 'PLAYING', 'COMPLETED', 'NO_SHOW'].includes(entry.status)
    && (!entry.approachingConfirmedAt || !entry.calledAt || !entry.checkInExpiresAt)) {
    violations.push(`${entry.status} entry requires confirmed presence and call fields`);
  }
  if (entry.status === 'DEFERRED' && !entry.deferredUntil) violations.push('deferred entry requires deferredUntil');
  if (['CHECKED_IN', 'ACTIVE_LOBBY', 'PLAYING', 'COMPLETED', 'RELEASED'].includes(entry.status)
    && !entry.checkedInAt) violations.push(`${entry.status} entry requires checkedInAt`);
  if ((entry.status === 'WAITING' || entry.status === 'APPROACHING')
    && (entry.calledAt || entry.checkInExpiresAt || entry.deferredUntil || entry.checkedInAt)) {
    violations.push(`${entry.status} entry contains stale call, deferral, or check-in state`);
  }
  return violations;
}

export function queueEventInvariantViolations(event: QueueEvent): string[] {
  const violations: string[] = [];
  if (!isPlainRecord(event) || !hasExactKeys(event, QUEUE_EVENT_KEYS)) return ['queue event has an invalid shape'];
  for (const field of ['id', 'queueEntryId', 'cabinetId', 'playerId'] as const) {
    if (typeof event[field] !== 'string' || event[field].trim() === '') violations.push(`queue event has an invalid ${field}`);
  }
  if (!isQueueEventType(event.type)) violations.push(`unknown queue event type ${String(event.type)}`);
  if (event.fromStatus !== null && !isQueueStatus(event.fromStatus)) {
    violations.push(`unknown queue event fromStatus ${String(event.fromStatus)}`);
  }
  if (!isQueueStatus(event.toStatus)) violations.push(`unknown queue event toStatus ${String(event.toStatus)}`);
  if (event.reason !== null && (typeof event.reason !== 'string' || event.reason.trim() === '')) {
    violations.push('queue event reason must be a non-empty string or null');
  }
  if (!Number.isInteger(event.configVersion) || event.configVersion < 0) violations.push('queue event has an invalid configVersion');
  try {
    timestampMillis(event.occurredAt, 'queue event occurredAt');
  } catch (error) {
    violations.push(error instanceof Error ? error.message : 'queue event has an invalid timestamp');
  }
  if (violations.length > 0) return violations;
  if (event.type === 'QUEUE_JOINED') {
    if (event.fromStatus !== null || event.toStatus !== 'WAITING') violations.push('QUEUE_JOINED has invalid statuses');
  } else if (event.type === 'PRESENCE_CONFIRMED') {
    if (event.fromStatus !== 'APPROACHING' || event.toStatus !== 'APPROACHING') {
      violations.push('PRESENCE_CONFIRMED has invalid statuses');
    }
  } else {
    const expectedTarget = EVENT_TARGET_STATUS[event.type];
    if (event.toStatus !== expectedTarget || event.fromStatus === null
      || !isLegalQueueTransition(event.fromStatus, event.toStatus)) {
      violations.push(`${event.type} has invalid statuses`);
    }
  }
  return violations;
}

export function assertQueueEventInvariants(event: QueueEvent): void {
  const violations = queueEventInvariantViolations(event);
  if (violations.length > 0) throw new ArcadeQueueError('INVALID_QUEUE_EVENT', violations.join('; '));
}

export function assertQueueEntryInvariants(entry: QueueEntry): void {
  const violations = queueEntryInvariantViolations(entry);
  if (violations.length > 0) throw new ArcadeQueueError('INVALID_QUEUE_ENTRY', violations.join('; '));
}

/** Creates a WAITING entry and rejects a second live entry for the same player and cabinet. */
export function joinQueue(existingEntries: readonly QueueEntry[], input: JoinQueueInput): QueueReduction {
  if (!Array.isArray(existingEntries)) throw new ArcadeQueueError('INVALID_QUEUE_VALUE', 'existingEntries must be an array');
  for (const existing of existingEntries) assertQueueEntryInvariants(existing);
  if (!isPlainRecord(input) || !hasExactKeys(input, [
    'id', 'eventId', 'cabinetId', 'playerId', 'preferredGame', 'flexibleGame', 'joinedAt', 'configVersion',
  ])) throw new ArcadeQueueError('INVALID_QUEUE_VALUE', 'join input has an invalid shape');
  requireString(input.id, 'queue entry id');
  requireString(input.eventId, 'event id');
  requireString(input.cabinetId, 'cabinet id');
  requireString(input.playerId, 'player id');
  requireString(input.preferredGame, 'preferred game');
  if (typeof input.flexibleGame !== 'boolean') throw new ArcadeQueueError('INVALID_QUEUE_VALUE', 'flexibleGame must be boolean');
  timestampMillis(input.joinedAt, 'joinedAt');
  requireNonNegativeInteger(input.configVersion, 'configVersion');
  if (existingEntries.some(entry => entry.id === input.id)) {
    throw new ArcadeQueueError('DUPLICATE_QUEUE_ENTRY', `queue entry ${input.id} already exists`);
  }
  if (existingEntries.some(entry => entry.cabinetId === input.cabinetId
    && entry.playerId === input.playerId && !isTerminalQueueStatus(entry.status))) {
    throw new ArcadeQueueError('PLAYER_ALREADY_QUEUED', 'player already has a live queue entry for this cabinet');
  }
  const entry: QueueEntry = {
    id: input.id,
    cabinetId: input.cabinetId,
    playerId: input.playerId,
    preferredGame: input.preferredGame,
    flexibleGame: input.flexibleGame,
    status: 'WAITING',
    joinedAt: input.joinedAt,
    originalJoinedAt: input.joinedAt,
    updatedAt: input.joinedAt,
    approachingConfirmedAt: null,
    calledAt: null,
    checkInExpiresAt: null,
    deferredUntil: null,
    checkedInAt: null,
    deferralCount: 0,
    automaticDeferralCount: 0,
    snoozeCount: 0,
    missCount: 0,
    configVersion: input.configVersion,
  };
  assertQueueEntryInvariants(entry);
  const event: QueueEvent = {
      id: input.eventId,
      type: 'QUEUE_JOINED',
      queueEntryId: entry.id,
      cabinetId: entry.cabinetId,
      playerId: entry.playerId,
      fromStatus: null,
      toStatus: 'WAITING',
      occurredAt: input.joinedAt,
      reason: null,
      configVersion: entry.configVersion,
  };
  return freezeReduction(entry, event);
}

function targetFor(action: QueueAction): QueueStatus | null {
  switch (action.type) {
    case 'MARK_APPROACHING': return 'APPROACHING';
    case 'CONFIRM_PRESENCE': return null;
    case 'CALL': return 'CALLED';
    case 'CHECK_IN': return 'CHECKED_IN';
    case 'ENTER_ACTIVE_LOBBY': return 'ACTIVE_LOBBY';
    case 'START_PLAYING': return 'PLAYING';
    case 'COMPLETE': return 'COMPLETED';
    case 'DEFER': return 'DEFERRED';
    case 'RETURN_TO_WAITING': return 'WAITING';
    case 'MARK_NO_SHOW': return 'NO_SHOW';
    case 'LEAVE': return 'LEFT_QUEUE';
    case 'RELEASE': return 'RELEASED';
  }
}

function validateAction(action: QueueAction): void {
  if (!isPlainRecord(action)) throw new ArcadeQueueError('INVALID_QUEUE_ACTION', 'queue action must be an object');
  const allowedTypes = [
    'MARK_APPROACHING', 'CONFIRM_PRESENCE', 'CALL', 'CHECK_IN', 'ENTER_ACTIVE_LOBBY',
    'START_PLAYING', 'COMPLETE', 'DEFER', 'RETURN_TO_WAITING', 'MARK_NO_SHOW', 'LEAVE', 'RELEASE',
  ];
  if (!allowedTypes.includes(action.type)) {
    throw new ArcadeQueueError('INVALID_QUEUE_ACTION', `unknown queue action ${String(action.type)}`);
  }
  const required = ['type', 'eventId', 'at'];
  const allowed = [...required, 'reason'];
  if (action.type === 'CALL') {
    required.push('checkInExpiresAt');
    allowed.push('checkInExpiresAt');
  }
  if (action.type === 'DEFER') {
    required.push('deferredUntil');
    allowed.push('deferredUntil');
  }
  const keys = Object.keys(action);
  if (required.some(key => !keys.includes(key)) || keys.some(key => !allowed.includes(key))) {
    throw new ArcadeQueueError('INVALID_QUEUE_ACTION', 'queue action has an invalid shape');
  }
  if (action.reason !== undefined && (typeof action.reason !== 'string' || action.reason.trim() === '')) {
    throw new ArcadeQueueError('INVALID_QUEUE_ACTION', 'reason must be a non-empty string when supplied');
  }
}

function eventTypeFor(action: QueueAction): QueueEventType {
  switch (action.type) {
    case 'MARK_APPROACHING': return 'MARKED_APPROACHING';
    case 'CONFIRM_PRESENCE': return 'PRESENCE_CONFIRMED';
    case 'CALL': return 'CALLED';
    case 'CHECK_IN': return 'CHECKED_IN';
    case 'ENTER_ACTIVE_LOBBY': return 'ENTERED_ACTIVE_LOBBY';
    case 'START_PLAYING': return 'STARTED_PLAYING';
    case 'COMPLETE': return 'COMPLETED';
    case 'DEFER': return 'DEFERRED';
    case 'RETURN_TO_WAITING': return 'RETURNED_TO_WAITING';
    case 'MARK_NO_SHOW': return 'MARKED_NO_SHOW';
    case 'LEAVE': return 'LEFT_QUEUE';
    case 'RELEASE': return 'RELEASED';
  }
}

/** Applies one queue action and emits the corresponding privacy-safe domain event. */
export function reduceQueueEntry(entry: QueueEntry, action: QueueAction): QueueReduction {
  assertQueueEntryInvariants(entry);
  validateAction(action);
  requireString(action.eventId, 'event id');
  const at = timestampMillis(action.at, 'at');
  if (at < timestampMillis(entry.updatedAt, 'updatedAt')) {
    throw new ArcadeQueueError('BACKDATED_QUEUE_ACTION', 'queue action precedes the current entry chronology');
  }

  if (action.type === 'CONFIRM_PRESENCE') {
    if (entry.status !== 'APPROACHING') {
      throw new ArcadeQueueError('ILLEGAL_QUEUE_TRANSITION', `cannot confirm presence from ${entry.status}`);
    }
    const next = { ...entry, approachingConfirmedAt: action.at, updatedAt: action.at };
    assertQueueEntryInvariants(next);
    return freezeReduction(next, eventFor(entry, action, 'PRESENCE_CONFIRMED', entry.status));
  }

  const target = targetFor(action);
  if (!target || !isLegalQueueTransition(entry.status, target)) {
    throw new ArcadeQueueError('ILLEGAL_QUEUE_TRANSITION', `cannot transition ${entry.status} to ${target}`);
  }

  let next: QueueEntry = { ...entry, status: target, updatedAt: action.at };
  if (action.type === 'CALL') {
    if (!entry.approachingConfirmedAt) {
      throw new ArcadeQueueError('PRESENCE_NOT_CONFIRMED', 'presence must be confirmed before call');
    }
    const expires = timestampMillis(action.checkInExpiresAt, 'checkInExpiresAt');
    if (expires <= at) throw new ArcadeQueueError('INVALID_CALL_WINDOW', 'check-in expiry must be after call time');
    next = { ...next, calledAt: action.at, checkInExpiresAt: action.checkInExpiresAt };
  } else if (action.type === 'CHECK_IN') {
    if (!entry.checkInExpiresAt || at >= timestampMillis(entry.checkInExpiresAt, 'checkInExpiresAt')) {
      throw new ArcadeQueueError('CALL_EXPIRED', 'cannot check in at or after call expiry');
    }
    next = { ...next, checkedInAt: action.at };
  } else if (action.type === 'DEFER') {
    if (timestampMillis(action.deferredUntil, 'deferredUntil') <= at) {
      throw new ArcadeQueueError('INVALID_SNOOZE_WINDOW', 'deferredUntil must be after deferral time');
    }
    next = {
      ...next,
      deferredUntil: action.deferredUntil,
      checkedInAt: null,
      deferralCount: entry.deferralCount + 1,
    };
  } else if (action.type === 'RETURN_TO_WAITING') {
    if (!entry.deferredUntil || at < timestampMillis(entry.deferredUntil, 'deferredUntil')) {
      throw new ArcadeQueueError('DEFERRAL_ACTIVE', 'entry cannot return before deferredUntil');
    }
    next = {
      ...next,
      approachingConfirmedAt: null,
      calledAt: null,
      checkInExpiresAt: null,
      deferredUntil: null,
      checkedInAt: null,
    };
  } else if (action.type === 'MARK_NO_SHOW') {
    next = { ...next, missCount: entry.missCount + 1 };
  }
  assertQueueEntryInvariants(next);
  return freezeReduction(next, eventFor(entry, action, eventTypeFor(action), target));
}

export function isSnoozeEligible(entry: QueueEntry, policy: QueuePolicy): boolean {
  assertQueueEntryInvariants(entry);
  validatePolicy(policy);
  return (entry.status === 'WAITING' || entry.status === 'APPROACHING' || entry.status === 'CALLED')
    && entry.snoozeCount < (policy.maximumSnoozes ?? 1);
}

export function snoozeQueueEntry(
  entry: QueueEntry,
  input: { eventId: string; at: ArcadeTimestamp; reason?: string; adjustPriority?: boolean },
  policy: QueuePolicy,
): QueueReduction {
  if (!isPlainRecord(input) || Object.keys(input).some(key => ![
    'eventId', 'at', 'reason', 'adjustPriority',
  ].includes(key))) throw new ArcadeQueueError('INVALID_QUEUE_ACTION', 'snooze input has an invalid shape');
  if (input.adjustPriority !== undefined && typeof input.adjustPriority !== 'boolean') {
    throw new ArcadeQueueError('INVALID_QUEUE_ACTION', 'adjustPriority must be boolean');
  }
  if (!isSnoozeEligible(entry, policy)) {
    throw new ArcadeQueueError('SNOOZE_NOT_ELIGIBLE', `entry cannot snooze from ${entry.status}`);
  }
  if (entry.status === 'CALLED' && entry.checkInExpiresAt
    && timestampMillis(input.at, 'at') >= timestampMillis(entry.checkInExpiresAt, 'checkInExpiresAt')) {
    throw new ArcadeQueueError('SNOOZE_NOT_ELIGIBLE', 'called entry cannot snooze after check-in expiry');
  }
  const reduced = reduceQueueEntry(entry, {
    type: 'DEFER',
    eventId: input.eventId,
    at: input.at,
    deferredUntil: addSeconds(input.at, policy.snoozeSeconds),
    reason: input.reason ?? 'PLAYER_SNOOZE',
  });
  const next = {
    ...reduced.entry,
    joinedAt: input.adjustPriority === false ? entry.joinedAt : input.at,
    approachingConfirmedAt: null,
    calledAt: null,
    checkInExpiresAt: null,
    checkedInAt: null,
    snoozeCount: entry.snoozeCount + 1,
  };
  assertQueueEntryInvariants(next);
  return freezeReduction(next, reduced.event);
}

/** Applies expiry at a caller-supplied time: eligible misses defer, the next miss becomes NO_SHOW. */
export function expireCalledEntry(
  entry: QueueEntry,
  input: { eventId: string; at: ArcadeTimestamp; reason?: string },
  policy: QueuePolicy,
): QueueReduction {
  assertQueueEntryInvariants(entry);
  validatePolicy(policy);
  if (entry.status !== 'CALLED' || !entry.checkInExpiresAt) {
    throw new ArcadeQueueError('NOT_CALLED', 'only a called entry can expire');
  }
  if (timestampMillis(input.at, 'at') < timestampMillis(entry.checkInExpiresAt, 'checkInExpiresAt')) {
    throw new ArcadeQueueError('CALL_NOT_EXPIRED', 'check-in window is still open');
  }
  const nextMissCount = entry.missCount + 1;
  if (nextMissCount < policy.removeAfterMisses
    && entry.automaticDeferralCount < policy.automaticDeferrals) {
    const reduced = reduceQueueEntry(entry, {
      type: 'DEFER',
      eventId: input.eventId,
      at: input.at,
      deferredUntil: addSeconds(input.at, policy.snoozeSeconds),
      reason: input.reason ?? 'CALL_EXPIRED',
    });
    const next = {
      ...reduced.entry,
      missCount: nextMissCount,
      automaticDeferralCount: entry.automaticDeferralCount + 1,
    };
    assertQueueEntryInvariants(next);
    return freezeReduction(next, reduced.event);
  }
  const reduced = reduceQueueEntry(entry, {
    type: 'MARK_NO_SHOW',
    eventId: input.eventId,
    at: input.at,
    reason: input.reason ?? 'CALL_EXPIRED',
  });
  return reduced;
}

export interface QueueSelectionOptions {
  cabinetId: string;
  limit: number;
  game?: string;
}

/** Stable FIFO selection by `(joinedAt, id)`; the input array is never reordered. */
export function selectWaitingEntries(
  entries: readonly QueueEntry[],
  options: QueueSelectionOptions,
): QueueEntry[] {
  if (!isPlainRecord(options) || !Object.keys(options).every(key => ['cabinetId', 'limit', 'game'].includes(key))
    || !Object.prototype.hasOwnProperty.call(options, 'cabinetId')
    || !Object.prototype.hasOwnProperty.call(options, 'limit')) {
    throw new ArcadeQueueError('INVALID_QUEUE_VALUE', 'selection options have an invalid shape');
  }
  requireString(options.cabinetId, 'cabinet id');
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new ArcadeQueueError('INVALID_SELECTION_LIMIT', 'limit must be a non-negative integer');
  }
  if (options.game !== undefined) requireString(options.game, 'game');
  if (!Array.isArray(entries)) throw new ArcadeQueueError('INVALID_QUEUE_VALUE', 'entries must be an array');
  for (const entry of entries) assertQueueEntryInvariants(entry);
  return entries
    .filter(entry => entry.status === 'WAITING' && entry.cabinetId === options.cabinetId
      && (!options.game || entry.preferredGame === options.game || entry.flexibleGame))
    .slice()
    .sort((a, b) => {
      const joinedDelta = timestampMillis(a.joinedAt, 'joinedAt') - timestampMillis(b.joinedAt, 'joinedAt');
      if (joinedDelta !== 0) return joinedDelta;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, options.limit)
    .map(entry => freezeQueueEntry(entry));
}
