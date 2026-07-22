import { describe, expect, it } from 'vitest';
import {
  QUEUE_STATUSES,
  ArcadeQueueError,
  assertQueueEntryInvariants,
  expireCalledEntry,
  isLegalQueueTransition,
  isSnoozeEligible,
  joinQueue,
  queueEntryInvariantViolations,
  queueEventInvariantViolations,
  reduceQueueEntry,
  selectWaitingEntries,
  snoozeQueueEntry,
  type JoinQueueInput,
  type QueueEntry,
  type QueuePolicy,
  type QueueStatus,
} from '../shared/arcade-queue';

const T0 = '2026-07-20T10:00:00.000Z';
const T1 = '2026-07-20T10:01:00.000Z';
const T2 = '2026-07-20T10:02:00.000Z';
const T3 = '2026-07-20T10:03:00.000Z';
const T4 = '2026-07-20T10:04:00.000Z';
const T5 = '2026-07-20T10:05:00.000Z';

const policy: QueuePolicy = {
  automaticDeferrals: 1,
  removeAfterMisses: 2,
  snoozeSeconds: 300,
};

const joinInput = (overrides: Partial<JoinQueueInput> = {}): JoinQueueInput => ({
  id: 'queue-1',
  eventId: 'event-join-1',
  cabinetId: 'ARCADE-01',
  playerId: 'player-1',
  preferredGame: 'racer',
  flexibleGame: false,
  joinedAt: T0,
  configVersion: 1,
  ...overrides,
});

const waitingEntry = (overrides: Partial<JoinQueueInput> = {}): QueueEntry =>
  joinQueue([], joinInput(overrides)).entry;

const calledEntry = (): QueueEntry => {
  const waiting = waitingEntry();
  let approaching = reduceQueueEntry(waiting, {
    type: 'MARK_APPROACHING', eventId: 'event-approach', at: T1,
  }).entry;
  approaching = reduceQueueEntry(approaching, {
    type: 'CONFIRM_PRESENCE', eventId: 'event-confirm', at: T1,
  }).entry;
  return reduceQueueEntry(approaching, {
    type: 'CALL', eventId: 'event-call', at: T2, checkInExpiresAt: T3,
  }).entry;
};

describe('queue entry creation', () => {
  it('creates a WAITING entry and a matching appendable event from injected IDs/time', () => {
    const result = joinQueue([], joinInput());
    expect(result.entry).toMatchObject({
      id: 'queue-1', playerId: 'player-1', status: 'WAITING', joinedAt: T0,
      originalJoinedAt: T0, deferralCount: 0, missCount: 0,
    });
    expect(result.event).toMatchObject({
      id: 'event-join-1', type: 'QUEUE_JOINED', fromStatus: null, toStatus: 'WAITING',
      occurredAt: T0,
    });
    expect(() => assertQueueEntryInvariants(result.entry)).not.toThrow();
  });

  it('rejects duplicate IDs and a second live entry for one player/cabinet', () => {
    const existing = waitingEntry();
    expect(() => joinQueue([existing], joinInput())).toThrow(/already exists/);
    expect(() => joinQueue([existing], joinInput({ id: 'queue-2', eventId: 'event-2' }))).toThrow(/already has/);
    expect(() => joinQueue([existing], joinInput({
      id: 'queue-2', eventId: 'event-2', cabinetId: 'ARCADE-02',
    }))).not.toThrow();
  });

  it('allows rejoin after a terminal entry', () => {
    const left = reduceQueueEntry(waitingEntry(), { type: 'LEAVE', eventId: 'event-left', at: T1 }).entry;
    expect(() => joinQueue([left], joinInput({ id: 'queue-2', eventId: 'event-2', joinedAt: T2 }))).not.toThrow();
  });

  it('fails closed on malformed persisted status/event enums and extra fields', () => {
    const joined = joinQueue([], joinInput());
    const badStatus = { ...joined.entry, status: 'QUEUED' } as unknown as QueueEntry;
    expect(queueEntryInvariantViolations(badStatus)).toContain('unknown status QUEUED');
    expect(isLegalQueueTransition('QUEUED' as QueueStatus, 'WAITING')).toBe(false);

    const badEvent = { ...joined.event, type: 'REQUEUED' } as unknown as typeof joined.event;
    expect(queueEventInvariantViolations(badEvent)).toContain('unknown queue event type REQUEUED');
    const extraEvent = { ...joined.event, payload: {} } as unknown as typeof joined.event;
    expect(queueEventInvariantViolations(extraEvent)).toContain('queue event has an invalid shape');
    const extraEntry = { ...joined.entry, partyId: 'party-1' } as unknown as QueueEntry;
    expect(queueEntryInvariantViolations(extraEntry)).toContain('queue entry has an invalid shape');
  });
});

