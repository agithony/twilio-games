import { describe, expect, it } from 'vitest';
import {
  LEAD_FIELD_LIMITS,
  ArcadeDomainError,
  assertWalletInvariants,
  availableBalance,
  claimChallengeReward,
  createPlayer,
  createWallet,
  deriveLedger,
  grantRegistrationCoins,
  normalizeLead,
  redeemReservation,
  refundReservation,
  releaseReservation,
  reserveCoins,
  walletInvariantViolations,
  type LeadInput,
  type WalletState,
  type WalletTransaction,
} from '../shared/arcade-domain';

const T0 = '2026-07-20T10:00:00.000Z';
const T1 = '2026-07-20T10:01:00.000Z';
const T2 = '2026-07-20T10:02:00.000Z';
const T3 = '2026-07-20T10:03:00.000Z';
const T4 = '2026-07-20T10:04:00.000Z';

const lead = (overrides: Partial<LeadInput> = {}): LeadInput => ({
  firstName: ' Ada ',
  lastName: ' Lovelace ',
  workEmail: ' ADA@EXAMPLE.COM ',
  companyName: ' Analytical Engines ',
  phoneNumber: '+1 (415) 555-2671',
  countryCode: ' uk ',
  ...overrides,
});

const registrationInput = (overrides: Record<string, unknown> = {}) => ({
  amount: 2,
  transactionId: 'tx-registration',
  idempotencyKey: 'registration:p1',
  createdAt: T0,
  configVersion: 1,
  ...overrides,
});

const registeredWallet = (amount = 2): WalletState => grantRegistrationCoins(
  createWallet('p1', T0),
  registrationInput({ amount }),
);

const reserveInput = (overrides: Record<string, unknown> = {}) => ({
  reservationId: 'reservation-1',
  queueEntryId: 'queue-1',
  amount: 1,
  transactionId: 'tx-reserve',
  idempotencyKey: 'reserve:queue-1',
  createdAt: T1,
  configVersion: 1,
  ...overrides,
});

describe('lead normalization and player creation', () => {
  it('normalizes all six fields while preserving Unicode text and UK', () => {
    expect(normalizeLead(lead({ firstName: '  José  ', companyName: ' 株式会社ツイリオ ' }))).toEqual({
      firstName: 'José',
      lastName: 'Lovelace',
      workEmail: 'ada@example.com',
      companyName: '株式会社ツイリオ',
      phoneNumber: '+14155552671',
      countryCode: 'UK',
    });
  });

  it('accepts an international 00 prefix and emits E.164', () => {
    expect(normalizeLead(lead({ phoneNumber: '0044 20 7946 0958' })).phoneNumber).toBe('+442079460958');
  });

  it.each([
    ['blank first name', { firstName: '\u2003' }],
    ['control character', { companyName: 'Acme\u0000Corp' }],
    ['bad email spacing', { workEmail: 'ada @example.com' }],
    ['email without a domain suffix', { workEmail: 'ada@localhost' }],
    ['local phone', { phoneNumber: '(415) 555-2671' }],
    ['phone extension', { phoneNumber: '+1 415 555 2671 x4' }],
    ['one-letter country', { countryCode: 'U' }],
    ['numeric country', { countryCode: 'U1' }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => normalizeLead(lead(overrides))).toThrow(ArcadeDomainError);
  });

  it('measures Unicode limits by code point and rejects rather than truncating', () => {
    const atLimit = '😀'.repeat(LEAD_FIELD_LIMITS.firstName);
    expect(normalizeLead(lead({ firstName: atLimit })).firstName).toBe(atLimit);
    expect(() => normalizeLead(lead({ firstName: `${atLimit}😀` }))).toThrow(/exceeds/);
  });

  it('creates a player from normalized lead data with injected identity and time', () => {
    const player = createPlayer({ id: 'p1', createdAt: T0, lead: lead(), preferredLocale: 'en-GB' });
    expect(player).toMatchObject({
      id: 'p1', createdAt: T0, firstName: 'Ada', workEmail: 'ada@example.com',
      phoneNumber: '+14155552671', countryCode: 'UK', preferredLocale: 'en-GB',
      marketingConsent: false,
    });
  });
});

