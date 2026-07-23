import { createHash } from 'node:crypto';
import type { ArcadeConfigSnapshot } from '../shared/arcade-config';
import { availableBalance } from '../shared/arcade-domain';
import {
  ARCADE_CONFIG_UPDATED_EVENT,
  ARCADE_STATION_UPDATED_EVENT,
  type ArcadeEventHub,
} from './arcade-events';
import {
  ARCADE_OUTBOUND_NOTIFICATION_STATUSES,
  ARCADE_PROVIDER_MESSAGE_STATUSES,
  ARCADE_STATE_MAX_MESSAGING_AUDIT_EVENTS,
  type ArcadeMessagingChannel,
  type ArcadeMessagingAuditEvent,
  type ArcadeOutboundAttemptRecord,
  type ArcadeOutboundNotificationRecord,
  type ArcadeOutboundNotificationStatus,
  type ArcadeProviderMessageStatus,
  type ArcadeState,
  type ArcadeStateStore,
} from './arcade-state-store';

type Timer = ReturnType<typeof setTimeout>;

const MAX_ATTEMPTS = 5;
const CLAIM_LEASE_MS = 30_000;
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
const WHATSAPP_WINDOW_MARGIN_MS = 5 * 60 * 1000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000] as const;
const MAX_TRANSITIONS_PER_RECONCILE = 32;
const RECENT_FAILURE_LIMIT = 20;

export interface ArcadeMessagingTransport {
  send(input: {
    channel: ArcadeMessagingChannel;
    to: string;
    body?: string;
    contentSid?: string;
    contentVariables?: Readonly<Record<string, string>>;
    statusCallback: string;
    validityPeriodSeconds: number;
  }): Promise<{
    providerMessageId: string;
    status: ArcadeProviderMessageStatus;
  }>;
}

export class ArcadeMessagingTransportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string | null = null,
    readonly acceptanceUnknown = false,
  ) {
    super(message);
    this.name = 'ArcadeMessagingTransportError';
  }
}

export interface ArcadeMessagingRuntimeOptions {
  readonly store: ArcadeStateStore;
  readonly config: () => ArcadeConfigSnapshot;
  readonly events: ArcadeEventHub;
  readonly publicBaseUrl: string;
  readonly enabled: (channel?: ArcadeMessagingChannel) => boolean;
  readonly createTransport: () => ArcadeMessagingTransport;
  readonly callNumber?: (locale: 'en-US' | 'pt-BR') => string | null | undefined;
  readonly clock?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => Timer;
  readonly clearTimer?: (timer: Timer) => void;
  readonly onError?: (error: unknown) => void;
}

export type ArcadeMessagingRuntimeStatus = Readonly<{
  configured: boolean;
  enabled: boolean;
  started: boolean;
  lastError: string | null;
  channels: Readonly<Record<ArcadeMessagingChannel, boolean>>;
  counts: Readonly<Record<ArcadeOutboundNotificationStatus, number>>;
  recentFailures: readonly ArcadeMessagingFailedNotice[];
}>;

export type ArcadeMessagingFailedNotice = Readonly<{
  notificationId: string;
  kind: ArcadeOutboundNotificationRecord['kind'];
  channel: ArcadeMessagingChannel;
  status: 'FAILED';
  attempts: number;
  maximumAttempts: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  terminalReason: string | null;
  updatedAt: string;
  expiresAt: string;
  retryEligible: boolean;
  retryIneligibleReason: string | null;
}>;

export class ArcadeMessagingRetryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArcadeMessagingRetryError';
  }
}

export type ArcadeMessagingRetryResult = Readonly<{
  notificationId: string;
  status: ArcadeOutboundNotificationStatus | null;
  attempts: number;
  replayed: boolean;
}>;

type ClaimedMessage = Readonly<{
  notificationId: string;
  attemptId: string;
  input: Parameters<ArcadeMessagingTransport['send']>[0];
}>;

type ClaimResult = Readonly<{
  claimed: ClaimedMessage | null;
  wakeAt: number | null;
}>;

export class ArcadeMessagingRuntime {
  private readonly store: ArcadeStateStore;
  private readonly config: () => ArcadeConfigSnapshot;
  private readonly events: ArcadeEventHub;
  private readonly publicBaseUrl: string;
  private readonly enabledSource: (channel?: ArcadeMessagingChannel) => boolean;
  private readonly createTransport: () => ArcadeMessagingTransport;
  private readonly callNumberSource?: (locale: 'en-US' | 'pt-BR') => string | null | undefined;
  private readonly clock: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly onError?: (error: unknown) => void;
  private transport: ArcadeMessagingTransport | null = null;
  private timer: Timer | null = null;
  private unsubscribe: (() => void) | null = null;
  private pending: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;
  private lastError: string | null = null;
  private counts = emptyCounts();
  private recentFailures: readonly ArcadeMessagingFailedNotice[] = Object.freeze([]);

