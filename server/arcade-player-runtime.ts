import { hkdfSync, randomUUID } from 'node:crypto';
import type { ArcadeMode } from '../shared/arcade-config';
import type { ArcadeConfigStore } from './arcade-config-store';
import type { ArcadeEventHub } from './arcade-events';
import { ArcadePlayerSessionService } from './arcade-player-session';
import { ArcadeChallengeTokenService } from './arcade-challenge-token';
import { ArcadeService } from './arcade-service';
import { ArcadeStateStore } from './arcade-state-store';

const ROOT_SECRET_PATTERN = /^[a-fA-F0-9]{64}$/;
const DERIVATION_SALT = Buffer.from('twilio-arcade-signing-v1', 'utf8');

export type ArcadePlayerRuntimeResources = Readonly<{
  store: ArcadeStateStore;
  service: ArcadeService;
  sessions: ArcadePlayerSessionService;
  challenges: ArcadeChallengeTokenService;
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
}

export class ArcadePlayerRuntimeError extends Error {
  constructor(readonly code: 'MODE_DISABLED' | 'STATE_UNAVAILABLE', message: string) {
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
  private readonly secureCookies: boolean;
  private readonly production: boolean;
  private readonly openStateStore: (file: string) => Promise<ArcadeStateStore>;
  private resources: ArcadePlayerRuntimeResources | null = null;
  private pending: Promise<ArcadePlayerRuntimeResources> | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private stopped = false;
  private mode: ArcadeMode = 'off';
  private degraded = false;
  private observedConfigVersion = 0;
  private failedConfigVersion: number | null = null;

  constructor(options: ArcadePlayerRuntimeOptions) {
    this.configStore = options.configStore;
    this.events = options.events;
    this.stateFile = options.stateFile;
    this.signingSecret = options.signingSecret;
    this.production = options.production ?? process.env.NODE_ENV === 'production';
    this.secureCookies = new URL(options.publicBaseUrl).protocol === 'https:';
    this.openStateStore = options.openStateStore ?? (file => ArcadeStateStore.open(file));
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Arcade player runtime cannot restart after it has stopped');
    if (this.started) return;
    await this.configStore.load();
    this.unsubscribe = this.events.subscribe(() => this.reconcile());
    this.started = true;
    await this.reconcile();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.pending?.catch(() => undefined);
    await this.resources?.store.flush();
    this.started = false;
  }

  async getActive(): Promise<ArcadePlayerRuntimeResources> {
    this.observeMode();
    const currentMode = this.mode as ArcadeMode;
    if (currentMode === 'off') {
      throw new ArcadePlayerRuntimeError('MODE_DISABLED', 'Arcade mode is off');
    }
    let resources: ArcadePlayerRuntimeResources;
    try {
      resources = this.resources ?? await this.initialize();
    } catch {
      throw new ArcadePlayerRuntimeError('STATE_UNAVAILABLE', 'Arcade player state is unavailable');
    }
    this.observeMode();
    const refreshedMode = this.mode as ArcadeMode;
    if (refreshedMode === 'off') {
      throw new ArcadePlayerRuntimeError('MODE_DISABLED', 'Arcade mode is off');
    }
    return resources;
  }

  async getForCleanup(): Promise<ArcadePlayerRuntimeResources> {
    this.observeMode();
    if (this.mode !== 'off') return this.getActive();
    if (this.resources) return this.resources;
    try {
      return await this.initialize();
    } catch {
      throw new ArcadePlayerRuntimeError('STATE_UNAVAILABLE', 'Arcade player state is unavailable');
    }
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
      return Promise.reject(new Error('Arcade player runtime initialization is degraded'));
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
      throw new Error('Arcade player sessions require an HTTPS PUBLIC_BASE_URL in production');
    }
    const root = Buffer.from(encodedSecret, 'hex');
    const sessionSecret = deriveSecret(root, 'player-session');
    const challengeSecret = deriveSecret(root, 'challenge-token');
    const store = await this.openStateStore(this.stateFile);
    const operatorMarker = Object.freeze({});
    const service = new ArcadeService({
      store,
      config: () => this.configStore.getSnapshot(),
      clock: () => Date.now(),
      idGenerator: kind => `${kind}:${randomUUID()}`,
      challengeTokenSecret: challengeSecret,
      operatorAuthorizer: authorization => {
        const value = authorization as { marker?: unknown; subject?: unknown } | null;
        return value?.marker === operatorMarker && typeof value.subject === 'string'
          ? { kind: 'operator', subject: value.subject }
          : null;
      },
    });
    const sessions = new ArcadePlayerSessionService(sessionSecret, {
      secureCookies: this.secureCookies,
    });
    const challenges = new ArcadeChallengeTokenService(challengeSecret);
    const operatorAuthorization = (subject: string) => Object.freeze({ marker: operatorMarker, subject });
    return Object.freeze({ store, service, sessions, challenges, operatorAuthorization });
  }
}

function deriveSecret(root: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', root, DERIVATION_SALT, Buffer.from(label, 'utf8'), 32));
}