describe('stable FIFO selection', () => {
  it('selects WAITING entries by (joinedAt, id), without mutating input order', () => {
    const later = waitingEntry({ id: 'z', playerId: 'p-z', joinedAt: T2 });
    const tiedB = waitingEntry({ id: 'b', playerId: 'p-b', joinedAt: T1 });
    const tiedA = waitingEntry({ id: 'a', playerId: 'p-a', joinedAt: T1 });
    const entries = [later, tiedB, tiedA];
    expect(selectWaitingEntries(entries, { cabinetId: 'ARCADE-01', limit: 3 }).map(entry => entry.id))
      .toEqual(['a', 'b', 'z']);
    expect(entries.map(entry => entry.id)).toEqual(['z', 'b', 'a']);
    expect(selectWaitingEntries(entries, { cabinetId: 'ARCADE-01', limit: 1 })[0]).not.toBe(tiedA);
    expect(Object.isFrozen(selectWaitingEntries(entries, { cabinetId: 'ARCADE-01', limit: 1 })[0])).toBe(true);
  });

  it('filters by cabinet/game, includes flexible players, and excludes non-waiting entries', () => {
    const racer = waitingEntry({ id: 'racer', playerId: 'p1' });
    const fighter = waitingEntry({ id: 'fighter', playerId: 'p2', preferredGame: 'fighter' });
    const flexible = waitingEntry({ id: 'flex', playerId: 'p3', preferredGame: 'trivia', flexibleGame: true });
    const otherCabinet = waitingEntry({ id: 'other', playerId: 'p4', cabinetId: 'ARCADE-02' });
    const approaching = reduceQueueEntry(waitingEntry({ id: 'approach', playerId: 'p5' }), {
      type: 'MARK_APPROACHING', eventId: 'event-approach', at: T1,
    }).entry;
    expect(selectWaitingEntries([fighter, flexible, otherCabinet, approaching, racer], {
      cabinetId: 'ARCADE-01', game: 'racer', limit: 10,
    }).map(entry => entry.id)).toEqual(['flex', 'racer']);
  });

  it('honors a zero limit and rejects invalid limits', () => {
    expect(selectWaitingEntries([waitingEntry()], { cabinetId: 'ARCADE-01', limit: 0 })).toEqual([]);
    expect(() => selectWaitingEntries([], { cabinetId: 'ARCADE-01', limit: -1 })).toThrow(/limit/);
  });
});

