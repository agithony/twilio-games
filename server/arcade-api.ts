import type http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ArcadeConfigValidationError,
  parseArcadeConfigSettings,
  projectPublicArcadeConfig,
  replaceArcadeConfigSettings,
  type ArcadeConfigSnapshot,
} from '../shared/arcade-config';
import { ArcadeDomainError, type LeadInput } from '../shared/arcade-domain';
import { ArcadeQueueError } from '../shared/arcade-queue';
import { isPlayableArcadeGame } from '../shared/arcade-games';
import { ArcadeStationError } from '../shared/arcade-station';
import type { StationEngineParticipantResult } from '../shared/arcade-station';
import {
  ArcadeConfigDegradedError,
  ArcadeConfigIdempotencyConflictError,
  ArcadeConfigStore,
  ArcadeConfigStoreError,
  ArcadeConfigVersionConflictError,
} from './arcade-config-store';
import {
  ARCADE_CONFIG_UPDATED_EVENT,
  ArcadeEventHub,
  type ArcadeEvent,
} from './arcade-events';
import {
  ArcadePlayerRuntime,
  ArcadePlayerRuntimeError,
} from './arcade-player-runtime';
import {
  ArcadePlayerSessionError,
  type ArcadePlayerSessionService,
} from './arcade-player-session';
import { ArcadeRateLimiter } from './arcade-rate-limiter';
import {
  ArcadeServiceError,
  type ArcadeOperatorQueueStatus,
  type ArcadeQueueStatus,
} from './arcade-service';
import { ArcadeStateStoreError, type ArcadeState } from './arcade-state-store';
import {
  ArcadeMessagingRetryError,
  recordArcadeMessagingStatus,
} from './arcade-messaging-runtime';
import {
  emptyPublicStation,
  projectDisplayStation,
  projectOperatorStation,
  projectPlayerStation,
  projectPublicStation,
  stationAggregateFromState,
} from './arcade-station-projection';
import {
  ARCADE_CHALLENGE_TOKEN_MAX_TTL_SECONDS,
  ARCADE_CHALLENGE_TOKEN_VERSION,
} from './arcade-challenge-token';

const ADMIN_CONFIG_BODY_LIMIT = 512 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_EVENT_STREAMS = 100;
const IDEMPOTENCY_KEY_LIMIT = 255;
const PLAYER_IDEMPOTENCY_KEY_LIMIT = 128;
const SESSION_BODY_LIMIT = 2 * 1024;
const REGISTRATION_BODY_LIMIT = 8 * 1024;
const QUEUE_BODY_LIMIT = 4 * 1024;
const CHALLENGE_BODY_LIMIT = 8 * 1024;
const STATION_BODY_LIMIT = 4 * 1024;
const DEFAULT_MESSAGING_ADDRESS_LIMIT = 30;
const DEFAULT_MESSAGING_ADDRESS_WINDOW_MS = 10 * 60_000;
const DEFAULT_MESSAGING_PROCESS_LIMIT = 600;
const DEFAULT_MESSAGING_PROCESS_WINDOW_MS = 60_000;

export interface ArcadeAdminPrincipal {
  readonly email: string;
}

export interface ArcadeApiOptions {
  readonly configStore: ArcadeConfigStore;
  readonly events: ArcadeEventHub;
  readonly authorizeAdmin: (request: http.IncomingMessage) => ArcadeAdminPrincipal | null;
  readonly publicBaseUrl: string;
  readonly heartbeatMs?: number;
  readonly maxEventStreams?: number;
  readonly tacStatus?: () => unknown;
  readonly tacRequired?: boolean;
  readonly playerRuntime?: ArcadePlayerRuntime;
  readonly now?: () => number;
  readonly displayToken?: string;
  readonly fallbackVoiceNumber?: string;
  readonly messagingCapabilities?: Readonly<{ sms: boolean; whatsapp: boolean }>;
  readonly inboundMessagingRateLimits?: Readonly<{
    addressLimit?: number;
    addressWindowMs?: number;
    processLimit?: number;
    processWindowMs?: number;
  }>;
}

type EventStream = {
  readonly response: http.ServerResponse;
  readonly close: () => void;
};

class ArcadeHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ArcadeHttpError';
  }
}

export class ArcadeApi {
  private readonly configStore: ArcadeConfigStore;
  private readonly events: ArcadeEventHub;
  private readonly authorizeAdmin: ArcadeApiOptions['authorizeAdmin'];
  private readonly expectedOrigin: string;
  private readonly heartbeatMs: number;
  private readonly maxEventStreams: number;
  private readonly tacStatus?: () => unknown;
  private readonly tacRequired: boolean;
  private readonly playerRuntime?: ArcadePlayerRuntime;
  private readonly now: () => number;
  private readonly rateLimiter: ArcadeRateLimiter;
  private readonly processRateLimiter: ArcadeRateLimiter;
  private readonly displayToken: Buffer;
  private readonly fallbackVoiceNumber: string | null;
  private readonly messagingCapabilities: Readonly<{ sms: boolean; whatsapp: boolean }>;
  private readonly inboundMessagingRateLimits: Readonly<{
    addressLimit: number;
    addressWindowMs: number;
    processLimit: number;
    processWindowMs: number;
  }>;
  private readonly streams = new Set<EventStream>();
  private readonly stationRoomCodes = new Set<string>();
  private unsubscribeStationCache: (() => void) | null = null;
  private readonly stationVoiceCalls = new Map<string, { callSid: string; readyEntryId: string }>();
  private abortStationEngine: ((game: 'racer' | 'monsters' | 'fighter', roomCode: string) => void) | null = null;
  private started = false;
  private stopped = false;

  constructor(options: ArcadeApiOptions) {
    this.configStore = options.configStore;
    this.events = options.events;
    this.authorizeAdmin = options.authorizeAdmin;
    this.expectedOrigin = new URL(options.publicBaseUrl).origin;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.maxEventStreams = options.maxEventStreams ?? DEFAULT_MAX_EVENT_STREAMS;
    this.tacStatus = options.tacStatus;
    this.tacRequired = options.tacRequired === true;
    this.playerRuntime = options.playerRuntime;
    this.now = options.now ?? Date.now;
    this.displayToken = Buffer.from(options.displayToken?.trim() ?? '', 'utf8');
    const fallbackVoiceNumber = options.fallbackVoiceNumber?.trim() ?? '';
    this.fallbackVoiceNumber = /^\+[1-9][0-9]{7,14}$/.test(fallbackVoiceNumber)
      ? fallbackVoiceNumber
      : null;
    this.messagingCapabilities = Object.freeze({
      sms: options.messagingCapabilities?.sms === true,
      whatsapp: options.messagingCapabilities?.whatsapp === true,
    });
    this.inboundMessagingRateLimits = Object.freeze({
      addressLimit: options.inboundMessagingRateLimits?.addressLimit
        ?? DEFAULT_MESSAGING_ADDRESS_LIMIT,
      addressWindowMs: options.inboundMessagingRateLimits?.addressWindowMs
        ?? DEFAULT_MESSAGING_ADDRESS_WINDOW_MS,
      processLimit: options.inboundMessagingRateLimits?.processLimit
        ?? DEFAULT_MESSAGING_PROCESS_LIMIT,
      processWindowMs: options.inboundMessagingRateLimits?.processWindowMs
        ?? DEFAULT_MESSAGING_PROCESS_WINDOW_MS,
    });
    this.rateLimiter = new ArcadeRateLimiter(this.now);
    this.processRateLimiter = new ArcadeRateLimiter(this.now, 16);
    if (!Number.isSafeInteger(this.heartbeatMs) || this.heartbeatMs < 10) {
      throw new TypeError('Arcade API heartbeatMs must be an integer of at least 10ms');
    }
    if (!Number.isSafeInteger(this.maxEventStreams) || this.maxEventStreams < 1) {
      throw new TypeError('Arcade API maxEventStreams must be a positive integer');
    }
    if (Object.values(this.inboundMessagingRateLimits)
      .some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError('Arcade API inbound messaging rate limits must be positive integers');
    }
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Arcade API cannot restart after it has stopped');
    if (this.started) return;
    await this.configStore.load();
    await this.playerRuntime?.start();
    const resources = this.playerRuntime?.getInitializedResources();
    if (resources) this.bindStationAbortHandler(resources);
    this.unsubscribeStationCache = this.events.subscribe(event => {
      if (event.type === 'arcade_station_updated' || event.type === ARCADE_CONFIG_UPDATED_EVENT) {
        void this.refreshStationRoomCache();
      }
    });
    await this.refreshStationRoomCache();
    this.started = true;
  }

  getHealthStatus(): { degraded: boolean } {
    const players = this.playerRuntime?.getStatus();
    return {
      degraded: this.configStore.getStatus().degraded
        || this.stationCapabilityIssue(this.configStore.getSnapshot()) !== null
        || (this.configStore.getSnapshot().arcade.mode !== 'off' && !this.tacMessagingReady())
        || Boolean(players && players.mode !== 'off' && players.degraded),
    };
  }

  async activateMessagingDelivery(): Promise<void> {
    await this.playerRuntime?.activateMessagingDelivery();
  }

  getVoiceNumbers(): Readonly<Record<'en-US' | 'pt-BR', string | null>> {
    return this.effectiveVoiceNumbers(this.configStore.getSnapshot());
  }

  setStationAbortHandler(
    handler: (game: 'racer' | 'monsters' | 'fighter', roomCode: string) => void,
  ): void {
    this.abortStationEngine = handler;
    this.playerRuntime?.setStationMatchRemovedHandler((game, roomCode) => {
      this.abortLiveStationEngine(game, roomCode);
    });
    const resources = this.playerRuntime?.getInitializedResources();
    if (resources) this.bindStationAbortHandler(resources);
  }

