import { describe, it, expect, afterEach } from 'vitest';
import { HttpServer } from '../server/http-server';

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
});