  constructor(options: ArcadeMessagingRuntimeOptions) {
    this.store = options.store;
    this.config = options.config;
    this.events = options.events;
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/$/, '');
    this.enabledSource = options.enabled;
    this.createTransport = options.createTransport;
    this.callNumberSource = options.callNumber;
    this.clock = options.clock ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Arcade messaging runtime cannot restart after stop');
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.events.subscribe(event => {
      if (event.type === ARCADE_STATION_UPDATED_EVENT || event.type === ARCADE_CONFIG_UPDATED_EVENT) {
        this.enqueueReconcile();
      }
    });
    await this.reconcile();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancelTimer();
    await this.pending.catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  getStatus(): ArcadeMessagingRuntimeStatus {
    const config = this.config();
    const channels = this.effectiveChannels(config);
    return Object.freeze({
      configured: this.isConfigured(),
      enabled: this.started && config.arcade.mode !== 'off' && (channels.sms || channels.whatsapp),
      started: this.started,
      lastError: this.lastError,
      channels,
      counts: Object.freeze({ ...this.counts }),
      recentFailures: this.recentFailures,
    });
  }

  async getAdminStatus(): Promise<ArcadeMessagingRuntimeStatus> {
    await this.refreshStatusState();
    return this.getStatus();
  }

  async recordStatus(input: {
    notificationId: string;
    attemptId: string;
    providerMessageId: string;
    providerStatus: string;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<boolean> {
    const updated = await recordArcadeMessagingStatus(this.store, input, this.clock);
    await this.refreshStatusState();
    if (updated) this.enqueueReconcile();
    return updated;
  }

  async retryFailedNotification(input: {
    notificationId: string;
    actorSubject: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<ArcadeMessagingRetryResult> {
    const notificationId = boundedRequired(input.notificationId, 128, 'notification ID');
    const actorSubject = boundedRequired(input.actorSubject, 256, 'actor subject');
    const reason = boundedRequired(input.reason, 200, 'operator reason');
    const idempotencyKey = boundedRequired(input.idempotencyKey, 128, 'idempotency key');
    if (!/^outbound:[a-f0-9]{64}$/.test(notificationId)) {
      throw new ArcadeMessagingRetryError('INVALID_NOTIFICATION', 'outbound notification ID is invalid');
    }
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify([notificationId, actorSubject, reason]))
      .digest('hex');
    const auditId = `messaging-audit:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
    const now = this.clock();
    const at = new Date(now).toISOString();
    const config = this.config();
    const result = await this.store.transaction(state => {
      const existing = state.messagingAuditEvents[auditId];
      if (existing) {
        if (existing.idempotencyKey !== idempotencyKey
          || existing.requestFingerprint !== requestFingerprint) {
          throw new ArcadeMessagingRetryError(
            'IDEMPOTENCY_CONFLICT', 'idempotency key was used for a different messaging retry',
          );
        }
        const current = state.outboundNotifications[existing.notificationId];
        return {
          notificationId: existing.notificationId,
          status: current?.status ?? null,
          attempts: current?.attempts.length ?? existing.attemptCount,
          replayed: true,
        } satisfies ArcadeMessagingRetryResult;
      }
      const notification = state.outboundNotifications[notificationId];
      if (!notification) {
        throw new ArcadeMessagingRetryError('NOTIFICATION_NOT_FOUND', 'outbound notification was not found');
      }
      const ineligibleReason = notificationRetryIneligibleReason(
        state,
        config,
        notification,
        now,
        this.started && !this.stopped && this.isChannelEnabled(notification.channel),
        this.callNumberSource,
      );
      if (ineligibleReason !== null) throw retryEligibilityError(ineligibleReason);

      pruneMessagingAuditEvents(state);
      const audit: ArcadeMessagingAuditEvent = {
        id: auditId,
        action: 'RETRY_OUTBOUND_NOTIFICATION',
        notificationId,
        actorSubject,
        reason,
        idempotencyKey,
        requestFingerprint,
        fromStatus: 'FAILED',
        attemptCount: notification.attempts.length,
        occurredAt: at,
      };
      state.messagingAuditEvents[audit.id] = audit;
      state.outboundNotifications[notification.id] = {
        ...notification,
        status: 'PENDING',
        nextAttemptAt: at,
        terminalReason: null,
        updatedAt: at,
        terminalAt: null,
      };
      return {
        notificationId,
        status: 'PENDING',
        attempts: notification.attempts.length,
        replayed: false,
      } satisfies ArcadeMessagingRetryResult;
    });
    await this.refreshStatusState();
    this.enqueueReconcile();
    return result;
  }

  private enqueueReconcile(): void {
    if (!this.started || this.stopped) return;
    this.pending = this.pending.then(() => this.reconcile()).catch(error => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.report(error);
      if (this.started && !this.stopped) this.schedule(this.clock() + 1_000);
    });
  }

  private async reconcile(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.cancelTimer();
    const activeConfig = this.config();
    if (activeConfig.arcade.mode === 'off') {
      await this.refreshStatusState();
      return;
    }
    const channels = this.effectiveChannels(activeConfig);
    if (!channels.sms && !channels.whatsapp) {
      const now = this.clock();
      const at = new Date(now).toISOString();
      const wakeAt = await this.store.transaction(state => {
        pruneAndExpire(state, now, at);
        return nextMaintenanceAt(state, now);
      });
      await this.refreshStatusState();
      if (wakeAt !== null) this.schedule(wakeAt);
      return;
    }
    for (let transitions = 0; transitions < MAX_TRANSITIONS_PER_RECONCILE; transitions += 1) {
      const now = this.clock();
      const result = await this.claimNext(now);
      if (!result.claimed) {
        await this.refreshStatusState();
        if (result.wakeAt !== null) this.schedule(result.wakeAt);
        return;
      }
      await this.deliver(result.claimed);
    }
    this.enqueueReconcile();
  }

  private claimNext(now: number): Promise<ClaimResult> {
    const at = new Date(now).toISOString();
    const config = this.config();
    return this.store.transaction(state => {
      pruneAndExpire(state, now, at);
      recoverStaleClaims(state, now, at);
      const candidates = Object.values(state.outboundNotifications)
        .filter(notification => (
          (notification.status === 'PENDING' || notification.status === 'RETRY_WAIT')
          && Date.parse(notification.nextAttemptAt ?? notification.createdAt) <= now
        ))
        .sort((left, right) => Date.parse(left.nextAttemptAt ?? left.createdAt)
          - Date.parse(right.nextAttemptAt ?? right.createdAt)
          || left.id.localeCompare(right.id));

      for (const notification of candidates) {
        if (!this.isChannelEnabled(notification.channel)) continue;
        const suppressionReason = notificationSuppressionReason(
          state, config, notification, this.callNumberSource,
        );
        if (suppressionReason !== null) {
          state.outboundNotifications[notification.id] = terminalNotification(
            notification, 'SUPPRESSED', at, suppressionReason,
          );
          continue;
        }
        const address = state.channelAddresses[notification.channelAddressId]!;
        if (notification.attempts.length >= MAX_ATTEMPTS) {
          state.outboundNotifications[notification.id] = terminalNotification(
            notification, 'FAILED', at, 'ATTEMPTS_EXHAUSTED',
          );
          continue;
        }
        const remainingSeconds = Math.floor((Date.parse(notification.expiresAt) - now) / 1000);
        if (remainingSeconds <= 5) {
          state.outboundNotifications[notification.id] = terminalNotification(
            notification, 'EXPIRED', at, 'NOTIFICATION_EXPIRED',
          );
          continue;
        }
        const inWhatsAppWindow = notification.channel !== 'whatsapp'
          || now < Date.parse(address.lastSeenAt) + WHATSAPP_WINDOW_MS - WHATSAPP_WINDOW_MARGIN_MS;
        if (!inWhatsAppWindow && notification.templateContentSid === null) {
          state.outboundNotifications[notification.id] = terminalNotification(
            notification, 'SUPPRESSED', at, 'WHATSAPP_TEMPLATE_REQUIRED',
          );
          continue;
        }
        const useTemplate = notification.channel === 'whatsapp' && !inWhatsAppWindow;
        const ordinal = notification.attempts.length + 1;
        const attempt: ArcadeOutboundAttemptRecord = {
          id: `${notification.id}:attempt:${ordinal}`,
          ordinal,
          providerMessageId: null,
          providerStatus: null,
          startedAt: at,
          finishedAt: null,
          callbackAt: null,
          errorCode: null,
          errorMessage: null,
        };
        state.outboundNotifications[notification.id] = {
          ...notification,
          status: 'SENDING',
          nextAttemptAt: null,
          attempts: [...notification.attempts, attempt],
          updatedAt: at,
        };
        const statusCallback = `${this.publicBaseUrl}/twilio/messaging/status?n=${encodeURIComponent(notification.id)}&a=${encodeURIComponent(attempt.id)}#rc=3&rp=ct,rt,5xx`;
        return {
          claimed: {
            notificationId: notification.id,
            attemptId: attempt.id,
            input: {
              channel: notification.channel,
              to: notification.to,
              ...(useTemplate ? {
                  contentSid: notification.templateContentSid!,
                  contentVariables: notification.templateVariables,
                } : { body: notification.body }),
              statusCallback,
              validityPeriodSeconds: Math.min(36_000, remainingSeconds),
            },
          },
          wakeAt: null,
        };
      }
      return {
        claimed: null,
        wakeAt: nextWakeAt(state, now, notification => this.isChannelEnabled(notification.channel)),
      };
    });
  }