  private effectiveVoiceNumbers(
    config: ArcadeConfigSnapshot,
  ): Readonly<Record<'en-US' | 'pt-BR', string | null>> {
    const configured = config.channels.voiceNumbers;
    const hasRuntimeNumber = configured['en-US'] !== null || configured['pt-BR'] !== null;
    return Object.freeze({
      'en-US': hasRuntimeNumber ? configured['en-US'] : this.fallbackVoiceNumber,
      'pt-BR': hasRuntimeNumber ? configured['pt-BR'] : this.fallbackVoiceNumber,
    });
  }

  voiceLocaleForNumber(number: string): 'en-US' | 'pt-BR' | null {
    const normalized = number.trim();
    if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) return null;
    const matches = Object.entries(this.getVoiceNumbers())
      .filter(([, candidate]) => candidate === normalized)
      .map(([locale]) => locale as 'en-US' | 'pt-BR');
    return matches.length === 1 ? matches[0]! : null;
  }

  async processMessagingWebhook(input: {
    from: string;
    body: string;
    providerMessageId: string;
    conversationProfileId?: string | null;
    conversationId?: string | null;
    recalledLocale?: 'en-US' | 'pt-BR' | null;
  }): Promise<string | null> {
    const config = this.configStore.getSnapshot();
    const providerAddress = input.from.trim();
    const channel = providerAddress.toLowerCase().startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const normalizedAddress = providerAddress.replace(/^whatsapp:/i, '');
    if (!/^\+[1-9][0-9]{7,14}$/.test(normalizedAddress)
      || !input.providerMessageId || input.providerMessageId.length > 256) {
      throw new ArcadeHttpError(400, 'INVALID_PROVIDER_MESSAGE', 'messaging provider identity is invalid');
    }
    const language = /\bLANG\s+(pt(?:-BR)?|en(?:-US)?)\b/i.exec(input.body)?.[1]
      ?? input.recalledLocale ?? 'en-US';
    const key = `provider:${createHash('sha256')
      .update(input.providerMessageId)
      .digest('hex')}`;
    if (this.playerRuntime) {
      const store = await this.playerRuntime.getStateStoreForCleanup();
      const receipt = (await store.read()).inboundMessages[key];
      if (receipt) {
        const requestFingerprint = createHash('sha256').update(JSON.stringify({
          body: input.body.trim(), channel,
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
          ...(input.conversationProfileId ? { conversationProfileId: input.conversationProfileId } : {}),
          normalizedAddress, providerAddress, providerMessageId: input.providerMessageId,
        })).digest('hex');
        if (receipt.requestFingerprint !== requestFingerprint) {
          const fallbackFingerprint = createHash('sha256').update(JSON.stringify({
            body: input.body.trim(), channel, normalizedAddress, providerAddress,
            providerMessageId: input.providerMessageId,
          })).digest('hex');
          if ((!input.conversationProfileId && !input.conversationId)
            || receipt.requestFingerprint !== fallbackFingerprint) {
            throw new ArcadeHttpError(409, 'IDEMPOTENCY_CONFLICT', 'provider message ID was reused');
          }
          // Direct /sms fallback already returned this reply. An enriched Orchestrator replay should
          // attach no second response, otherwise the player receives duplicate messages.
          return null;
        }
        return receipt.reply;
      }
    }
    const addressRate = this.rateLimiter.consume(
      `messaging-inbound-address:${normalizedAddress}`,
      this.inboundMessagingRateLimits.addressLimit,
      this.inboundMessagingRateLimits.addressWindowMs,
    );
    if (!addressRate.allowed) return messagingRateLimitReply(language);
    const processRate = this.processRateLimiter.consume(
      'messaging-inbound-process',
      this.inboundMessagingRateLimits.processLimit,
      this.inboundMessagingRateLimits.processWindowMs,
    );
    if (!processRate.allowed) return messagingRateLimitReply(language);
    if (config.arcade.mode === 'off') return null;
    if (!config.channels[channel]) {
      return channel === 'whatsapp'
        ? 'WhatsApp is not enabled for this Twilio Games station.'
        : 'SMS is not enabled for this Twilio Games station.';
    }
    this.requireStationRuntimeCapabilities(config);
    const runtime = this.requirePlayerRuntime();
    const resources = this.configStore.getStatus().degraded
      ? await runtime.getForCleanup()
      : await this.getActivePlayerResources();
    const result = await resources.service.processInboundStationMessage({
      channel,
      normalizedAddress,
      providerAddress,
      providerMessageId: input.providerMessageId,
      body: input.body,
      stationId: config.arcade.cabinetId,
      preferredLocale: language,
      idempotencyKey: key,
      conversationProfileId: input.conversationProfileId,
      conversationId: input.conversationId,
    });
    return result.reply;
  }

  async processMessagingStatusCallback(input: {
    notificationId: string;
    attemptId: string;
    providerMessageId: string;
    providerStatus: string;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<boolean> {
    if (!this.playerRuntime) return false;
    const resources = this.playerRuntime.getInitializedResources();
    if (resources) return resources.messaging.recordStatus(input);
    return recordArcadeMessagingStatus(
      await this.playerRuntime.getStateStoreForCleanup(), input, this.now,
    );
  }

  async stationVoiceRoute(from: string, callSid = ''): Promise<{
    game: 'racer' | 'monsters' | 'fighter';
    roomCode: string;
    matchId: string;
    launchGeneration: number;
    admitted: boolean;
    readyEntryId: string | null;
  } | null> {
    const config = this.configStore.getSnapshot();
    if (config.arcade.mode !== 'off' && !config.channels.voice) return null;
    const runtime = this.requirePlayerRuntime();
    const resources = config.arcade.mode === 'off'
      ? runtime.getInitializedResources()
      : await this.getActivePlayerResources();
    if (!resources) return null;
    const state = await resources.store.read();
    const aggregate = stationAggregateFromState(state, config.arcade.cabinetId)
      ?? Object.values(state.stations)
        .filter(station => station.phase !== 'ATTRACT')
        .map(station => stationAggregateFromState(state, station.id))
        .find(candidate => candidate !== null)
      ?? null;
    const match = aggregate?.station.activeMatchId
      ? aggregate.matches[aggregate.station.activeMatchId]
      : undefined;
    if (!aggregate || !match || !['LAUNCHING', 'PLAYING'].includes(aggregate.station.phase)) return null;
    const normalizedAddress = from.trim().replace(/^whatsapp:/i, '');
    const participantPlayerIds = new Set(match.participantReadyEntryIds.map(id => (
      aggregate.readyEntries[id]?.playerId
    )).filter((playerId): playerId is string => Boolean(playerId)));
    const matchingPlayerIds = [...participantPlayerIds].filter(playerId => (
      state.players[playerId]?.lead?.phoneNumber === normalizedAddress
      || Object.values(state.channelAddresses).some(address => (
        address.playerId === playerId && address.normalizedAddress === normalizedAddress
      ))
    ));
    const playerId = matchingPlayerIds.length === 1 ? matchingPlayerIds[0] : undefined;
    const readyEntryId = playerId ? match.participantReadyEntryIds.find(id => (
      aggregate.readyEntries[id]?.playerId === playerId
    )) : undefined;
    let admitted = Boolean(readyEntryId);
    if (admitted && playerId && callSid) {
      const existingCall = this.stationVoiceCalls.get(playerId);
      if (existingCall && existingCall.callSid !== callSid) admitted = false;
      else if (readyEntryId) {
        this.stationVoiceCalls.set(playerId, { callSid, readyEntryId });
      }
    }
    this.stationRoomCodes.add(match.engineRoomCode);
    return {
      game: match.game,
      roomCode: match.engineRoomCode,
      matchId: match.id,
      launchGeneration: match.launchGeneration,
      admitted,
      readyEntryId: readyEntryId ?? null,
    };
  }

  async validateStationVoiceSetup(input: {
    callSid: string;
    readyEntryId: string;
    matchId: string;
    launchGeneration: number;
    game: string;
    roomCode: string;
  }): Promise<boolean> {
    if (!input.callSid || !input.readyEntryId || !input.matchId
      || !Number.isSafeInteger(input.launchGeneration) || input.launchGeneration < 1) return false;
    try {
      const resources = await this.requirePlayerRuntime().getForCleanup();
      const state = await resources.store.read();
      const config = this.configStore.getSnapshot();
      const station = state.stations[config.arcade.cabinetId];
      const match = station?.activeMatchId ? state.stationMatches[station.activeMatchId] : undefined;
      const entry = state.stationReadyEntries[input.readyEntryId];
      const activeCall = entry ? this.stationVoiceCalls.get(entry.playerId) : undefined;
      return config.arcade.mode !== 'off'
        && Boolean(station && ['LAUNCHING', 'PLAYING'].includes(station.phase))
        && match?.id === input.matchId
        && match.launchGeneration === input.launchGeneration
        && match.game === input.game
        && match.engineRoomCode === input.roomCode
        && match.participantReadyEntryIds.includes(input.readyEntryId)
        && entry?.status !== 'LEFT'
        && activeCall?.callSid === input.callSid
        && activeCall.readyEntryId === input.readyEntryId;
    } catch {
      return false;
    }
  }

  stationVoiceParticipantConnected(callSid: string, readyEntryId: string, enginePlayerId: string): void {
    const active = [...this.stationVoiceCalls.values()].find(call => (
      call.callSid === callSid && call.readyEntryId === readyEntryId
    ));
    if (!active) return;
    void this.playerRuntime?.getForCleanup().then(resources => {
      resources.station.markParticipantConnected(readyEntryId, enginePlayerId);
    }).catch(() => undefined);
  }

  stationVoiceParticipantDisconnected(callSid: string, readyEntryId: string): void {
    const active = [...this.stationVoiceCalls.values()].find(call => (
      call.callSid === callSid && call.readyEntryId === readyEntryId
    ));
    if (!active) return;
    void this.playerRuntime?.getForCleanup().then(resources => {
      resources.station.markParticipantDisconnected(readyEntryId);
    }).catch(() => undefined);
  }

  requiresStationVoiceAssignment(): boolean {
    const config = this.configStore.getSnapshot();
    return config.arcade.mode !== 'off';
  }

  stationVoiceCallEnded(callSid: string): void {
    if (!callSid) return;
    for (const [playerId, activeCall] of this.stationVoiceCalls) {
      if (activeCall.callSid === callSid) {
        this.stationVoiceCalls.delete(playerId);
        void this.playerRuntime?.getForCleanup().then(resources => (
          resources.station.markParticipantDisconnected(activeCall.readyEntryId)
        )).catch(() => undefined);
      }
    }
  }

  isStationEngineRoom(roomCode: string): boolean {
    return this.stationRoomCodes.has(roomCode.trim().toUpperCase())
      || this.stationRoomCodes.has(roomCode.trim());
  }

  stationEngineStarted(game: 'racer' | 'monsters' | 'fighter', roomCode: string): void {
    void this.playerRuntime?.getForCleanup().then(resources => {
      resources.station.markEngineStarted(game, roomCode);
    }).catch(() => undefined);
  }

  stationEngineCompleted(
    game: 'racer' | 'monsters' | 'fighter',
    roomCode: string,
    results: readonly StationEngineParticipantResult[] = [],
  ): void {
    void this.playerRuntime?.getForCleanup().then(resources => (
      resources.station.markEngineCompleted(game, roomCode, results)
    )).catch(() => undefined);
  }

  stationEngineAbandoned(game: 'racer' | 'monsters' | 'fighter', roomCode: string): void {
    void this.playerRuntime?.getForCleanup().then(resources => (
      resources.station.markEngineAbandoned(game, roomCode)
    )).catch(() => undefined);
  }

  async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    pathname = requestPath(request),
  ): Promise<void> {
    try {
      if (!this.started || this.stopped) {
        throw new ArcadeHttpError(503, 'ARCADE_UNAVAILABLE', 'Twilio Games API is not available');
      }

      if (pathname === '/api/arcade/config/public') {
        this.requireMethod(request, ['GET']);
        const config = await this.configStore.read();
        const projected = projectPublicArcadeConfig(config);
        sendJson(response, 200, {
          ...projected,
          channels: { ...projected.channels, voiceNumbers: this.getVoiceNumbers() },
        }, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
          ETag: configEtag(config.version),
        });
        return;
      }

      if (pathname === '/api/arcade/events') {
        this.requireMethod(request, ['GET']);
        this.openEventStream(request, response);
        return;
      }

      if (pathname === '/api/arcade/station/public') {
        await this.handlePublicStation(request, response);
        return;
      }


      if (pathname === '/api/arcade/station/display') {
        await this.handleDisplayStation(request, response);
        return;
      }

      if (pathname === '/api/arcade/station/me') {
        await this.handlePlayerStation(request, response);
        return;
      }

      if (pathname === '/api/arcade/station/coin') {
        await this.handleStationCoin(request, response);
        return;
      }

      if (pathname === '/api/arcade/station/leave') {
        await this.handleStationLeave(request, response);
        return;
      }

      if (pathname === '/api/arcade/station/display/ready') {
        await this.handleStationDisplayReady(request, response);
        return;
      }

      if (pathname === '/api/arcade/session') {
        await this.handlePlayerSession(request, response);
        return;
      }

      if (pathname === '/api/arcade/register') {
        await this.handleRegistration(request, response);
        return;
      }

      if (pathname === '/api/arcade/player') {
        await this.handlePlayerStatus(request, response);
        return;
      }

      if (pathname === '/api/arcade/wallet') {
        await this.handleWalletStatus(request, response);
        return;
      }

      if (pathname === '/api/arcade/challenges') {
        await this.handleChallengeList(request, response);
        return;
      }

      const challengeRoute = parseChallengeRoute(pathname);
      if (challengeRoute) {
        if (challengeRoute.action === 'token') {
          await this.handleChallengeToken(request, response, challengeRoute.challengeId);
        } else {
          await this.handleChallengeClaim(request, response, challengeRoute.challengeId);
        }
        return;
      }

      if (pathname === '/api/arcade/queue/status') {
        await this.handleQueueStatus(request, response);
        return;
      }

      if (pathname === '/api/arcade/queue/join') {
        await this.handleJoinQueue(request, response);
        return;
      }

      if (pathname === '/api/arcade/queue/confirm') {
        await this.handleCurrentQueueAction(request, response, 'confirm');
        return;
      }

      if (pathname === '/api/arcade/queue/snooze') {
        await this.handleCurrentQueueAction(request, response, 'snooze');
        return;
      }

      if (pathname === '/api/arcade/queue/leave') {
        await this.handleCurrentQueueAction(request, response, 'leave');
        return;
      }

      if (pathname === '/api/arcade/check-in') {
        await this.handleCurrentQueueAction(request, response, 'check-in');
        return;
      }

      if (pathname === '/api/admin/arcade/config') {
        const principal = this.requireAdmin(request);
        if (request.method === 'GET') {
          const config = await this.configStore.read();
          sendJson(response, 200, config, {
            'Cache-Control': 'no-store',
            ETag: configEtag(config.version),
          });
          return;
        }
        if (request.method === 'PATCH') {
          this.requireSameOrigin(request);
          requireJsonContentType(request);
          const expectedVersion = parseIfMatch(request.headers['if-match']);
          const idempotencyKey = requireHeader(
            request.headers['idempotency-key'],
            'Idempotency-Key',
            IDEMPOTENCY_KEY_LIMIT,
          );
          const settings = await readJson(request, ADMIN_CONFIG_BODY_LIMIT);
          const parsedSettings = parseArcadeConfigSettings(settings);
          const update = async (state?: ArcadeState) => {
            const current = this.configStore.getSnapshot();
            const requested = replaceArcadeConfigSettings(current, parsedSettings, {
              updatedAt: current.updatedAt,
              updatedBy: current.updatedBy,
            });
            this.validateStationAdmissionConfig(requested);
            const changesActivePolicy = requested.arcade.mode !== current.arcade.mode
              || requested.arcade.cabinetId !== current.arcade.cabinetId
              || requested.coins.chargePolicy !== current.coins.chargePolicy
              || JSON.stringify(requested.channels) !== JSON.stringify(current.channels)
              || JSON.stringify(requested.station) !== JSON.stringify(current.station);
            if (changesActivePolicy && state) {
              if (Object.values(state.stations).some(station => station.phase !== 'ATTRACT')) {
                throw new ArcadeHttpError(
                  409,
                  'ACTIVE_STATION_CONFIG_LOCKED',
                  'station policy cannot change during an active round',
                );
              }
            }
            return this.configStore.update({
              expectedVersion,
              idempotencyKey,
              updatedBy: principal.email,
              settings,
            });
          };
          const config = this.playerRuntime
            ? await (await this.playerRuntime.getStateStoreForCleanup()).runExclusive(update)
            : await update();
          sendJson(response, 200, config, {
            'Cache-Control': 'no-store',
            ETag: configEtag(config.version),
          });
          return;
        }
        this.methodNotAllowed(['GET', 'PATCH']);
      }

      if (pathname === '/api/admin/arcade/status') {
        this.requireMethod(request, ['GET']);
        this.requireAdmin(request);
        const config = this.configStore.getSnapshot();
        let messaging = this.playerRuntime?.getMessagingStatus() ?? null;
        let messagingStorage = null;
        try {
          const resources = await this.playerRuntime?.getForCleanup();
          if (resources) {
            messaging = await resources.messaging.getAdminStatus();
            messagingStorage = await resources.service.getMessagingStorageStatus();
          }
        } catch {
          // Keep status available when player-state initialization is degraded.
        }
        sendJson(response, 200, {
          config: this.configStore.getStatus(),
          tac: this.tacStatus?.() ?? null,
          players: this.playerRuntime?.getStatus() ?? null,
          messaging: messaging ? {
            ...messaging,
            onboarding: {
              sms: config.channels.sms && this.messagingCapabilities.sms,
              whatsapp: config.channels.whatsapp && this.messagingCapabilities.whatsapp,
            },
            storage: messagingStorage,
          } : null,
        }, { 'Cache-Control': 'no-store' });
        return;
      }

      const messagingRetry = parseOperatorMessagingRetryRoute(pathname);
      if (messagingRetry) {
        await this.handleOperatorMessagingRetry(request, response, messagingRetry.notificationId);
        return;
      }

      if (pathname === '/api/admin/arcade/station') {
        await this.handleOperatorStation(request, response);
        return;
      }

      const stationCoinGrant = parseOperatorStationCoinGrantRoute(pathname);
      if (stationCoinGrant) {
        await this.handleOperatorStationCoinGrant(request, response, stationCoinGrant.readyEntryId);
        return;
      }

      const stationPlayerDrop = parseOperatorStationDropRoute(pathname);
      if (stationPlayerDrop) {
        await this.handleOperatorStationPlayerDrop(request, response, stationPlayerDrop.readyEntryId);
        return;
      }

      const stationAction = parseOperatorStationRoute(pathname);
      if (stationAction) {
        await this.handleOperatorStationAction(request, response, stationAction);
        return;
      }

      if (pathname === '/api/admin/arcade/queue') {
        await this.handleOperatorQueue(request, response);
        return;
      }

      const operatorQueueRoute = parseOperatorQueueRoute(pathname);
      if (operatorQueueRoute) {
        await this.handleOperatorQueueAction(
          request,
          response,
          operatorQueueRoute.queueEntryId,
          operatorQueueRoute.action,
        );
        return;
      }

      if (pathname === '/api/admin/arcade/matches/start') {
        await this.handleOperatorMatchStart(request, response);
        return;
      }

      const operatorMatchRoute = parseOperatorMatchRoute(pathname);
      if (operatorMatchRoute) {
        await this.handleOperatorMatchComplete(request, response, operatorMatchRoute.matchId);
        return;
      }

      if (pathname.startsWith('/api/arcade/') || pathname.startsWith('/api/admin/arcade/')) {
        throw new ArcadeHttpError(404, 'NOT_FOUND', 'Twilio Games endpoint was not found');
      }
      throw new ArcadeHttpError(404, 'NOT_FOUND', 'Twilio Games endpoint was not found');
    } catch (error) {
      this.sendError(response, error);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeStationCache?.();
    this.unsubscribeStationCache = null;
    for (const stream of [...this.streams]) stream.close();
    await Promise.all([this.configStore.flush(), this.playerRuntime?.stop()]);
  }

  private async refreshStationRoomCache(): Promise<void> {
    if (!this.playerRuntime?.getStatus().initialized) {
      this.stationRoomCodes.clear();
      return;
    }
    try {
      const state = await (await this.playerRuntime.getForCleanup()).store.read();
      const active = new Set(Object.values(state.stations)
        .filter(station => station.activeMatchId !== null && station.phase !== 'ATTRACT')
        .map(station => state.stationMatches[station.activeMatchId!]?.engineRoomCode)
        .filter((roomCode): roomCode is string => Boolean(roomCode)));
      this.stationRoomCodes.clear();
      for (const roomCode of active) this.stationRoomCodes.add(roomCode);
      if (active.size === 0) this.stationVoiceCalls.clear();
    } catch {
      // Keep the previous cache on transient state errors so admission remains fail closed.
    }
  }

  private async handlePlayerSession(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const body = requireExactObject(await readJson(request, SESSION_BODY_LIMIT), ['cabinetId'], []);
    this.enforceProcessRate('session-process', 120, 60_000);

    const config = this.configStore.getSnapshot();
    const runtime = this.requirePlayerRuntime();
    this.requireStationRuntimeCapabilities(config);
    const resources = await runtime.getActive();
    if (body.cabinetId !== config.arcade.cabinetId) {
      throw new ArcadeHttpError(409, 'CABINET_CHANGED', 'Twilio Games QR belongs to another station');
    }
    if (config.arcade.mode === 'off') {
      throw new ArcadeHttpError(409, 'ARCADE_MODE_DISABLED', 'station mode is off');
    }
    const audience = this.playerSessionAudience(config.arcade.cabinetId);
    let playerId: string | null = null;
    try {
      playerId = resources.sessions.readCookie(request.headers.cookie, audience)?.player ?? null;
    } catch (error) {
      if (error instanceof ArcadePlayerSessionError && error.code === 'DUPLICATE_COOKIE') throw error;
      playerId = null;
    }

    let issuance: ReturnType<ArcadePlayerSessionService['issue']> | null = null;
    if (!playerId) {
      if (config.arcade.mode === 'coin_only') {
        throw new ArcadeHttpError(
          409,
          'MESSAGING_IDENTITY_REQUIRED',
          'join through SMS or WhatsApp before entering the ready pool',
        );
      }
      issuance = resources.sessions.issue(runtime.newPlayerId(), audience);
      playerId = issuance.payload.player;
    }

    const player = await resources.service.getPlayerStatus(playerId);
    if (config.arcade.mode === 'coin_only' && !player) {
      throw new ArcadeHttpError(
        409,
        'MESSAGING_IDENTITY_REQUIRED',
        'join through SMS or WhatsApp before entering the ready pool',
      );
    }
    const wallet = await resources.service.getWalletStatus(playerId);
    sendJson(response, 200, {
      mode: config.arcade.mode,
      registered: player?.registered ?? false,
      availableBalance: wallet?.availableBalance ?? null,
    }, {
      'Cache-Control': 'no-store',
      ...(issuance ? { 'Set-Cookie': issuance.cookie } : {}),
    });
  }

  private async handleRegistration(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'],
      'Idempotency-Key',
      PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, REGISTRATION_BODY_LIMIT),
      ['lead', 'termsAccepted'],
      ['marketingConsent', 'preferredLocale'],
    );
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`registration-player:${playerId}`, 5, 10 * 60_000);
    this.enforceProcessRate('registration-process', 60, 60_000);
    const result = await resources.service.registerPlayer({
      playerId,
      destination: null,
      idempotencyKey: playerServiceKey(playerId, 'register', idempotencyKey),
      lead: body.lead as LeadInput,
      termsAccepted: body.termsAccepted as boolean,
      marketingConsent: body.marketingConsent as boolean | undefined,
      preferredLocale: body.preferredLocale as string | undefined,
    });
    const player = await resources.service.getPlayerStatus(playerId);
    sendJson(response, 200, {
      ...player,
      availableBalance: result.availableBalance,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handlePlayerStatus(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player-profile:${playerId}`, 120, 60_000);
    this.enforceProcessRate('read-process', 3_000, 60_000);
    const player = await resources.service.getPlayerStatus(playerId);
    sendJson(response, 200, player ?? {
      registered: false,
      firstName: null,
      preferredLocale: null,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleWalletStatus(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player-wallet:${playerId}`, 120, 60_000);
    this.enforceProcessRate('read-process', 3_000, 60_000);
    const wallet = await resources.service.getWalletStatus(playerId);
    if (!wallet) {
      throw new ArcadeHttpError(409, 'REGISTRATION_REQUIRED', 'player registration is required');
    }
    sendJson(response, 200, wallet, { 'Cache-Control': 'no-store' });
  }

  private async handleQueueStatus(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player-queue:${playerId}`, 120, 60_000);
    this.enforceProcessRate('read-process', 3_000, 60_000);
    const queue = await resources.service.getQueueStatus(playerId);
    sendJson(response, 200, { queue: publicQueueStatus(queue) }, { 'Cache-Control': 'no-store' });
  }

  private async handleChallengeList(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player-challenges:${playerId}`, 120, 60_000);
    this.enforceProcessRate('read-process', 3_000, 60_000);
    const challenges = await resources.service.listChallenges(playerId);
    sendJson(response, 200, { challenges }, { 'Cache-Control': 'no-store' });
  }

  private async handleChallengeToken(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    challengeId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    requireExactObject(await readJson(request, SESSION_BODY_LIMIT), [], []);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`mutation-player:${playerId}`, 30, 60_000);
    this.enforceProcessRate('mutation-process', 600, 60_000);
    const challenge = (await resources.service.listChallenges(playerId))
      .find(candidate => candidate.id === challengeId);
    if (!challenge || !challenge.available) {
      throw new ArcadeHttpError(409, 'CHALLENGE_UNAVAILABLE', 'game challenge is unavailable');
    }
    const issuedAt = Math.floor(this.now() / 1000);
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
      throw new ArcadeHttpError(500, 'ARCADE_INTERNAL_ERROR', 'game challenge token clock is invalid');
    }
    const expiry = issuedAt + ARCADE_CHALLENGE_TOKEN_MAX_TTL_SECONDS;
    const token = resources.challenges.sign({
      v: ARCADE_CHALLENGE_TOKEN_VERSION,
      player: playerId,
      challenge: challengeId,
      audience: this.configStore.getSnapshot().arcade.cabinetId,
      jti: `challenge:${randomUUID()}`,
      issuedAt,
      expiry,
    });
    sendJson(response, 200, {
      challengeId,
      token,
      expiresAt: new Date(expiry * 1000).toISOString(),
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleChallengeClaim(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    challengeId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, CHALLENGE_BODY_LIMIT), ['token'], []);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`mutation-player:${playerId}`, 30, 60_000);
    this.enforceProcessRate('mutation-process', 600, 60_000);
    const result = await resources.service.claimChallenge({
      playerId,
      challengeId,
      token: body.token as string,
      idempotencyKey: playerServiceKey(playerId, `challenge-${challengeId}`, idempotencyKey),
    });
    sendJson(response, 200, {
      challengeId: result.challengeId,
      rewardCoins: result.rewardCoins,
      availableBalance: result.availableBalance,
      destinationUrl: result.destinationUrl,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleJoinQueue(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, QUEUE_BODY_LIMIT), ['preferredGame'], ['flexibleGame'],
    );
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`mutation-player:${playerId}`, 30, 60_000);
    this.enforceProcessRate('mutation-process', 600, 60_000);
    const result = await resources.service.joinQueue({
      playerId,
      preferredGame: body.preferredGame as 'racer' | 'monsters' | 'fighter' | 'trivia',
      flexibleGame: body.flexibleGame as boolean | undefined,
      idempotencyKey: playerServiceKey(playerId, 'queue-join', idempotencyKey),
    });
    const queue = await resources.service.getQueueStatus(playerId);
    sendJson(response, 200, {
      queue: publicQueueStatus(queue),
      availableBalance: result.availableBalance,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleCurrentQueueAction(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    action: 'confirm' | 'snooze' | 'leave' | 'check-in',
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, QUEUE_BODY_LIMIT),
      action === 'check-in' ? ['game'] : [],
      [],
    );
    const runtime = this.requirePlayerRuntime();
    const resources = action === 'leave'
      ? await runtime.getForCleanup()
      : await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`mutation-player:${playerId}`, 30, 60_000);
    this.enforceProcessRate('mutation-process', 600, 60_000);
    const current = await resources.service.getQueueStatus(playerId);
    if (!current) throw new ArcadeHttpError(409, 'QUEUE_ENTRY_REQUIRED', 'player has no active queue entry');
    const common = {
      playerId,
      queueEntryId: current.queueEntryId,
      idempotencyKey: playerServiceKey(playerId, `queue-${action}`, idempotencyKey),
    };
    const result = action === 'confirm'
      ? await resources.service.confirmPresence(common)
      : action === 'snooze'
        ? await resources.service.snoozeQueueEntry(common)
        : action === 'leave'
          ? await resources.service.leaveQueue(common)
          : await resources.service.checkInQueueEntry({
            ...common,
            game: body.game as 'racer' | 'monsters' | 'fighter' | 'trivia',
          });
    const queue = await resources.service.getQueueStatus(playerId);
    sendJson(response, 200, {
      status: result.entry.status,
      queue: publicQueueStatus(queue),
      availableBalance: result.availableBalance,
      reservation: result.reservation
        ? { amount: result.reservation.amount, status: result.reservation.status }
        : null,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handlePublicStation(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    this.enforceProcessRate('station-public-read', 3_000, 60_000);
    const config = this.configStore.getSnapshot();
    if (config.arcade.mode === 'off') {
      sendJson(response, 200, emptyPublicStation(), {
        'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ETag: stationEtag(0),
      });
      return;
    }
    const resources = await this.getActivePlayerResources();
    const state = await resources.store.read();
    const projection = projectPublicStation(
      state,
      stationAggregateFromState(state, config.arcade.cabinetId),
    );
    sendJson(response, 200, projection, {
      'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ETag: stationEtag(projection.revision),
    });
  }

  private async handleDisplayStation(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    this.requireDisplayAuthorization(request);
    const config = this.configStore.getSnapshot();
    if (config.arcade.mode === 'off') {
      sendJson(response, 200, emptyPublicStation(), {
        'Cache-Control': 'no-store', ETag: stationEtag(0),
      });
      return;
    }
    const resources = await this.getActivePlayerResources();
    const state = await resources.store.read();
    const projection = projectDisplayStation(
      state,
      stationAggregateFromState(state, config.arcade.cabinetId),
    );
    sendJson(response, 200, projection, {
      'Cache-Control': 'no-store', ETag: stationEtag(projection.revision),
    });
  }

  private async handlePlayerStation(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const runtime = this.requirePlayerRuntime();
    const resources = this.configStore.getSnapshot().arcade.mode === 'off'
      ? await runtime.getForCleanup()
      : await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player-station:${playerId}`, 120, 60_000);
    const state = await resources.store.read();
    if (!state.wallets[playerId]) {
      throw new ArcadeHttpError(409, 'REGISTRATION_REQUIRED', 'player registration is required');
    }
    const aggregate = playerStationAggregate(state, playerId, this.configStore.getSnapshot().arcade.cabinetId);
    const projection = projectPlayerStation(state, aggregate, playerId);
    const playerLocale = state.players[playerId]?.preferredLocale?.toLowerCase().startsWith('pt')
      ? 'pt-BR'
      : 'en-US';
    const config = this.configStore.getSnapshot();
    const browserLead = Boolean(state.players[playerId]?.lead)
      && !Object.values(state.channelAddresses).some(address => address.playerId === playerId);
    const callNumber = browserLead && projection.phase === 'LAUNCHING'
      && projection.ready?.status === 'ADMITTED' && config.arcade.mode !== 'off'
      && config.channels.voice
      ? this.effectiveVoiceNumbers(config)[playerLocale]
      : null;
    sendJson(response, 200, { ...projection, callNumber }, {
      'Cache-Control': 'no-store', ETag: stationEtag(projection.revision),
    });
  }

  private async handleStationCoin(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    requireExactObject(await readJson(request, STATION_BODY_LIMIT), [], []);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`station-coin:${playerId}`, 10, 60_000);
    this.enforceProcessRate('station-coin-process', 240, 60_000);
    const stationId = this.configStore.getSnapshot().arcade.cabinetId;
    const identityState = await resources.store.read();
    const messagingLinked = Object.values(identityState.channelAddresses)
      .some(address => address.playerId === playerId);
    if (this.configStore.getSnapshot().arcade.mode === 'coin_only') {
      if (!messagingLinked || identityState.messagingDrafts[playerId]?.stationId !== stationId) {
        throw new ArcadeHttpError(
          409, 'MESSAGING_IDENTITY_REQUIRED',
          'join through SMS or WhatsApp before entering the ready pool',
        );
      }
    }
    await resources.service.insertStationCoin({
      stationId,
      playerId,
      idempotencyKey: playerServiceKey(playerId, 'station-coin', idempotencyKey),
    });
    const state = await resources.store.read();
    const projection = projectPlayerStation(
      state, stationAggregateFromState(state, stationId), playerId,
    );
    sendJson(response, 200, projection, {
      'Cache-Control': 'no-store', ETag: stationEtag(projection.revision),
    });
  }

  private async handleStationLeave(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    requireExactObject(await readJson(request, STATION_BODY_LIMIT), [], []);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`station-leave:${playerId}`, 10, 60_000);
    const state = await resources.store.read();
    const entry = Object.values(state.stationReadyEntries)
      .find(candidate => candidate.playerId === playerId && !['COMPLETED', 'LEFT'].includes(candidate.status));
    if (!entry) throw new ArcadeHttpError(409, 'READY_ENTRY_REQUIRED', 'player is not in the station ready pool');
    const station = state.stations[entry.stationId];
    if (!station) throw new ArcadeHttpError(503, 'ARCADE_STATE_UNAVAILABLE', 'Twilio Games player state is unavailable');
    await resources.service.leaveStationReadyEntry({
      stationId: entry.stationId,
      playerId,
      readyEntryId: entry.id,
      expectedRevision: station.revision,
      idempotencyKey: playerServiceKey(playerId, 'station-leave', idempotencyKey),
    });
    const updated = await resources.store.read();
    const projection = projectPlayerStation(
      updated, stationAggregateFromState(updated, entry.stationId), playerId,
    );
    sendJson(response, 200, projection, {
      'Cache-Control': 'no-store', ETag: stationEtag(projection.revision),
    });
  }

  private async handleStationDisplayReady(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireDisplayAuthorization(request);
    requireJsonContentType(request);
    const body = requireExactObject(
      await readJson(request, STATION_BODY_LIMIT), ['matchId', 'launchGeneration'], [],
    );
    const expectedRevision = parseStationIfMatch(request.headers['if-match']);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const resources = await this.getActivePlayerResources();
    const result = await resources.station.markDisplayReady({
      matchId: body.matchId as string,
      launchGeneration: body.launchGeneration as number,
      expectedRevision,
      idempotencyKey: playerServiceKey('station-display', 'ready', idempotencyKey),
    });
    sendJson(response, 200, { phase: result.station.phase, revision: result.station.revision }, {
      'Cache-Control': 'no-store', ETag: stationEtag(result.station.revision),
    });
  }

  private async handleOperatorStation(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    this.requireAdmin(request);
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const state = await resources.store.read();
    const aggregate = stationAggregateFromState(
      state, this.configStore.getSnapshot().arcade.cabinetId,
    );
    if (!aggregate) {
      sendJson(response, 200, null, { 'Cache-Control': 'no-store', ETag: stationEtag(0) });
      return;
    }
    sendJson(response, 200, projectOperatorStation(
      state, aggregate, resources.station.connectedParticipantIds(),
    ), {
      'Cache-Control': 'no-store', ETag: stationEtag(aggregate.station.revision),
    });
  }

  private async handleOperatorMessagingRetry(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    notificationId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, STATION_BODY_LIMIT), ['reason'], []);
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const result = await resources.messaging.retryFailedNotification({
      notificationId,
      actorSubject: principal.email,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`, `messaging-retry:${notificationId}`, idempotencyKey,
      ),
    });
    sendJson(response, 200, result, { 'Cache-Control': 'no-store' });
  }

  private async handleOperatorStationCoinGrant(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    readyEntryId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, STATION_BODY_LIMIT), ['amount', 'reason'], []);
    const amount = body.amount;
    if (!Number.isSafeInteger(amount) || (amount as number) < 1 || (amount as number) > 100) {
      throw new ArcadeHttpError(400, 'INVALID_AMOUNT', 'coin amount must be a whole number from 1 to 100');
    }
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const result = await resources.service.grantStationPlayerCoins({
      stationId: this.configStore.getSnapshot().arcade.cabinetId,
      readyEntryId,
      amount: amount as number,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`, `station-coins:${readyEntryId}`, idempotencyKey,
      ),
      authorization: resources.operatorAuthorization(principal.email),
    });
    sendJson(response, 200, {
      readyEntryId: result.readyEntryId,
      availableBalance: result.availableBalance,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleOperatorStationPlayerDrop(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    readyEntryId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const expectedRevision = parseStationIfMatch(request.headers['if-match']);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, STATION_BODY_LIMIT), ['reason'], []);
    const resources = await this.requirePlayerRuntime().getForCleanup();
    await resources.station.dropAdmittedEntry({
      readyEntryId,
      expectedRevision,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`, `station-drop:${readyEntryId}`, idempotencyKey,
      ),
      authorization: resources.operatorAuthorization(principal.email),
    });
    const state = await resources.store.read();
    const aggregate = stationAggregateFromState(state, this.configStore.getSnapshot().arcade.cabinetId);
    if (!aggregate) throw new ArcadeHttpError(503, 'ARCADE_STATE_UNAVAILABLE', 'Twilio Games state is unavailable');
    sendJson(response, 200, projectOperatorStation(state, aggregate), {
      'Cache-Control': 'no-store', ETag: stationEtag(aggregate.station.revision),
    });
  }

  private async handleOperatorStationAction(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    action: OperatorStationAction,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const expectedRevision = parseStationIfMatch(request.headers['if-match']);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, STATION_BODY_LIMIT),
      action === 'select' ? ['game', 'reason'] : ['reason'],
      [],
    );
    const reason = operatorReason(body.reason);
    const runtime = this.requirePlayerRuntime();
    const cleanup = action === 'complete' || action === 'advance' || action === 'fail' || action === 'reset';
    const resources = cleanup ? await runtime.getForCleanup() : await this.getActivePlayerResources();
    const stationId = this.configStore.getSnapshot().arcade.cabinetId;
    const before = await resources.store.read();
    const beforeStation = before.stations[stationId];
    const activeMatch = beforeStation?.activeMatchId
      ? before.stationMatches[beforeStation.activeMatchId] ?? null
      : null;
    const common = {
      stationId,
      expectedRevision,
      reason,
      idempotencyKey: playerServiceKey(`operator:${principal.email}`, `station-${action}`, idempotencyKey),
      authorization: resources.operatorAuthorization(principal.email),
    };
    if (action === 'select') {
      if (!isPlayableArcadeGame(body.game)) {
        throw new ArcadeHttpError(400, 'INVALID_GAME', 'game is not station-playable');
      }
      await resources.station.selectGame({ ...common, game: body.game });
    } else if (action === 'close') await resources.service.closeStationRecruiting(common);
    else if (action === 'launch') await resources.service.requestStationLaunch(common);
    else if (action === 'complete') await resources.service.completeStationMatch(common);
    else if (action === 'advance') await resources.service.advanceStationResults(common);
    else if (action === 'fail') await resources.service.failStationLaunch(common);
    else {
      await resources.service.resetStation(common);
      await resources.station.flush();
    }
    if (activeMatch && ['complete', 'fail', 'reset'].includes(action)) {
      this.abortLiveStationEngine(activeMatch.game, activeMatch.engineRoomCode);
      await this.refreshStationRoomCache();
    }

    const state = await resources.store.read();
    const aggregate = stationAggregateFromState(state, stationId);
    if (!aggregate) throw new ArcadeHttpError(503, 'ARCADE_STATE_UNAVAILABLE', 'Twilio Games state is unavailable');
    sendJson(response, 200, projectOperatorStation(state, aggregate), {
      'Cache-Control': 'no-store', ETag: stationEtag(aggregate.station.revision),
    });
  }

  private async handleOperatorQueue(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    this.requireAdmin(request);
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const queue = (await resources.service.listOperatorQueue()).map(publicOperatorQueueStatus);
    sendJson(response, 200, { queue }, { 'Cache-Control': 'no-store' });
  }

  private async handleOperatorQueueAction(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    queueEntryId: string,
    action: 'approach' | 'call' | 'expire' | 'requeue' | 'activate' | 'release',
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, QUEUE_BODY_LIMIT), ['reason'], []);
    const runtime = this.requirePlayerRuntime();
    const resources = action === 'release'
      ? await runtime.getForCleanup()
      : await this.getActivePlayerResources();
    const entry = await resources.service.getOperatorQueueEntry(queueEntryId);
    if (!entry) throw new ArcadeHttpError(404, 'QUEUE_ENTRY_NOT_FOUND', 'queue entry was not found');
    const input = {
      playerId: entry.playerId,
      queueEntryId,
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`,
        `queue-${action}:${queueEntryId}`,
        idempotencyKey,
      ),
      reason: operatorReason(body.reason),
      authorization: resources.operatorAuthorization(principal.email),
    };
    const result = action === 'approach'
      ? await resources.service.markApproaching(input)
      : action === 'call'
        ? await resources.service.callQueueEntry(input)
        : action === 'expire'
          ? await resources.service.expireQueueEntry(input)
          : action === 'requeue'
            ? await resources.service.requeueEntry(input)
            : action === 'activate'
              ? await resources.service.activateLobby(input)
              : await resources.service.releaseQueueEntry(input);
    sendJson(response, 200, {
      queueEntryId,
      status: result.entry.status,
      availableBalance: result.availableBalance,
      reservation: result.reservation
        ? { amount: result.reservation.amount, status: result.reservation.status }
        : null,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleOperatorMatchStart(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, QUEUE_BODY_LIMIT), ['queueEntryIds', 'game', 'reason'], [],
    );
    const resources = await this.getActivePlayerResources();
    const result = await resources.service.startMatch({
      queueEntryIds: body.queueEntryIds as string[],
      game: body.game as 'racer' | 'monsters' | 'fighter' | 'trivia',
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(`operator:${principal.email}`, 'match-start', idempotencyKey),
      authorization: resources.operatorAuthorization(principal.email),
    });
    sendJson(response, 200, {
      matchId: result.matchId,
      entries: result.entries.map(entry => ({ queueEntryId: entry.id, status: entry.status })),
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleOperatorMatchComplete(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    matchId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, QUEUE_BODY_LIMIT), ['queueEntryIds', 'reason'], [],
    );
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const entries = await resources.service.completeMatch({
      queueEntryIds: body.queueEntryIds as string[],
      matchId,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`,
        `match-complete:${matchId}`,
        idempotencyKey,
      ),
      authorization: resources.operatorAuthorization(principal.email),
    });
    sendJson(response, 200, {
      matchId,
      entries: entries.map(entry => ({ queueEntryId: entry.id, status: entry.status })),
    }, { 'Cache-Control': 'no-store' });
  }

  private openEventStream(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (this.streams.size >= this.maxEventStreams) {
      throw new ArcadeHttpError(503, 'EVENT_STREAM_LIMIT', 'Twilio Games event stream capacity is exhausted');
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    let closed = false;
    let unsubscribe: () => void = () => undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream: EventStream = {
      response,
      close: () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        this.streams.delete(stream);
        response.end();
      },
    };
    this.streams.add(stream);
    const writeChunk = (chunk: string) => {
      if (closed || response.destroyed) return;
      if (!response.write(chunk)) stream.close();
    };
    const write = (event: ArcadeEvent) => writeChunk(formatEvent(event));
    unsubscribe = this.events.subscribe(write);
    heartbeat = setInterval(() => {
      writeChunk(': keep-alive\n\n');
    }, this.heartbeatMs);
    heartbeat.unref?.();
    write({
      type: ARCADE_CONFIG_UPDATED_EVENT,
      version: this.configStore.getSnapshot().version,
    });
    request.once('aborted', stream.close);
    response.once('close', stream.close);
  }

  private requirePlayerRuntime(): ArcadePlayerRuntime {
    if (!this.playerRuntime) {
      throw new ArcadeHttpError(503, 'ARCADE_STATE_UNAVAILABLE', 'Twilio Games player state is unavailable');
    }
    return this.playerRuntime;
  }

  private validateStationAdmissionConfig(config: ArcadeConfigSnapshot): void {
    const issue = this.stationCapabilityIssue(config);
    if (issue) throw new ArcadeHttpError(422, issue.code, issue.message);
  }

  private stationCapabilityIssue(
    config: ArcadeConfigSnapshot,
  ): Readonly<{ code: string; message: string }> | null {
    if (config.arcade.mode === 'off') return null;
    if (this.displayToken.length < 16) {
      return {
        code: 'STATION_DISPLAY_TOKEN_REQUIRED',
        message: 'Configure ARCADE_DISPLAY_TOKEN with at least 16 characters before enabling station mode.',
      };
    }
    if (!config.channels.voice) {
      return {
        code: 'STATION_VOICE_REQUIRED',
        message: 'Enable the Voice channel before saving an active station mode.',
      };
    }
    const voiceNumbers = this.effectiveVoiceNumbers(config);
    const missingLocales = (['en-US', 'pt-BR'] as const).filter(locale => voiceNumbers[locale] === null);
    if (missingLocales.length > 0) {
      return {
        code: 'STATION_VOICE_NUMBERS_REQUIRED',
        message: `Configure an E.164 Voice number for ${missingLocales.join(' and ')} or configure GAME_PHONE_NUMBER before saving an active station mode.`,
      };
    }
    if (config.arcade.mode === 'coin_only'
      && !((config.channels.sms && this.messagingCapabilities.sms)
        || (config.channels.whatsapp && this.messagingCapabilities.whatsapp))) {
      return {
        code: 'COIN_ONLY_MESSAGING_REQUIRED',
        message: 'coin_only requires an enabled channel with a configured sender: TWILIO_SMS_NUMBER/TWILIO_PHONE_NUMBER for SMS or TWILIO_WHATSAPP_NUMBER for WhatsApp.',
      };
    }
    return null;
  }

  private requireStationRuntimeCapabilities(config = this.configStore.getSnapshot()): void {
    const issue = this.stationCapabilityIssue(config);
    if (issue) throw new ArcadeHttpError(503, 'STATION_CAPABILITY_UNAVAILABLE', issue.message);
  }

  private async getActivePlayerResources() {
    this.requireStationRuntimeCapabilities();
    const resources = await this.requirePlayerRuntime().getActive();
    this.bindStationAbortHandler(resources);
    return resources;
  }

  private tacMessagingReady(): boolean {
    if (!this.tacRequired) return true;
    const status = this.tacStatus?.() as { started?: unknown; connected?: unknown } | undefined;
    return status?.started === true && status.connected === true;
  }

  private bindStationAbortHandler(
    resources: NonNullable<ReturnType<ArcadePlayerRuntime['getInitializedResources']>>,
  ): void {
    resources.station.setMatchRemovedHandler((game, roomCode) => {
      this.abortLiveStationEngine(game, roomCode);
    });
  }

  private abortLiveStationEngine(
    game: 'racer' | 'monsters' | 'fighter',
    roomCode: string,
  ): void {
    this.abortStationEngine?.(game, roomCode);
    this.stationRoomCodes.delete(roomCode);
    this.stationVoiceCalls.clear();
  }

  private requirePlayerSession(
    request: http.IncomingMessage,
    sessions: ArcadePlayerSessionService,
  ): string {
    const session = sessions.readCookie(
      request.headers.cookie,
      this.playerSessionAudience(this.configStore.getSnapshot().arcade.cabinetId),
    );
    if (!session) {
      throw new ArcadeHttpError(401, 'ARCADE_SESSION_REQUIRED', 'Twilio Games player session is required');
    }
    return session.player;
  }

  private playerSessionAudience(cabinetId: string): string {
    return `${this.expectedOrigin}#${cabinetId}`;
  }

  private enforceRate(key: string, limit: number, windowMs: number): void {
    this.enforceRateWith(this.rateLimiter, key, limit, windowMs);
  }

  private enforceProcessRate(key: string, limit: number, windowMs: number): void {
    this.enforceRateWith(this.processRateLimiter, key, limit, windowMs);
  }

  private enforceRateWith(
    limiter: ArcadeRateLimiter,
    key: string,
    limit: number,
    windowMs: number,
  ): void {
    const result = limiter.consume(key, limit, windowMs);
    if (result.allowed) return;
    const error = new ArcadeHttpError(429, 'RATE_LIMITED', 'Twilio Games request rate limit exceeded');
    Object.defineProperty(error, 'retryAfter', {
      value: String(result.retryAfterSeconds), enumerable: false,
    });
    throw error;
  }

  private requireAdmin(request: http.IncomingMessage): ArcadeAdminPrincipal {
    let principal: ArcadeAdminPrincipal | null = null;
    try {
      principal = this.authorizeAdmin(request);
    } catch {
      principal = null;
    }
    const email = principal?.email.trim().toLowerCase() ?? '';
    if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
      throw new ArcadeHttpError(401, 'ADMIN_AUTH_REQUIRED', 'Twilio Games operator authentication is required');
    }
    return { email };
  }

  private requireDisplayAuthorization(request: http.IncomingMessage): void {
    const supplied = Buffer.from(firstHeader(request.headers['x-arcade-display-token'])?.trim() ?? '', 'utf8');
    if (this.displayToken.length < 16 || supplied.length !== this.displayToken.length
      || !timingSafeEqual(supplied, this.displayToken)) {
      throw new ArcadeHttpError(401, 'ARCADE_DISPLAY_AUTH_REQUIRED', 'Twilio Games display authentication is required');
    }
  }

  private requireSameOrigin(request: http.IncomingMessage): void {
    const origin = firstHeader(request.headers.origin);
    if (origin !== this.expectedOrigin) {
      throw new ArcadeHttpError(403, 'ORIGIN_FORBIDDEN', 'request origin is not allowed');
    }
  }

  private requireMethod(request: http.IncomingMessage, allowed: readonly string[]): void {
    if (!allowed.includes(request.method ?? '')) this.methodNotAllowed(allowed);
  }

  private methodNotAllowed(allowed: readonly string[]): never {
    const error = new ArcadeHttpError(405, 'METHOD_NOT_ALLOWED', 'method is not allowed for this endpoint');
    Object.defineProperty(error, 'allowed', { value: allowed.join(', '), enumerable: false });
    throw error;
  }

  private sendError(response: http.ServerResponse, error: unknown): void {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }
    let status = 500;
    let code = 'ARCADE_INTERNAL_ERROR';
    let message = 'Twilio Games request failed';
    let details: Record<string, unknown> | undefined;
    let allow: string | undefined;
    let retryAfter: string | undefined;

    if (error instanceof ArcadeHttpError) {
      ({ status, code, message } = error);
      allow = (error as ArcadeHttpError & { allowed?: string }).allowed;
      retryAfter = (error as ArcadeHttpError & { retryAfter?: string }).retryAfter;
    } else if (error instanceof ArcadeConfigValidationError) {
      status = 400;
      code = 'INVALID_ARCADE_CONFIG';
      message = error.message;
    } else if (error instanceof ArcadeConfigVersionConflictError) {
      status = 412;
      code = 'ARCADE_CONFIG_VERSION_CONFLICT';
      message = error.message;
      details = { expectedVersion: error.expectedVersion, currentVersion: error.actualVersion };
    } else if (error instanceof ArcadeConfigIdempotencyConflictError) {
      status = 409;
      code = 'IDEMPOTENCY_CONFLICT';
      message = error.message;
    } else if (error instanceof ArcadeConfigDegradedError) {
      status = 503;
      code = 'ARCADE_CONFIG_DEGRADED';
      message = error.message;
    } else if (error instanceof ArcadeConfigStoreError) {
      message = error.message;
    } else if (error instanceof ArcadePlayerRuntimeError) {
      status = error.code === 'MODE_DISABLED' ? 409 : 503;
      code = error.code === 'MODE_DISABLED'
        ? 'ARCADE_MODE_DISABLED'
        : error.code === 'CONFIG_DEGRADED' ? 'ARCADE_CONFIG_DEGRADED' : 'ARCADE_STATE_UNAVAILABLE';
      message = error.code === 'MODE_DISABLED'
        ? 'station mode is off'
        : error.code === 'CONFIG_DEGRADED'
          ? 'Twilio Games configuration integrity is degraded; new activity is disabled'
          : 'Twilio Games player state is unavailable';
    } else if (error instanceof ArcadePlayerSessionError) {
      status = 401;
      code = 'ARCADE_SESSION_REQUIRED';
      message = 'Twilio Games player session is invalid or expired';
    } else if (error instanceof ArcadeMessagingRetryError) {
      status = error.code === 'INVALID_RETRY_REQUEST' || error.code === 'INVALID_NOTIFICATION'
        ? 400
        : error.code === 'NOTIFICATION_NOT_FOUND' ? 404 : 409;
      code = error.code;
      message = error.message;
    } else if (error instanceof ArcadeServiceError) {
      ({ status, code, message } = playerServiceError(error.code));
    } else if (error instanceof ArcadeDomainError) {
      ({ status, code, message } = playerDomainError(error.code));
    } else if (error instanceof ArcadeQueueError) {
      ({ status, code, message } = playerQueueError(error.code));
    } else if (error instanceof ArcadeStationError) {
      ({ status, code, message } = playerStationError(error.code));
    } else if (error instanceof ArcadeStateStoreError) {
      status = 503;
      code = 'ARCADE_STATE_UNAVAILABLE';
      message = 'Twilio Games player state is unavailable';
    }

    sendJson(response, status, { error: { code, message, ...(details ? { details } : {}) } }, {
      'Cache-Control': 'no-store',
      ...(allow ? { Allow: allow } : {}),
      ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
    });
  }
}

