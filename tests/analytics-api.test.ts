import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { HttpServer } from '../server/http-server';
import { GoogleAnalyticsAuth } from '../server/google-analytics-auth';

let server: HttpServer | undefined;
const analyticsPath = `data/_test-analytics-api-${process.pid}.json`;
afterEach(async () => { await server?.stop(); server = undefined; await rm(analyticsPath, { force: true }); });

function setup(email = 'reporter@twilio.com'): { auth: GoogleAnalyticsAuth; cookie: string } {
  const auth = new GoogleAnalyticsAuth({ clientId: 'google-id', clientSecret: 'google-secret',
    redirectUri: 'http://localhost/auth/google/callback', allowedEmail: 'guest@example.com' });
  return { auth, cookie: auth.issueSession(email).split(';')[0]! };
}

describe('analytics API', () => {
  it('requires a Google session and returns no-store JSON', async () => {
    const { auth, cookie } = setup();
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, analyticsAuth: auth, analyticsPath });
    const port = await server.start(), url = `http://127.0.0.1:${port}/api/analytics`;
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: { cookie } });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).summary.sessions).toBe(0);
  });

  it('reports the current Google user and downloads an authenticated PDF', async () => {
    const { auth, cookie } = setup();
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, analyticsAuth: auth, analyticsPath });
    const port = await server.start();
    const session = await (await fetch(`http://127.0.0.1:${port}/api/analytics/session`, { headers: { cookie } })).json();
    expect(session).toMatchObject({ authenticated: true, email: 'reporter@twilio.com' });
    const response = await fetch(`http://127.0.0.1:${port}/api/analytics.pdf`, { headers: { cookie } });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('rejects malformed report filters', async () => {
    const { auth, cookie } = setup('guest@example.com');
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false, analyticsAuth: auth, analyticsPath });
    const port = await server.start(), headers = { cookie };
    expect((await fetch(`http://127.0.0.1:${port}/api/analytics?from=2026-02-30`, { headers })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/api/analytics?game=unknown`, { headers })).status).toBe(400);
  });
});