  private async deliver(claimed: ClaimedMessage): Promise<void> {
    let result: Awaited<ReturnType<ArcadeMessagingTransport['send']>>;
    try {
      this.transport ??= this.createTransport();
      result = await this.transport.send(claimed.input);
      if (!/^(?:SM|MM)[a-fA-F0-9]{32}$/.test(result.providerMessageId)
        || !(ARCADE_PROVIDER_MESSAGE_STATUSES as readonly string[]).includes(result.status)) {
        throw new ArcadeMessagingTransportError('Twilio returned an invalid message response', false, null, true);
      }
    } catch (error) {
      await this.finishFailure(claimed, error);
      this.lastError = error instanceof Error ? error.message : String(error);
      this.report(error);
      return;
    }
    try {
      await this.finishSuccess(claimed, result.providerMessageId, result.status);
      this.lastError = null;
    } catch (error) {
      // Leave the durable claim in SENDING. Lease recovery quarantines it without resending,
      // while the attempt-specific status callback can still reconcile a provider acceptance.
      this.lastError = error instanceof Error ? error.message : String(error);
      this.report(error);
    }
  }

  private finishSuccess(
    claimed: ClaimedMessage,
    providerMessageId: string,
    providerStatus: ArcadeProviderMessageStatus,
  ): Promise<void> {
    const at = new Date(this.clock()).toISOString();
    return this.store.transaction(state => {
      const notification = state.outboundNotifications[claimed.notificationId];
      if (!notification) return;
      const index = notification.attempts.findIndex(attempt => attempt.id === claimed.attemptId);
      if (index < 0) return;
      const current = notification.attempts[index]!;
      if (current.providerMessageId !== null && current.providerMessageId !== providerMessageId) {
        throw new ArcadeMessagingTransportError('provider SID conflicts with status callback', false);
      }
      const mergedStatus = mergeProviderStatus(current.providerStatus, providerStatus);
      const attempts = [...notification.attempts];
      attempts[index] = {
        ...current,
        providerMessageId,
        providerStatus: mergedStatus,
        finishedAt: at,
      };
      state.outboundNotifications[notification.id] = applyProviderStatus(
        { ...notification, attempts, updatedAt: at },
        mergedStatus,
        at,
      );
    });
  }