describe('queue transition graph', () => {
  const legalEdges: Array<[QueueStatus, QueueStatus]> = [
    ['WAITING', 'APPROACHING'], ['WAITING', 'DEFERRED'], ['WAITING', 'LEFT_QUEUE'],
    ['APPROACHING', 'CALLED'], ['APPROACHING', 'DEFERRED'], ['APPROACHING', 'LEFT_QUEUE'],
    ['CALLED', 'CHECKED_IN'], ['CALLED', 'DEFERRED'], ['CALLED', 'NO_SHOW'], ['CALLED', 'LEFT_QUEUE'],
    ['CHECKED_IN', 'ACTIVE_LOBBY'], ['CHECKED_IN', 'RELEASED'],
    ['ACTIVE_LOBBY', 'PLAYING'], ['ACTIVE_LOBBY', 'RELEASED'],
    ['PLAYING', 'COMPLETED'], ['DEFERRED', 'WAITING'], ['DEFERRED', 'LEFT_QUEUE'],
  ];

  it('reports exactly the declared legal status edges', () => {
    const expected = new Set(legalEdges.map(([from, to]) => `${from}:${to}`));
    for (const from of QUEUE_STATUSES) {
      for (const to of QUEUE_STATUSES) {
        expect(isLegalQueueTransition(from, to), `${from} -> ${to}`)
          .toBe(expected.has(`${from}:${to}`));
      }
    }
  });

  it('runs the complete happy path and emits every transition', () => {
    let entry = waitingEntry();
    const approaching = reduceQueueEntry(entry, {
      type: 'MARK_APPROACHING', eventId: 'e1', at: T1,
    });
    expect(approaching.event).toMatchObject({ type: 'MARKED_APPROACHING', fromStatus: 'WAITING', toStatus: 'APPROACHING' });
    entry = approaching.entry;

    const confirmed = reduceQueueEntry(entry, { type: 'CONFIRM_PRESENCE', eventId: 'e2', at: T1 });
    expect(confirmed.entry.approachingConfirmedAt).toBe(T1);
    expect(confirmed.event).toMatchObject({ type: 'PRESENCE_CONFIRMED', fromStatus: 'APPROACHING', toStatus: 'APPROACHING' });
    entry = confirmed.entry;

    entry = reduceQueueEntry(entry, {
      type: 'CALL', eventId: 'e3', at: T2, checkInExpiresAt: T3,
    }).entry;
    expect(entry).toMatchObject({ status: 'CALLED', calledAt: T2, checkInExpiresAt: T3 });

    entry = reduceQueueEntry(entry, { type: 'CHECK_IN', eventId: 'e4', at: '2026-07-20T10:02:30.000Z' }).entry;
    expect(entry.status).toBe('CHECKED_IN');
    entry = reduceQueueEntry(entry, { type: 'ENTER_ACTIVE_LOBBY', eventId: 'e5', at: T3 }).entry;
    expect(entry.status).toBe('ACTIVE_LOBBY');
    entry = reduceQueueEntry(entry, { type: 'START_PLAYING', eventId: 'e6', at: T4 }).entry;
    expect(entry.status).toBe('PLAYING');
    const completed = reduceQueueEntry(entry, { type: 'COMPLETE', eventId: 'e7', at: T5 });
    expect(completed.entry.status).toBe('COMPLETED');
    expect(completed.event.type).toBe('COMPLETED');
  });

  it('requires approaching presence confirmation before CALL', () => {
    const approaching = reduceQueueEntry(waitingEntry(), {
      type: 'MARK_APPROACHING', eventId: 'event-approach', at: T1,
    }).entry;
    expect(() => reduceQueueEntry(approaching, {
      type: 'CALL', eventId: 'event-call', at: T2, checkInExpiresAt: T3,
    })).toThrow(/presence must be confirmed/);
    const confirmed = reduceQueueEntry(approaching, {
      type: 'CONFIRM_PRESENCE', eventId: 'event-confirm', at: T1,
    }).entry;
    expect(reduceQueueEntry(confirmed, {
      type: 'CALL', eventId: 'event-call', at: T2, checkInExpiresAt: T3,
    }).entry.status).toBe('CALLED');
  });

  it('rejects backdated actions and malformed call/check-in chronology', () => {
    expect(() => reduceQueueEntry(waitingEntry(), {
      type: 'MARK_APPROACHING', eventId: 'event-backdated', at: '2026-07-20T09:59:00.000Z',
    })).toThrow(/precedes the current entry chronology/);

    const called = calledEntry();
    expect(() => reduceQueueEntry(called, {
      type: 'CHECK_IN', eventId: 'event-backdated-checkin', at: T1,
    })).toThrow(/precedes the current entry chronology/);
    expect(queueEntryInvariantViolations({
      ...called, checkInExpiresAt: T1,
    }).some(violation => violation.includes('checkInExpiresAt must follow calledAt'))).toBe(true);
    expect(queueEntryInvariantViolations({
      ...called, status: 'CHECKED_IN', checkedInAt: T1,
    }).some(violation => violation.includes('checkedInAt is out of order'))).toBe(true);
  });

  it.each([
    ['WAITING -> PLAYING', () => reduceQueueEntry(waitingEntry(), { type: 'START_PLAYING', eventId: 'e', at: T1 })],
    ['APPROACHING -> CHECKED_IN', () => {
      const approaching = reduceQueueEntry(waitingEntry(), { type: 'MARK_APPROACHING', eventId: 'e1', at: T1 }).entry;
      return reduceQueueEntry(approaching, { type: 'CHECK_IN', eventId: 'e2', at: T2 });
    }],
    ['CALLED -> COMPLETED', () => reduceQueueEntry(calledEntry(), { type: 'COMPLETE', eventId: 'e', at: T3 })],
    ['terminal -> any state', () => {
      const left = reduceQueueEntry(waitingEntry(), { type: 'LEAVE', eventId: 'e1', at: T1 }).entry;
      return reduceQueueEntry(left, { type: 'MARK_APPROACHING', eventId: 'e2', at: T2 });
    }],
  ])('rejects illegal transition %s', (_name, operation) => {
    expect(operation).toThrow(ArcadeQueueError);
  });

  it('rejects invalid call windows and check-in at or after expiry', () => {
    let approaching = reduceQueueEntry(waitingEntry(), {
      type: 'MARK_APPROACHING', eventId: 'e1', at: T1,
    }).entry;
    approaching = reduceQueueEntry(approaching, {
      type: 'CONFIRM_PRESENCE', eventId: 'e-confirm', at: T1,
    }).entry;
    expect(() => reduceQueueEntry(approaching, {
      type: 'CALL', eventId: 'e2', at: T2, checkInExpiresAt: T2,
    })).toThrow(/after call time/);
    expect(() => reduceQueueEntry(calledEntry(), {
      type: 'CHECK_IN', eventId: 'e3', at: T3,
    })).toThrow(/at or after call expiry/);
  });

  it('releases checked-in and active-lobby entries but not a playing entry', () => {
    const checkedIn = reduceQueueEntry(calledEntry(), {
      type: 'CHECK_IN', eventId: 'e-check', at: '2026-07-20T10:02:30.000Z',
    }).entry;
    expect(reduceQueueEntry(checkedIn, { type: 'RELEASE', eventId: 'e-release', at: T3 }).entry.status)
      .toBe('RELEASED');
    const lobby = reduceQueueEntry(checkedIn, { type: 'ENTER_ACTIVE_LOBBY', eventId: 'e-lobby', at: T3 }).entry;
    expect(reduceQueueEntry(lobby, { type: 'RELEASE', eventId: 'e-release-2', at: T4 }).entry.status)
      .toBe('RELEASED');
    const playing = reduceQueueEntry(lobby, { type: 'START_PLAYING', eventId: 'e-playing', at: T4 }).entry;
    expect(() => reduceQueueEntry(playing, { type: 'RELEASE', eventId: 'e-release-3', at: T5 }))
      .toThrow(/cannot transition/);
  });
});

