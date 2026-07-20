import type { MemoryClient } from 'twilio-agent-connect';
import type { ArcadeMode } from '../shared/arcade-config';
import type { ArcadeConfigStore } from './arcade-config-store';
import type { ArcadeEventHub } from './arcade-events';

export interface ArcadeTacClient {
  readonly memory: MemoryClient;
  shutdown(): void;
}

export type ArcadeTacClientFactory = () => Promise<ArcadeTacClient>;

export type ArcadeTacGatewayStatus = Readonly<{
  started: boolean;
  mode: ArcadeMode;
  connected: boolean;
  lastError: string | null;
}>;

export interface ArcadeTacGatewayOptions {
  readonly configStore: ArcadeConfigStore;
  readonly events: ArcadeEventHub;
  readonly createClient?: ArcadeTacClientFactory;
}

/**
 * Feature-gated TAC lifecycle. It initializes Orchestrator/Memory only and intentionally does not
 * register Voice or Messaging channels, so current Conversation Relay and SMS traffic stay intact.
 */
export class ArcadeTacGateway {
  private readonly configStore: ArcadeConfigStore;
  private readonly events: ArcadeEventHub;
  private readonly createClient: ArcadeTacClientFactory;
  private client: ArcadeTacClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private pendingConnection: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private mode: ArcadeMode = 'off';
  private lastError: string | null = null;

  constructor(options: ArcadeTacGatewayOptions) {
    this.configStore = options.configStore;
    this.events = options.events;
    this.createClient = options.createClient ?? createDefaultTacClient;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Arcade TAC gateway cannot restart after it has stopped');
    if (this.started) return;
    await this.configStore.load();
    this.unsubscribe = this.events.subscribe(() => this.reconcile());
    this.started = true;
    try {
      await this.reconcile();
    } catch (error) {
      this.unsubscribe();
      this.unsubscribe = null;
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lastError = this.disconnect();
    this.started = false;
  }

  getStatus(): ArcadeTacGatewayStatus {
    return Object.freeze({
      started: this.started,
      mode: this.mode,
      connected: this.client !== null,
      lastError: this.lastError,
    });
  }

  getMemoryClient(): MemoryClient | null {
    return this.client?.memory ?? null;
  }

  private reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // ConfigStore publishes synchronously after replacing its snapshot, so mode-off is observed
    // before an in-flight TAC promise can attach a newly-created client.
    this.mode = this.configStore.getSnapshot().arcade.mode;
    if (this.mode === 'off') {
      this.lastError = this.disconnect();
      return Promise.resolve();
    }
    if (this.client) {
      this.lastError = null;
      return Promise.resolve();
    }
    return this.pendingConnection ?? this.connect();
  }

  private connect(): Promise<void> {
    const connection = this.createClient().then(client => {
      if (this.stopped || this.mode === 'off') {
        try { client.shutdown(); } catch { /* Shutdown is best-effort after cancellation. */ }
        return;
      }
      this.client = client;
      this.lastError = null;
    }).catch(error => {
      if (!this.stopped && this.mode !== 'off') {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }).finally(() => {
      if (this.pendingConnection === connection) this.pendingConnection = null;
    });
    this.pendingConnection = connection;
    // Event subscribers observe the returned rejection; this guard also covers shutdown races.
    void connection.catch(() => undefined);
    return connection;
  }

  private disconnect(): string | null {
    const client = this.client;
    this.client = null;
    if (!client) return null;
    try {
      client.shutdown();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

async function createDefaultTacClient(): Promise<ArcadeTacClient> {
  const { TAC, TACConfig } = await import('twilio-agent-connect');
  const config = TACConfig.fromEnv();
  if (!config.isOrchestratorEnabled()) {
    throw new Error('TWILIO_CONVERSATION_CONFIGURATION_ID is required for Arcade TAC Memory');
  }
  const tac = await TAC.create({ config });
  const memory = tac.getMemoryClient();
  if (!memory) {
    tac.shutdown();
    throw new Error('TAC initialized without Conversation Memory');
  }
  return { memory, shutdown: () => tac.shutdown() };
}