  private finishFailure(claimed: ClaimedMessage, error: unknown): Promise<void> {
    const now = this.clock();
    const at = new Date(now).toISOString();
    const detail = transportError(error);
    return this.store.transaction(state => {
      const notification = state.outboundNotifications[claimed.notificationId];
      if (!notification) return;
      const index = notification.attempts.findIndex(attempt => attempt.id === claimed.attemptId);
      if (index < 0) return;
      const attempts = [...notification.attempts];
      attempts[index] = {
        ...attempts[index]!,
        finishedAt: at,
        errorCode: detail.code,
        errorMessage: detail.message,
      };
      if (attempts[index]!.providerMessageId !== null) {
        state.outboundNotifications[notification.id] = {
          ...notification,
          attempts,
          updatedAt: at,
        };
        return;
      }
      if (detail.acceptanceUnknown) {
        state.outboundNotifications[notification.id] = {
          ...notification,
          attempts,
          status: 'ACCEPTED',
          nextAttemptAt: null,
          terminalReason: 'AMBIGUOUS_PROVIDER_ACCEPTANCE',
          updatedAt: at,
        };
        return;
      }
      const retryDelay = RETRY_DELAYS_MS[Math.min(index, RETRY_DELAYS_MS.length - 1)]!;
      const canRetry = detail.retryable && attempts.length < MAX_ATTEMPTS
        && now + retryDelay < Date.parse(notification.expiresAt);
      state.outboundNotifications[notification.id] = canRetry ? {
        ...notification,
        attempts,
        status: 'RETRY_WAIT',
        nextAttemptAt: new Date(now + retryDelay).toISOString(),
        updatedAt: at,
      } : terminalNotification(
        { ...notification, attempts },
        Date.parse(notification.expiresAt) <= now ? 'EXPIRED' : 'FAILED',
        at,
        detail.code ?? (detail.retryable ? 'ATTEMPTS_EXHAUSTED' : 'PERMANENT_FAILURE'),
      );
    });
  }

