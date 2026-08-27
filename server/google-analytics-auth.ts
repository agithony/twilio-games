import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

const SESSION_COOKIE = 'twilio_analytics_session';
const STATE_COOKIE = 'twilio_analytics_oauth_state';
const SESSION_MS = 8 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;
const PIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const PIN_MAX_FAILURES = 5;
const PIN_CLIENT_LIMIT = 1000;

type AuthMethod = 'google' | 'pin';
type AuthReturnTo = '/analytics' | '/operator';
interface Session { email: string; analyticsAuthorized: boolean; authMethod: AuthMethod; expiresAt: number; }
interface OAuthState { expiresAt: number; returnTo: AuthReturnTo; }
interface GoogleUser { email?: unknown; email_verified?: unknown; }

export interface GoogleAnalyticsAuthOptions {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  allowedEmail?: string;
  adminPin?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

export class GoogleAnalyticsAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly analyticsAllowedEmails: readonly string[];
  private readonly adminPinDigest: Buffer | null;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly secure: boolean;
  private sessions = new Map<string, Session>();
  private states = new Map<string, OAuthState>();
  private pinFailures = new Map<string, number[]>();

  constructor(private readonly options: GoogleAnalyticsAuthOptions) {
    this.clientId = options.clientId?.trim() ?? '';
    this.clientSecret = options.clientSecret?.trim() ?? '';
    this.analyticsAllowedEmails = [options.allowedEmail ?? '']
      .map(email => email.trim().toLowerCase())
      .filter(Boolean);
    const adminPin = options.adminPin?.trim() ?? '';
    if (adminPin && adminPin !== 'disabled' && (adminPin.length < 6 || adminPin.length > 64)) {
      throw new Error('ANALYTICS_ADMIN_PIN must contain between 6 and 64 characters');
    }
    this.adminPinDigest = adminPin && adminPin !== 'disabled' ? digest(adminPin) : null;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.secure = options.redirectUri.startsWith('https://');
  }

  get googleConfigured(): boolean { return Boolean(this.clientId && this.clientSecret); }
  get pinConfigured(): boolean { return this.adminPinDigest !== null; }
  get configured(): boolean { return this.googleConfigured || this.pinConfigured; }

