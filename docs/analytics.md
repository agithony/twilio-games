# Activation Analytics

The private `/analytics` dashboard provides date-filtered engagement reporting for Voice Racer, Voice Monsters, and Voice Fighter. It includes summary KPIs, daily trends, per-game performance, popular selections, generated takeaways, and downloadable PDF reports.

## Google OAuth setup

Create an OAuth 2.0 **Web application** client in Google Cloud Console. Add these authorized redirect URIs as applicable:

- Production: `https://<app-fqdn>/auth/google/callback`
- Local server: `http://localhost:8080/auth/google/callback`

The production URI must exactly match `PUBLIC_BASE_URL` plus `/auth/google/callback`. Configure:

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth web client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth web client secret |
| `ANALYTICS_ALLOWED_EMAIL` | Optional single verified Google email outside `@twilio.com` |
| `ANALYTICS_PATH` | Rollup file; defaults to `data/analytics.json` |

The deployment workflow reads the client ID and secret from GitHub Actions secrets. It reads `ANALYTICS_ALLOWED_EMAIL` from a GitHub Actions repository variable.

If the exception account is outside Twilio Google Workspace, the OAuth application's audience must permit that account. A Workspace-internal OAuth application prevents outside accounts from reaching the callback, so the application-level exception cannot override it.

## Authorization model

1. `/auth/google` creates a random, ten-minute OAuth state and sends it in an HTTP-only SameSite cookie.
2. Google redirects to `/auth/google/callback`; the server validates the state and exchanges the authorization code directly with Google.
3. The server reads Google userinfo and requires `email_verified: true`.
4. Access is granted only when the normalized email ends exactly in `@twilio.com` or exactly matches `ANALYTICS_ALLOWED_EMAIL`.
5. The server creates an opaque eight-hour session in memory and sends only its random ID in a secure, HTTP-only SameSite cookie.

Google access tokens and client secrets are never sent to dashboard JavaScript. Analytics APIs return `Cache-Control: no-store`. A container restart clears active dashboard sessions and requires users to sign in again.

## Metrics and privacy

Collection occurs at authoritative game-state transitions. Spectators and browser refreshes do not count as gameplay.

- Engaged participants: pseudonymous participant slots that entered an active match.
- Sessions: races, battles, or fights that reached active gameplay.
- Completed and abandoned sessions: authoritative terminal state versus an interrupted active match.
- Active play time: time spent in active gameplay phases.
- Voice commands: accepted semantic commands, never raw speech or transcripts.
- Selections: aggregate maps, monsters/fighters, and Racer vehicles.

The store retains daily rollups for 730 days. It does not persist Google emails, phone numbers, display names, transcripts, OAuth tokens, or LLM text. Participant keys are hashed before persistence.

## APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/analytics/session` | Current sign-in state |
| `GET /api/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&game=all` | Filtered report JSON |
| `GET /api/analytics.pdf?...` | The same filtered report as a PDF attachment |
| `POST /auth/logout` | Ends the analytics session |

Report endpoints require the Google session cookie. Date ranges are inclusive and limited to 366 days. Valid game filters are `all`, `racer`, `monsters`, and `fighter`.