  private schedule(at: number): void {
    const delay = Math.max(0, at - this.clock());
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.enqueueReconcile();
    }, Math.min(delay, 2_147_483_647));
    this.timer.unref?.();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private isConfigured(): boolean {
    try {
      return this.enabledSource() === true;
    } catch {
      return false;
    }
  }

  private isChannelEnabled(channel: ArcadeMessagingChannel): boolean {
    try {
      return this.enabledSource(channel) === true;
    } catch {
      return false;
    }
  }

  private effectiveChannels(
    config: ArcadeConfigSnapshot,
  ): Readonly<Record<ArcadeMessagingChannel, boolean>> {
    return Object.freeze({
      sms: config.arcade.mode !== 'off' && config.channels.sms && this.isChannelEnabled('sms'),
      whatsapp: config.arcade.mode !== 'off'
        && config.channels.whatsapp && this.isChannelEnabled('whatsapp'),
    });
  }

  private async refreshStatusState(): Promise<void> {
    const state = await this.store.read();
    const counts = emptyCounts();
    for (const notification of Object.values(state.outboundNotifications)) counts[notification.status] += 1;
    this.counts = counts;
    const now = this.clock();
    const config = this.config();
    this.recentFailures = Object.freeze(Object.values(state.outboundNotifications)
      .filter((notification): notification is ArcadeOutboundNotificationRecord & { status: 'FAILED' } => (
        notification.status === 'FAILED'
      ))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        || right.id.localeCompare(left.id))
      .slice(0, RECENT_FAILURE_LIMIT)
      .map(notification => failedNotice(
        state,
        config,
        notification,
        now,
        this.started && !this.stopped && this.isChannelEnabled(notification.channel),
        this.callNumberSource,
      )));
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Error reporting must not stop later delivery attempts.
    }
  }
}

function notificationSuppressionReason(
  state: ArcadeState,
  config: ArcadeConfigSnapshot,
  notification: ArcadeOutboundNotificationRecord,
  callNumberSource: ArcadeMessagingRuntimeOptions['callNumber'],
): string | null {
  const address = state.channelAddresses[notification.channelAddressId];
  if (!address || address.playerId !== notification.playerId || !config.channels[notification.channel]) {
    return 'CHANNEL_DISABLED';
  }
  if (notification.kind === 'STATION_RESULTS') {
    const standardResults = config.postGame.enabled && config.postGame.channels.includes(notification.channel);
    const wallet = state.wallets[notification.playerId];
    const now = Date.now();
    const challengeResults = config.postGame.includeChallenges && config.earning.enabled
      && config.coins.chargePolicy !== 'free' && wallet && availableBalance(wallet) === 0
      && config.earning.challenges.some(challenge => challenge.enabled
        && (challenge.startsAt === null || Date.parse(challenge.startsAt) <= now)
        && (challenge.endsAt === null || now < Date.parse(challenge.endsAt))
        && wallet.challengeClaims.filter(claim => claim.challengeId === challenge.id).length
          < challenge.maxClaimsPerPlayer);
    const hasChallengePrompt = /Reply MORE|Responda MAIS/.test(notification.body);
    if (hasChallengePrompt && !challengeResults) return 'RESULTS_OBSOLETE';
    if (!standardResults && !challengeResults) return 'CHANNEL_DISABLED';
  }
  const station = state.stations[notification.stationId];
  const match = state.stationMatches[notification.matchId];
  const entry = state.stationReadyEntries[notification.readyEntryId];
  if (!station || !match || !entry || entry.playerId !== notification.playerId
    || match.stationId !== station.id || entry.stationId !== station.id) {
    return 'NOTICE_STATE_CHANGED';
  }
  if (notification.kind === 'STATION_ADMITTED') {
    return entry.status === 'ADMITTED' && match.participantReadyEntryIds.includes(entry.id)
      && station.activeMatchId === match.id && ['LOCKED', 'LAUNCHING'].includes(station.phase)
      && ['PREPARING', 'LAUNCHING'].includes(match.phase)
      ? null
      : 'ADMISSION_OBSOLETE';
  }
  if (notification.kind === 'STATION_OVERFLOW') {
    return entry.status === 'OVERFLOW' && match.overflowReadyEntryIds.includes(entry.id)
      && station.activeMatchId === match.id
      && ['LOCKED', 'LAUNCHING', 'PLAYING', 'RESULTS'].includes(station.phase)
      && ['PREPARING', 'LAUNCHING', 'PLAYING', 'COMPLETED'].includes(match.phase)
      ? null
      : 'OVERFLOW_OBSOLETE';
  }
  if (notification.kind === 'STATION_CALL_NOW') {
    if (entry.status !== 'ADMITTED' || !match.participantReadyEntryIds.includes(entry.id)
      || station.activeMatchId !== match.id || station.phase !== 'LAUNCHING'
      || match.phase !== 'LAUNCHING') {
      return 'CALL_NOW_OBSOLETE';
    }
    const locale = notification.locale.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en-US';
    const callNumber = currentVoiceNumber(config, locale, callNumberSource);
    return config.channels.voice && callNumber !== null
      && notification.templateVariables['1'] === callNumber
      ? null
      : 'VOICE_ROUTE_CHANGED';
  }
  if (notification.kind === 'STATION_RESULTS') {
    const resetAfterCompletion = state.stationControlEvents.some(event => (
      event.stationId === station.id && event.matchId === match.id && event.action === 'RESET_STATION'
      && Date.parse(event.occurredAt) >= Date.parse(notification.createdAt)
    ));
    return entry.status === 'COMPLETED' && match.phase === 'COMPLETED'
      && match.participantReadyEntryIds.includes(entry.id) && !resetAfterCompletion
      ? null
      : 'RESULTS_OBSOLETE';
  }
  return entry.status === 'READY' && match.phase === 'COMPLETED'
    && match.overflowReadyEntryIds.includes(entry.id)
    && entry.roundId !== match.roundId && station.activeRoundId === entry.roundId
    && ['RECRUITING', 'GAME_SELECTION'].includes(station.phase)
    ? null
    : 'NEXT_GAME_OBSOLETE';
}

