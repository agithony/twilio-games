import { describe, it, expect, afterEach } from 'vitest';
import { HttpServer } from '../server/http-server';
import type { ArcadeTacGateway } from '../server/arcade-tac-gateway';
import twilio from 'twilio';

let srv: HttpServer;
afterEach(async () => { await srv?.stop(); });

function makeServer() {
  return new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
}
async function sms(port: number, from: string, body: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ From: from, Body: body, MessageSid: `S${Math.random()}`, ...extra });
  const res = await fetch(`http://127.0.0.1:${port}/sms`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  return { status: res.status, xml: await res.text() };
}

describe('SMS concierge API', () => {
  it('replies with TwiML asking for a room code on first contact', async () => {
    srv = makeServer(); const port = await srv.start();
    const r = await sms(port, '+15551112222', 'hi');
    expect(r.status).toBe(200);
    expect(r.xml).toContain('<Message>');
    expect(r.xml.toLowerCase()).toMatch(/room code/);
  });

  it('walks code → name → joined over real HTTP', async () => {
    srv = makeServer(); const port = await srv.start();
    // create the room first by spectating/joining via the game is not needed: the concierge's
    // findRoom getOrCreates the room, so a valid 4-digit code is accepted.
    const codeReply = await sms(port, '+15551113333', '4821');
    expect(codeReply.xml.toLowerCase()).toMatch(/name/);
    const nameReply = await sms(port, '+15551113333', 'Ada');
    expect(nameReply.xml.toLowerCase()).toMatch(/you're in|youre in|in room/);
  });

  it('rejects MMS politely', async () => {
    srv = makeServer(); const port = await srv.start();
    const r = await sms(port, '+15551114444', '', { NumMedia: '1' });
    expect(r.xml.toLowerCase()).toMatch(/not supported/);
  });

  it('lets TAC own active messaging and accepts Conversation Orchestrator events', async () => {
    const events: Array<{ payload: unknown; token?: string }> = [];
    const gateway = {
      start: async () => undefined,
      stop: async () => undefined,
      ownsMessaging: () => true,
      processWebhook: async (payload: unknown, token?: string) => {
        events.push({ payload, ...(token ? { token } : {}) });
      },
    } as unknown as ArcadeTacGateway;
    srv = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      arcadeTacGateway: gateway,
    });
    const port = await srv.start();
    const inbound = await sms(port, '+15551115555', 'JOIN ARCADE-01');
    expect(inbound.xml).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
    const mms = await sms(port, '+15551115555', '', { NumMedia: '1' });
    expect(mms.xml).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');

    const payload = { eventType: 'COMMUNICATION_CREATED', data: { id: 'comm-1' } };
    const response = await fetch(`http://127.0.0.1:${port}/tac/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'I-Twilio-Idempotency-Token': 'token-1' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    expect(events).toEqual([{ payload, token: 'token-1' }]);
  });

  it('rejects Orchestrator callbacks when the TAC gateway is disabled', async () => {
    srv = makeServer();const port = await srv.start();
    const response = await fetch(`http://127.0.0.1:${port}/tac/webhook`, {
      method: 'POST',headers:{'Content-Type':'application/json'},body:'{}',
    });
    expect(response.status).toBe(503);
  });

  it('restricts the secondary Portuguese token to Voice webhooks', async () => {
    const primaryToken='primary-token',portugueseToken='portuguese-token';
    srv=new HttpServer({
      port:0,publicBaseUrl:'http://localhost',authToken:primaryToken,
      additionalAuthTokens:[portugueseToken],validateSignatures:true,
    });
    const port=await srv.start();
    const smsParams={From:'+551155555555',Body:'4821',MessageSid:'SM-secondary'};
    const smsUrl='http://localhost/sms';
    const smsSignature=twilio.getExpectedTwilioSignature(portugueseToken,smsUrl,smsParams);
    const smsResponse=await fetch(`http://127.0.0.1:${port}/sms`,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':smsSignature},
      body:new URLSearchParams(smsParams).toString(),
    });
    expect(smsResponse.status).toBe(403);

    const voiceParams={From:'+5511999999999',To:'+551155555555',CallSid:'CA-secondary'};
    const voiceUrl='http://localhost/voice/incoming';
    const voiceSignature=twilio.getExpectedTwilioSignature(portugueseToken,voiceUrl,voiceParams);
    const voiceResponse=await fetch(`http://127.0.0.1:${port}/voice/incoming`,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':voiceSignature},
      body:new URLSearchParams(voiceParams).toString(),
    });
    expect(voiceResponse.status).toBe(200);
    expect(await voiceResponse.text()).toContain('<ConversationRelay');
  });
});
