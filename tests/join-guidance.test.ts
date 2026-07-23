import { describe, expect, it } from 'vitest';
import { buildJoinGuidance } from '../client/join/guidance';

const base = {
  portuguese: false,
  mode: 'coin_only' as const,
  termsRequired: false,
  freePlay: false,
};

describe('join guidance', () => {
  it('names only the messaging channels that are actually available', () => {
    const sms = buildJoinGuidance({ ...base, sms: true, whatsapp: false });
    expect(sms.intro).toBe('Send JOIN by SMS.');
    expect(sms.intro).not.toContain('WhatsApp');

    const whatsapp = buildJoinGuidance({ ...base, sms: false, whatsapp: true });
    expect(whatsapp.intro).toBe('Send JOIN by WhatsApp.');
    expect(whatsapp.intro).not.toContain('SMS');

    const both = buildJoinGuidance({ ...base, sms: true, whatsapp: true });
    expect(both.intro).toBe('Send JOIN by SMS or WhatsApp.');
  });

  it('keeps browser-only guidance free of unavailable messaging channels', () => {
    const guidance = buildJoinGuidance({ ...base, mode: 'lead_capture', sms: false, whatsapp: false });
    expect(guidance.messaging).toBe(false);
    expect(guidance.intro).toBe('Register in your browser to join.');
    expect(guidance.intro).not.toMatch(/SMS|WhatsApp/);
  });

  it('explains browser plus messaging without changing the short command', () => {
    const guidance = buildJoinGuidance({ ...base, mode: 'lead_capture', sms: true, whatsapp: false });
    expect(guidance.messaging).toBe(true);
    expect(guidance.command).toBe('JOIN');
    expect(guidance.intro).toBe('Register in your browser or send JOIN by SMS.');
    expect(guidance.channelDetail).toBe('Opens JOIN prefilled; just tap Send');
  });

  it('localizes the concise channel subtitle', () => {
    const guidance = buildJoinGuidance({ ...base, portuguese: true, sms: false, whatsapp: true, termsRequired: true });
    expect(guidance.command).toBe('ENTRAR');
    expect(guidance.intro).toBe('Envie ENTRAR por WhatsApp.');
    expect(guidance.intro).not.toContain('SMS');
  });
});
