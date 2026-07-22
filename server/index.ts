import { HttpServer } from './http-server';
import { ArcadeApi } from './arcade-api';
import { ArcadeConfigStore } from './arcade-config-store';
import { ArcadeEventHub } from './arcade-events';
import { ArcadeTacGateway, recalledMemoryLocale } from './arcade-tac-gateway';
import { ArcadePlayerRuntime } from './arcade-player-runtime';
import { GoogleAnalyticsAuth } from './google-analytics-auth';
import { isLoopbackAddress, isLoopbackUrl } from './arcade-dev-auth';
import { TwilioMessagingTransport } from './twilio-messaging';
import type { ArcadeMessagingChannel, ArcadeStationNotificationKind } from './arcade-state-store';

const port = Number(process.env.PORT ?? 8080);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const additionalAuthTokens = [process.env.TWILIO_PT_AUTH_TOKEN]
  .map(value => value?.trim())
  .filter((value): value is string => Boolean(value));
const smsNumber = configuredMessagingSender(
  process.env.TWILIO_SMS_NUMBER ?? process.env.TWILIO_PHONE_NUMBER,
);
const whatsappNumber = configuredMessagingSender(process.env.TWILIO_WHATSAPP_NUMBER);
const outboundRestCredentialsConfigured = configuredCredential(
  process.env.TWILIO_ACCOUNT_SID, /^AC[a-fA-F0-9]{32}$/,
) && configuredCredential(process.env.TWILIO_API_KEY, /^SK[a-fA-F0-9]{32}$/)
  && configuredCredential(process.env.TWILIO_API_SECRET);
// FAIL CLOSED: validate Twilio webhook signatures by DEFAULT whenever an auth token is set,
// regardless of NODE_ENV (a deploy that forgets NODE_ENV=production must NOT silently drop auth).
// Local dev without a token has nothing to validate against; opt out explicitly only if needed.
const validateSignatures = process.env.TWILIO_VALIDATE_SIGNATURES
  ? process.env.TWILIO_VALIDATE_SIGNATURES !== 'false'
  : Boolean(authToken || additionalAuthTokens.length) || process.env.NODE_ENV === 'production';

if (validateSignatures && !authToken) {
  console.warn('[security] signature validation is ON but TWILIO_AUTH_TOKEN is unset — webhooks will 500 until it is configured.');
}

// When EDITOR_TOKEN is set, /api writes (manifest + maps) require it — gate the editor on a public
// deploy. Unset (local dev) leaves writes open so the editor works with zero setup.
const editorToken = process.env.EDITOR_TOKEN;
const arcadeAdminEmails = new Set((process.env.ARCADE_ADMIN_EMAILS ?? '')
  .split(',')
  .map(email => email.trim().toLowerCase())
  .filter(Boolean));
const analyticsAuth = new GoogleAnalyticsAuth({
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  redirectUri: `${publicBaseUrl.replace(/\/$/, '')}/auth/google/callback`,
  allowedEmail: process.env.ANALYTICS_ALLOWED_EMAIL,
  allowedEmails: [...arcadeAdminEmails],
});
const arcadeDevAdmin = process.env.ARCADE_DEV_ADMIN === 'true'
  && process.env.NODE_ENV !== 'production'
  && isLoopbackUrl(publicBaseUrl);
if (arcadeDevAdmin) {
  console.warn('[security] ARCADE_DEV_ADMIN is enabled for local development.');
} else if (arcadeAdminEmails.size === 0) {
  console.warn('[security] ARCADE_ADMIN_EMAILS is unset; Twilio Games operator APIs are disabled.');
}
const arcadeEvents = new ArcadeEventHub(error => {
  console.error('[arcade-events] subscriber failed:', error instanceof Error ? error.message : String(error));
});
const arcadeConfigStore = new ArcadeConfigStore({
  directory: process.env.ARCADE_CONFIG_DIRECTORY ?? 'data',
  deploymentMode: 'single-process',
  events: arcadeEvents,
});
const arcadeTacGateway = process.env.ARCADE_TAC_ENABLED === 'false'
  ? undefined
  : new ArcadeTacGateway({ configStore: arcadeConfigStore, events: arcadeEvents });