describe('wallet ledger and registration grant', () => {
  it('creates an empty wallet and derives exact balances from its ledger', () => {
    const state = createWallet('p1', T0);
    expect(state.wallet.cachedBalance).toBe(0);
    expect(deriveLedger(state.transactions, state.reservations)).toEqual({
      ledgerBalance: 0, reservedBalance: 0, availableBalance: 0,
    });
    expect(() => assertWalletInvariants(state)).not.toThrow();
  });

  it('grants registration coins exactly once and does not mutate the prior state', () => {
    const empty = createWallet('p1', T0);
    const granted = grantRegistrationCoins(empty, registrationInput());
    expect(empty.transactions).toHaveLength(0);
    expect(granted.wallet.cachedBalance).toBe(2);
    expect(granted.transactions).toHaveLength(1);
    expect(granted.transactions[0]).toMatchObject({ type: 'registration_grant', delta: 2 });
    expect(granted.idempotencyRecords).toHaveLength(1);
  });

  it('returns the same state for an exact idempotent registration replay', () => {
    const state = registeredWallet();
    const replay = grantRegistrationCoins(state, registrationInput({ transactionId: 'ignored-retry-id', createdAt: T1 }));
    expect(replay).toStrictEqual(state);
    expect(replay).not.toBe(state);
  });

  it('rejects a second registration grant under another key', () => {
    const state = registeredWallet();
    expect(() => grantRegistrationCoins(state, registrationInput({
      transactionId: 'tx-registration-2', idempotencyKey: 'registration:p1:again', createdAt: T1,
    }))).toThrow(/only once/);
  });

  it('rejects reuse of an idempotency key for a different payload', () => {
    const state = registeredWallet();
    expect(() => grantRegistrationCoins(state, registrationInput({ amount: 3 }))).toThrow(/different request/);
  });

  it('detects invalid deltas, negative ledgers, duplicate registration grants, and stale cache values', () => {
    const state = registeredWallet();
    const malformedTransaction: WalletTransaction = {
      ...state.transactions[0]!, id: 'tx-bad', idempotencyKey: 'bad', delta: -3,
    };
    expect(() => deriveLedger([malformedTransaction])).toThrow(/positive delta/);

    const duplicateGrant: WalletState = {
      ...state,
      wallet: { ...state.wallet, cachedBalance: 4 },
      transactions: [
        ...state.transactions,
        { ...state.transactions[0]!, id: 'tx-2', idempotencyKey: 'key-2' },
      ],
      idempotencyRecords: [
        ...state.idempotencyRecords,
        { ...state.idempotencyRecords[0]!, key: 'key-2', resultTransactionId: 'tx-2' },
      ],
    };
    expect(walletInvariantViolations(duplicateGrant)).toContain('wallet has more than one registration grant');

    const stale: WalletState = { ...state, wallet: { ...state.wallet, cachedBalance: 99 } };
    expect(() => assertWalletInvariants(stale)).toThrow(/cached balance/);
  });

  it('fails closed on unknown persisted transaction, reservation, and idempotency enums', () => {
    const registered = registeredWallet();
    const unknownTransaction = {
      ...registered,
      transactions: registered.transactions.map(transaction => ({ ...transaction, type: 'mystery_credit' })),
    } as unknown as WalletState;
    expect(() => assertWalletInvariants(unknownTransaction)).toThrow(/unknown type mystery_credit/);
    expect(() => deriveLedger(unknownTransaction.transactions)).toThrow(/unknown type mystery_credit/);

    const reserved = reserveCoins(registered, reserveInput());
    const unknownReservation = {
      ...reserved,
      reservations: reserved.reservations.map(reservation => ({ ...reservation, status: 'HELD_FOREVER' })),
    } as unknown as WalletState;
    expect(() => assertWalletInvariants(unknownReservation)).toThrow(/unknown status HELD_FOREVER/);

    const unknownOperation = {
      ...registered,
      idempotencyRecords: registered.idempotencyRecords.map(record => ({ ...record, operation: 'UPSERT' })),
    } as unknown as WalletState;
    expect(() => assertWalletInvariants(unknownOperation)).toThrow(/unknown operation UPSERT/);
  });

  it('rejects extra persisted fields and lead fields outside the six-field contract', () => {
    const registered = registeredWallet();
    const transactionWithExtraField = {
      ...registered,
      transactions: registered.transactions.map(transaction => ({ ...transaction, mutableBalance: 2 })),
    } as unknown as WalletState;
    expect(() => assertWalletInvariants(transactionWithExtraField)).toThrow(/invalid shape/);
    expect(() => normalizeLead({ ...lead(), jobTitle: 'Programmer' } as unknown as LeadInput)).toThrow(/exactly the six/);
  });

  it('deep-clones and freezes transaction metadata without retaining prior aggregate references', () => {
    const metadata = { source: { channel: 'sms', tags: ['registration'] } };
    const registered = grantRegistrationCoins(createWallet('p1', T0), registrationInput({ metadata }));
    const stored = registered.transactions[0]!.metadata as {
      source: { channel: string; tags: string[] };
    };
    expect(stored).not.toBe(metadata);
    expect(stored.source).not.toBe(metadata.source);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.source)).toBe(true);
    expect(Object.isFrozen(stored.source.tags)).toBe(true);
    metadata.source.channel = 'voice';
    metadata.source.tags[0] = 'changed';
    expect(stored).toEqual({ source: { channel: 'sms', tags: ['registration'] } });

    const reserved = reserveCoins(registered, reserveInput());
    expect(reserved.transactions[0]).not.toBe(registered.transactions[0]);
    expect(Object.isFrozen(reserved)).toBe(true);
    expect(Object.isFrozen(reserved.transactions)).toBe(true);
  });
});

