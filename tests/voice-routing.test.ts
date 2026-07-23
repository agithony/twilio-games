import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ArcadeApi } from '../server/arcade-api';
import { HttpServer } from '../server/http-server';
import type { SupportedLocale } from '../shared/i18n/locales';

type StationVoiceRoute = Awaited<ReturnType<ArcadeApi['stationVoiceRoute']>>;

let server: HttpServer | undefined;
let directory: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.restoreAllMocks();
});

async function harness(options: {
  active: boolean;
  activeChecks?: readonly boolean[];
  locale?: SupportedLocale;
  route?: StationVoiceRoute;
  routeError?: Error;
  standaloneVoiceEnabled?: boolean;
  authToken?: string;
  additionalAuthTokens?: readonly string[];
}) {
  directory = await mkdtemp(path.join(tmpdir(), 'voice-routing-'));
  const stationVoiceRoute = vi.fn(async () => {
    if (options.routeError) throw options.routeError;
    return options.route ?? null;
  });
  const voiceLocaleForNumber = vi.fn(() => options.locale ?? 'en-US');
  let activeCheck = 0;
  const arcadeApi = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    activateMessagingDelivery: vi.fn(async () => undefined),
    getHealthStatus: vi.fn(() => ({ degraded: false })),
    isStationEngineRoom: vi.fn(() => false),
    requiresStationVoiceAssignment: vi.fn(() => {
      const checks = options.activeChecks;
      return checks?.[Math.min(activeCheck++, checks.length - 1)] ?? options.active;
    }),
    voiceLocaleForNumber,
    stationVoiceRoute,
  } as unknown as ArcadeApi;
  server = new HttpServer({
    port: 0,
    publicBaseUrl: 'http://localhost',
    authToken: options.authToken,
    additionalAuthTokens: options.additionalAuthTokens,
    validateSignatures: Boolean(options.authToken),
    arcadeApi,
    standaloneVoiceEnabled: options.standaloneVoiceEnabled ?? false,
    analyticsPath: path.join(directory, 'analytics.json'),
    manifestPath: path.join(directory, 'manifest.json'),
    mapsPath: path.join(directory, 'maps.json'),
    arenaPath: path.join(directory, 'arena.json'),
    leaderboardPath: path.join(directory, 'leaderboard.json'),
    fighterMapsPath: path.join(directory, 'fighter-maps.json'),
    fighterPreviewDir: path.join(directory, 'fighter-previews'),
    clientDir: path.join(directory, 'client'),
  });
  const port = await server.start();
  return { port, stationVoiceRoute, voiceLocaleForNumber };
}

async function incomingCall(port: number, input: {
  from?: string;
  to?: string;
  callSid?: string;
  signature?: string;
} = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/voice/incoming`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(input.signature ? { 'X-Twilio-Signature': input.signature } : {}),
    },
    body: new URLSearchParams({
      From: input.from ?? '+14155550199',
      To: input.to ?? '+18555993809',
      CallSid: input.callSid ?? 'CA-voice-routing',
    }),
  });
}

describe('Arcade Voice routing', () => {
  it.each([
    ['en-US', 'Twilio Games is currently paused or unavailable. Please try again when the event is open. Goodbye.'],
    ['pt-BR', 'O Twilio Games está pausado ou indisponível no momento. Tente novamente quando o evento estiver aberto. Até logo.'],
  ] as const)('returns localized Say and Hangup while event mode is off (%s)', async (locale, message) => {
    const { port, stationVoiceRoute } = await harness({ active: false, locale });
    const response = await incomingCall(port);
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    expect(xml).toContain(`<Say language="${locale}">${message}</Say>`);
    expect(xml).toContain('<Hangup />');
    expect(xml).not.toContain('<Connect');
    expect(xml).not.toContain('<ConversationRelay');
    expect(stationVoiceRoute).not.toHaveBeenCalled();
  });

  it('does not route a retained admitted match after the event is paused', async () => {
    const retainedRoute: NonNullable<StationVoiceRoute> = {
      game: 'racer', roomCode: 'STALE-ROOM', matchId: 'stale-match', launchGeneration: 2,
      admitted: true, readyEntryId: 'stale-ready-entry',
    };
    const { port, stationVoiceRoute } = await harness({ active: false, route: retainedRoute });
    const xml = await (await incomingCall(port)).text();

    expect(stationVoiceRoute).not.toHaveBeenCalled();
    expect(xml).toContain('<Hangup />');
    expect(xml).not.toContain('STALE-ROOM');
    expect(xml).not.toContain('<ConversationRelay');
  });

  it('drops a station route if the event is paused while routing the call', async () => {
    const route: NonNullable<StationVoiceRoute> = {
      game: 'racer', roomCode: 'JUST-PAUSED', matchId: 'paused-match', launchGeneration: 3,
      admitted: true, readyEntryId: 'paused-ready-entry',
    };
    const { port, stationVoiceRoute } = await harness({
      active: true, activeChecks: [true, false], route,
    });
    const xml = await (await incomingCall(port)).text();

    expect(stationVoiceRoute).toHaveBeenCalledOnce();
    expect(xml).toContain('<Hangup />');
    expect(xml).not.toContain('JUST-PAUSED');
    expect(xml).not.toContain('<ConversationRelay');
  });

  it('allows explicit standalone Voice routing without consulting retained station state', async () => {
    const { port, stationVoiceRoute } = await harness({
      active: false, standaloneVoiceEnabled: true,
    });
    const xml = await (await incomingCall(port)).text();

    expect(stationVoiceRoute).not.toHaveBeenCalled();
    expect(xml).toContain('<Connect');
    expect(xml).toContain('<ConversationRelay');
    expect(xml).toContain('<Parameter name="roomCode" value="4821"');
  });

  it('keeps active-event admitted station routing unchanged', async () => {
    const route: NonNullable<StationVoiceRoute> = {
      game: 'monsters', roomCode: 'EVENT-ROOM', matchId: 'match-1', launchGeneration: 4,
      admitted: true, readyEntryId: 'ready-1',
    };
    const { port, stationVoiceRoute } = await harness({ active: true, route });
    const xml = await (await incomingCall(port, { callSid: 'CA-active' })).text();

    expect(stationVoiceRoute).toHaveBeenCalledWith('+14155550199', 'CA-active');
    expect(xml).toContain('<ConversationRelay');
    expect(xml).toContain('<Parameter name="roomCode" value="EVENT-ROOM"');
    expect(xml).toContain('<Parameter name="game" value="monsters"');
    expect(xml).toContain('<Parameter name="matchId" value="match-1"');
    expect(xml).toContain('<Parameter name="launchGeneration" value="4"');
  });

  it('returns unavailable TwiML when active station routing fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { port } = await harness({
      active: true, locale: 'pt-BR', routeError: new Error('state read failed'),
    });
    const response = await incomingCall(port);
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain('O Twilio Games está pausado ou indisponível no momento.');
    expect(xml).toContain('<Hangup />');
    expect(xml).not.toContain('<ConversationRelay');
    expect(errorLog).toHaveBeenCalledWith('[voice] station routing failed:', 'state read failed');
  });

  it('rejects an invalid signature before locale or station routing', async () => {
    const { port, stationVoiceRoute, voiceLocaleForNumber } = await harness({
      active: true,
      authToken: 'primary-auth-token',
      additionalAuthTokens: ['secondary-auth-token'],
    });
    const response = await incomingCall(port, { signature: 'invalid-signature' });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('invalid signature');
    expect(voiceLocaleForNumber).not.toHaveBeenCalled();
    expect(stationVoiceRoute).not.toHaveBeenCalled();
  });
});