function notificationRetryIneligibleReason(
  state: ArcadeState,
  config: ArcadeConfigSnapshot,
  notification: ArcadeOutboundNotificationRecord,
  now: number,
  deliveryEnabled: boolean,
  callNumberSource: ArcadeMessagingRuntimeOptions['callNumber'],
): string | null {
  if (notification.status !== 'FAILED') return 'NOT_FAILED';
  if (Date.parse(notification.expiresAt) <= now) return 'NOTIFICATION_EXPIRED';
  if (notification.attempts.length >= MAX_ATTEMPTS) return 'ATTEMPTS_EXHAUSTED';
  if (!deliveryEnabled || config.arcade.mode === 'off') return 'OUTBOUND_MESSAGING_DISABLED';
  return notificationSuppressionReason(state, config, notification, callNumberSource);
}

function retryEligibilityError(reason: string): ArcadeMessagingRetryError {
  if (reason === 'NOTIFICATION_EXPIRED') {
    return new ArcadeMessagingRetryError(reason, 'outbound notification has expired');
  }
  if (reason === 'ATTEMPTS_EXHAUSTED') {
    return new ArcadeMessagingRetryError(reason, 'outbound notification has no attempts remaining');
  }
  if (reason === 'OUTBOUND_MESSAGING_DISABLED') {
    return new ArcadeMessagingRetryError(reason, 'proactive outbound messaging is not effectively enabled');
  }
  if (reason === 'NOT_FAILED') {
    return new ArcadeMessagingRetryError('NOTIFICATION_NOT_RETRYABLE', 'outbound notification is not failed');
  }
  return new ArcadeMessagingRetryError('NOTIFICATION_OBSOLETE', `outbound notification is obsolete: ${reason}`);
}

function failedNotice(
  state: ArcadeState,
  config: ArcadeConfigSnapshot,
  notification: ArcadeOutboundNotificationRecord & { status: 'FAILED' },
  now: number,
  deliveryEnabled: boolean,
  callNumberSource: ArcadeMessagingRuntimeOptions['callNumber'],
): ArcadeMessagingFailedNotice {
  const lastAttempt = notification.attempts.at(-1);
  const retryIneligibleReason = notificationRetryIneligibleReason(
    state, config, notification, now, deliveryEnabled, callNumberSource,
  );
  return Object.freeze({
    notificationId: notification.id,
    kind: notification.kind,
    channel: notification.channel,
    status: 'FAILED',
    attempts: notification.attempts.length,
    maximumAttempts: MAX_ATTEMPTS,
    lastErrorCode: lastAttempt?.errorCode ?? null,
    lastErrorMessage: lastAttempt?.errorMessage ?? null,
    terminalReason: notification.terminalReason,
    updatedAt: notification.updatedAt,
    expiresAt: notification.expiresAt,
    retryEligible: retryIneligibleReason === null,
    retryIneligibleReason,
  });
}

function pruneMessagingAuditEvents(state: ArcadeState): void {
  const events = Object.values(state.messagingAuditEvents);
  if (events.length < ARCADE_STATE_MAX_MESSAGING_AUDIT_EVENTS) return;
  events.sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
    || left.id.localeCompare(right.id));
  for (const event of events.slice(0, events.length - ARCADE_STATE_MAX_MESSAGING_AUDIT_EVENTS + 1)) {
    delete state.messagingAuditEvents[event.id];
  }
}

function boundedRequired(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ArcadeMessagingRetryError('INVALID_RETRY_REQUEST', `${field} must be a non-empty bounded string`);
  }
  return value.trim();
}

