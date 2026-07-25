# Activation Analytics

The private `/analytics` dashboard reports engagement for Voice Racer, Voice Monsters, and Voice Fighter. It provides summary metrics, UTC daily trends, per-game performance, popular selections, generated takeaways, and downloadable PDF reports.

## Google OAuth Setup

Create an OAuth 2.0 Web application client in Google Cloud Console. Add each redirect URI that the deployment uses:

| Environment | Authorized redirect URI |
|---|---|
| Production | `https://<app-fqdn>/auth/google/callback` |
| Local server | `http://localhost:8080/auth/google/callback` |

The redirect URI must exactly match `PUBLIC_BASE_URL` plus `/auth/google/callback`.

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth web client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth web client secret |
| `ANALYTICS_ALLOWED_EMAIL` | Optional exact external email that may read analytics |
| `ARCADE_ADMIN_EMAILS` | Comma-separated operator allowlist; these accounts may sign in, but this setting does not grant analytics access |
| `ANALYTICS_PATH` | Rollup file path; defaults to `data/analytics.json` |

The deployment workflow reads the client ID and secret from GitHub Actions secrets. It reads `ANALYTICS_ALLOWED_EMAIL` and `ARCADE_ADMIN_EMAILS` from repository variables.

If an allowed account is outside Twilio Google Workspace, the OAuth application's audience must permit it. A Workspace-internal OAuth application can block the account before the application evaluates either allowlist.

## Authentication And Authorization

1. `GET /auth/google` creates a random OAuth state, retains it in memory for ten minutes, and sends the value in an HTTP-only, SameSite=Lax cookie.
2. Google redirects to `/auth/google/callback`; the server validates the state and cookie, exchanges the code, reads userinfo, and requires `email_verified: true`.
3. A verified `@twilio.com` address, the exact `ANALYTICS_ALLOWED_EMAIL`, or an address in `ARCADE_ADMIN_EMAILS` may receive an application session.
4. The server stores an opaque random session in memory for eight hours and sends only its ID in an HTTP-only, SameSite=Lax cookie.
5. Analytics authorization is narrower: only a verified `@twilio.com` address or the exact `ANALYTICS_ALLOWED_EMAIL` may request reports.

An external account listed only in `ARCADE_ADMIN_EMAILS` can authenticate and use authorized station operations, but its session has `analyticsAuthorized: false`. Both analytics report endpoints return `401` for that account. Conversely, `ANALYTICS_ALLOWED_EMAIL` grants analytics access but does not by itself add the account to the operator allowlist.

OAuth state and session cookies include `Secure` only when the configured redirect URI uses HTTPS. Local HTTP cookies remain HTTP-only and SameSite=Lax without `Secure`. Google access tokens and client secrets never reach dashboard JavaScript. A process restart clears OAuth state and active sessions.

## Session Status

`GET /api/analytics/session` always returns no-store JSON describing the current browser session:

| Field | Meaning |
|---|---|
| `authenticated` | The session cookie maps to a live eight-hour application session |
| `analyticsAuthorized` | That authenticated identity may call the JSON and PDF analytics endpoints |
| `configured` | Both Google OAuth client ID and client secret are present |
| `email` | Normalized session email; omitted when no session is authenticated |

Authentication and analytics authorization are intentionally separate. Clients must check both `authenticated` and `analyticsAuthorized` before displaying the dashboard.

## Metrics

Collection occurs at authoritative game-state transitions. Spectator connections and browser refreshes do not create sessions.

| Metric | Definition |
|---|---|
| Engaged participants | Distinct pseudonymous participant-slot keys in the selected UTC buckets and games; this is not identity resolution across people or devices |
| Sessions | Active races, battles, or fights that were later recorded as completed or abandoned |
| Completed | Racer result with at least one finisher, Monsters result, or Fighter victory/results transition |
| Abandoned | A tracked active match that left gameplay without its completed terminal transition |
| Active play time | Rounded elapsed seconds from the tracked gameplay start until completion or abandonment |
| Voice commands | Accepted semantic commands; raw speech and transcripts are never recorded |
| Selections | Aggregate map, monster/fighter, and Racer vehicle values stored with recorded sessions |

For every recorded match, `sessions` increases once and exactly one of `completed` or `abandoned` increases. Completion rate is `completed / sessions`; average session time is `playSeconds / sessions`. A session is assigned to the UTC date on which it is recorded, usually its completion or abandonment date. Voice commands use the UTC date on which the command is accepted.

The store hashes participant keys with SHA-256 and a server-side salt before persistence. It does not persist Google emails, phone numbers, display names, transcripts, OAuth tokens, access tokens, or LLM text.

## Retention

Each new analytics write prunes date keys older than the UTC date produced by `Date.now() - 730 days`. The cutoff date remains, as does the current date, so a continuously active store can contain up to 731 inclusive UTC day buckets. `MAX_DAYS = 730` expresses the age cutoff, not a maximum of 730 stored labels.

Loading the file does not prune it immediately. Older keys already on disk remain until a new match or voice command schedules persistence. Reports only read the dates explicitly requested, so retained out-of-range keys do not enter a report.

## Report APIs

| Endpoint | Purpose | Authorization |
|---|---|---|
| `GET /api/analytics/session` | Current authentication and authorization state | Public status response |
| `GET /api/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&game=all` | Filtered report JSON | Analytics-authorized session |
| `GET /api/analytics.pdf?...` | A PDF generated from the same report model and filters | Analytics-authorized session |
| `POST /auth/logout` | Deletes the in-memory session and expires its cookie | Current cookie, if present |

The report endpoints return `Cache-Control: no-store`. They return `401` whenever the session lacks analytics authorization, including an authenticated external operator-only session.

Dates use strict `YYYY-MM-DD` UTC labels and include both endpoints. Omitting `from` defaults it to 29 UTC days before the current date; omitting `to` defaults it to the current UTC date, producing a 30-bucket default report. A supplied malformed date returns `400` instead of falling back.

The range validator limits the elapsed gap between `from` and `to` to 366 days. Because the endpoints are inclusive, the largest accepted request contains 367 UTC date buckets. A reversed range or a gap greater than 366 days returns `400`.

Valid game filters are `all`, `racer`, `monsters`, and `fighter`. The filter controls summary metrics, trends, selections, and insights. The `games` object still reports each game's metrics for the requested date range so the dashboard can show the full per-title comparison.