describe('challenge claims', () => {
  const claimInput = (overrides: Record<string, unknown> = {}) => ({
    claimId: 'claim-1',
    challengeId: 'voice-docs',
    rewardCoins: 1,
    maxClaimsPerPlayer: 1,
    enabled: true,
    startsAt: T0,
    endsAt: T4,
    transactionId: 'tx-challenge',
    idempotencyKey: 'challenge:p1:voice-docs',
    createdAt: T1,
    configVersion: 2,
    requestMetadata: { channel: 'sms' },
    ...overrides,
  });

  it('atomically appends a claim, reward transaction, and idempotency record', () => {
    const state = claimChallengeReward(registeredWallet(1), claimInput());
    expect(state.wallet.cachedBalance).toBe(2);
    expect(state.challengeClaims[0]).toMatchObject({
      id: 'claim-1', challengeId: 'voice-docs', rewardCoins: 1, transactionId: 'tx-challenge',
    });
    expect(state.transactions.at(-1)).toMatchObject({ type: 'challenge_reward', delta: 1 });
    expect(() => assertWalletInvariants(state)).not.toThrow();
  });

  it('is idempotent but enforces the per-player claim limit for another key', () => {
    const claimed = claimChallengeReward(registeredWallet(1), claimInput());
    expect(claimChallengeReward(claimed, claimInput({ transactionId: 'retry-tx' }))).toStrictEqual(claimed);
    expect(() => claimChallengeReward(claimed, claimInput({
      claimId: 'claim-2', transactionId: 'tx-challenge-2', idempotencyKey: 'challenge:again',
    }))).toThrow(/claim limit/);
  });

  it('rejects disabled, early, and expired challenge claims', () => {
    const state = registeredWallet(1);
    expect(() => claimChallengeReward(state, claimInput({ enabled: false }))).toThrow(/disabled/);
    expect(() => claimChallengeReward(state, claimInput({ startsAt: T2 }))).toThrow(/not started/);
    expect(() => claimChallengeReward(state, claimInput({ endsAt: T1 }))).toThrow(/ended/);
  });

  it('deep-clones and freezes challenge request metadata', () => {
    const requestMetadata = { request: { ip: '192.0.2.1', tags: ['redirect'] } };
    const state = claimChallengeReward(registeredWallet(1), claimInput({ requestMetadata }));
    const stored = state.challengeClaims[0]!.requestMetadata as {
      request: { ip: string; tags: string[] };
    };
    requestMetadata.request.ip = '198.51.100.1';
    requestMetadata.request.tags.push('mutated');
    expect(stored).toEqual({ request: { ip: '192.0.2.1', tags: ['redirect'] } });
    expect(Object.isFrozen(stored.request.tags)).toBe(true);
  });
});

