import { randomBytes } from 'node:crypto';
import type http from 'node:http';

const SESSION_COOKIE = 'twilio_analytics_session';
const STATE_COOKIE = 'twilio_analytics_oauth_state';
const SESSION_MS = 8 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;

interface Session { email: string; analyticsAuthorized: boolean; expiresAt: number; }
type AuthReturnPath = '/analytics' | '/operator';
interface OAuthState { expiresAt: number; returnTo: AuthReturnPath; }
interface GoogleUser { email?: unknown; email_verified?: unknown; }

export interface GoogleAnalyticsAuthOptions {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  allowedEmail?: string;
  allowedEmails?: readonly string[];
  fetcher?: typeof fetch;
  now?: () => number;
}

export class GoogleAnalyticsAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly analyticsAllowedEmails: readonly string[];
  private readonly loginAllowedEmails: readonly string[];
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly secure: boolean;
  private sessions = new Map<string, Session>();
  private states = new Map<string, OAuthState>();

  constructor(private readonly options: GoogleAnalyticsAuthOptions) {
    this.clientId = options.clientId?.trim() ?? '';
    this.clientSecret = options.clientSecret?.trim() ?? '';
    this.analyticsAllowedEmails = [options.allowedEmail ?? '']
      .map(email => email.trim().toLowerCase())
      .filter(Boolean);
    this.loginAllowedEmails = [...this.analyticsAllowedEmails, ...(options.allowedEmails ?? [])]
      .map(email => email.trim().toLowerCase())
      .filter(Boolean);
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.secure = options.redirectUri.startsWith('https://');
  }

  get configured(): boolean { return Boolean(this.clientId && this.clientSecret); }

  begin(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.configured) { res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Google OAuth is not configured'); return; }
    this.sweep();
    const state = randomBytes(24).toString('base64url');
    const requestedReturn = new URL(req.url ?? '', 'http://localhost').searchParams.get('returnTo');
    const returnTo = requestedReturn === '/operator' ? requestedReturn : '/analytics';
    this.states.set(state, { expiresAt: this.now() + STATE_MS, returnTo });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: this.options.redirectUri,
      response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' }).toString();
    res.writeHead(302, { Location: url.toString(), 'Set-Cookie': cookie(STATE_COOKIE, state, STATE_MS, this.secure), 'Cache-Control': 'no-store' }).end();
  }

  async complete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost');
    const state = url.searchParams.get('state') ?? '', code = url.searchParams.get('code') ?? '';
    const cookies = parseCookies(req.headers.cookie);
    const pending = this.states.get(state);
    this.states.delete(state);
    const clearState = cookie(STATE_COOKIE, '', 0, this.secure);
    if (!state || cookies[STATE_COOKIE] !== state || !pending || pending.expiresAt < this.now()
      || !code || url.searchParams.has('error')) {
      this.redirectDenied(res, clearState, 'invalid_oauth_state', pending?.returnTo); return;
    }
    try {
      const tokenResponse = await this.fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ code, client_id: this.clientId, client_secret: this.clientSecret,
          redirect_uri: this.options.redirectUri, grant_type: 'authorization_code' }),
      });
      if (!tokenResponse.ok) throw new Error(`token exchange returned ${tokenResponse.status}`);
      const tokens = await tokenResponse.json() as { access_token?: unknown };
      if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new Error('token exchange omitted access token');
      const userResponse = await this.fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10_000),
      });
      if (!userResponse.ok) throw new Error(`userinfo returned ${userResponse.status}`);
      const user = await userResponse.json() as GoogleUser;
      const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
      if (user.email_verified !== true || !isAnalyticsEmailAllowed(email, this.loginAllowedEmails)) {
        this.redirectDenied(res, clearState, 'email_not_allowed', pending.returnTo); return;
      }
      const sessionCookie = this.issueSession(email);
      res.writeHead(302, { Location: pending.returnTo, 'Set-Cookie': [clearState, sessionCookie], 'Cache-Control': 'no-store' }).end();
    } catch (error) {
      console.error('[analytics-auth] Google OAuth failed:', (error as Error).message);
      this.redirectDenied(res, clearState, 'oauth_failed', pending.returnTo);
    }
  }

  currentUser(req: http.IncomingMessage): { email: string; analyticsAuthorized: boolean } | null {
    this.sweep();
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE]; if (!id) return null;
    const session = this.sessions.get(id); if (!session || session.expiresAt <= this.now()) return null;
    return { email: session.email, analyticsAuthorized: session.analyticsAuthorized };
  }

  currentAnalyticsUser(req: http.IncomingMessage): { email: string } | null {
    const user = this.currentUser(req);
    return user?.analyticsAuthorized ? { email: user.email } : null;
  }

  logout(req: http.IncomingMessage, res: http.ServerResponse): void {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE]; if (id) this.sessions.delete(id);
    res.writeHead(204, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0, this.secure), 'Cache-Control': 'no-store' }).end();
  }

  /** Issues an authorized session cookie. Used by the OAuth callback and HTTP integration tests. */
  issueSession(email: string): string {
    const normalized = email.trim().toLowerCase();
    if (!isAnalyticsEmailAllowed(normalized, this.loginAllowedEmails)) throw new Error('email is not authorized');
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, {
      email: normalized,
      analyticsAuthorized: isAnalyticsEmailAllowed(normalized, this.analyticsAllowedEmails),
      expiresAt: this.now() + SESSION_MS,
    });
    return cookie(SESSION_COOKIE, id, SESSION_MS, this.secure);
  }

  private redirectDenied(
    res: http.ServerResponse,
    clearState: string,
    reason: string,
    returnTo: AuthReturnPath = '/analytics',
  ): void {
    const separator = returnTo.includes('?') ? '&' : '?';
    res.writeHead(302, { Location: `${returnTo}${separator}auth=${encodeURIComponent(reason)}`, 'Set-Cookie': clearState, 'Cache-Control': 'no-store' }).end();
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
    for (const [state, pending] of this.states) if (pending.expiresAt <= now) this.states.delete(state);
  }
}

export function isAnalyticsEmailAllowed(email: string, allowedEmail: string | readonly string[] = ''): boolean {
  const normalized = email.trim().toLowerCase();
  const exceptions = (Array.isArray(allowedEmail) ? allowedEmail : [allowedEmail])
    .map(value => value.trim().toLowerCase()).filter(Boolean);
  return /^[^@\s]+@twilio\.com$/.test(normalized) || exceptions.includes(normalized);
}

function cookie(name: string, value: string, durationMs: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(durationMs / 1000)}${secure ? '; Secure' : ''}`;
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('='); if (index < 0) continue;
    const name = part.slice(0, index).trim(); if (!name) continue;
    try { out[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return out;
}