function requestPath(request: http.IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    throw new ArcadeHttpError(400, 'INVALID_URL', 'request URL is invalid');
  }
}

function parseChallengeRoute(pathname: string): {
  challengeId: string;
  action: 'token' | 'claim';
} | null {
  const match = /^\/api\/arcade\/challenges\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/(token|claim)$/.exec(pathname);
  if (!match) return null;
  return { challengeId: match[1]!, action: match[2]! as 'token' | 'claim' };
}

function parseOperatorQueueRoute(pathname: string): {
  queueEntryId: string;
  action: 'approach' | 'call' | 'expire' | 'requeue' | 'activate' | 'release';
} | null {
  const match = /^\/api\/admin\/arcade\/queue\/([A-Za-z0-9](?:[A-Za-z0-9:._-]{0,127}))\/(approach|call|expire|requeue|activate|release)$/.exec(pathname);
  if (!match) return null;
  return {
    queueEntryId: match[1]!,
    action: match[2]! as 'approach' | 'call' | 'expire' | 'requeue' | 'activate' | 'release',
  };
}

function parseOperatorMessagingRetryRoute(pathname: string): { notificationId: string } | null {
  const match = /^\/api\/admin\/arcade\/messaging\/notifications\/(outbound(?::|%3A)[a-f0-9]{64})\/retry$/i.exec(pathname);
  return match ? { notificationId: match[1]!.replace(/%3A/i, ':').toLowerCase() } : null;
}