describe('call expiry and no-show policy', () => {
  it('defers the first expired call, preserving original join time and incrementing counters', () => {
    const expired = expireCalledEntry(calledEntry(), { eventId: 'event-expire-1', at: T3 }, policy);
    expect(expired.entry).toMatchObject({
      status: 'DEFERRED', originalJoinedAt: T0, missCount: 1, deferralCount: 1,
      automaticDeferralCount: 1, snoozeCount: 0, joinedAt: T0,
      deferredUntil: '2026-07-20T10:08:00.000Z',
    });
    expect(expired.event).toMatchObject({ type: 'DEFERRED', reason: 'CALL_EXPIRED' });
  });

  it('cannot return early, then rejoins FIFO while preserving automatic-deferral priority', () => {
    const deferred = expireCalledEntry(calledEntry(), { eventId: 'event-expire-1', at: T3 }, policy).entry;
    expect(() => reduceQueueEntry(deferred, {
      type: 'RETURN_TO_WAITING', eventId: 'event-return', at: T4,
    })).toThrow(/before deferredUntil/);
    const returned = reduceQueueEntry(deferred, {
      type: 'RETURN_TO_WAITING', eventId: 'event-return', at: '2026-07-20T10:08:00.000Z',
    }).entry;
    expect(returned).toMatchObject({
      status: 'WAITING', originalJoinedAt: T0, joinedAt: T0,
      calledAt: null, checkInExpiresAt: null, deferredUntil: null,
    });
  });

  it('marks the next expired call no-show under the supplied policy', () => {
    let entry = expireCalledEntry(calledEntry(), { eventId: 'event-expire-1', at: T3 }, policy).entry;
    entry = reduceQueueEntry(entry, {
      type: 'RETURN_TO_WAITING', eventId: 'event-return', at: '2026-07-20T10:08:00.000Z',
    }).entry;
    entry = reduceQueueEntry(entry, {
      type: 'MARK_APPROACHING', eventId: 'event-approach-2', at: '2026-07-20T10:09:00.000Z',
    }).entry;
    entry = reduceQueueEntry(entry, {
      type: 'CONFIRM_PRESENCE', eventId: 'event-confirm-2', at: '2026-07-20T10:09:00.000Z',
    }).entry;
    entry = reduceQueueEntry(entry, {
      type: 'CALL', eventId: 'event-call-2', at: '2026-07-20T10:10:00.000Z',
      checkInExpiresAt: '2026-07-20T10:11:00.000Z',
    }).entry;
    const noShow = expireCalledEntry(entry, {
      eventId: 'event-expire-2', at: '2026-07-20T10:11:00.000Z',
    }, policy);
    expect(noShow.entry).toMatchObject({ status: 'NO_SHOW', missCount: 2, deferralCount: 1 });
    expect(noShow.event).toMatchObject({ type: 'MARKED_NO_SHOW', reason: 'CALL_EXPIRED' });
  });

  it('obeys policies with no automatic deferral and rejects premature/non-called expiry', () => {
    const noDeferral = { ...policy, automaticDeferrals: 0 };
    expect(expireCalledEntry(calledEntry(), { eventId: 'event-expire', at: T3 }, noDeferral).entry.status)
      .toBe('NO_SHOW');
    expect(() => expireCalledEntry(calledEntry(), { eventId: 'event-early', at: T2 }, policy))
      .toThrow(/still open/);
    expect(() => expireCalledEntry(waitingEntry(), { eventId: 'event-waiting', at: T3 }, policy))
      .toThrow(/only a called/);
  });

  it('preserves FIFO priority through one automatic deferral', () => {
    const deferred = expireCalledEntry(calledEntry(), { eventId: 'event-expire', at: T3 }, policy).entry;
    const returned = reduceQueueEntry(deferred, {
      type: 'RETURN_TO_WAITING', eventId: 'event-return', at: '2026-07-20T10:08:00.000Z',
    }).entry;
    const later = waitingEntry({
      id: 'queue-later', playerId: 'player-later', joinedAt: T1, eventId: 'event-later',
    });
    expect(selectWaitingEntries([later, returned], { cabinetId: 'ARCADE-01', limit: 2 })
      .map(entry => entry.id)).toEqual(['queue-1', 'queue-later']);
  });
});

