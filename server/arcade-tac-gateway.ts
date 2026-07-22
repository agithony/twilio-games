import type { ConversationId, MemoryClient, TACMemoryResponse } from 'twilio-agent-connect';
import type { ArcadeMode } from '../shared/arcade-config';
import type { ArcadeConfigStore } from './arcade-config-store';
import { ARCADE_CONFIG_UPDATED_EVENT, type ArcadeEventHub } from './arcade-events';

export interface ArcadeTacClient {
  readonly memory: MemoryClient;
  setMessageHandler?(handler: ArcadeTacMessageHandler): void;
  processWebhook?(payload: unknown, idempotencyToken?: string): Promise<void>;
  shutdown(): void;
}

export interface ArcadeTacMessage {
  readonly conversationId: string;
  readonly profileId: string | null;
  readonly providerMessageId: string;
  readonly channel: 'sms' | 'whatsapp';
  readonly author: string;
  readonly message: string;
  readonly memory: TACMemoryResponse | undefined;
}

export type ArcadeTacMessageHandler = (input: ArcadeTacMessage) => Promise<string | null>;

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

/** Feature-gated TAC lifecycle for Orchestrator messaging and Conversation Memory. */
export class ArcadeTacGateway {
  private readonly configStore: ArcadeConfigStore;
  private readonly events: ArcadeEventHub;
  private readonly createClient: ArcadeTacClientFactory;
  private client: ArcadeTacClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private pendingConnection: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private operational = false;
  private mode: ArcadeMode = 'off';
  private lastError: string | null = null;
  private messageHandler: ArcadeTacMessageHandler | null = null;

