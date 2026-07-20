import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ARCADE_CONFIG,
  parseArcadeConfig,
  type ArcadeConfigSnapshot,
  type ArcadeMode,
} from '../shared/arcade-config';
import { availableBalance } from '../shared/arcade-domain';
import {
  ArcadeService,
  type ClaimArcadeChallengeInput,
  type RegisterArcadePlayerInput,
} from '../server/arcade-service';
import { ArcadeStateStore } from '../server/arcade-state-store';
import { signArcadeChallengeToken } from '../server/arcade-challenge-token';

const directories: string[] = [];
const T0 = Date.parse('2026-07-20T10:00:00.000Z');
const TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
const OPERATOR_AUTHORIZATION = Object.freeze({ token: 'trusted-test-operator' });
const OPERATOR = Object.freeze({ authorization: OPERATOR_AUTHORIZATION });

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function arcadeConfig(
  mode: ArcadeMode = 'lead_capture',
  overrides: {
    startingBalance?: number;
    rewardCoins?: number;
    version?: number;
    maxClaimsPerPlayer?: number;
    chargePolicy?: 'per_player' | 'per_match' | 'host_sponsors' | 'free';
    refundOnLobbyTimeout?: boolean;
    gameCosts?: Partial<Record<'racer' | 'monsters' | 'fighter' | 'trivia', number>>;
  } = {},
): ArcadeConfigSnapshot {
  const input = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
  input.version = overrides.version ?? 1;
  input.updatedAt = '2026-07-20T00:00:00.000Z';
  input.arcade.mode = mode;
  input.coins.startingBalance = overrides.startingBalance ?? 2;
  const chargePolicy = overrides.chargePolicy ?? 'per_player';
  input.coins.chargePolicy = chargePolicy === 'per_match' || chargePolicy === 'host_sponsors'
    ? 'per_player'
    : chargePolicy;
  input.coins.refundOnLobbyTimeout = overrides.refundOnLobbyTimeout ?? true;
  input.coins.gameCosts = {
    racer: 1, monsters: 1, fighter: 1, trivia: 1, ...overrides.gameCosts,
  };
  input.earning.challenges = [{
    id: 'voice-docs',
    title: 'Read the Voice docs',
    url: 'https://www.twilio.com/docs/voice',
    rewardCoins: overrides.rewardCoins ?? 1,
    enabled: true,
    maxClaimsPerPlayer: overrides.maxClaimsPerPlayer ?? 1,
    displayOrder: 0,
    startsAt: null,
    endsAt: null,
  }];
  const parsed = parseArcadeConfig(input);
  return chargePolicy === 'per_match' || chargePolicy === 'host_sponsors'
    ? { ...parsed, coins: { ...parsed.coins, chargePolicy } }
    : parsed;
}

interface Harness {
  file: string;
  store: ArcadeStateStore;
  service: ArcadeService;
  setTime: (milliseconds: number) => void;
  setConfig: (config: ArcadeConfigSnapshot) => void;
}

async function harness(initialConfig = arcadeConfig()): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcade-service-'));
  directories.push(directory);
  const file = path.join(directory, 'state.json');
  const store = await ArcadeStateStore.open(file);
  let now = T0;
  let config = initialConfig;
  let sequence = 0;
  const service = new ArcadeService({
    store,
    config: () => config,
    clock: () => now,
    idGenerator: kind => `${kind}-${++sequence}`,
    challengeTokenSecret: TOKEN_SECRET,
    operatorAuthorizer: authorization => authorization === OPERATOR_AUTHORIZATION
      ? { kind: 'operator', subject: 'operator:test' }
      : null,
  });
  return {
    file,
    store,
    service,
    setTime: value => { now = value; },
    setConfig: value => { config = value; },
  };
}

function challengeToken(
  player = 'p1',
  jti = `challenge-token:${player}`,
  audience = 'ARCADE-01',
): string {
  const issuedAt = Math.floor(T0 / 1000);
  return signArcadeChallengeToken({
    v: 1,
    player,
    challenge: 'voice-docs',
    audience,
    jti,
    issuedAt,
    expiry: issuedAt + 900,
  }, TOKEN_SECRET);
}