describe('snooze eligibility', () => {
  it('allows one supplied-policy snooze from waiting, approaching, or called', () => {
    const waiting = waitingEntry();
    const approaching = reduceQueueEntry(waiting, {
      type: 'MARK_APPROACHING', eventId: 'event-approach', at: T1,
    }).entry;
    expect(isSnoozeEligible(waiting, policy)).toBe(true);
    expect(isSnoozeEligible(approaching, policy)).toBe(true);
    expect(isSnoozeEligible(calledEntry(), policy)).toBe(true);

    const snoozed = snoozeQueueEntry(waiting, { eventId: 'event-snooze', at: T1 }, policy);
    expect(snoozed.entry).toMatchObject({
      status: 'DEFERRED', deferredUntil: '2026-07-20T10:06:00.000Z', joinedAt: T1,
      deferralCount: 1, snoozeCount: 1, automaticDeferralCount: 0,
    });
    expect(snoozed.event.reason).toBe('PLAYER_SNOOZE');

    const calledSnooze = snoozeQueueEntry(calledEntry(), {
      eventId: 'event-called-snooze', at: '2026-07-20T10:02:30.000Z',
    }, policy).entry;
    expect(calledSnooze).toMatchObject({
      status: 'DEFERRED', calledAt: null, checkInExpiresAt: null, approachingConfirmedAt: null,
      snoozeCount: 1, automaticDeferralCount: 0,
    });
    expect(() => snoozeQueueEntry(calledEntry(), {
      eventId: 'event-late-snooze', at: T3,
    }, policy)).toThrow(/cannot snooze after check-in expiry/);
  });

  it('rejects terminal/ineligible states and exhausted deferral allowance', () => {
    const left = reduceQueueEntry(waitingEntry(), { type: 'LEAVE', eventId: 'event-left', at: T1 }).entry;
    expect(isSnoozeEligible(left, policy)).toBe(false);
    const deferred = snoozeQueueEntry(waitingEntry(), { eventId: 'event-snooze', at: T1 }, policy).entry;
    expect(isSnoozeEligible(deferred, policy)).toBe(false);
    expect(() => snoozeQueueEntry(left, { eventId: 'event-snooze-2', at: T2 }, policy)).toThrow(/cannot snooze/);
  });

  it('keeps snooze allowance separate so a snooze does not consume the first automatic miss deferral', () => {
    let entry = snoozeQueueEntry(waitingEntry(), { eventId: 'event-snooze', at: T1 }, policy).entry;
    entry = reduceQueueEntry(entry, {
      type: 'RETURN_TO_WAITING', eventId: 'event-return', at: '2026-07-20T10:06:00.000Z',
    }).entry;
    expect(isSnoozeEligible(entry, policy)).toBe(false);
    entry = reduceQueueEntry(entry, {
      type: 'MARK_APPROACHING', eventId: 'event-approach', at: '2026-07-20T10:07:00.000Z',
    }).entry;
    entry = reduceQueueEntry(entry, {
      type: 'CONFIRM_PRESENCE', eventId: 'event-confirm', at: '2026-07-20T10:07:00.000Z',
    }).entry;
    entry = reduceQueueEntry(entry, {
      type: 'CALL', eventId: 'event-call', at: '2026-07-20T10:08:00.000Z',
      checkInExpiresAt: '2026-07-20T10:09:00.000Z',
    }).entry;
    const expired = expireCalledEntry(entry, {
      eventId: 'event-expire', at: '2026-07-20T10:09:00.000Z',
    }, policy).entry;
    expect(expired).toMatchObject({
      status: 'DEFERRED', missCount: 1, deferralCount: 2,
      snoozeCount: 1, automaticDeferralCount: 1,
    });
  });

  it('adjusts explicit-snooze FIFO priority by default and can preserve it explicitly', () => {
    const snoozed = snoozeQueueEntry(waitingEntry(), { eventId: 'event-snooze', at: T1 }, policy).entry;
    const returned = reduceQueueEntry(snoozed, {
      type: 'RETURN_TO_WAITING', eventId: 'event-return', at: '2026-07-20T10:06:00.000Z',
    }).entry;
    const middle = waitingEntry({
      id: 'queue-middle', playerId: 'player-middle', eventId: 'event-middle',
      joinedAt: '2026-07-20T10:00:30.000Z',
    });
    expect(selectWaitingEntries([returned, middle], { cabinetId: 'ARCADE-01', limit: 2 })
      .map(entry => entry.id)).toEqual(['queue-middle', 'queue-1']);

    const preserved = snoozeQueueEntry(waitingEntry({ id: 'preserved', playerId: 'p-preserved' }), {
      eventId: 'event-preserved', at: T1, adjustPriority: false,
    }, policy).entry;
    expect(preserved.joinedAt).toBe(T0);
  });
});

describe('queue invariants', () => {
  it('reports malformed counters, timestamps, and status-dependent fields', () => {
    const malformed = {
      ...waitingEntry(),
      status: 'CALLED' as const,
      joinedAt: 'not-a-time',
      deferralCount: -1,
    };
    const violations = queueEntryInvariantViolations(malformed);
    expect(violations).toContain('invalid deferralCount');
    expect(violations.some(value => value.includes('valid timestamp'))).toBe(true);
    expect(violations).toContain('CALLED entry requires confirmed presence and call fields');
  });

  it('does not mutate an entry while reducing it', () => {
    const waiting = waitingEntry();
    const next = reduceQueueEntry(waiting, {
      type: 'MARK_APPROACHING', eventId: 'event-approach', at: T1,
    }).entry;
    expect(waiting.status).toBe('WAITING');
    expect(next.status).toBe('APPROACHING');
    expect(next).not.toBe(waiting);
  });
});
