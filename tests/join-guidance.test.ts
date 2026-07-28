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
    expect(guidance.intro).toBe('Send JOIN by SMS (recommended), or continue in your browser.');
    expect(guidance.channelDetail).toBe('Recommended · opens JOIN prefilled; just tap Send');
  });

  it('localizes the concise channel subtitle', () => {
    const guidance = buildJoinGuidance({ ...base, portuguese: true, sms: false, whatsapp: true, termsRequired: true });
    expect(guidance.command).toBe('ENTRAR');
    expect(guidance.intro).toBe('Envie ENTRAR por WhatsApp.');
    expect(guidance.intro).not.toContain('SMS');
  });

  it('offers Portuguese browser fallback while keeping WhatsApp recommended',()=>{
    const guidance=buildJoinGuidance({...base,portuguese:true,mode:'lead_capture',sms:true,whatsapp:true});
    expect(guidance.messaging).toBe(true);
    expect(guidance.intro).toBe('Envie ENTRAR por WhatsApp (recomendado) ou continue no navegador.');
    expect(guidance.intro).not.toContain('SMS');
    expect(guidance.browserDetail).toContain('Alternativa');
  });

  it('offers Portuguese browser-only fallback when WhatsApp is unavailable',()=>{
    const guidance=buildJoinGuidance({...base,portuguese:true,mode:'lead_capture',sms:true,whatsapp:false});
    expect(guidance.messaging).toBe(false);
    expect(guidance.intro).toBe('Continue no navegador para entrar.');
  });
});
