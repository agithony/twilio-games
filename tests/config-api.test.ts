// GET /api/config is the client bootstrap: it exposes the phone number players CALL to join, so the
// lobby can show it + encode the QR. Public + unauthenticated (no secrets here — just the number).
import { describe, it, expect, afterEach } from 'vitest';
import { HttpServer } from '../server/http-server';

let srv: HttpServer;
afterEach(async () => { await srv?.stop(); });

describe('GET /api/config', () => {
  it('returns the configured game phone number', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      gamePhoneNumber: '+14155550123' });
    const port = await srv.start();
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    expect(cfg.phoneNumber).toBe('+14155550123');
    expect(cfg.voiceNumbers).toEqual({ 'en-US': '+14155550123', 'pt-BR': '+14155550123' });
    expect(cfg.smsNumber).toBe('');
  });

  it('keeps the SMS number separate from the legacy voice fallback', async () => {
    srv = new HttpServer({
      port: 0,
      publicBaseUrl: 'http://localhost',
      validateSignatures: false,
      gamePhoneNumber: '+14155550123',
      smsNumber: '+15005550006',
    });
    const port = await srv.start();
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    expect(cfg).toMatchObject({ phoneNumber: '+14155550123', smsNumber: '+15005550006' });
  });

  it('returns an empty string when no number is configured (lobby shows a placeholder)', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    expect(cfg.phoneNumber).toBe('');
  });

  it('is unauthenticated even when an editor token is set (public bootstrap)', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      editorToken: 'secret', gamePhoneNumber: '+14155550123' });
    const port = await srv.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/config`);
    expect(res.status).toBe(200);
    expect((await res.json()).phoneNumber).toBe('+14155550123');
  });
});
