import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import twilio from 'twilio';
import type { ArcadeApi } from '../server/arcade-api';
import { HttpServer } from '../server/http-server';

const AUTH_TOKEN = 'test-status-callback-token';
const NOTIFICATION_ID = `outbound:${'a'.repeat(64)}`;
const ATTEMPT_ID = `${NOTIFICATION_ID}:attempt:1`;
const MESSAGE_SID = `SM${'b'.repeat(32)}`;
let server: HttpServer | undefined;
let directory: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('Twilio messaging status callback', () => {
  it('validates the exact URL including query parameters and forwards evolving form fields', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'arcade-status-api-'));
    const recordStatus = vi.fn(async () => true);
    const arcadeApi = {
      start: async () => undefined,
      stop: async () => undefined,
      activateMessagingDelivery: async () => undefined,
      getHealthStatus: () => ({ degraded: false }),
      isStationEngineRoom: () => false,
      processMessagingStatusCallback: recordStatus,
    } as unknown as ArcadeApi;
    server = new HttpServer({
      port: 0,
      publicBaseUrl: 'http://localhost',
      authToken: AUTH_TOKEN,
      validateSignatures: true,
      arcadeApi,
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
    const query = `?n=${encodeURIComponent(NOTIFICATION_ID)}&a=${encodeURIComponent(ATTEMPT_ID)}`;
    const signedUrl = `http://localhost/twilio/messaging/status${query}`;
    const params = {
      AccountSid: `AC${'c'.repeat(32)}`,
      MessageSid: MESSAGE_SID,
      MessageStatus: 'delivered',
      ErrorCode: '',
      FutureTwilioField: 'accepted-for-signature-validation',
    };
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, signedUrl, params);
    const send = (targetQuery: string, targetSignature: string) => fetch(
      `http://127.0.0.1:${port}/twilio/messaging/status${targetQuery}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': targetSignature,
        },
        body: new URLSearchParams(params),
      },
    );

    expect((await send(query, signature)).status).toBe(204);
    expect(recordStatus).toHaveBeenCalledWith({
      notificationId: NOTIFICATION_ID,
      attemptId: ATTEMPT_ID,
      providerMessageId: MESSAGE_SID,
      providerStatus: 'delivered',
      errorCode: null,
      errorMessage: null,
    });
    expect((await send(`${query}x`, signature)).status).toBe(403);
    expect(recordStatus).toHaveBeenCalledTimes(1);
  });
});