function parseOperatorStationCoinGrantRoute(pathname: string): { readyEntryId: string } | null {
  const match = /^\/api\/admin\/arcade\/station\/ready\/([A-Za-z0-9](?:[A-Za-z0-9:._-]{0,127}))\/coins\/grant$/.exec(pathname);
  return match ? { readyEntryId: match[1]! } : null;
}

function parseOperatorStationDropRoute(pathname: string): { readyEntryId: string } | null {
  const match = /^\/api\/admin\/arcade\/station\/ready\/([A-Za-z0-9](?:[A-Za-z0-9:._-]{0,127}))\/drop$/.exec(pathname);
  return match ? { readyEntryId: match[1]! } : null;
}

function parseOperatorMatchRoute(pathname: string): { matchId: string } | null {
  const match = /^\/api\/admin\/arcade\/matches\/([A-Za-z0-9](?:[A-Za-z0-9:._-]{0,127}))\/complete$/.exec(pathname);
  return match ? { matchId: match[1]! } : null;
}

type OperatorStationAction = 'close' | 'select' | 'launch' | 'complete' | 'advance' | 'fail' | 'reset';

function parseOperatorStationRoute(pathname: string): OperatorStationAction | null {
  const routes: Readonly<Record<string, OperatorStationAction>> = {
    '/api/admin/arcade/station/recruiting/close': 'close',
    '/api/admin/arcade/station/game/select': 'select',
    '/api/admin/arcade/station/launch/request': 'launch',
    '/api/admin/arcade/station/match/complete': 'complete',
    '/api/admin/arcade/station/results/advance': 'advance',
    '/api/admin/arcade/station/launch/fail': 'fail',
    '/api/admin/arcade/station/reset': 'reset',
  };
  return Object.prototype.hasOwnProperty.call(routes, pathname) ? routes[pathname]! : null;
}