function registration(playerId: string, idempotencyKey = `register:${playerId}`): RegisterArcadePlayerInput {
  return {
    playerId,
    destination: `+1415555${playerId === 'p1' ? '0101' : '0202'}`,
    idempotencyKey,
    lead: {
      firstName: ' Ada ',
      lastName: ' Lovelace ',
      workEmail: `${playerId.toUpperCase()}@EXAMPLE.COM`,
      companyName: ' Analytical Engines ',
      phoneNumber: '+1 (415) 555-0199',
      countryCode: ' uk ',
    },
    termsAccepted: true,
    marketingConsent: false,
  };
}

async function moveToLobby(h: Harness, playerId: string, prefix: string): Promise<string> {
  const joined = await h.service.joinQueue({
    playerId, preferredGame: 'racer', idempotencyKey: `${prefix}:join`,
  });
  const queueEntryId = joined.entry.id;
  await h.service.markApproaching({ playerId, queueEntryId, idempotencyKey: `${prefix}:approach`, ...OPERATOR });
  await h.service.confirmPresence({ playerId, queueEntryId, idempotencyKey: `${prefix}:confirm` });
  await h.service.callQueueEntry({ playerId, queueEntryId, idempotencyKey: `${prefix}:call`, ...OPERATOR });
  await h.service.checkInQueueEntry({
    playerId, queueEntryId, game: 'racer', idempotencyKey: `${prefix}:check-in`,
  });
  await h.service.activateLobby({ playerId, queueEntryId, idempotencyKey: `${prefix}:lobby`, ...OPERATOR });
  return queueEntryId;
}

