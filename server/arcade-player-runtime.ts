import { hkdfSync, randomUUID } from 'node:crypto';
import type { ArcadeMode } from '../shared/arcade-config';
import type { PlayableArcadeGame } from '../shared/arcade-games';
import type { ArcadeConfigStore } from './arcade-config-store';
import {
  ARCADE_CONFIG_UPDATED_EVENT,
  createArcadeStationUpdatedEvent,
  type ArcadeEventHub,
} from './arcade-events';
import { ArcadePlayerSessionService } from './arcade-player-session';
import { ArcadeChallengeTokenService } from './arcade-challenge-token';
import { ArcadeService } from './arcade-service';
import { ArcadeStateStore, type ArcadeStationNotificationKind } from './arcade-state-store';
import { ArcadeStationRuntime } from './arcade-station-runtime';
import {
  ArcadeMessagingRuntime,
  type ArcadeMessagingRuntimeStatus,
  type ArcadeMessagingTransport,
} from './arcade-messaging-runtime';

const ROOT_SECRET_PATTERN = /^[a-fA-F0-9]{64}$/;
const DERIVATION_SALT = Buffer.from('twilio-arcade-signing-v1', 'utf8');

export type ArcadePlayerRuntimeResources = Readonly<{
  store: ArcadeStateStore;
  service: ArcadeService;
  sessions: ArcadePlayerSessionService;
  challenges: ArcadeChallengeTokenService;
  station: ArcadeStationRuntime;
  messaging: ArcadeMessagingRuntime;
  operatorAuthorization: (subject: string) => unknown;
}>;

export type ArcadePlayerRuntimeStatus = Readonly<{
  started: boolean;
  mode: ArcadeMode;
  initialized: boolean;
  degraded: boolean;
  reason: 'INITIALIZATION_FAILED' | null;
}>;

export interface ArcadePlayerRuntimeOptions {
  readonly configStore: ArcadeConfigStore;
  readonly events: ArcadeEventHub;
  readonly stateFile: string;
  readonly publicBaseUrl: string;
  readonly signingSecret: () => string | undefined;
  readonly production?: boolean;
  readonly openStateStore?: (file: string) => Promise<ArcadeStateStore>;
  readonly outboundMessaging?: ArcadePlayerRuntimeMessagingOptions;
}

export interface ArcadePlayerRuntimeMessagingOptions {
  readonly enabled: () => boolean;
  readonly createTransport: () => ArcadeMessagingTransport;
  readonly callNumber?: (locale: 'en-US' | 'pt-BR') => string | null | undefined;
  readonly whatsappContentSid?: (
    kind: ArcadeStationNotificationKind,
    locale: 'en-US' | 'pt-BR',
  ) => string | null | undefined;
}

export class ArcadePlayerRuntimeError extends Error {
  constructor(
    readonly code: 'MODE_DISABLED' | 'STATE_UNAVAILABLE' | 'CONFIG_DEGRADED',
    message: string,
  ) {
    super(message);
    this.name = 'ArcadePlayerRuntimeError';
  }
}

/** Lazily opens PII-bearing player state only after durable runtime configuration enables Arcade. */
export class ArcadePlayerRuntime {
  private readonly configStore: ArcadeConfigStore;
  private readonly events: ArcadeEventHub;
  private readonly stateFile: string;
  private readonly signingSecret: () => string | undefined;
  private readonly publicBaseUrl: string;
  private readonly secureCookies: boolean;
  private readonly production: boolean;
  private readonly openStateStore: (file: string) => Promise<ArcadeStateStore>;
  private readonly outboundMessaging?: ArcadePlayerRuntimeMessagingOptions;
  private resources: ArcadePlayerRuntimeResources | null = null;
  private pending: Promise<ArcadePlayerRuntimeResources> | null = null;
  private cleanupStore: ArcadeStateStore | null = null;
  private cleanupStorePending: Promise<ArcadeStateStore> | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private stopped = false;
  private mode: ArcadeMode = 'off';
  private degraded = false;
  private observedConfigVersion = 0;
  private failedConfigVersion: number | null = null;
  private messagingActivated = false;
  private stationMatchRemoved: ((game: PlayableArcadeGame, roomCode: string) => void) | null = null;