function configEtag(version: number): string {
  return `"arcade-config-${version}"`;
}

function stationEtag(revision: number): string {
  return `"arcade-station-${revision}"`;
}

function parseIfMatch(value: string | string[] | undefined): number {
  const header = firstHeader(value);
  const match = /^"arcade-config-([1-9][0-9]*)"$/.exec(header ?? '');
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(version)) {
    throw new ArcadeHttpError(428, 'ARCADE_CONFIG_VERSION_REQUIRED', 'a current Twilio Games settings ETag is required');
  }
  return version;
}

function parseStationIfMatch(value: string | string[] | undefined): number {
  const header = firstHeader(value);
  const match = /^"arcade-station-([1-9][0-9]*)"$/.exec(header ?? '');
  const revision = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(revision)) {
    throw new ArcadeHttpError(428, 'ARCADE_STATION_REVISION_REQUIRED', 'a current station ETag is required');
  }
  return revision;
}

function playerStationAggregate(state: ArcadeState, playerId: string, defaultStationId: string) {
  const entry = Object.values(state.stationReadyEntries)
    .find(candidate => candidate.playerId === playerId && !['COMPLETED', 'LEFT'].includes(candidate.status));
  return stationAggregateFromState(state, entry?.stationId ?? defaultStationId);
}