  constructor(options: ArcadeTacGatewayOptions) {
    this.configStore = options.configStore;
    this.events = options.events;
    this.createClient = options.createClient ?? createDefaultTacClient;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Arcade TAC gateway cannot restart after it has stopped');
    if (this.started) return;
    await this.configStore.load();
    this.unsubscribe = this.events.subscribe(event => {
      if (event.type === ARCADE_CONFIG_UPDATED_EVENT) return this.reconcile();
    });
    this.started = true;
    try {
      await this.reconcile();
    } catch (error) {
      // Keep deterministic browser/direct-webhook fallback available. Health remains degraded and a
      // later configuration update retries the TAC connection without restarting the process.
      this.lastError = error instanceof Error ? error.message : String(error);
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
      connected: this.client !== null && this.operational,
      lastError: this.lastError,
    });
  }

  getMemoryClient(): MemoryClient | null {
    return this.operational ? this.client?.memory ?? null : null;
  }

  setMessageHandler(handler: ArcadeTacMessageHandler): void {
    this.messageHandler = handler;
    this.client?.setMessageHandler?.(handler);
  }

  ownsMessaging(): boolean {
    return this.started && this.mode !== 'off' && this.client !== null && this.operational;
  }

  async processWebhook(payload: unknown, idempotencyToken?: string): Promise<void> {
    if (!this.started || this.mode === 'off' || !this.client?.processWebhook) {
      throw new Error('TAC messaging is not connected');
    }
    try {
      await this.client.processWebhook(payload, idempotencyToken);
      this.operational = true;
      this.lastError = null;
    } catch (error) {
      this.operational = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
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
      this.operational = true;
      if (this.messageHandler) client.setMessageHandler?.(this.messageHandler);
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
    this.operational = false;
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
  const { TAC, TACConfig, SMSChannel, WhatsAppChannel } = await import('twilio-agent-connect');
  const whatsapp = process.env.TWILIO_WHATSAPP_NUMBER?.trim() ?? '';
  if (whatsapp && !whatsapp.toLowerCase().startsWith('whatsapp:')) {
    process.env.TWILIO_WHATSAPP_NUMBER = `whatsapp:${whatsapp}`;
  }
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
  const sms = new SMSChannel(tac, { memoryMode: 'always' });
  const whatsappChannel = process.env.TWILIO_WHATSAPP_NUMBER
    ? new WhatsAppChannel(tac, { memoryMode: 'always' })
    : null;
  tac.registerChannel(sms);
  if (whatsappChannel) tac.registerChannel(whatsappChannel);
  let handler: ArcadeTacMessageHandler | null = null;
  const inFlight = new Set<Promise<void>>();
  const callbackFailures: unknown[] = [];
  tac.onMessageReady(async ({
    conversationId, profileId, message, author, memory: recalled, session, channel,
  }) => {
    if ((channel !== 'sms' && channel !== 'whatsapp') || !handler) return null;
    // Orchestrator channelId is the original SMS/WhatsApp provider SID. Prefer it so a direct
    // signed-webhook fallback and a later Orchestrator retry share one durable idempotency key.
    const channelId = String(session.metadata.channelId ?? '');
    const providerMessageId = /^(?:SM|MM)[a-f0-9]{32}$/i.test(channelId)
      ? channelId
      : String(session.metadata.lastCommunicationId ?? conversationId);
    const task = (async () => {
      const response = await handler!({
        conversationId: String(conversationId),
        profileId: profileId ? String(profileId) : null,
        providerMessageId,
        channel,
        author,
        message,
        memory: recalled,
      });
      if (response) {
        const responseChannel = channel === 'whatsapp' ? whatsappChannel : sms;
        if (!responseChannel) throw new Error('TAC WhatsApp channel is not configured');
        await responseChannel.sendResponse(conversationId, response);
      }
    })();
    inFlight.add(task);
    try {
      await task;
    } catch (error) {
      callbackFailures.push(error);
      throw error;
    } finally {
      inFlight.delete(task);
    }
    // Responses are sent explicitly above so callback and delivery failures can reach the webhook.
    return null;
  });
  let webhookQueue = Promise.resolve();
  const processWebhook = async (payload: unknown): Promise<void> => {
    callbackFailures.length = 0;
    const input = payload as {
      eventType?: unknown;
      data?: {
        id?: unknown;
        conversationId?: unknown;
        author?: { channel?: unknown };
        recipients?: Array<{ channel?: unknown }>;
      };
    };
    const channel = String(input.data?.author?.channel
      ?? input.data?.recipients?.[0]?.channel ?? '').toLowerCase();
    if (channel === 'whatsapp') {
      if (!whatsappChannel) throw new Error('TAC WhatsApp channel is not configured');
      await whatsappChannel.processWebhook(payload);
    } else if (channel === 'sms') {
      await sms.processWebhook(payload);
    } else {
      // Conversation lifecycle events can omit a channel; both channels safely filter by payload.
      await sms.processWebhook(payload);
      if (whatsappChannel) await whatsappChannel.processWebhook(payload);
    }
    await Promise.allSettled([...inFlight]);
    const failure = callbackFailures.shift();
    callbackFailures.length = 0;
    if (failure) {
      // The SDK records lastCommunicationId before invoking the application callback. Clear it on
      // failure so Twilio's retry can replay the durable handler/send instead of being skipped.
      if (input.eventType === 'COMMUNICATION_CREATED') {
        const conversationId = String(input.data?.conversationId ?? '');
        const communicationId = String(input.data?.id ?? '');
        for (const candidate of [sms, whatsappChannel].filter(Boolean)) {
          const session = candidate!.getConversationSession(conversationId as ConversationId);
          if (session?.metadata.lastCommunicationId === communicationId) {
            delete session.metadata.lastCommunicationId;
          }
        }
      }
      throw failure;
    }
  };
  return {
    memory,
    setMessageHandler: next => { handler = next; },
    processWebhook: (payload, _idempotencyToken) => {
      const run = webhookQueue.then(
        () => processWebhook(payload),
        () => processWebhook(payload),
      );
      webhookQueue = run.catch(() => undefined);
      return run;
    },
    shutdown: () => tac.shutdown(),
  };
}