describe('reservation lifecycle', () => {
  it('reserves without changing ledger balance and reduces only available balance', () => {
    const state = reserveCoins(registeredWallet(2), reserveInput());
    expect(state.wallet.cachedBalance).toBe(2);
    expect(deriveLedger(state.transactions, state.reservations)).toEqual({
      ledgerBalance: 2, reservedBalance: 1, availableBalance: 1,
    });
    expect(state.reservations[0]?.status).toBe('ACTIVE');
  });

  it('releases an active hold without changing total balance', () => {
    const reserved = reserveCoins(registeredWallet(2), reserveInput());
    const released = releaseReservation(reserved, {
      reservationId: 'reservation-1', transactionId: 'tx-release', idempotencyKey: 'release:1',
      createdAt: T2, configVersion: 1,
    });
    expect(released.reservations[0]).toMatchObject({ status: 'RELEASED', releasedAt: T2 });
    expect(availableBalance(released)).toBe(2);
    expect(released.transactions.at(-1)).toMatchObject({ type: 'reservation_release', delta: 0 });
  });

  it('redeems only at match start and can then refund the exact redeemed amount', () => {
    const reserved = reserveCoins(registeredWallet(2), reserveInput());
    const redeemed = redeemReservation(reserved, {
      reservationId: 'reservation-1', matchId: 'match-1', transactionId: 'tx-redeem',
      idempotencyKey: 'redeem:1', createdAt: T2, configVersion: 1,
    });
    expect(redeemed.wallet.cachedBalance).toBe(1);
    expect(redeemed.reservations[0]).toMatchObject({ status: 'REDEEMED', matchId: 'match-1' });
    expect(availableBalance(redeemed)).toBe(1);

    const refunded = refundReservation(redeemed, {
      reservationId: 'reservation-1', transactionId: 'tx-refund', idempotencyKey: 'refund:1',
      createdAt: T3, configVersion: 1,
    });
    expect(refunded.wallet.cachedBalance).toBe(2);
    expect(refunded.reservations[0]).toMatchObject({ status: 'REFUNDED', refundedAt: T3 });
    expect(refunded.transactions.at(-1)).toMatchObject({ type: 'refund', delta: 1, matchId: 'match-1' });
  });

  it('rejects wallet mutations that move reservation chronology backwards', () => {
    const reserved = reserveCoins(registeredWallet(2), reserveInput());
    const redeemed = redeemReservation(reserved, {
      reservationId: 'reservation-1', matchId: 'match-1', transactionId: 'tx-redeem',
      idempotencyKey: 'redeem:1', createdAt: T2, configVersion: 1,
    });
    expect(() => refundReservation(redeemed, {
      reservationId: 'reservation-1', transactionId: 'tx-refund', idempotencyKey: 'refund:1',
      createdAt: T1, configVersion: 1,
    })).toThrow(/precedes/);
  });

  it('returns the same aggregate for exact lifecycle retries', () => {
    const reserved = reserveCoins(registeredWallet(2), reserveInput());
    expect(reserveCoins(reserved, reserveInput({ transactionId: 'retry-reserve' }))).toStrictEqual(reserved);
    const released = releaseReservation(reserved, {
      reservationId: 'reservation-1', transactionId: 'tx-release', idempotencyKey: 'release:1',
      createdAt: T2, configVersion: 1,
    });
    expect(releaseReservation(released, {
      reservationId: 'reservation-1', transactionId: 'retry-release', idempotencyKey: 'release:1',
      createdAt: T3, configVersion: 1,
    })).toStrictEqual(released);
  });

  it('enforces sufficient available balance and one active reservation per player', () => {
    const wallet = registeredWallet(2);
    expect(() => reserveCoins(wallet, reserveInput({ amount: 3 }))).toThrow(/too low/);
    const reserved = reserveCoins(wallet, reserveInput());
    expect(() => reserveCoins(reserved, reserveInput({
      reservationId: 'reservation-2', queueEntryId: 'queue-2', transactionId: 'tx-reserve-2',
      idempotencyKey: 'reserve:queue-2',
    }))).toThrow(/active reservation/);
  });

  it('permits a later reservation after release while preserving history', () => {
    const first = reserveCoins(registeredWallet(2), reserveInput());
    const released = releaseReservation(first, {
      reservationId: 'reservation-1', transactionId: 'tx-release', idempotencyKey: 'release:1',
      createdAt: T2, configVersion: 1,
    });
    const second = reserveCoins(released, reserveInput({
      reservationId: 'reservation-2', queueEntryId: 'queue-2', transactionId: 'tx-reserve-2',
      idempotencyKey: 'reserve:queue-2', createdAt: T3,
    }));
    expect(second.reservations.map(reservation => reservation.status)).toEqual(['RELEASED', 'ACTIVE']);
  });

  it('rejects release/redeem/refund from illegal reservation states', () => {
    const reserved = reserveCoins(registeredWallet(2), reserveInput());
    expect(() => refundReservation(reserved, {
      reservationId: 'reservation-1', transactionId: 'tx-refund', idempotencyKey: 'refund:1',
      createdAt: T2, configVersion: 1,
    })).toThrow(/cannot refund ACTIVE/);

    const released = releaseReservation(reserved, {
      reservationId: 'reservation-1', transactionId: 'tx-release', idempotencyKey: 'release:1',
      createdAt: T2, configVersion: 1,
    });
    expect(() => redeemReservation(released, {
      reservationId: 'reservation-1', matchId: 'match-1', transactionId: 'tx-redeem',
      idempotencyKey: 'redeem:1', createdAt: T3, configVersion: 1,
    })).toThrow(/cannot redeem RELEASED/);
    expect(() => releaseReservation(released, {
      reservationId: 'reservation-1', transactionId: 'tx-release-2', idempotencyKey: 'release:2',
      createdAt: T3, configVersion: 1,
    })).toThrow(/cannot release RELEASED/);
  });

  it('detects active holds exceeding the ledger', () => {
    const reserved = reserveCoins(registeredWallet(2), reserveInput());
    const malformed: WalletState = {
      ...reserved,
      reservations: reserved.reservations.map(item => ({ ...item, amount: 3 })),
    };
    expect(() => assertWalletInvariants(malformed)).toThrow(/exceed ledger balance/);
  });
});