function requireHeader(value: string | string[] | undefined, name: string, maximum: number): string {
  const header = firstHeader(value)?.trim() ?? '';
  if (!header || header.length > maximum || /[\u0000-\u001f\u007f]/.test(header)) {
    throw new ArcadeHttpError(400, 'INVALID_HEADER', `${name} must be a non-empty bounded header`);
  }
  return header;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireJsonContentType(request: http.IncomingMessage): void {
  const contentType = firstHeader(request.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ArcadeHttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
}

function requireExactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArcadeHttpError(400, 'INVALID_REQUEST', 'request body must be an object');
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(object);
  if (keys.some(key => !allowed.has(key))
    || required.some(key => !Object.prototype.hasOwnProperty.call(object, key))) {
    throw new ArcadeHttpError(400, 'INVALID_REQUEST', 'request body has unexpected or missing fields');
  }
  return object;
}

function playerServiceKey(playerId: string, route: string, externalKey: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([playerId, route, externalKey]), 'utf8')
    .digest('hex');
  return `api:${digest}`;
}

function operatorReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ArcadeHttpError(400, 'INVALID_REQUEST', 'operator reason must be a non-empty bounded string');
  }
  return value.trim();
}

function messagingRateLimitReply(locale: string): string {
  return locale.toLowerCase().startsWith('pt')
    ? 'Muitas mensagens foram recebidas. Aguarde alguns minutos e tente novamente.'
    : 'Too many messages were received. Wait a few minutes and try again.';
}