  begin(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.googleConfigured) { res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Google OAuth is not configured'); return; }
    this.sweep();
    const state = randomBytes(24).toString('base64url');
    const returnTo = authReturnTo(new URL(req.url ?? '', 'http://localhost').searchParams.get('returnTo'));
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
      if (user.email_verified !== true || !isAnalyticsEmailAllowed(email, this.analyticsAllowedEmails)) {
        this.redirectDenied(res, clearState, 'email_not_allowed', pending.returnTo); return;
      }
      const sessionCookie = this.issueSession(email);
      res.writeHead(302, { Location: pending.returnTo, 'Set-Cookie': [clearState, sessionCookie], 'Cache-Control': 'no-store' }).end();
    } catch (error) {
      console.error('[analytics-auth] Google OAuth failed:', (error as Error).message);
      this.redirectDenied(res, clearState, 'oauth_failed', pending.returnTo);
    }
  }

  currentUser(req: http.IncomingMessage): { email: string; analyticsAuthorized: boolean; authMethod: AuthMethod } | null {
    this.sweep();
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE]; if (!id) return null;
    const session = this.sessions.get(id); if (!session || session.expiresAt <= this.now()) return null;
    return { email: session.email, analyticsAuthorized: session.analyticsAuthorized, authMethod: session.authMethod };
  }

  currentAnalyticsUser(req: http.IncomingMessage): { email: string } | null {
    const user = this.currentUser(req);
    return user?.analyticsAuthorized ? { email: user.email } : null;
  }

  currentOperatorUser(req: http.IncomingMessage): { email: string } | null {
    const user = this.currentUser(req);
    if (!user?.analyticsAuthorized) return null;
    return { email: user.authMethod === 'pin' ? 'admin-pin@local.invalid' : user.email };
  }

  completePin(req: http.IncomingMessage, res: http.ServerResponse, pin: string): void {
    const now = this.now();
    this.sweepPinFailures(now);
    let client = requestAddress(req);
    if (!this.pinFailures.has(client) && this.pinFailures.size >= PIN_CLIENT_LIMIT) client = 'overflow';
    const failures = (this.pinFailures.get(client) ?? []).filter(at => at > now - PIN_FAILURE_WINDOW_MS);
    if (failures.length) this.pinFailures.set(client, failures); else this.pinFailures.delete(client);
    if (!this.adminPinDigest) {
      this.pinResponse(res, 503, 'pin_not_configured'); return;
    }
    if (failures.length >= PIN_MAX_FAILURES) {
      this.pinResponse(res, 429, 'too_many_attempts', pinRetryAfter(failures, now)); return;
    }
    const valid = timingSafeEqual(this.adminPinDigest, digest(pin.trim()));
    if (!valid) {
      failures.push(now); this.pinFailures.set(client, failures);
      const limited = failures.length >= PIN_MAX_FAILURES;
      this.pinResponse(res, limited ? 429 : 401, limited ? 'too_many_attempts' : 'invalid_pin',
        limited ? pinRetryAfter(failures, now) : undefined);
      return;
    }
    this.pinFailures.delete(client);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': this.issueAuthorizedSession('Admin PIN', 'pin'),
      'Cache-Control': 'no-store',
    }).end('{"authenticated":true}');
  }

  logout(req: http.IncomingMessage, res: http.ServerResponse): void {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE]; if (id) this.sessions.delete(id);
    res.writeHead(204, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0, this.secure), 'Cache-Control': 'no-store' }).end();
  }

  /** Issues an authorized session cookie. Used by the OAuth callback and HTTP integration tests. */
  issueSession(email: string): string {
    const normalized = email.trim().toLowerCase();
    if (!isAnalyticsEmailAllowed(normalized, this.analyticsAllowedEmails)) throw new Error('email is not authorized');
    return this.issueAuthorizedSession(normalized, 'google');
  }

  private issueAuthorizedSession(email: string, authMethod: AuthMethod): string {
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, {
      email,
      analyticsAuthorized: true,
      authMethod,
      expiresAt: this.now() + SESSION_MS,
    });
    return cookie(SESSION_COOKIE, id, SESSION_MS, this.secure);
  }

  private pinResponse(res: http.ServerResponse, status: number, error: string, retryAfter?: number): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}),
    }).end(JSON.stringify({ error }));
  }

  private redirectDenied(
    res: http.ServerResponse,
    clearState: string,
    reason: string,
    returnTo: AuthReturnTo = '/analytics',
  ): void {
    const query = new URLSearchParams({ auth: reason });
    if (returnTo === '/operator') query.set('returnTo', returnTo);
    res.writeHead(302, { Location: `/analytics?${query}`, 'Set-Cookie': clearState, 'Cache-Control': 'no-store' }).end();
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
    for (const [state, pending] of this.states) if (pending.expiresAt <= now) this.states.delete(state);
  }

  private sweepPinFailures(now: number): void {
    for (const [client, attempts] of this.pinFailures) {
      const active = attempts.filter(at => at > now - PIN_FAILURE_WINDOW_MS);
      if (active.length) this.pinFailures.set(client, active); else this.pinFailures.delete(client);
    }
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

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function authReturnTo(value: string | null | undefined): AuthReturnTo {
  return value === '/operator' ? '/operator' : '/analytics';
}

function pinRetryAfter(failures: readonly number[], now: number): number {
  return Math.max(1, Math.ceil(((failures[0] ?? now) + PIN_FAILURE_WINDOW_MS - now) / 1000));
}

function requestAddress(req: http.IncomingMessage): string {
  const remote = req.socket.remoteAddress || 'unknown';
  if (!isTrustedProxyAddress(remote)) return remote;
  const forwarded = req.headers['x-forwarded-for'];
  const value = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',').at(-1)?.trim();
  return value?.slice(0, 128) || remote;
}

function isTrustedProxyAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^::ffff:/, '');
  if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  if (/^(?:127|10)\./.test(address) || /^192\.168\./.test(address) || /^169\.254\./.test(address)) return true;
  const match = /^172\.(\d{1,3})\./.exec(address);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
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