describe('ArcadeService durable journey', () => {
  it('identifies coin-only players and issues the starting grant once', async () => {
    const h = await harness(arcadeConfig('coin_only', { startingBalance: 2 }));
    const first = await h.service.identifyCoinOnly({
      playerId: 'trusted:p1', destination: '+14155550101', idempotencyKey: 'coin:identify',
    });
    const updated = await h.service.identifyCoinOnly({
      playerId: 'trusted:p1', destination: '+14155550102', idempotencyKey: 'coin:update',
    });
    expect(first.player.lead).toBeNull();
    expect(updated.player.trustedDestination).toBe('+14155550102');
    expect(h.store.snapshot().wallets['trusted:p1']?.transactions
      .filter(item => item.type === 'registration_grant')).toHaveLength(1);
    expect(updated.availableBalance).toBe(2);
    await expect(h.service.registerPlayer(registration('trusted:p1'))).rejects.toMatchObject({ code: 'MODE_DISABLED' });
  });

  it('registers, grants, queues, checks in, redeems, rewards, and queues again', async () => {
    const h = await harness(arcadeConfig('lead_capture', { startingBalance: 2, rewardCoins: 1 }));
    const registered = await h.service.registerPlayer(registration('p1'));
    expect(registered.player.lead).toMatchObject({
      firstName: 'Ada', workEmail: 'p1@example.com', phoneNumber: '+14155550199', countryCode: 'UK',
    });
    expect(registered.availableBalance).toBe(2);
    expect(h.store.snapshot().wallets.p1?.transactions
      .filter(transaction => transaction.type === 'registration_grant')).toHaveLength(1);

    const joined = await h.service.joinQueue({
      playerId: 'p1', preferredGame: 'racer', idempotencyKey: 'journey:join',
    });
    expect(joined.reservation).toBeNull();
    expect(joined.availableBalance).toBe(2);

    const snoozed = await h.service.snoozeQueueEntry({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'journey:snooze',
    });
    expect(snoozed.entry.status).toBe('DEFERRED');
    h.setTime(T0 + 300_000);
    await h.service.requeueEntry({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'journey:return', ...OPERATOR,
    });
    await h.service.markApproaching({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'journey:approach', ...OPERATOR,
    });
    await h.service.confirmPresence({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'journey:confirm',
    });
    await h.service.callQueueEntry({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'journey:call', ...OPERATOR,
    });
    h.setTime(T0 + 330_000);
    const checkedIn = await h.service.checkInQueueEntry({
      playerId: 'p1', queueEntryId: joined.entry.id, game: 'racer', idempotencyKey: 'journey:check-in',
    });
    expect(checkedIn.reservation?.status).toBe('ACTIVE');
    expect(checkedIn.availableBalance).toBe(1);
    await h.service.activateLobby({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'journey:lobby', ...OPERATOR,
    });
    const started = await h.service.startMatch({
      queueEntryIds: [joined.entry.id], game: 'racer', idempotencyKey: 'journey:start', ...OPERATOR,
    });
    expect(started.entries[0]?.status).toBe('PLAYING');
    expect(h.store.snapshot().wallets.p1?.wallet.cachedBalance).toBe(1);
    await h.service.completeMatch({
      queueEntryIds: [joined.entry.id], matchId: started.matchId,
      idempotencyKey: 'journey:complete', ...OPERATOR,
    });

    const claim = await h.service.claimChallenge({
      playerId: 'p1', challengeId: 'voice-docs', idempotencyKey: 'journey:challenge',
      token: challengeToken('p1', 'journey-token'),
    });
    expect(claim).toMatchObject({
      rewardCoins: 1, destinationUrl: 'https://www.twilio.com/docs/voice', availableBalance: 2,
    });
    const persistedClaimResult = h.store.snapshot().idempotencyRecords['journey:challenge']?.result;
    expect(persistedClaimResult).toEqual(claim);
    expect(JSON.stringify(persistedClaimResult)).not.toContain('p1@example.com');
    expect(JSON.stringify(persistedClaimResult)).not.toContain('journey-token');
    const queuedAgain = await h.service.joinQueue({
      playerId: 'p1', preferredGame: 'fighter', idempotencyKey: 'journey:rejoin',
    });
    expect(queuedAgain.entry.status).toBe('WAITING');
    expect(queuedAgain.entry.id).not.toBe(joined.entry.id);

    const restarted = await ArcadeStateStore.open(h.file);
    expect(restarted.snapshot().players.p1?.lead?.workEmail).toBe('p1@example.com');
    expect(restarted.snapshot().wallets.p1?.challengeClaims).toHaveLength(1);
    expect(restarted.snapshot().idempotencyRecords['journey:start']?.result).toEqual(started);
  });

  it('expires a call, durably defers it, and returns it to waiting', async () => {
    const h = await harness();
    await h.service.registerPlayer(registration('p1'));
    const joined = await h.service.joinQueue({
      playerId: 'p1', preferredGame: 'racer', idempotencyKey: 'expire:join',
    });
    await h.service.markApproaching({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'expire:approach', ...OPERATOR,
    });
    await h.service.confirmPresence({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'expire:confirm',
    });
    await h.service.callQueueEntry({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'expire:call', ...OPERATOR,
    });
    h.setTime(T0 + 60_000);
    const expired = await h.service.expireQueueEntry({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'expire:expire', ...OPERATOR,
    });
    expect(expired.entry).toMatchObject({ status: 'DEFERRED', missCount: 1, deferralCount: 1 });
    h.setTime(T0 + 360_000);
    const returned = await h.service.requeueEntry({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'expire:return', ...OPERATOR,
    });
    expect(returned.entry.status).toBe('WAITING');
  });

  it('upserts exactly six normalized lead fields without issuing another grant', async () => {
    const h = await harness();
    await h.service.registerPlayer(registration('p1'));
    const updated = await h.service.registerPlayer({
      ...registration('p1', 'register:p1:update'),
      lead: { ...registration('p1').lead, companyName: '  Twilio  ' },
    });
    expect(updated.player.lead?.companyName).toBe('Twilio');
    expect(h.store.snapshot().wallets.p1?.transactions
      .filter(item => item.type === 'registration_grant')).toHaveLength(1);

    await expect(h.service.registerPlayer({
      ...registration('p2'),
      lead: { ...registration('p2').lead, jobTitle: 'Engineer' } as any,
    })).rejects.toThrow(/exactly the approved six fields/);
    await expect(h.service.registerPlayer({ ...registration('p2'), termsAccepted: false }))
      .rejects.toMatchObject({ code: 'TERMS_REQUIRED' });

    const { destination: _unverifiedDestination, ...unverified } = registration('p2', 'register:p2:unverified');
    const unverifiedPlayer = await h.service.registerPlayer(unverified);
    expect(unverifiedPlayer.player.lead?.phoneNumber).toBe('+14155550199');
    expect(unverifiedPlayer.player.trustedDestination).toBeNull();
  });
});

