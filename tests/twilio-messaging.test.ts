import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  clientFactory: vi.fn(),
}));

vi.mock('twilio', () => ({
  default: mocks.clientFactory,
}));

import { ArcadeMessagingTransportError } from '../server/arcade-messaging-runtime';
import { TwilioMessagingTransport } from '../server/twilio-messaging';

const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const API_KEY = `SK${'b'.repeat(32)}`;
const API_SECRET = 'api-secret';
const MESSAGE_SID = `SM${'c'.repeat(32)}`;
const CONTENT_SID = `HX${'d'.repeat(32)}`;
const SERVICE_SID = `MG${'e'.repeat(32)}`;

beforeEach(() => {
  mocks.create.mockReset();
  mocks.clientFactory.mockReset();
  mocks.clientFactory.mockReturnValue({ messages: { create: mocks.create } });
});

function transport() {
  return new TwilioMessagingTransport({
    accountSid: ACCOUNT_SID,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    smsFrom: '+14155550100',
    whatsappFrom: 'whatsapp:+14155550101',
    messagingServiceSid: SERVICE_SID,
  });
}

describe('TwilioMessagingTransport', () => {
  it('uses API-key auth, disables SDK retries, and maps SMS creation', async () => {
    mocks.create.mockResolvedValue({ sid: MESSAGE_SID, status: 'queued' });
    const client = transport();
    expect(mocks.clientFactory).toHaveBeenCalledWith(API_KEY, API_SECRET, {
      accountSid: ACCOUNT_SID,
      autoRetry: false,
      timeout: 10_000,
    });
    await expect(client.send({
      channel: 'sms',
      to: '+14155550199',
      body: 'You are admitted.',
      statusCallback: 'https://arcade.example/status?n=one',
      validityPeriodSeconds: 300,
    })).resolves.toEqual({ providerMessageId: MESSAGE_SID, status: 'queued' });
    expect(mocks.create).toHaveBeenCalledWith({
      to: '+14155550199',
      from: '+14155550100',
      body: 'You are admitted.',
      statusCallback: 'https://arcade.example/status?n=one',
      validityPeriod: 300,
      smartEncoded: true,
    });
  });

  it('uses a Messaging Service and omits body for WhatsApp templates', async () => {
    mocks.create.mockResolvedValue({ sid: MESSAGE_SID, status: 'accepted' });
    const client = transport();
    await client.send({
      channel: 'whatsapp',
      to: 'whatsapp:+14155550199',
      contentSid: CONTENT_SID,
      contentVariables: { '1': 'Voice Racer' },
      statusCallback: 'https://arcade.example/status?n=two',
      validityPeriodSeconds: 600,
    });
    expect(mocks.create).toHaveBeenCalledWith({
      to: 'whatsapp:+14155550199',
      from: 'whatsapp:+14155550101',
      messagingServiceSid: SERVICE_SID,
      contentSid: CONTENT_SID,
      contentVariables: JSON.stringify({ '1': 'Voice Racer' }),
      statusCallback: 'https://arcade.example/status?n=two',
      validityPeriod: 600,
    });
  });

  it('classifies Twilio 4xx errors as permanent and 429/5xx as retryable', async () => {
    const client = transport();
    mocks.create.mockRejectedValueOnce(Object.assign(new Error('bad destination'), { status: 400, code: 21211 }));
    await expect(client.send({
      channel: 'sms', to: '+14155550199', body: 'test',
      statusCallback: 'https://arcade.example/status', validityPeriodSeconds: 60,
    })).rejects.toEqual(expect.objectContaining<Partial<ArcadeMessagingTransportError>>({
      retryable: false, code: '21211',
    }));
    mocks.create.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429, code: 20429 }));
    await expect(client.send({
      channel: 'sms', to: '+14155550199', body: 'test',
      statusCallback: 'https://arcade.example/status', validityPeriodSeconds: 60,
    })).rejects.toEqual(expect.objectContaining<Partial<ArcadeMessagingTransportError>>({
      retryable: true, code: '20429',
    }));
  });
});
