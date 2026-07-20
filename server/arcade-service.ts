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
  grantRegistrationCoins,
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
  snoozeQueueEntry as reduceSnoozeQueueEntry,
  type QueueAction,
  type QueueEntry,
  type QueueReduction,
} from '../shared/arcade-queue';
import {
  ArcadeStateStore,
  type ArcadePlayerRecord,
  type ArcadeQueueEntryConfigSnapshot,
  type ArcadeServiceIdempotencyRecord,
  type ArcadeState,
} from './arcade-state-store';
import {
  ARCADE_CHALLENGE_TOKEN_MAX_BYTES,
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
  readonly operatorAuthorizer?: ArcadeOperatorAuthorizer;
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

export interface OperatorQueueEntryActionInput extends QueueEntryActionInput {
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
  readonly reason?: string;
  readonly authorization: unknown;
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
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_JSON_DEPTH = 10;
const MAX_CANONICAL_JSON_DEPTH = 24;
const MAX_MATCH_ENTRIES = 64;

function requireIdentifier(value: unknown, field: string, maximum = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new ArcadeServiceError('INVALID_INPUT', `${field} must be a non-empty bounded string`);
  }
  if (FORBIDDEN_RECORD_KEYS.has(value)) {
    throw new ArcadeServiceError('INVALID_INPUT', `${field} is not a safe record key`);
  }
  return value;
}

function own<Value>(record: Record<string, Value>, key: string): Value | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function requireReason(value: unknown): string {
  return requireIdentifier(value, 'reason', MAX_REASON_LENGTH).trim();
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

export class ArcadeService {
  private readonly store: ArcadeStateStore;
  private readonly configSource: ArcadeConfigSnapshot | (() => ArcadeConfigSnapshot);
  private readonly clock: ArcadeClock;
  private readonly idGenerator: ArcadeIdGenerator;
  private readonly challengeTokenSecret: Buffer;
  private readonly operatorAuthorizer: ArcadeOperatorAuthorizer;

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
      this.operatorAuthorizer = operatorAuthorizer ?? (() => null);
    } else {
      this.store = optionsOrStore.store;
      this.configSource = optionsOrStore.config;
      this.clock = optionsOrStore.clock;
      this.idGenerator = optionsOrStore.idGenerator;
      this.challengeTokenSecret = copyChallengeTokenSecret(optionsOrStore.challengeTokenSecret);
      this.operatorAuthorizer = optionsOrStore.operatorAuthorizer ?? (() => null);
    }
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
    return this.execute('REGISTER_PLAYER', input.idempotencyKey, playerId, {
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
      const normalized = createPlayer({
        id: playerId,
        createdAt: own(state.players, playerId)?.createdAt ?? at,
        lead: exactLead(input.lead),
        preferredLocale: input.preferredLocale,
        conversationProfileId: input.conversationProfileId,
        crmLeadId: input.crmLeadId,
        termsAcceptedAt: input.termsAccepted ? at : own(state.players, playerId)?.termsAcceptedAt ?? null,
        marketingConsent: input.marketingConsent,
      });
      const existing = own(state.players, playerId);
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

  async joinQueue(input: JoinArcadeQueueInput): Promise<QueueEntryResult> {
    const playerId = requireIdentifier(input.playerId, 'playerId');
    if (!GAMES.has(input.preferredGame)) {
      throw new ArcadeServiceError('INVALID_GAME', 'preferredGame is not an Arcade game');
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
        throw new ArcadeServiceError('QUEUE_FULL', 'Arcade queue is full');
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
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
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
    return this.execute('EXPIRE_QUEUE_ENTRY', input.idempotencyKey, playerId, {
      playerId, queueEntryId, authorizedBy: principal,
    }, (state, config, at) => {
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
      const reduction = expireCalledEntry(
        entry,
        { eventId: this.id('queue-event'), at },
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
    if (!GAMES.has(input.game)) throw new ArcadeServiceError('INVALID_GAME', 'check-in game is not an Arcade game');
    return this.execute('CHECK_IN_QUEUE_ENTRY', input.idempotencyKey, playerId, {
      playerId, queueEntryId, game: input.game, reason: input.reason ?? null,
    }, (state, config, at) => {
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
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
    if (!GAMES.has(input.game)) throw new ArcadeServiceError('INVALID_GAME', 'match game is not an Arcade game');
    const principal = this.authorizeOperator(input.authorization, 'MATCH_UNAUTHORIZED');
    return this.execute('START_MATCH', input.idempotencyKey, null, {
      queueEntryIds, game: input.game, authorizedBy: principal,
    }, (state, _config, at) => {
      const entries = queueEntryIds.map(id => this.requireEntry(state, id));
      for (const entry of entries) {
        if (entry.status !== 'ACTIVE_LOBBY') {
          throw new ArcadeServiceError('MATCH_NOT_READY', `queue entry ${entry.id} is not in the active lobby`);
        }
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
          type: 'START_PLAYING', eventId: this.id('queue-event'), at,
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
    return this.execute('COMPLETE_MATCH', input.idempotencyKey, null, {
      queueEntryIds, matchId, reason: input.reason ?? null, authorizedBy: principal,
    }, (state, _config, at) => {
      const completed: QueueEntry[] = [];
      for (const id of queueEntryIds) {
        const entry = this.requireEntry(state, id);
        const snapshot = own(state.queueEntryConfigs, id);
        if (entry.status !== 'PLAYING' || snapshot?.matchId !== matchId) {
          throw new ArcadeServiceError('MATCH_NOT_ACTIVE', `queue entry ${id} is not playing in match ${matchId}`);
        }
        const reduction = reduceQueueEntry(entry, {
          type: 'COMPLETE', eventId: this.id('queue-event'), at, reason: input.reason,
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
    return this.execute('RELEASE_QUEUE_ENTRY', input.idempotencyKey, playerId, {
      playerId, queueEntryId, reason: input.reason ?? null, authorizedBy: principal,
    }, (state, config, at) => {
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
      const reduction = reduceQueueEntry(entry, {
        type: 'RELEASE', eventId: this.id('queue-event'), at, reason: input.reason,
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
    return this.queueAction(operation, input, makeAction, principal);
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
      const entry = this.requireOwnedEntry(state, playerId, queueEntryId);
      const reduction = reduceQueueEntry(entry, makeAction(entry, this.id('queue-event'), at, config));
      this.applyQueueReduction(state, reduction);
      return queueResult(state, reduction.entry);
    });
  }

  private execute<Result>(
    operation: string,
    idempotencyKeyInput: string,
    playerId: string | null,
    payload: unknown,
    mutate: (state: ArcadeState, config: ArcadeConfigSnapshot, at: string) => Result,
    authorizeBeforeReplay?: (config: ArcadeConfigSnapshot, at: string) => void,
  ): Promise<Result> {
    const idempotencyKey = requireIdentifier(
      idempotencyKeyInput,
      'idempotencyKey',
      MAX_IDEMPOTENCY_KEY_LENGTH,
    );
    const requestFingerprint = fingerprint(payload);
    return this.store.transaction(state => {
      let config: ArcadeConfigSnapshot | undefined;
      let at: string | undefined;
      if (authorizeBeforeReplay) {
        config = this.config();
        at = this.now();
        authorizeBeforeReplay(config, at);
      }
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
      config ??= this.config();
      at ??= this.now();
      const result = mutate(state, config, at);
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
    if (config.arcade.mode === 'off') throw new ArcadeServiceError('MODE_DISABLED', 'Arcade mode is off');
  }

  private requireQueueOn(config: ArcadeConfigSnapshot): void {
    this.requireOn(config);
    if (!config.queue.enabled) throw new ArcadeServiceError('QUEUE_DISABLED', 'Arcade queue is disabled');
  }

  private requireSupportedChargePolicy(config: ArcadeConfigSnapshot): void {
    if (config.coins.chargePolicy !== 'per_player' && config.coins.chargePolicy !== 'free') {
      throw new ArcadeServiceError(
        'UNSUPPORTED_CHARGE_POLICY',
        `${config.coins.chargePolicy} requires a future party/wave payer model`,
      );
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
    if (existing) return existing;
    let wallet = createWallet(playerId, at);
    if (config.coins.startingBalance > 0) {
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