function publicQueueStatus(status: ArcadeQueueStatus | null): Omit<ArcadeQueueStatus, 'queueEntryId'> | null {
  if (!status) return null;
  const { queueEntryId: _queueEntryId, ...safe } = status;
  return safe;
}

function publicOperatorQueueStatus(
  status: ArcadeOperatorQueueStatus,
): Omit<ArcadeOperatorQueueStatus, 'playerId'> {
  const { playerId: _playerId, ...safe } = status;
  return safe;
}

function playerServiceError(serviceCode: string): { status: number; code: string; message: string } {
  switch (serviceCode) {
    case 'INVALID_INPUT':
    case 'INVALID_REGISTRATION':
    case 'INVALID_GAME':
    case 'INVALID_MATCH':
      return { status: 400, code: serviceCode, message: 'Twilio Games request is invalid' };
    case 'TERMS_REQUIRED':
      return { status: 422, code: serviceCode, message: 'terms acknowledgement is required' };
    case 'IDEMPOTENCY_CONFLICT':
      return { status: 409, code: serviceCode, message: 'idempotency key was reused for another request' };
    case 'MODE_DISABLED':
      return { status: 409, code: 'ARCADE_MODE_DISABLED', message: 'station mode does not allow this operation' };
    case 'UNSUPPORTED_CHARGE_POLICY':
    case 'QUEUE_DISABLED':
      return { status: 503, code: serviceCode, message: 'Twilio Games operation is unavailable' };
    case 'CONFIG_DEGRADED':
      return {
        status: 503,
        code: 'ARCADE_CONFIG_DEGRADED',
        message: 'Twilio Games configuration integrity is degraded; new activity is disabled',
      };
    case 'PLAYER_NOT_FOUND':
    case 'WALLET_NOT_FOUND':
      return { status: 409, code: 'REGISTRATION_REQUIRED', message: 'player registration is required' };
    case 'PHONE_ALREADY_LINKED':
      return { status: 409, code: serviceCode, message: 'phone number is already linked to another player' };
    case 'PHONE_CHANGE_REQUIRES_RELINK':
      return { status: 409, code: serviceCode, message: 'messaging-linked phone number requires verified relinking' };
    case 'MESSAGING_IDENTITY_REQUIRED':
      return { status: 409, code: serviceCode, message: 'join through SMS or WhatsApp before entering the ready pool' };
    case 'QUEUE_FULL':
    case 'GAME_NOT_ELIGIBLE':
      return { status: 409, code: serviceCode, message: 'station queue operation cannot be completed' };
    case 'CHALLENGE_UNAVAILABLE':
    case 'CHALLENGE_TOKEN_REPLAYED':
      return { status: 409, code: serviceCode, message: 'game challenge cannot be claimed' };
    case 'MATCH_NOT_READY':
    case 'MATCH_NOT_ACTIVE':
    case 'MATCH_PARTICIPANTS_MISMATCH':
    case 'CABINET_CHANGED':
    case 'READY_POOL_FULL':
    case 'READY_ENTRY_NOT_FOUND':
    case 'READY_ENTRY_FORBIDDEN':
    case 'RESERVATION_NOT_ACTIVE':
    case 'STALE_STATION_LAUNCH':
      return { status: 409, code: serviceCode, message: 'Twilio Games match operation cannot be completed' };
    case 'STATION_NOT_FOUND':
      return { status: 404, code: serviceCode, message: 'Twilio Games station was not found' };
    case 'STATION_COIN_POLICY_UNSUPPORTED':
      return { status: 503, code: serviceCode, message: 'station coin operation is unavailable' };
    case 'STATION_ACTION_UNAUTHORIZED':
      return { status: 403, code: serviceCode, message: 'station control is not authorized' };
    case 'INVALID_CHALLENGE_TOKEN':
      return { status: 400, code: serviceCode, message: 'game challenge token is invalid' };
    case 'QUEUE_ENTRY_NOT_FOUND':
    case 'QUEUE_ENTRY_FORBIDDEN':
      return { status: 409, code: 'QUEUE_ENTRY_REQUIRED', message: 'player has no active queue entry' };
    default:
      return { status: 500, code: 'ARCADE_INTERNAL_ERROR', message: 'Twilio Games request failed' };
  }
}

