import { afterEach, describe, expect, it } from 'vitest';
import { HttpServer } from '../server/http-server';
import { GoogleAnalyticsAuth, isAnalyticsEmailAllowed } from '../server/google-analytics-auth';

let server: HttpServer | undefined;
afterEach(async () => { await server?.stop(); server = undefined; });

describe('Google analytics authorization', () => {
  it('allows verified Twilio addresses or exactly one configured exception', () => {
    expect(isAnalyticsEmailAllowed('Ada@Twilio.com')).toBe(true);
    expect(isAnalyticsEmailAllowed('guest@example.com', 'Guest@Example.com')).toBe(true);
    expect(isAnalyticsEmailAllowed('person@sub.twilio.com')).toBe(false);
    expect(isAnalyticsEmailAllowed('other@example.com', 'guest@example.com')).toBe(false);
    expect(isAnalyticsEmailAllowed('operator@example.com', [
      'first@example.com', 'operator@example.com',
    ])).toBe(true);
  });

  it('completes Google OAuth and creates an HTTP-only analytics session', async () => {
    const auth = googleAuth({ email: 'analyst@twilio.com', email_verified: true });
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, analyticsAuth: auth });
    const port = await server.start(), base = `http://127.0.0.1:${port}`;
    const begin = await fetch(`${base}/auth/google?returnTo=${encodeURIComponent('https://evil.example')}`, { redirect: 'manual' });
    const stateCookie = begin.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(begin.headers.get('location')!).searchParams.get('state');
    const callback = await fetch(`${base}/auth/google/callback?code=valid&state=${state}`, { headers: { cookie: stateCookie }, redirect: 'manual' });
    expect(callback.status).toBe(302); expect(callback.headers.get('location')).toBe('/analytics');
    const cookies = callback.headers.getSetCookie();
    const sessionCookie = cookies.find(value => value.startsWith('twilio_analytics_session='))!.split(';')[0]!;
    expect(cookies.join(';')).toContain('HttpOnly'); expect(cookies.join(';')).toContain('SameSite=Lax');
    const session = await (await fetch(`${base}/api/analytics/session`, { headers: { cookie: sessionCookie } })).json();
    expect(session).toMatchObject({ authenticated: true, email: 'analyst@twilio.com' });
  });

  it('denies a verified Google address outside the domain and exception', async () => {
    const auth = googleAuth({ email: 'outsider@example.com', email_verified: true });
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, analyticsAuth: auth });
    const port = await server.start(), base = `http://127.0.0.1:${port}`;
    const begin = await fetch(`${base}/auth/google`, { redirect: 'manual' });
    const stateCookie = begin.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(begin.headers.get('location')!).searchParams.get('state');
    const callback = await fetch(`${base}/auth/google/callback?code=valid&state=${state}`, { headers: { cookie: stateCookie }, redirect: 'manual' });
    expect(callback.headers.get('location')).toBe('/analytics?auth=email_not_allowed');
  });

  it('returns Google authentication to the allowlisted operator page', async () => {
    const auth = googleAuth({ email: 'operator@twilio.com', email_verified: true });
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, analyticsAuth: auth });
    const port = await server.start(), base = `http://127.0.0.1:${port}`;
    const begin = await fetch(`${base}/auth/google?returnTo=${encodeURIComponent('/operator')}`, { redirect: 'manual' });
    const stateCookie = begin.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(begin.headers.get('location')!).searchParams.get('state');
    const callback = await fetch(`${base}/auth/google/callback?code=valid&state=${state}`, {
      headers: { cookie: stateCookie }, redirect: 'manual',
    });
    expect(callback.headers.get('location')).toBe('/operator');
    const sessionCookie = callback.headers.getSetCookie()
      .find(value => value.startsWith('twilio_analytics_session='))!.split(';')[0]!;
    const request = { headers: { cookie: sessionCookie } } as Parameters<GoogleAnalyticsAuth['currentOperatorUser']>[0];
    expect(auth.currentOperatorUser(request)).toEqual({ email: 'operator@twilio.com' });
  });

  it('accepts the configured admin PIN and creates the same analytics session', async () => {
    const auth = new GoogleAnalyticsAuth({ redirectUri: 'http://localhost/auth/google/callback', adminPin: 'Game!Night#2026' });
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, analyticsAuth: auth });
    const port = await server.start(), base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/auth/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: 'Game!Night#2026' }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const session = await (await fetch(`${base}/api/analytics/session`, { headers: { cookie } })).json();
    expect(session).toMatchObject({ authenticated: true, analyticsAuthorized: true, email: 'Admin PIN',
      configured: true, googleConfigured: false, pinConfigured: true });
    const request = { headers: { cookie } } as Parameters<GoogleAnalyticsAuth['currentOperatorUser']>[0];
    expect(auth.currentOperatorUser(request)).toEqual({ email: 'admin-pin@local.invalid' });
  });

  it('rejects incorrect PINs and rate limits repeated failures', async () => {
    const auth = new GoogleAnalyticsAuth({ redirectUri: 'http://localhost/auth/google/callback', adminPin: 'Game!Night#2026' });
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, analyticsAuth: auth });
    const port = await server.start(), base = `http://127.0.0.1:${port}`;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const response = await pinLogin(base, '000000');
      expect(response.status).toBe(401); expect(response.headers.get('set-cookie')).toBeNull();
    }
    const limited = await pinLogin(base, '000000');
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('900');
    expect((await pinLogin(base, 'Game!Night#2026')).status).toBe(429);
    expect((await pinLogin(base, 'Game!Night#2026', '203.0.113.9')).status).toBe(200);
  });

  it('requires a PIN with at least six characters', () => {
    expect(() => new GoogleAnalyticsAuth({ redirectUri: 'http://localhost/auth/google/callback',
      adminPin: '1234' })).toThrow('ANALYTICS_ADMIN_PIN');
  });

});

function pinLogin(base: string, pin: string, forwardedFor?: string): Promise<Response> {
  return fetch(`${base}/auth/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json',
    ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}) },
    body: JSON.stringify({ pin }) });
}

function googleAuth(
  user: { email: string; email_verified: boolean },
): GoogleAnalyticsAuth {
  const fetcher: typeof fetch = async (input) => String(input).includes('/token')
    ? new Response(JSON.stringify({ access_token: 'google-access-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify(user), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new GoogleAnalyticsAuth({ clientId: 'google-id', clientSecret: 'google-secret',
    redirectUri: 'http://localhost/auth/google/callback', allowedEmail: 'guest@example.com',
    fetcher });
}