function pruneAndExpire(state: ArcadeState, now: number, at: string): void {
  for (const notification of Object.values(state.outboundNotifications)) {
    if (isTerminal(notification.status)) {
      if (notification.terminalAt && Date.parse(notification.terminalAt) + TERMINAL_RETENTION_MS <= now) {
        delete state.outboundNotifications[notification.id];
      }
      continue;
    }
    if (Date.parse(notification.expiresAt) <= now) {
      state.outboundNotifications[notification.id] = terminalNotification(
        notification, 'EXPIRED', at, 'NOTIFICATION_EXPIRED',
      );
    }
  }
}

function recoverStaleClaims(state: ArcadeState, now: number, at: string): void {
  for (const notification of Object.values(state.outboundNotifications)) {
    if (notification.status !== 'SENDING') continue;
    const attempt = notification.attempts.at(-1);
    const retryAt = Date.parse(attempt?.startedAt ?? notification.updatedAt) + CLAIM_LEASE_MS;
    if (retryAt > now) continue;
    if (!attempt) continue;
    const attempts = [...notification.attempts];
    attempts[attempts.length - 1] = {
      ...attempt,
      finishedAt: attempt.finishedAt ?? at,
      errorCode: attempt.errorCode ?? 'SEND_RESULT_UNKNOWN',
      errorMessage: attempt.errorMessage ?? 'Process stopped before the provider response was persisted',
    };
    state.outboundNotifications[notification.id] = {
      ...notification,
      attempts,
      status: 'ACCEPTED',
      nextAttemptAt: null,
      terminalReason: 'AMBIGUOUS_PROVIDER_ACCEPTANCE',
      updatedAt: at,
    };
  }
}