  constructor(options: ArcadePlayerRuntimeOptions) {
    this.configStore = options.configStore;
    this.events = options.events;
    this.stateFile = options.stateFile;
    this.signingSecret = options.signingSecret;
    this.publicBaseUrl = options.publicBaseUrl;
    this.production = options.production ?? process.env.NODE_ENV === 'production';
    this.secureCookies = new URL(options.publicBaseUrl).protocol === 'https:';
    this.openStateStore = options.openStateStore ?? (file => ArcadeStateStore.open(file));
    this.outboundMessaging = options.outboundMessaging;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Twilio Games player runtime cannot restart after it has stopped');
    if (this.started) return;
    await this.configStore.load();
    this.unsubscribe = this.events.subscribe(event => {
      if (event.type === ARCADE_CONFIG_UPDATED_EVENT) return this.reconcile();
    });
    this.started = true;
    await this.reconcile();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.pending?.catch(() => undefined);
    await this.resources?.messaging.stop();
    await this.resources?.station.stop();
    await (this.resources?.store ?? this.cleanupStore)?.flush();
    this.started = false;
  }

  async getActive(): Promise<ArcadePlayerRuntimeResources> {
    this.observeMode();
    if (this.configStore.getStatus().degraded) {
      throw new ArcadePlayerRuntimeError(
        'CONFIG_DEGRADED',
        'arcade config integrity is degraded; new activity is disabled',
      );
    }
    const currentMode = this.mode as ArcadeMode;
    if (currentMode === 'off') {
      throw new ArcadePlayerRuntimeError('MODE_DISABLED', 'station mode is off');
    }
    let resources: ArcadePlayerRuntimeResources;
    try {
      resources = this.resources ?? await this.initialize();
    } catch {
      throw new ArcadePlayerRuntimeError('STATE_UNAVAILABLE', 'Twilio Games player state is unavailable');
    }
    this.observeMode();
    if (this.configStore.getStatus().degraded) {
      throw new ArcadePlayerRuntimeError(
        'CONFIG_DEGRADED',
        'arcade config integrity is degraded; new activity is disabled',
      );
    }
    const refreshedMode = this.mode as ArcadeMode;
    if (refreshedMode === 'off') {
      throw new ArcadePlayerRuntimeError('MODE_DISABLED', 'station mode is off');
    }
    return resources;
  }

  async getForCleanup(): Promise<ArcadePlayerRuntimeResources> {
    this.observeMode();
    if (this.resources) return this.resources;
    try {
      return await this.initialize();
    } catch {
      throw new ArcadePlayerRuntimeError('STATE_UNAVAILABLE', 'Twilio Games player state is unavailable');
    }
  }

  getInitializedResources(): ArcadePlayerRuntimeResources | null {
    return this.resources;
  }

  async getStateStoreForCleanup(): Promise<ArcadeStateStore> {
    if (this.resources) return this.resources.store;
    if (this.cleanupStore) return this.cleanupStore;
    if (this.cleanupStorePending) return this.cleanupStorePending;
    const task = this.openStateStore(this.stateFile).then(store => {
      this.cleanupStore = store;
      return store;
    }).finally(() => {
      if (this.cleanupStorePending === task) this.cleanupStorePending = null;
    });
    this.cleanupStorePending = task;
    return task;
  }

  getStatus(): ArcadePlayerRuntimeStatus {
    this.observeMode();
    return Object.freeze({
      started: this.started,
      mode: this.mode,
      initialized: this.resources !== null,
      degraded: this.degraded,
      reason: this.degraded ? 'INITIALIZATION_FAILED' : null,
    });
  }

  getMessagingStatus(): ArcadeMessagingRuntimeStatus | null {
    return this.resources?.messaging.getStatus() ?? null;
  }

  async activateMessagingDelivery(): Promise<void> {
    if (this.stopped) return;
    this.messagingActivated = true;
    await this.resources?.messaging.start();
  }

  setStationMatchRemovedHandler(
    handler: (game: PlayableArcadeGame, roomCode: string) => void,
  ): void {
    this.stationMatchRemoved = handler;
    this.resources?.station.setMatchRemovedHandler(handler);
  }

  newPlayerId(): string {
    return `player:${randomUUID()}`;
  }

  private observeMode(): void {
    const config = this.configStore.getSnapshot();
    this.mode = config.arcade.mode;
    if (config.version !== this.observedConfigVersion) {
      this.observedConfigVersion = config.version;
      if (this.failedConfigVersion !== config.version) {
        this.failedConfigVersion = null;
        this.degraded = false;
      }
    }
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    this.observeMode();
    if (this.mode === 'off' || this.resources) return;
    await this.initialize().catch(() => undefined);
  }