const arcadePlayerRuntime = new ArcadePlayerRuntime({
  configStore: arcadeConfigStore,
  events: arcadeEvents,
  stateFile: process.env.ARCADE_STATE_PATH ?? 'data/arcade-state.json',
  publicBaseUrl,
  signingSecret: () => process.env.ARCADE_SIGNING_SECRET,
  outboundMessaging: {
    enabled: (channel?: ArcadeMessagingChannel) => process.env.ARCADE_OUTBOUND_MESSAGING_ENABLED === 'true'
      && (channel === undefined || (outboundRestCredentialsConfigured
        && (channel === 'sms' ? smsNumber !== null : whatsappNumber !== null))),
    callNumber: locale => arcadeConfigStore.getSnapshot().channels.voiceNumbers[locale]
      ?? process.env.GAME_PHONE_NUMBER,
    whatsappContentSid: (kind, locale) => process.env[whatsappContentSidEnvironmentName(kind, locale)],
    createTransport: () => new TwilioMessagingTransport({
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      apiKey: process.env.TWILIO_API_KEY,
      apiSecret: process.env.TWILIO_API_SECRET,
      smsFrom: smsNumber ?? undefined,
      whatsappFrom: whatsappNumber ?? undefined,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    }),
  },
});
const arcadeApi = new ArcadeApi({
  configStore: arcadeConfigStore,
  events: arcadeEvents,
  publicBaseUrl,
  tacStatus: () => arcadeTacGateway?.getStatus() ?? { started: false, mode: 'off', connected: false, lastError: null },
  tacRequired: arcadeTacGateway !== undefined,
  playerRuntime: arcadePlayerRuntime,
  displayToken: process.env.ARCADE_DISPLAY_TOKEN,
  fallbackVoiceNumber: process.env.GAME_PHONE_NUMBER,
  messagingCapabilities: { sms: smsNumber !== null, whatsapp: whatsappNumber !== null },
  authorizeAdmin: request => {
    if (arcadeDevAdmin && isLoopbackAddress(request.socket.remoteAddress)
      && request.headers['x-arcade-dev-admin'] === 'true') {
      return { email: 'local-arcade-admin@twilio.com' };
    }
    const principal = analyticsAuth.currentUser(request);
    return principal && arcadeAdminEmails.has(principal.email) ? principal : null;
  },
});
arcadeTacGateway?.setMessageHandler(async input => {
  const author = input.channel === 'whatsapp' && !input.author.toLowerCase().startsWith('whatsapp:')
    ? `whatsapp:${input.author}`
    : input.author;
  return arcadeApi.processMessagingWebhook({
    from: author,
    body: input.message,
    providerMessageId: input.providerMessageId,
    conversationProfileId: input.profileId,
    conversationId: input.conversationId,
    recalledLocale: recalledMemoryLocale(input.memory),
  });
});
// Deploy-safe levels: the LIVE maps file lives on the persistent mount (data/maps.json) so editor-
// authored levels survive redeploys; the image's committed assets/maps/maps.json is the one-time
// SEED copied in on first boot when the persistent file doesn't exist yet.
const srv = new HttpServer({
  port, publicBaseUrl, authToken, additionalAuthTokens, validateSignatures, editorToken,
  analyticsAuth, arcadeApi, arcadeTacGateway,
  analyticsPath: process.env.ANALYTICS_PATH ?? 'data/analytics.json',
  googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  mapsPath: process.env.MAPS_PATH ?? 'data/maps.json',
  bundledMapsPath: process.env.BUNDLED_MAPS_PATH ?? 'assets/maps/maps.json',
  // Voice Monsters arena config — live on the persistent mount, seeded from the committed default.
  arenaPath: process.env.ARENA_PATH ?? 'data/arena.json',
  bundledArenaPath: process.env.BUNDLED_ARENA_PATH ?? 'assets/arena/arena.json',
  fighterMapsPath: process.env.FIGHTER_MAPS_PATH ?? 'data/fighter-maps.json',
  bundledFighterMapsPath: process.env.BUNDLED_FIGHTER_MAPS_PATH ?? 'assets/fighters/maps/maps.json',
  fighterPreviewDir: process.env.FIGHTER_PREVIEW_DIR ?? 'data/fighter-previews',
  fighterDisplayToken: process.env.ARCADE_DISPLAY_TOKEN ?? process.env.FIGHTER_DISPLAY_TOKEN,
  // The number players call to join (shown + QR-encoded on the lobby screen). Unset → placeholder.
  gamePhoneNumber: process.env.GAME_PHONE_NUMBER,
  smsNumber: smsNumber ?? undefined,
  whatsappNumber: whatsappNumber ?? undefined,
});
srv.start().then((p) => {
  console.log(`Voice Racer listening on http://localhost:${p}`);
  console.log(`  game WS: ws://localhost:${p}/game   voice WS: ws://localhost:${p}/voice`);
  console.log(`  webhooks: POST ${publicBaseUrl}/voice/incoming , /voice/join`);
  console.log(`  twilio signature validation: ${validateSignatures ? 'ON' : 'OFF'}`);
});
const shutdown = () => srv.stop().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function whatsappContentSidEnvironmentName(
  kind: ArcadeStationNotificationKind,
  locale: 'en-US' | 'pt-BR',
): string {
  return `TWILIO_WHATSAPP_CONTENT_SID_${kind}_${locale === 'pt-BR' ? 'PT_BR' : 'EN_US'}`;
}

function configuredMessagingSender(value: string | undefined): string | null {
  const normalized = (value?.trim() ?? '').replace(/^whatsapp:/i, '');
  return /^\+[1-9][0-9]{7,14}$/.test(normalized) ? normalized : null;
}

function configuredCredential(value: string | undefined, pattern?: RegExp): boolean {
  const normalized = value?.trim() ?? '';
  return normalized !== '' && normalized !== 'disabled' && (!pattern || pattern.test(normalized));
}
