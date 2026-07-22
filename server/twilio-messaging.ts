import twilio from 'twilio';
import {
  ARCADE_PROVIDER_MESSAGE_STATUSES,
  type ArcadeProviderMessageStatus,
} from './arcade-state-store';
import {
  ArcadeMessagingTransportError,
  type ArcadeMessagingTransport,
} from './arcade-messaging-runtime';

export interface TwilioMessagingTransportOptions {
  readonly accountSid: string | undefined;
  readonly apiKey: string | undefined;
  readonly apiSecret: string | undefined;
  readonly smsFrom: string | undefined;
  readonly whatsappFrom: string | undefined;
  readonly messagingServiceSid?: string | undefined;
}

export class TwilioMessagingTransport implements ArcadeMessagingTransport {
  private readonly client: ReturnType<typeof twilio>;
  private readonly smsFrom: string | null;
  private readonly whatsappFrom: string | null;
  private readonly messagingServiceSid: string | null;

  constructor(options: TwilioMessagingTransportOptions) {
    const accountSid = credential(options.accountSid, 'TWILIO_ACCOUNT_SID', /^AC[a-fA-F0-9]{32}$/);
    const apiKey = credential(options.apiKey, 'TWILIO_API_KEY', /^SK[a-fA-F0-9]{32}$/);
    const apiSecret = credential(options.apiSecret, 'TWILIO_API_SECRET');
    this.smsFrom = optionalSender(options.smsFrom, 'TWILIO_PHONE_NUMBER');
    this.whatsappFrom = optionalSender(options.whatsappFrom, 'TWILIO_WHATSAPP_NUMBER');
    this.messagingServiceSid = optionalCredential(
      options.messagingServiceSid,
      'TWILIO_MESSAGING_SERVICE_SID',
      /^MG[a-fA-F0-9]{32}$/,
    );
    this.client = twilio(apiKey, apiSecret, {
      accountSid,
      autoRetry: false,
      timeout: 10_000,
    });
  }

  async send(input: Parameters<ArcadeMessagingTransport['send']>[0]): Promise<{
    providerMessageId: string;
    status: ArcadeProviderMessageStatus;
  }> {
    try {
      const message = input.channel === 'sms'
        ? await this.client.messages.create({
          to: input.to,
          from: this.smsFrom ?? missingSmsSender(),
          body: requireBody(input.body),
          statusCallback: input.statusCallback,
          validityPeriod: input.validityPeriodSeconds,
          smartEncoded: true,
        })
        : await this.sendWhatsApp(input);
      if (!(ARCADE_PROVIDER_MESSAGE_STATUSES as readonly string[]).includes(message.status)) {
        throw new ArcadeMessagingTransportError(`Twilio returned unsupported status ${message.status}`, false);
      }
      return {
        providerMessageId: message.sid,
        status: message.status as ArcadeProviderMessageStatus,
      };
    } catch (error) {
      if (error instanceof ArcadeMessagingTransportError) throw error;
      const value = error as { status?: unknown; code?: unknown; message?: unknown };
      const status = typeof value.status === 'number' ? value.status : null;
      const code = typeof value.code === 'number' || typeof value.code === 'string'
        ? String(value.code)
        : null;
      const message = typeof value.message === 'string' ? value.message : 'Twilio message request failed';
      throw new ArcadeMessagingTransportError(
        message,
        status === null || status === 429 || status >= 500,
        code,
        status === null,
      );
    }
  }

  private async sendWhatsApp(input: Parameters<ArcadeMessagingTransport['send']>[0]) {
    if (!this.whatsappFrom) {
      throw new ArcadeMessagingTransportError('TWILIO_WHATSAPP_NUMBER is required for WhatsApp delivery', false);
    }
    if (input.contentSid) {
      if (!this.messagingServiceSid) {
        throw new ArcadeMessagingTransportError(
          'TWILIO_MESSAGING_SERVICE_SID is required for WhatsApp templates',
          false,
        );
      }
      return this.client.messages.create({
        to: input.to,
        from: `whatsapp:${this.whatsappFrom}`,
        messagingServiceSid: this.messagingServiceSid,
        contentSid: input.contentSid,
        contentVariables: JSON.stringify(input.contentVariables ?? {}),
        statusCallback: input.statusCallback,
        validityPeriod: input.validityPeriodSeconds,
      });
    }
    return this.client.messages.create({
      to: input.to,
      from: `whatsapp:${this.whatsappFrom}`,
      body: requireBody(input.body),
      statusCallback: input.statusCallback,
      validityPeriod: input.validityPeriodSeconds,
    });
  }
}

function requireBody(value: string | undefined): string {
  if (!value) throw new ArcadeMessagingTransportError('message body is required', false);
  return value;
}

function credential(value: string | undefined, name: string, pattern?: RegExp): string {
  const normalized = value?.trim() ?? '';
  if (!normalized || normalized === 'disabled' || (pattern && !pattern.test(normalized))) {
    throw new ArcadeMessagingTransportError(`${name} is not configured`, false);
  }
  return normalized;
}

function optionalCredential(
  value: string | undefined,
  name: string,
  pattern: RegExp,
): string | null {
  const normalized = value?.trim() ?? '';
  if (!normalized || normalized === 'disabled') return null;
  if (!pattern.test(normalized)) throw new ArcadeMessagingTransportError(`${name} is invalid`, false);
  return normalized;
}

function optionalSender(value: string | undefined, name: string): string | null {
  const normalized = (value?.trim() ?? '').replace(/^whatsapp:/i, '');
  if (!normalized || normalized === 'disabled') return null;
  if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) {
    throw new ArcadeMessagingTransportError(`${name} is invalid`, false);
  }
  return normalized;
}

function missingSmsSender(): never {
  throw new ArcadeMessagingTransportError('TWILIO_PHONE_NUMBER is required for SMS delivery', false);
}