describe('ArcadeService atomicity and idempotency', () => {
  it.each(['per_match', 'host_sponsors'] as const)('rejects unsupported %s charge policy', async chargePolicy => {
    const h = await harness(arcadeConfig('lead_capture', { chargePolicy }));
    await expect(h.service.registerPlayer(registration('p1')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CHARGE_POLICY' });
    expect(Object.keys(h.store.snapshot().players)).toHaveLength(0);
    expect(Object.keys(h.store.snapshot().queueEntries)).toHaveLength(0);
  });

  it('rejects dangerous and oversized record keys before state lookup', async () => {
    const h = await harness();
    await expect(h.service.registerPlayer(registration('toString')))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(h.service.registerPlayer(registration('p1', '__proto__')))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(h.service.registerPlayer(registration('x'.repeat(257))))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(Object.keys(h.store.snapshot().players)).toHaveLength(0);
    expect(Object.keys(h.store.snapshot().idempotencyRecords)).toHaveLength(0);
  });

  it('serializes duplicate clicks and prevents concurrent overspend', async () => {
    const h = await harness(arcadeConfig('lead_capture', { startingBalance: 1 }));
    await h.service.registerPlayer(registration('p1'));
    const request = { playerId: 'p1', preferredGame: 'racer' as const, idempotencyKey: 'double-click' };
    const [first, replay] = await Promise.all([h.service.joinQueue(request), h.service.joinQueue(request)]);
    expect(replay).toEqual(first);
    expect(h.store.snapshot().queueEvents.filter(event => event.type === 'QUEUE_JOINED')).toHaveLength(1);
    await h.service.markApproaching({
      playerId: 'p1', queueEntryId: first.entry.id, idempotencyKey: 'spend:approach', ...OPERATOR,
    });
    await h.service.confirmPresence({
      playerId: 'p1', queueEntryId: first.entry.id, idempotencyKey: 'spend:confirm',
    });
    await h.service.callQueueEntry({
      playerId: 'p1', queueEntryId: first.entry.id, idempotencyKey: 'spend:call', ...OPERATOR,
    });
    const checkIn = {
      playerId: 'p1', queueEntryId: first.entry.id, game: 'racer' as const,
      idempotencyKey: 'check-in-double-click',
    };
    const [checkedIn, checkedInReplay] = await Promise.all([
      h.service.checkInQueueEntry(checkIn), h.service.checkInQueueEntry(checkIn),
    ]);
    expect(checkedInReplay).toEqual(checkedIn);
    expect(h.store.snapshot().wallets.p1?.reservations.filter(item => item.status === 'ACTIVE')).toHaveLength(1);
    expect(availableBalance(h.store.snapshot().wallets.p1!)).toBe(0);

    await expect(h.service.checkInQueueEntry({
      ...checkIn, idempotencyKey: 'competing-click',
    })).rejects.toThrow(/cannot transition/);
    expect(availableBalance(h.store.snapshot().wallets.p1!)).toBe(0);
  });

  it('requires trusted operator authorization for booth-controlled transitions and match binding', async () => {
    const h = await harness();
    await h.service.registerPlayer(registration('p1'));
    const joined = await h.service.joinQueue({
      playerId: 'p1', preferredGame: 'fighter', idempotencyKey: 'authorization:join',
    });
    expect(() => h.service.markApproaching({
      playerId: 'p1', queueEntryId: joined.entry.id,
      idempotencyKey: 'authorization:approach', authorization: {},
    })).toThrow(/trusted operator or system authorization/);
    expect(h.store.snapshot().queueEntries[joined.entry.id]?.status).toBe('WAITING');

    await h.service.markApproaching({
      playerId: 'p1', queueEntryId: joined.entry.id,
      idempotencyKey: 'authorization:approach', ...OPERATOR,
    });
    await h.service.confirmPresence({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'authorization:confirm',
    });
    await h.service.callQueueEntry({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'authorization:call', ...OPERATOR,
    });
    await h.service.checkInQueueEntry({
      playerId: 'p1', queueEntryId: joined.entry.id, game: 'fighter',
      idempotencyKey: 'authorization:check-in',
    });
    await expect(h.store.transaction(state => {
      (state.queueEntries[joined.entry.id] as { status: string }).status = 'NO_SHOW';
    })).rejects.toThrow(/cannot retain an active reservation/);
    await h.service.activateLobby({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'authorization:lobby', ...OPERATOR,
    });
    await expect(h.service.startMatch({
      queueEntryIds: [joined.entry.id], game: 'racer',
      idempotencyKey: 'authorization:wrong-game', ...OPERATOR,
    })).rejects.toThrow(/checked in for racer/);
    await expect(h.service.startMatch({
      queueEntryIds: [joined.entry.id], game: 'fighter',
      idempotencyKey: 'authorization:start', authorization: {},
    })).rejects.toMatchObject({ code: 'MATCH_UNAUTHORIZED' });

    const started = await h.service.startMatch({
      queueEntryIds: [joined.entry.id], game: 'fighter',
      idempotencyKey: 'authorization:start', ...OPERATOR,
    });
    expect(h.store.snapshot().queueEntryConfigs[joined.entry.id]).toMatchObject({
      assignedGame: 'fighter', matchId: started.matchId,
    });
    await expect(h.store.transaction(state => {
      (state.queueEntries[joined.entry.id] as { status: string }).status = 'ACTIVE_LOBBY';
      const captured = state.queueEntryConfigs[joined.entry.id]!;
      state.queueEntryConfigs[joined.entry.id] = { ...captured, matchId: null };
    })).rejects.toThrow(/must have an active reservation/);
    await expect(h.service.completeMatch({
      queueEntryIds: [joined.entry.id], matchId: 'different-match',
      idempotencyKey: 'authorization:wrong-match', ...OPERATOR,
    })).rejects.toMatchObject({ code: 'MATCH_NOT_ACTIVE' });
    await h.service.completeMatch({
      queueEntryIds: [joined.entry.id], matchId: started.matchId,
      idempotencyKey: 'authorization:complete', ...OPERATOR,
    });
  });

  it('persists challenge idempotency, consumes tokens once, and honors the configured claim limit', async () => {
    const h = await harness(arcadeConfig('lead_capture', { maxClaimsPerPlayer: 2 }));
    await h.service.registerPlayer(registration('p1'));
    const same = {
      playerId: 'p1', challengeId: 'voice-docs', idempotencyKey: 'claim-click',
      token: challengeToken('p1', 'same-token'),
    };
    const [first, replay] = await Promise.all([
      h.service.claimChallenge(same), h.service.claimChallenge(same),
    ]);
    expect(replay).toEqual(first);
    expect(h.store.snapshot().wallets.p1?.challengeClaims).toHaveLength(1);
    await expect(h.service.claimChallenge({ ...same, token: `${same.token}x` }))
      .rejects.toMatchObject({ code: 'INVALID_CHALLENGE_TOKEN' });

    await expect(h.service.claimChallenge({
      ...same, idempotencyKey: 'claim-token-replay',
    })).rejects.toMatchObject({ code: 'CHALLENGE_TOKEN_REPLAYED' });
    await h.service.claimChallenge({
      ...same, idempotencyKey: 'claim-again', token: challengeToken('p1', 'fresh-token'),
    });
    expect(h.store.snapshot().wallets.p1?.challengeClaims).toHaveLength(2);
    await expect(h.service.claimChallenge({
      ...same, idempotencyKey: 'claim-over-limit', token: challengeToken('p1', 'third-token'),
    })).rejects.toThrow(/claim limit/);
    const restartedStore = await ArcadeStateStore.open(h.file);
    const restarted = new ArcadeService({
      store: restartedStore,
      config: arcadeConfig(),
      clock: () => T0,
      idGenerator: kind => `restart-${kind}`,
      challengeTokenSecret: TOKEN_SECRET,
    });
    expect(await restarted.claimChallenge(same)).toEqual(first);
  });

  it('prices flexible players using the game assigned at check-in', async () => {
    const h = await harness(arcadeConfig('lead_capture', {
      startingBalance: 3,
      gameCosts: { fighter: 1, racer: 3 },
    }));
    await h.service.registerPlayer(registration('p1'));
    const joined = await h.service.joinQueue({
      playerId: 'p1', preferredGame: 'fighter', flexibleGame: true,
      idempotencyKey: 'flexible:join',
    });
    await h.service.markApproaching({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'flexible:approach', ...OPERATOR,
    });
    await h.service.confirmPresence({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'flexible:confirm',
    });
    await h.service.callQueueEntry({
      playerId: 'p1', queueEntryId: joined.entry.id, idempotencyKey: 'flexible:call', ...OPERATOR,
    });
    const checkedIn = await h.service.checkInQueueEntry({
      playerId: 'p1', queueEntryId: joined.entry.id, game: 'racer',
      idempotencyKey: 'flexible:check-in',
    });
    expect(checkedIn.reservation?.amount).toBe(3);
    expect(checkedIn.availableBalance).toBe(0);
    expect(h.store.snapshot().queueEntryConfigs[joined.entry.id]?.assignedGame).toBe('racer');
  });

  it('rejects tokenless, tampered, wrong-player, and wrong-audience claims', async () => {
    const h = await harness();
    await h.service.registerPlayer(registration('p1'));
    const base = {
      playerId: 'p1', challengeId: 'voice-docs', idempotencyKey: 'token-security',
    };
    await expect(h.service.claimChallenge(base as ClaimArcadeChallengeInput))
      .rejects.toMatchObject({ code: 'INVALID_CHALLENGE_TOKEN' });
    const token = challengeToken('p1', 'tamper-token');
    await expect(h.service.claimChallenge({ ...base, token: `${token.slice(0, -1)}A` }))
      .rejects.toMatchObject({ code: 'INVALID_CHALLENGE_TOKEN' });
    await expect(h.service.claimChallenge({ ...base, idempotencyKey: 'wrong-player', token: challengeToken('p2') }))
      .rejects.toMatchObject({ code: 'INVALID_CHALLENGE_TOKEN' });
    await expect(h.service.claimChallenge({
      ...base, idempotencyKey: 'wrong-audience', token: challengeToken('p1', 'audience-token', 'ARCADE-02'),
    })).rejects.toMatchObject({ code: 'INVALID_CHALLENGE_TOKEN' });
    expect(h.store.snapshot().wallets.p1?.challengeClaims).toHaveLength(0);
  });

  it('detaches bounded challenge metadata from caller mutations', async () => {
    const h = await harness();
    await h.service.registerPlayer(registration('p1'));
    const metadata = { source: { channel: 'sms' } };
    await h.service.claimChallenge({
      playerId: 'p1', challengeId: 'voice-docs', idempotencyKey: 'metadata-claim',
      token: challengeToken('p1', 'metadata-token'), requestMetadata: metadata,
    });
    metadata.source.channel = 'mutated';
    const snapshot = h.store.snapshot();
    expect(snapshot.wallets.p1?.challengeClaims[0]?.requestMetadata).toMatchObject({
      source: { channel: 'sms' }, tokenJti: 'metadata-token',
    });
    expect(Object.isFrozen(snapshot.wallets.p1?.challengeClaims[0]?.requestMetadata)).toBe(true);

    await expect(h.service.claimChallenge({
      playerId: 'p1', challengeId: 'voice-docs', idempotencyKey: 'oversized-metadata',
      token: challengeToken('p1', 'oversized-token'), requestMetadata: { data: 'x'.repeat(17_000) },
    })).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
  });

  it('uses the active challenge snapshot at the serialized claim time', async () => {
    const h = await harness(arcadeConfig('lead_capture', { rewardCoins: 1, version: 1 }));
    await h.service.registerPlayer(registration('p1'));
    h.setConfig(arcadeConfig('lead_capture', { rewardCoins: 3, version: 2 }));
    const claimed = await h.service.claimChallenge({
      playerId: 'p1', challengeId: 'voice-docs', idempotencyKey: 'active-config-claim',
      token: challengeToken('p1', 'active-config-token'),
    });
    expect(claimed.rewardCoins).toBe(3);
    expect(h.store.snapshot().wallets.p1?.challengeClaims[0]?.configVersion).toBe(2);
    expect(h.store.snapshot().wallets.p1?.transactions.at(-1)).toMatchObject({ delta: 3, configVersion: 2 });
  });

  it('detects global idempotency key payload conflicts', async () => {
    const h = await harness();
    await h.service.registerPlayer(registration('p1', 'same-key'));
    await expect(h.service.registerPlayer({
      ...registration('p1', 'same-key'),
      lead: { ...registration('p1').lead, companyName: 'Different Company' },
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(h.store.snapshot().wallets.p1?.transactions).toHaveLength(1);
  });

  it('redeems every participant or none when starting a multi-entry match', async () => {
    const h = await harness(arcadeConfig('lead_capture', { startingBalance: 1 }));
    await h.service.registerPlayer(registration('p1'));
    await h.service.registerPlayer(registration('p2'));
    const p1Entry = await moveToLobby(h, 'p1', 'p1');
    const p2Joined = await h.service.joinQueue({
      playerId: 'p2', preferredGame: 'racer', idempotencyKey: 'p2:join',
    });

    await expect(h.service.startMatch({
      queueEntryIds: [p1Entry, p2Joined.entry.id], game: 'racer',
      idempotencyKey: 'match:failed', ...OPERATOR,
    })).rejects.toThrow(/not in the active lobby/);
    expect(h.store.snapshot().queueEntries[p1Entry]?.status).toBe('ACTIVE_LOBBY');
    expect(h.store.snapshot().wallets.p1?.wallet.cachedBalance).toBe(1);
    expect(h.store.snapshot().wallets.p1?.reservations[0]?.status).toBe('ACTIVE');

    await h.service.markApproaching({
      playerId: 'p2', queueEntryId: p2Joined.entry.id, idempotencyKey: 'p2:approach', ...OPERATOR,
    });
    await h.service.confirmPresence({ playerId: 'p2', queueEntryId: p2Joined.entry.id, idempotencyKey: 'p2:confirm' });
    await h.service.callQueueEntry({
      playerId: 'p2', queueEntryId: p2Joined.entry.id, idempotencyKey: 'p2:call', ...OPERATOR,
    });
    await h.service.checkInQueueEntry({
      playerId: 'p2', queueEntryId: p2Joined.entry.id, game: 'racer', idempotencyKey: 'p2:check-in',
    });
    await h.service.activateLobby({
      playerId: 'p2', queueEntryId: p2Joined.entry.id, idempotencyKey: 'p2:lobby', ...OPERATOR,
    });
    const started = await h.service.startMatch({
      queueEntryIds: [p1Entry, p2Joined.entry.id], game: 'racer',
      idempotencyKey: 'match:success', ...OPERATOR,
    });
    expect(started.entries.map(entry => entry.status)).toEqual(['PLAYING', 'PLAYING']);
    expect(h.store.snapshot().wallets.p1?.wallet.cachedBalance).toBe(0);
    expect(h.store.snapshot().wallets.p2?.wallet.cachedBalance).toBe(0);
  });
});

describe('ArcadeService mode gate and cleanup', () => {
  it('creates nothing while off but completes, releases, and refunds existing play', async () => {
    const h = await harness(arcadeConfig('lead_capture', { startingBalance: 2 }));
    await h.service.registerPlayer(registration('p1'));
    await h.service.registerPlayer(registration('p2'));
    const playingEntry = await moveToLobby(h, 'p1', 'off-p1');

    const checkedIn = await h.service.joinQueue({
      playerId: 'p2', preferredGame: 'racer', idempotencyKey: 'off-p2:join',
    });
    await h.service.markApproaching({
      playerId: 'p2', queueEntryId: checkedIn.entry.id, idempotencyKey: 'off-p2:approach', ...OPERATOR,
    });
    await h.service.confirmPresence({ playerId: 'p2', queueEntryId: checkedIn.entry.id, idempotencyKey: 'off-p2:confirm' });
    await h.service.callQueueEntry({
      playerId: 'p2', queueEntryId: checkedIn.entry.id, idempotencyKey: 'off-p2:call', ...OPERATOR,
    });
    await h.service.checkInQueueEntry({
      playerId: 'p2', queueEntryId: checkedIn.entry.id, game: 'racer', idempotencyKey: 'off-p2:check-in',
    });
    await h.service.registerPlayer(registration('p4'));
    const waiting = await h.service.joinQueue({
      playerId: 'p4', preferredGame: 'fighter', idempotencyKey: 'off-p4:join',
    });

    h.setConfig(arcadeConfig('off', { startingBalance: 2, version: 2 }));
    const beforeFailedCreation = h.store.snapshot();
    await expect(h.service.registerPlayer(registration('p3'))).rejects.toMatchObject({ code: 'MODE_DISABLED' });
    expect(h.store.snapshot()).toEqual(beforeFailedCreation);

    const started = await h.service.startMatch({
      queueEntryIds: [playingEntry], game: 'racer', idempotencyKey: 'off-p1:start', ...OPERATOR,
    });
    expect(h.store.snapshot().wallets.p1?.transactions.at(-1)?.configVersion).toBe(1);
    await h.service.completeMatch({
      queueEntryIds: [playingEntry], matchId: started.matchId,
      idempotencyKey: 'off:complete', ...OPERATOR,
    });
    const released = await h.service.releaseQueueEntry({
      playerId: 'p2', queueEntryId: checkedIn.entry.id, idempotencyKey: 'off:release', ...OPERATOR,
    });
    expect(released).toMatchObject({ entry: { status: 'RELEASED' }, reservation: { status: 'RELEASED' } });
    const left = await h.service.leaveQueue({
      playerId: 'p4', queueEntryId: waiting.entry.id, idempotencyKey: 'off-p4:leave',
    });
    expect(left.entry.status).toBe('LEFT_QUEUE');
    await expect(h.service.refundQueueEntry({
      playerId: 'p1', queueEntryId: playingEntry, idempotencyKey: 'off:unauthorized-refund',
      reason: 'cabinet failed', authorization: {},
    })).rejects.toMatchObject({ code: 'REFUND_UNAUTHORIZED' });
    const refunded = await h.service.refundQueueEntry({
      playerId: 'p1', queueEntryId: playingEntry, idempotencyKey: 'off:refund',
      reason: 'cabinet failed after match start', authorization: OPERATOR_AUTHORIZATION,
    });
    expect(refunded.availableBalance).toBe(2);
    await expect(h.service.joinQueue({
      playerId: 'p1', preferredGame: 'racer', idempotencyKey: 'off:new-queue',
    })).rejects.toMatchObject({ code: 'MODE_DISABLED' });
  });

  it('rejects even authorized refunds when the captured policy is ineligible', async () => {
    const h = await harness(arcadeConfig('lead_capture', { refundOnLobbyTimeout: false }));
    await h.service.registerPlayer(registration('p1'));
    const entry = await moveToLobby(h, 'p1', 'no-refund');
    const started = await h.service.startMatch({
      queueEntryIds: [entry], game: 'racer', idempotencyKey: 'no-refund:start', ...OPERATOR,
    });
    await h.service.completeMatch({
      queueEntryIds: [entry], matchId: started.matchId,
      idempotencyKey: 'no-refund:complete', ...OPERATOR,
    });
    await expect(h.service.refundQueueEntry({
      playerId: 'p1', queueEntryId: entry, idempotencyKey: 'no-refund:refund',
      reason: 'operator requested', authorization: OPERATOR_AUTHORIZATION,
    })).rejects.toMatchObject({ code: 'REFUND_NOT_ELIGIBLE' });
  });
});