  private initialize(): Promise<ArcadePlayerRuntimeResources> {
    if (this.resources) return Promise.resolve(this.resources);
    if (this.pending) return this.pending;
    const configVersion = this.configStore.getSnapshot().version;
    if (this.failedConfigVersion === configVersion) {
      return Promise.reject(new Error('Twilio Games player runtime initialization is degraded'));
    }
    const task = this.createResources().then(resources => {
      this.resources = resources;
      this.degraded = false;
      this.failedConfigVersion = null;
      return resources;
    }).catch(error => {
      this.degraded = true;
      this.failedConfigVersion = configVersion;
      throw error;
    }).finally(() => {
      if (this.pending === task) this.pending = null;
    });
    this.pending = task;
    void task.catch(() => undefined);
    return task;
  }

  private async createResources(): Promise<ArcadePlayerRuntimeResources> {
    const encodedSecret = this.signingSecret()?.trim() ?? '';
    if (!ROOT_SECRET_PATTERN.test(encodedSecret)) {
      throw new Error('ARCADE_SIGNING_SECRET must contain exactly 64 hexadecimal characters');
    }
    if (this.production && !this.secureCookies) {
      throw new Error('Twilio Games player sessions require an HTTPS PUBLIC_BASE_URL in production');
    }
    const root = Buffer.from(encodedSecret, 'hex');
    const sessionSecret = deriveSecret(root, 'player-session');
    const challengeSecret = deriveSecret(root, 'challenge-token');
    const roomCodeSecret = deriveSecret(root, 'engine-room').toString('hex');
    const store = await this.getStateStoreForCleanup();
    const operatorMarker = Object.freeze({});
    const service = new ArcadeService({
      store,
      config: () => this.configStore.getSnapshot(),
      clock: () => Date.now(),
      idGenerator: kind => `${kind}:${randomUUID()}`,
      challengeTokenSecret: challengeSecret,
      operatorAuthorizer: authorization => {
        const value = authorization as { marker?: unknown; subject?: unknown; kind?: unknown } | null;
        return value?.marker === operatorMarker && typeof value.subject === 'string'
          && (value.kind === 'operator' || value.kind === 'system')
          ? { kind: value.kind, subject: value.subject }
          : null;
      },
      stationUpdated: revision => this.events.publish(createArcadeStationUpdatedEvent(revision)),
      stationNotifications: this.outboundMessaging ? {
        enabled: this.outboundMessaging.enabled,
        callNumber: this.outboundMessaging.callNumber,
        whatsappContentSid: this.outboundMessaging.whatsappContentSid,
      } : undefined,
      newMutationsAllowed: () => !this.configStore.getStatus().degraded,
    });
    const sessions = new ArcadePlayerSessionService(sessionSecret, {
      secureCookies: this.secureCookies,
    });
    const challenges = new ArcadeChallengeTokenService(challengeSecret);
    const operatorAuthorization = (subject: string) => Object.freeze({
      marker: operatorMarker, subject, kind: 'operator',
    });
    const systemAuthorization = () => Object.freeze({
      marker: operatorMarker, subject: 'station-runtime', kind: 'system',
    });
    const station = new ArcadeStationRuntime({
      service,
      events: this.events,
      stationId: () => this.configStore.getSnapshot().arcade.cabinetId,
      systemAuthorization,
      enabled: () => this.configStore.getSnapshot().arcade.mode !== 'off',
      config: () => this.configStore.getSnapshot(),
      roomCodeSecret: () => roomCodeSecret,
      onMatchRemoved: (game, roomCode) => this.stationMatchRemoved?.(game, roomCode),
    });
    const messaging = new ArcadeMessagingRuntime({
      store,
      config: () => this.configStore.getSnapshot(),
      events: this.events,
      publicBaseUrl: this.publicBaseUrl,
      enabled: this.outboundMessaging?.enabled ?? (() => false),
      callNumber: this.outboundMessaging?.callNumber,
      createTransport: this.outboundMessaging?.createTransport ?? (() => {
        throw new Error('Twilio Games outbound messaging is not configured');
      }),
      onError: error => {
        console.error('[arcade-messaging] delivery failed:', error instanceof Error ? error.message : String(error));
      },
    });
    try {
      if (this.messagingActivated) await messaging.start();
      await station.start();
    } catch (error) {
      await messaging.stop();
      await station.stop();
      throw error;
    }
    return Object.freeze({ store, service, sessions, challenges, station, messaging, operatorAuthorization });
  }
}

function deriveSecret(root: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', root, DERIVATION_SALT, Buffer.from(label, 'utf8'), 32));
}