function playerDomainError(domainCode: string): { status: number; code: string; message: string } {
  if (domainCode === 'INSUFFICIENT_BALANCE' || domainCode === 'IDEMPOTENCY_CONFLICT'
    || domainCode === 'CHALLENGE_CLAIM_LIMIT' || domainCode === 'CHALLENGE_UNAVAILABLE'
    || domainCode === 'ACTIVE_RESERVATION_EXISTS') {
    return { status: 409, code: domainCode, message: 'game coin wallet operation cannot be completed' };
  }
  return { status: 400, code: 'INVALID_REQUEST', message: 'Twilio Games request is invalid' };
}

function playerStationError(stationCode: string): { status: number; code: string; message: string } {
  if (stationCode === 'REVISION_CONFLICT') {
    return { status: 412, code: 'ARCADE_STATION_VERSION_CONFLICT', message: 'station state changed' };
  }
  if (stationCode.startsWith('INVALID_')) {
    return { status: 400, code: 'INVALID_REQUEST', message: 'station request is invalid' };
  }
  return { status: 409, code: stationCode, message: 'station transition cannot be completed' };
}

function playerQueueError(queueCode: string): { status: number; code: string; message: string } {
  if (queueCode === 'INVALID_QUEUE_VALUE' || queueCode === 'INVALID_SELECTION_LIMIT') {
    return { status: 400, code: 'INVALID_REQUEST', message: 'station queue request is invalid' };
  }
  return { status: 409, code: queueCode, message: 'station queue transition cannot be completed' };
}

async function readJson(request: http.IncomingMessage, maximumBytes: number): Promise<unknown> {
  const contentLength = firstHeader(request.headers['content-length']);
  if (contentLength !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new ArcadeHttpError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid');
    }
    if (Number(contentLength) > maximumBytes) {
      request.resume();
      throw new ArcadeHttpError(413, 'REQUEST_TOO_LARGE', `request body exceeds ${maximumBytes} bytes`);
    }
  }

  const body = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximumBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(bytes);
    });
    request.once('end', () => {
      if (tooLarge) reject(new ArcadeHttpError(413, 'REQUEST_TOO_LARGE', `request body exceeds ${maximumBytes} bytes`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.once('aborted', () => reject(new ArcadeHttpError(400, 'REQUEST_ABORTED', 'request body was aborted')));
    request.once('error', reject);
  });
  if (!body.trim()) throw new ArcadeHttpError(400, 'INVALID_JSON', 'request body must contain JSON');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ArcadeHttpError(400, 'INVALID_JSON', 'request body is not valid JSON');
  }
}

function formatEvent(event: ArcadeEvent): string {
  const id = event.type === ARCADE_CONFIG_UPDATED_EVENT
    ? String(event.version)
    : `station:${event.revision}`;
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}
