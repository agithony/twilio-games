import { describe, expect, it } from 'vitest';
import {
  ARCADE_CONFIG_SCHEMA_VERSION,
  ArcadeConfigValidationError,
  DEFAULT_ARCADE_CONFIG,
  createArcadeConfigSnapshot,
  createDefaultArcadeConfig,
  normalizeCountryCode,
  parseArcadeConfig,
  parseArcadeConfigSettings,
  projectPublicArcadeConfig,
  replaceArcadeConfigSettings,
} from '../shared/arcade-config';

function rawConfig(): any {
  return JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG));
}

function rawSettings(): any {
  const { schemaVersion: _schemaVersion, version: _version, updatedAt: _updatedAt, updatedBy: _updatedBy,
    ...settings } = rawConfig();
  return settings;
}

function expectInvalid(candidate: unknown): void {
  expect(() => parseArcadeConfig(candidate)).toThrow(ArcadeConfigValidationError);
}

describe('Twilio Arcade runtime configuration', () => {
  it('ships revision 1 of schema 1 in mode off with the complete approved defaults', () => {
    expect(DEFAULT_ARCADE_CONFIG.schemaVersion).toBe(ARCADE_CONFIG_SCHEMA_VERSION);
    expect(DEFAULT_ARCADE_CONFIG.version).toBe(1);
    expect(DEFAULT_ARCADE_CONFIG.arcade.mode).toBe('off');
    expect(DEFAULT_ARCADE_CONFIG.coins).toMatchObject({
      startingBalance: 1,
      defaultGameCost: 1,
      gameCosts: { racer: 1, monsters: 1, fighter: 1, trivia: 1 },
      chargePolicy: 'per_player',
      consumeWhen: 'match_start',
    });
    expect(DEFAULT_ARCADE_CONFIG.queue).toMatchObject({
      maximumWaitingPlayers: 250,
      checkInWindowSeconds: 60,
      baseJoinWindowSeconds: 45,
      readyGraceSeconds: 20,
      hardStartDeadlineSeconds: 90,
    });
    expect(DEFAULT_ARCADE_CONFIG.channels).toEqual({ voice: true, sms: false, whatsapp: false });
    expect(DEFAULT_ARCADE_CONFIG.postGame.enabled).toBe(false);
    expect(DEFAULT_ARCADE_CONFIG.postGame.channels).toEqual([]);
    expect(DEFAULT_ARCADE_CONFIG.intelligence.enabled).toBe(false);
  });

  it('contains exactly the six approved registration fields and no verification workflow', () => {
    const fields = DEFAULT_ARCADE_CONFIG.registration.fields;
    expect(fields.map(field => field.key)).toEqual([
      'firstName', 'lastName', 'workEmail', 'companyName', 'phoneNumber', 'countryCode',
    ]);
    expect(fields.every(field => field.enabled && field.required)).toBe(true);
    expect(fields.find(field => field.key === 'workEmail')).toMatchObject({ verify: false });
    expect(fields.find(field => field.key === 'phoneNumber')).toMatchObject({ verify: false });
    expect(fields.find(field => field.key === 'countryCode')).toMatchObject({ length: 2 });
    expect(fields.some(field => (field.key as string) === 'jobTitle')).toBe(false);
  });

  it.each(['off', 'coin_only', 'lead_capture'] as const)('accepts mode %s', mode => {
    const candidate = rawConfig();
    candidate.arcade.mode = mode;
    expect(parseArcadeConfig(candidate).arcade.mode).toBe(mode);
  });

  it('requires every field and requiredByDefault in lead_capture mode', () => {
    for (const change of [
      (candidate: any) => { candidate.registration.fields[0].enabled = false; candidate.registration.fields[0].required = false; },
      (candidate: any) => { candidate.registration.fields[0].required = false; },
      (candidate: any) => { candidate.registration.requiredByDefault = false; },
    ]) {
      const candidate = rawConfig();
      candidate.arcade.mode = 'lead_capture';
      change(candidate);
      expectInvalid(candidate);
    }
  });

  it('rejects duplicate, missing, extra, and altered registration fields', () => {
    const duplicate = rawConfig();
    duplicate.registration.fields[5] = { ...duplicate.registration.fields[0] };
    expectInvalid(duplicate);

    const missing = rawConfig();
    missing.registration.fields.pop();
    expectInvalid(missing);

    const jobTitle = rawConfig();
    jobTitle.registration.fields[5] = { key: 'jobTitle', enabled: true, required: true };
    expectInvalid(jobTitle);

    const verified = rawConfig();
    verified.registration.fields[2].verify = true;
    expectInvalid(verified);

    const longCountry = rawConfig();
    longCountry.registration.fields[5].length = 3;
    expectInvalid(longCountry);
  });

  it('normalizes safe text and timezone-bearing ISO timestamps', () => {
    const candidate = rawConfig();
    candidate.updatedBy = '  admin@example.com  ';
    candidate.arcade.displayName = '  Cafe\u0301 Arcade  ';
    candidate.earning.challenges = [{
      id: 'voice-docs',
      title: '  Voice docs  ',
      url: '  https://www.twilio.com/docs/voice  ',
      rewardCoins: 1,
      enabled: true,
      maxClaimsPerPlayer: 1,
      displayOrder: 0,
      startsAt: '2026-07-20T01:00:00-04:00',
      endsAt: '2026-07-20T06:00:00Z',
    }];
    const parsed = parseArcadeConfig(candidate);
    expect(parsed.updatedBy).toBe('admin@example.com');
    expect(parsed.arcade.displayName).toBe('Café Arcade');
    expect(parsed.earning.challenges[0]).toMatchObject({
      title: 'Voice docs',
      url: 'https://www.twilio.com/docs/voice',
      startsAt: '2026-07-20T05:00:00.000Z',
      endsAt: '2026-07-20T06:00:00.000Z',
    });
  });

  it('normalizes the country input contract without deciding the UK-to-GB integration question', () => {
    expect(normalizeCountryCode(' us ')).toBe('US');
    expect(normalizeCountryCode('uk')).toBe('UK');
    expect(() => normalizeCountryCode('USA')).toThrow(ArcadeConfigValidationError);
    expect(() => normalizeCountryCode('éx')).toThrow(ArcadeConfigValidationError);
  });

  it('rejects unknown fields at every level', () => {
    const root = rawConfig();
    root.secret = true;
    expectInvalid(root);

    const nested = rawConfig();
    nested.coins.gameCosts.pong = 1;
    expectInvalid(nested);

    const challenge = rawConfig();
    challenge.earning.challenges = [{
      id: 'docs', title: 'Docs', url: 'https://twilio.com', rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null, proof: 'none',
    }];
    expectInvalid(challenge);
  });

  it('rejects prototype-polluting keys and unsafe object prototypes', () => {
    const pollutedKey = JSON.stringify(rawConfig()).replace(
      '"displayName":"Twilio Arcade"',
      '"displayName":"Twilio Arcade","__proto__":{"polluted":true}',
    );
    expectInvalid(pollutedKey);

    const constructorKey = JSON.stringify(rawConfig()).replace(
      '"voice":true',
      '"voice":true,"constructor":{"prototype":{"polluted":true}}',
    );
    expectInvalid(constructorKey);

    const candidate = rawConfig();
    Object.setPrototypeOf(candidate.queue, { injected: true });
    expectInvalid(candidate);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects malformed JSON and non-object roots', () => {
    expectInvalid('{bad json');
    expectInvalid(null);
    expectInvalid([]);
  });

  it('accepts a complete valid challenge and rejects duplicate IDs', () => {
    const candidate = rawConfig();
    const challenge = {
      id: 'voice-docs', title: 'Explore Voice', url: 'https://www.twilio.com/docs/voice',
      rewardCoins: 2, enabled: true, maxClaimsPerPlayer: 1, displayOrder: 1,
      startsAt: null, endsAt: null,
    };
    candidate.earning.challenges = [challenge];
    expect(parseArcadeConfig(candidate).earning.challenges[0]).toMatchObject(challenge);
    candidate.earning.challenges.push({ ...challenge, title: 'Duplicate' });
    expectInvalid(candidate);
  });

  it.each([
    '../admin',
    'Voice_Docs',
    '-voice-docs',
    'voice/docs',
    'constructor',
  ])('rejects unsafe challenge ID %s', id => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id, title: 'Docs', url: 'https://twilio.com', rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    expectInvalid(candidate);
  });

  it.each([
    'http://www.twilio.com/docs',
    '/relative',
    'javascript:alert(1)',
    'https://user:password@example.com/docs',
  ])('rejects unsafe challenge URL %s', url => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id: 'docs', title: 'Docs', url, rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    expectInvalid(candidate);
  });

  it('canonicalizes accepted HTTPS destinations with URL.href', () => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id: 'docs', title: 'Docs',
      url: ' https://WWW.TWILIO.COM:443/products/../docs/voice?q=hello world#start ',
      rewardCoins: 1, enabled: true, maxClaimsPerPlayer: 1, displayOrder: 1,
      startsAt: null, endsAt: null,
    }];
    expect(parseArcadeConfig(candidate).earning.challenges[0]!.url).toBe(
      'https://www.twilio.com/docs/voice?q=hello%20world#start',
    );
  });

  it.each([
    'https://localhost/docs',
    'https://arcade.local/docs',
    'https://intranet/docs',
    'https://127.0.0.1/docs',
    'https://127.1/docs',
    'https://10.2.3.4/docs',
    'https://172.16.0.1/docs',
    'https://192.168.1.1/docs',
    'https://169.254.1.1/docs',
    'https://[::1]/docs',
    'https://[fd00::1]/docs',
    'https://[fe80::1]/docs',
    'https://[::ffff:127.0.0.1]/docs',
  ])('rejects loopback, private, or local challenge destination %s', url => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id: 'docs', title: 'Docs', url, rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    expectInvalid(candidate);
  });

  it.each([
    ['not-a-date', null],
    ['2026-02-30T00:00:00Z', null],
    ['2026-07-20T00:00:00', null],
    ['2026-07-20T02:00:00Z', '2026-07-20T01:00:00Z'],
    ['2026-07-20T01:00:00Z', '2026-07-20T01:00:00Z'],
  ])('rejects invalid challenge schedule %s to %s', (startsAt, endsAt) => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id: 'docs', title: 'Docs', url: 'https://twilio.com', rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt, endsAt,
    }];
    expectInvalid(candidate);
  });

  it('rejects invalid number ranges and non-integers', () => {
    for (const change of [
      (candidate: any) => { candidate.version = 0; },
      (candidate: any) => { candidate.coins.startingBalance = -1; },
      (candidate: any) => { candidate.coins.defaultGameCost = 1.5; },
      (candidate: any) => { candidate.earning.defaultRewardCoins = 0; },
      (candidate: any) => { candidate.queue.maximumWaitingPlayers = 0; },
      (candidate: any) => { candidate.queue.snoozeSeconds = 86_401; },
    ]) {
      const candidate = rawConfig();
      change(candidate);
      expectInvalid(candidate);
    }
  });

  it('accepts documented milestone maxima and rejects values immediately above them', () => {
    const atLimit = rawConfig();
    atLimit.coins.startingBalance = 100;
    atLimit.coins.defaultGameCost = 100;
    atLimit.coins.gameCosts = { racer: 100, monsters: 100, fighter: 100, trivia: 100 };
    atLimit.earning.defaultRewardCoins = 100;
    atLimit.earning.challenges = [{
      id: 'docs', title: 'Docs', url: 'https://www.twilio.com/docs', rewardCoins: 100,
      enabled: true, maxClaimsPerPlayer: 100, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    atLimit.queue.maximumWaitingPlayers = 5_000;
    expect(parseArcadeConfig(atLimit)).toMatchObject({
      coins: { startingBalance: 100, defaultGameCost: 100 },
      queue: { maximumWaitingPlayers: 5_000 },
    });

    for (const change of [
      (candidate: any) => { candidate.coins.startingBalance = 101; },
      (candidate: any) => { candidate.coins.defaultGameCost = 101; },
      (candidate: any) => { candidate.coins.gameCosts.racer = 101; },
      (candidate: any) => { candidate.earning.defaultRewardCoins = 101; },
      (candidate: any) => { candidate.queue.maximumWaitingPlayers = 5_001; },
      (candidate: any) => {
        candidate.earning.challenges = [{
          id: 'docs', title: 'Docs', url: 'https://www.twilio.com/docs', rewardCoins: 101,
          enabled: true, maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
        }];
      },
      (candidate: any) => {
        candidate.earning.challenges = [{
          id: 'docs', title: 'Docs', url: 'https://www.twilio.com/docs', rewardCoins: 1,
          enabled: true, maxClaimsPerPlayer: 101, displayOrder: 1, startsAt: null, endsAt: null,
        }];
      },
    ]) {
      const candidate = rawConfig();
      change(candidate);
      expectInvalid(candidate);
    }
  });

  it('bounds challenge count, post-game channels, identifiers, and display text', () => {
    const challenges = rawConfig();
    challenges.earning.challenges = Array.from({ length: 101 }, (_, index) => ({
      id: `challenge-${index}`, title: `Challenge ${index}`, url: 'https://www.twilio.com/docs',
      rewardCoins: 1, enabled: true, maxClaimsPerPlayer: 1, displayOrder: index,
      startsAt: null, endsAt: null,
    }));
    expectInvalid(challenges);

    const channels = rawConfig();
    channels.postGame.channels = ['sms', 'whatsapp', 'sms'];
    expectInvalid(channels);

    const cabinetId = rawConfig();
    cabinetId.arcade.cabinetId = 'a'.repeat(65);
    expectInvalid(cabinetId);

    const title = rawConfig();
    title.earning.challenges = [{
      id: 'docs', title: 'a'.repeat(201), url: 'https://www.twilio.com/docs', rewardCoins: 1,
      enabled: true, maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    expectInvalid(title);

    const challengeId = rawConfig();
    challengeId.earning.challenges = [{
      id: 'a'.repeat(65), title: 'Docs', url: 'https://www.twilio.com/docs', rewardCoins: 1,
      enabled: true, maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    expectInvalid(challengeId);
  });

  it('rejects timer and no-show relationships that cannot honor the hard deadline', () => {
    for (const change of [
      (candidate: any) => { candidate.queue.checkInWindowSeconds = 91; },
      (candidate: any) => { candidate.queue.baseJoinWindowSeconds = 71; },
      (candidate: any) => { candidate.queue.automaticDeferrals = 2; },
    ]) {
      const candidate = rawConfig();
      change(candidate);
      expectInvalid(candidate);
    }
  });

  it('rejects invalid enum values and duplicate post-game channels', () => {
    const charge = rawConfig();
    charge.coins.chargePolicy = 'per_ai';
    expectInvalid(charge);

    const consume = rawConfig();
    consume.coins.consumeWhen = 'check_in';
    expectInvalid(consume);

    const channels = rawConfig();
    channels.postGame.channels = ['sms', 'sms'];
    expectInvalid(channels);
  });

  it('accepts only currently modeled charge policies while retaining future-facing types', () => {
    const free = rawConfig();
    free.coins.chargePolicy = 'free';
    expect(parseArcadeConfig(free).coins.chargePolicy).toBe('free');

    for (const policy of ['per_match', 'host_sponsors']) {
      const candidate = rawConfig();
      candidate.coins.chargePolicy = policy;
      expectInvalid(candidate);
    }
  });

  it('returns detached, deeply immutable snapshots', () => {
    const candidate = rawConfig();
    const snapshot = createArcadeConfigSnapshot(candidate);
    candidate.arcade.displayName = 'Changed outside';
    candidate.registration.fields[0].required = false;
    expect(snapshot.arcade.displayName).toBe('Twilio Arcade');
    expect(snapshot.registration.fields[0]!.required).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.coins.gameCosts)).toBe(true);
    expect(Object.isFrozen(snapshot.registration.fields)).toBe(true);
    expect(() => { (snapshot.arcade as any).mode = 'lead_capture'; }).toThrow(TypeError);

    const firstDefault = createDefaultArcadeConfig();
    const secondDefault = createDefaultArcadeConfig();
    expect(firstDefault).not.toBe(secondDefault);
    expect(firstDefault.arcade).not.toBe(secondDefault.arcade);
  });

  it('projects a frozen public config without server identity or direct challenge destinations', () => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id: 'docs', title: 'Docs', url: 'https://twilio.com/docs', rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    const projected = projectPublicArcadeConfig(candidate);
    expect(projected.version).toBe(1);
    expect(projected.arcade.mode).toBe('off');
    expect(projected).not.toHaveProperty('updatedAt');
    expect(projected).not.toHaveProperty('updatedBy');
    expect(projected.earning.challenges[0]).not.toHaveProperty('url');
    expect(Object.isFrozen(projected.earning.challenges[0])).toBe(true);
    candidate.earning.challenges[0].title = 'Changed';
    expect(projected.earning.challenges[0]!.title).toBe('Docs');
  });

  it('parses only full settings payloads for replacement', () => {
    const settings = rawSettings();
    expect(parseArcadeConfigSettings(settings).arcade.mode).toBe('off');
    delete settings.queue;
    expect(() => parseArcadeConfigSettings(settings)).toThrow(ArcadeConfigValidationError);

    const withMetadata = rawSettings();
    withMetadata.version = 99;
    expect(() => parseArcadeConfigSettings(withMetadata)).toThrow(ArcadeConfigValidationError);
  });

  it('replaces all settings, preserves server metadata, and advances revision exactly once', () => {
    const current = rawConfig();
    current.version = 41;
    current.updatedAt = '2026-07-20T00:00:00.000Z';
    current.updatedBy = 'original@example.com';
    const replacement = rawSettings();
    replacement.arcade.mode = 'coin_only';
    replacement.arcade.displayName = 'New Arcade';
    replacement.coins.startingBalance = 3;

    const updated = replaceArcadeConfigSettings(current, replacement);
    expect(updated).toMatchObject({
      schemaVersion: 1,
      version: 42,
      updatedAt: '2026-07-20T00:00:00.000Z',
      updatedBy: 'original@example.com',
      arcade: { mode: 'coin_only', displayName: 'New Arcade' },
      coins: { startingBalance: 3 },
    });
    expect(current.version).toBe(41);
    expect(replacement).not.toHaveProperty('version');
  });

  it('accepts trusted update metadata separately without allowing it to control the revision', () => {
    const current = rawConfig();
    current.version = 9;
    const updated = replaceArcadeConfigSettings(current, rawSettings(), {
      updatedAt: '2026-07-20T12:34:56Z',
      updatedBy: ' admin@example.com ',
    });
    expect(updated.version).toBe(10);
    expect(updated.schemaVersion).toBe(1);
    expect(updated.updatedAt).toBe('2026-07-20T12:34:56.000Z');
    expect(updated.updatedBy).toBe('admin@example.com');
  });

  it('does not conflate schemaVersion with revision version', () => {
    const wrongSchema = rawConfig();
    wrongSchema.schemaVersion = 2;
    wrongSchema.version = 100;
    expectInvalid(wrongSchema);

    const highRevision = rawConfig();
    highRevision.version = 100;
    expect(parseArcadeConfig(highRevision)).toMatchObject({ schemaVersion: 1, version: 100 });
  });
});