export async function recordArcadeMessagingStatus(
  store: ArcadeStateStore,
  input: {
    notificationId: string;
    attemptId: string;
    providerMessageId: string;
    providerStatus: string;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
  clock: () => number = Date.now,
): Promise<boolean> {
  if (!/^outbound:[a-f0-9]{64}$/.test(input.notificationId)
    || input.attemptId.length > 256
    || !/^(?:SM|MM)[a-fA-F0-9]{32}$/.test(input.providerMessageId)
    || !(ARCADE_PROVIDER_MESSAGE_STATUSES as readonly string[]).includes(input.providerStatus)) {
    return false;
  }
  const at = new Date(clock()).toISOString();
  return store.transaction(state => {
    const notification = state.outboundNotifications[input.notificationId];
    if (!notification) return false;
    const attemptIndex = notification.attempts.findIndex(attempt => attempt.id === input.attemptId);
    if (attemptIndex < 0) return false;
    const attempt = notification.attempts[attemptIndex]!;
    if (attempt.providerMessageId !== null && attempt.providerMessageId !== input.providerMessageId) return false;
    const incomingStatus = input.providerStatus as ArcadeProviderMessageStatus;
    const providerStatus = mergeProviderStatus(attempt.providerStatus, incomingStatus);
    const incomingWins = attempt.providerStatus === null
      || providerStatusRank(incomingStatus) >= providerStatusRank(attempt.providerStatus);
    const delivered = incomingStatus === 'delivered' || incomingStatus === 'read';
    const incomingErrorCode = boundedNullable(input.errorCode, 64);
    const incomingErrorMessage = boundedNullable(input.errorMessage, 512);
    const attempts = [...notification.attempts];
    attempts[attemptIndex] = {
      ...attempt,
      providerMessageId: input.providerMessageId,
      providerStatus,
      callbackAt: latestTimestamp(attempt.callbackAt, at),
      errorCode: delivered ? null : incomingWins ? incomingErrorCode ?? attempt.errorCode : attempt.errorCode,
      errorMessage: delivered ? null : incomingWins ? incomingErrorMessage ?? attempt.errorMessage : attempt.errorMessage,
    };
    if (attemptIndex !== notification.attempts.length - 1
      && providerStatus !== 'delivered' && providerStatus !== 'read') {
      state.outboundNotifications[notification.id] = { ...notification, attempts, updatedAt: at };
      return true;
    }
    state.outboundNotifications[notification.id] = applyProviderStatus(
      { ...notification, attempts, updatedAt: at },
      providerStatus,
      at,
    );
    return true;
  });
}

function nextWakeAt(
  state: ArcadeState,
  now: number,
  deliveryEnabled: (notification: ArcadeOutboundNotificationRecord) => boolean,
): number | null {
  let next: number | null = null;
  for (const notification of Object.values(state.outboundNotifications)) {
    if (isTerminal(notification.status)) continue;
    let candidate = Date.parse(notification.expiresAt);
    if (notification.status === 'SENDING') {
      candidate = Date.parse(notification.attempts.at(-1)?.startedAt ?? notification.updatedAt) + CLAIM_LEASE_MS;
    } else if (notification.nextAttemptAt && deliveryEnabled(notification)) {
      candidate = Date.parse(notification.nextAttemptAt);
    }
    if (!Number.isFinite(candidate)) continue;
    candidate = Math.max(now, candidate);
    next = next === null ? candidate : Math.min(next, candidate);
  }
  return next;
}

function nextMaintenanceAt(state: ArcadeState, now: number): number | null {
  let next: number | null = null;
  for (const notification of Object.values(state.outboundNotifications)) {
    const candidate = isTerminal(notification.status)
      ? notification.terminalAt ? Date.parse(notification.terminalAt) + TERMINAL_RETENTION_MS : Number.NaN
      : Date.parse(notification.expiresAt);
    if (!Number.isFinite(candidate)) continue;
    const bounded = Math.max(now, candidate);
    next = next === null ? bounded : Math.min(next, bounded);
  }
  return next;
}

function terminalNotification(
  notification: ArcadeOutboundNotificationRecord,
  status: Extract<ArcadeOutboundNotificationStatus, 'DELIVERED' | 'FAILED' | 'EXPIRED' | 'SUPPRESSED'>,
  at: string,
  reason: string,
): ArcadeOutboundNotificationRecord {
  return {
    ...notification,
    status,
    nextAttemptAt: null,
    terminalReason: reason,
    updatedAt: at,
    terminalAt: at,
  };
}

function applyProviderStatus(
  notification: ArcadeOutboundNotificationRecord,
  status: ArcadeProviderMessageStatus,
  at: string,
): ArcadeOutboundNotificationRecord {
  if (status === 'delivered' || status === 'read') {
    return terminalNotification(notification, 'DELIVERED', at, status.toUpperCase());
  }
  if (status === 'failed' || status === 'undelivered' || status === 'canceled') {
    if (notification.status === 'DELIVERED') return notification;
    return terminalNotification(notification, 'FAILED', at, status.toUpperCase());
  }
  if (notification.status === 'DELIVERED' || notification.status === 'FAILED') return notification;
  return {
    ...notification,
    status: 'ACCEPTED',
    nextAttemptAt: null,
    terminalReason: null,
    terminalAt: null,
    updatedAt: at,
  };
}

function mergeProviderStatus(
  current: ArcadeProviderMessageStatus | null,
  incoming: ArcadeProviderMessageStatus,
): ArcadeProviderMessageStatus {
  if (current === null) return incoming;
  if (isTerminalProviderStatus(current)) return current;
  return providerStatusRank(incoming) > providerStatusRank(current) ? incoming : current;
}

function isTerminalProviderStatus(status: ArcadeProviderMessageStatus): boolean {
  return status === 'delivered' || status === 'read' || status === 'failed'
    || status === 'undelivered' || status === 'canceled';
}

function providerStatusRank(status: ArcadeProviderMessageStatus): number {
  if (status === 'accepted' || status === 'scheduled') return 10;
  if (status === 'queued') return 20;
  if (status === 'sending') return 30;
  if (status === 'sent') return 40;
  if (status === 'failed' || status === 'undelivered' || status === 'canceled') return 50;
  if (status === 'delivered') return 60;
  return 70;
}

function transportError(error: unknown): {
  retryable: boolean;
  acceptanceUnknown: boolean;
  code: string | null;
  message: string;
} {
  if (error instanceof ArcadeMessagingTransportError) {
    return {
      retryable: error.retryable,
      acceptanceUnknown: error.acceptanceUnknown,
      code: error.code,
      message: error.message.slice(0, 512),
    };
  }
  return {
    retryable: false,
    acceptanceUnknown: true,
    code: null,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
  };
}

function boundedNullable(value: string | null | undefined, maximum: number): string | null {
  const normalized = value?.trim() ?? '';
  return normalized ? normalized.slice(0, maximum) : null;
}

function latestTimestamp(left: string | null, right: string): string {
  return !left || Date.parse(right) > Date.parse(left) ? right : left;
}

function isTerminal(status: ArcadeOutboundNotificationStatus): boolean {
  return status === 'DELIVERED' || status === 'FAILED' || status === 'EXPIRED' || status === 'SUPPRESSED';
}

function emptyCounts(): Record<ArcadeOutboundNotificationStatus, number> {
  return Object.fromEntries(ARCADE_OUTBOUND_NOTIFICATION_STATUSES.map(status => [status, 0])) as
    Record<ArcadeOutboundNotificationStatus, number>;
}

function currentVoiceNumber(
  config: ArcadeConfigSnapshot,
  locale: 'en-US' | 'pt-BR',
  fallback: ((locale: 'en-US' | 'pt-BR') => string | null | undefined) | undefined,
): string | null {
  const configured = config.channels.voiceNumbers;
  if (configured['en-US'] !== null || configured['pt-BR'] !== null) return configured[locale];
  try {
    const value = fallback?.(locale)?.trim() ?? '';
    return /^\+[1-9][0-9]{7,14}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}
