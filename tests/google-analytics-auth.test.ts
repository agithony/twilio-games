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
    const begin = await fetch(`${base}/auth/google`, { redirect: 'manual' });
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

  it('returns Arcade operators to the Arcade console after sign-in', async () => {
    const auth = googleAuth({ email: 'operator@twilio.com', email_verified: true });
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, analyticsAuth: auth });
    const port = await server.start(), base = `http://127.0.0.1:${port}`;
    const begin = await fetch(`${base}/auth/google?returnTo=/arcade/%3Foperator%3D1`, { redirect: 'manual' });
    const stateCookie = begin.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(begin.headers.get('location')!).searchParams.get('state');
    const callback = await fetch(`${base}/auth/google/callback?code=valid&state=${state}`, {
      headers: { cookie: stateCookie }, redirect: 'manual',
    });
    expect(callback.headers.get('location')).toBe('/arcade/?operator=1');
  });

  it('does not grant Analytics access to an external Arcade-only operator', async () => {
    const auth = googleAuth(
      { email: 'arcade.operator@example.com', email_verified: true },
      ['arcade.operator@example.com'],
    );
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, analyticsAuth: auth });
    const port = await server.start(), base = `http://127.0.0.1:${port}`;
    const begin = await fetch(`${base}/auth/google?returnTo=/arcade/`, { redirect: 'manual' });
    const stateCookie = begin.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(begin.headers.get('location')!).searchParams.get('state');
    const callback = await fetch(`${base}/auth/google/callback?code=valid&state=${state}`, {
      headers: { cookie: stateCookie }, redirect: 'manual',
    });
    const sessionCookie = callback.headers.getSetCookie()
      .find(value => value.startsWith('twilio_analytics_session='))!.split(';')[0]!;
    const session = await (await fetch(`${base}/api/analytics/session`, {
      headers: { cookie: sessionCookie },
    })).json();
    expect(session).toMatchObject({
      authenticated: true, analyticsAuthorized: false, email: 'arcade.operator@example.com',
    });
    expect((await fetch(`${base}/api/analytics`, { headers: { cookie: sessionCookie } })).status).toBe(401);
  });
});

function googleAuth(
  user: { email: string; email_verified: boolean },
  allowedEmails: readonly string[] = [],
): GoogleAnalyticsAuth {
  const fetcher: typeof fetch = async (input) => String(input).includes('/token')
    ? new Response(JSON.stringify({ access_token: 'google-access-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify(user), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new GoogleAnalyticsAuth({ clientId: 'google-id', clientSecret: 'google-secret',
    redirectUri: 'http://localhost/auth/google/callback', allowedEmail: 'guest@example.com',
    allowedEmails, fetcher });
}
