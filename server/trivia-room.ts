import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import {
  TRIVIA_ANSWER_WINDOW_MS,
  TRIVIA_MAX_PLAYERS,
  TRIVIA_MIN_PLAYERS,
  TRIVIA_ROUND_CATEGORY_IDS,
  buildTriviaRound,
  rankTriviaPlayers,
  resolveTriviaChoiceId,
  scoreTriviaAnswer,
  triviaSeed,
  type TriviaQuestionBank,
  type TriviaQuestionDefinition,
  type TriviaRoundCategoryId,
  type TriviaRoundQuestion,
} from '../shared/trivia';
import {
  projectTriviaState,
  type TriviaAuthoritativePlayer,
  type TriviaCategoryVoteCounts,
  type TriviaEvent,
  type TriviaPhase,
  type TriviaPublicStanding,
  type TriviaResult,
  type TriviaResultPlayer,
  type TriviaState,
} from '../shared/trivia-protocol';

export const TRIVIA_COUNTDOWN_MS = 3_000;
export const TRIVIA_LOADING_TIMEOUT_MS = 30_000;
/** Two bounded Relay prompt chunks can each take 20s; 60s leaves a conservative recovery margin. */
export const TRIVIA_QUESTION_PROMPT_TIMEOUT_MS = 60_000;
/** Relay playback is bounded at 20s; 25s gives the synchronized cue a recovery margin. */
export const TRIVIA_ANSWER_CUE_TIMEOUT_MS = 25_000;
/** Gives every caller the same future onset after the synchronized preparation barrier. */
export const TRIVIA_ANSWER_START_DELAY_MS = 3_000;
export const TRIVIA_FINAL_ANSWER_GRACE_MS = 1_500;
export const TRIVIA_REVEAL_MS = 4_000;

export interface TriviaRoomOptions {
  bank: TriviaQuestionBank | readonly TriviaQuestionDefinition[];
  now?: () => number;
  seed?: string | number;
  preferredLocale?: SupportedLocale;
  contentRevision?: string;
  countdownMs?: number;
  loadingTimeoutMs?: number;
  questionPromptTimeoutMs?: number;
  answerCueTimeoutMs?: number;
  finalAnswerGraceMs?: number;
  revealMs?: number;
}

export interface TriviaRosterPolicy {
  readonly stationFixed?: boolean;
  readonly allowReplay?: boolean;
}

interface RoomPlayer extends TriviaAuthoritativePlayer {
  name: string;
  nameConfirmed: boolean;
  connected: boolean;
  categoryVote: TriviaRoundCategoryId | null;
  rawScore: number;
  correctCount: number;
  bestStreak: number;
  currentStreak: number;
  cumulativeCorrectTimeMs: number;
  submittedChoiceId: string | null;
  submittedElapsedMs: number | null;
  submittedCorrect: boolean | null;
  submittedPoints: number;
  rank?: number;
  normalizedScore?: number;
}

export class TriviaRoom {
  phase: TriviaPhase = 'lobby';
  private readonly players: RoomPlayer[] = [];
  private nextPlayer = 1;
  private nextPlayerOrder = 0;
  private expectedPlayerCountValue: 1 | 2 | 3 | 4 = 1;
  private automaticSetupValue = false;
  private stationFixedValue = false;
  private allowReplayValue = true;
  private rosterFrozen = false;
  private locale: SupportedLocale;
  private readonly questions: TriviaQuestionBank | readonly TriviaQuestionDefinition[];
  private readonly now: () => number;
  private readonly seed: string | number;
  private readonly contentRevision: string;
  private readonly countdownMs: number;
  private readonly loadingTimeoutMs: number;
  private readonly questionPromptTimeoutMs: number;
  private readonly answerCueTimeoutMs: number;
  private readonly finalAnswerGraceMs: number;
  private readonly revealMs: number;
  private categoryValue: TriviaRoundCategoryId | null = null;
  private round: readonly TriviaRoundQuestion[] = [];
  private loadingGenerationValue = 0;
  private displayReadyValue = false;
  private loadingDeadlineAt: number | null = null;
  private countdownEndsAt: number | null = null;
  private countdownValue: 1 | 2 | 3 | null = null;
  private questionIndexValue: number | null = null;
  private questionPromptEndsAt: number | null = null;
  private answerCueEndsAt: number | null = null;
  private answeringStartsAt: number | null = null;
  private questionEndsAt: number | null = null;
  private finalAnswerDeadlineAt: number | null = null;
  private revealEndsAt: number | null = null;
  private readonly promptReadyPlayerIds = new Set<string>();
  private readonly answerCueReadyPlayerIds = new Set<string>();
  private resultValue: TriviaResult | null = null;
  private events: TriviaEvent[] = [];

  constructor(readonly code: string, options: TriviaRoomOptions) {
    if (!options?.bank) throw new TypeError('a parsed trivia question bank is required');
    this.questions = options.bank;
    this.now = options.now ?? Date.now;
    this.seed = options.seed ?? code;
    this.locale = options.preferredLocale ?? DEFAULT_LOCALE;
    this.contentRevision = cleanRevision(options.contentRevision
      ?? String('version' in options.bank ? options.bank.version : 1));
    this.countdownMs = positiveDuration(options.countdownMs ?? TRIVIA_COUNTDOWN_MS, 'countdownMs');
    this.loadingTimeoutMs = positiveDuration(options.loadingTimeoutMs ?? TRIVIA_LOADING_TIMEOUT_MS, 'loadingTimeoutMs');
    this.questionPromptTimeoutMs = boundedPromptDuration(
      options.questionPromptTimeoutMs ?? TRIVIA_QUESTION_PROMPT_TIMEOUT_MS,
    );
    this.answerCueTimeoutMs = boundedCueDuration(options.answerCueTimeoutMs ?? TRIVIA_ANSWER_CUE_TIMEOUT_MS);
    this.finalAnswerGraceMs = nonNegativeDuration(
      options.finalAnswerGraceMs ?? TRIVIA_FINAL_ANSWER_GRACE_MS,
      'finalAnswerGraceMs',
    );
    this.revealMs = positiveDuration(options.revealMs ?? TRIVIA_REVEAL_MS, 'revealMs');
  }

  addPlayer(name: string, nameConfirmed = true, assignedPlayerOrder?: number): { playerId: string } | { error: string } {
    if (this.rosterFrozen || this.phase !== 'lobby') return { error: 'round_in_progress' };
    if (assignedPlayerOrder !== undefined
      && (!Number.isSafeInteger(assignedPlayerOrder) || assignedPlayerOrder < 0 || assignedPlayerOrder >= TRIVIA_MAX_PLAYERS)) {
      return { error: 'invalid_player_order' };
    }
    if (assignedPlayerOrder !== undefined && this.stationFixedValue
      && (assignedPlayerOrder >= this.expectedPlayerCountValue || !this.hasValidStationPlayerOrder())) {
      return { error: 'invalid_player_order' };
    }
    if (assignedPlayerOrder !== undefined
      && this.players.some(player => player.playerOrder === assignedPlayerOrder)) {
      return { error: 'player_order_taken' };
    }
    if (this.players.length >= TRIVIA_MAX_PLAYERS
      || (this.automaticSetupValue && this.players.length >= this.expectedPlayerCountValue)) {
      return { error: 'room_full' };
    }
    const playerId = `t${this.nextPlayer++}`;
    let playerOrder = assignedPlayerOrder ?? this.nextPlayerOrder;
    if (assignedPlayerOrder === undefined) {
      while (this.players.some(player => player.playerOrder === playerOrder)) playerOrder += 1;
      this.nextPlayerOrder = playerOrder + 1;
    }
    const player: RoomPlayer = {
      playerId,
      name: cleanName(name),
      nameConfirmed,
      playerOrder,
      connected: true,
      categoryVote: null,
      rawScore: 0,
      correctCount: 0,
      bestStreak: 0,
      currentStreak: 0,
      cumulativeCorrectTimeMs: 0,
      submittedChoiceId: null,
      submittedElapsedMs: null,
      submittedCorrect: null,
      submittedPoints: 0,
    };
    this.players.push(player);
    this.players.sort((a, b) => a.playerOrder - b.playerOrder);
    if (!this.automaticSetupValue) this.expectedPlayerCountValue = this.players.length as 1 | 2 | 3 | 4;
    this.events.push({ type: 'player_joined', playerId, name: player.name, playerOrder, atMs: this.now() });
    return { playerId };
  }

  /** Permanently removes a participant. Temporary transport loss uses setPlayerConnected instead. */
  permanentlyRemovePlayer(playerId: string): boolean {
    const index = this.players.findIndex(player => player.playerId === playerId);
    if (index < 0) return false;
    if (this.stationFixedValue && this.phase === 'results' && this.resultValue) return false;
    this.players.splice(index, 1);
    this.promptReadyPlayerIds.delete(playerId);
    this.answerCueReadyPlayerIds.delete(playerId);
    this.events.push({ type: 'player_left', playerId, atMs: this.now() });
    if (!this.players.length) {
      const stationPregame = this.stationFixedValue
        && (this.phase === 'lobby' || this.phase === 'category_select' || this.phase === 'loading');
      if (!stationPregame) this.resetEmptyRoom();
      return true;
    }
    if (!this.stationFixedValue) this.expectedPlayerCountValue = this.players.length as 1 | 2 | 3 | 4;
    if (this.phase === 'question_prompt') this.maybeStartAnswerCue(this.now());
    else if (this.phase === 'answer_cue') this.maybeStartAnswering(this.now());
    else if (this.phase === 'question'
      && this.players.every(player => player.submittedChoiceId !== null)) this.revealQuestion(this.now());
    return true;
  }

  /** Reconciles authoritative station participants without ever rewriting an active round roster. */
  reconcilePregameRoster(
    expectedPlayerCount: number,
    activePlayerIds: readonly string[],
    participantSlots: readonly (string | null)[],
  ): boolean {
    if (!Number.isSafeInteger(expectedPlayerCount)
      || expectedPlayerCount < TRIVIA_MIN_PLAYERS || expectedPlayerCount > TRIVIA_MAX_PLAYERS
      || !['lobby', 'category_select', 'loading'].includes(this.phase)) return false;
    if (participantSlots.length !== expectedPlayerCount
      || activePlayerIds.length > expectedPlayerCount
      || new Set(activePlayerIds).size !== activePlayerIds.length) return false;
    const slottedPlayerIds = participantSlots.filter((playerId): playerId is string => playerId !== null);
    const activePlayers = new Set(activePlayerIds);
    if (new Set(slottedPlayerIds).size !== slottedPlayerIds.length
      || slottedPlayerIds.length !== activePlayers.size
      || slottedPlayerIds.some(playerId => !activePlayers.has(playerId))) return false;
    const playersById = new Map(this.players.map(player => [player.playerId, player]));
    if (slottedPlayerIds.some(playerId => !playersById.has(playerId))) return false;
    const retained = new Set(slottedPlayerIds);

    const removed = this.players.filter(player => !retained.has(player.playerId));
    for (const player of removed) {
      this.events.push({ type: 'player_left', playerId: player.playerId, atMs: this.now() });
    }
    const orderedPlayers = participantSlots.flatMap((playerId, playerOrder): RoomPlayer[] => (
      playerId === null ? [] : [{ ...playersById.get(playerId)!, playerOrder }]
    ));
    this.players.splice(0, this.players.length, ...orderedPlayers);
    if (this.phase === 'loading') this.loadingGenerationValue += 1;
    this.phase = 'lobby';
    this.expectedPlayerCountValue = expectedPlayerCount as 1 | 2 | 3 | 4;
    this.automaticSetupValue = true;
    this.stationFixedValue = true;
    this.allowReplayValue = false;
    this.rosterFrozen = false;
    this.categoryValue = null;
    this.round = [];
    this.displayReadyValue = false;
    this.loadingDeadlineAt = null;
    this.countdownEndsAt = null;
    this.countdownValue = null;
    this.questionIndexValue = null;
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.answeringStartsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.revealEndsAt = null;
    this.promptReadyPlayerIds.clear();
    this.answerCueReadyPlayerIds.clear();
    this.resultValue = null;
    this.resetPlayersForRound();
    return true;
  }

  setPlayerConnected(playerId: string, connected: boolean): boolean {
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!player || player.connected === connected) return false;
    player.connected = connected;
    return true;
  }

  setName(playerId: string, name: string): boolean {
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!player) return false;
    player.name = cleanName(name);
    player.nameConfirmed = true;
    if (this.resultValue) {
      const resultPlayers = this.resultValue.players.map(resultPlayer => resultPlayer.playerId === playerId
        ? Object.freeze({ ...resultPlayer, name: player.name })
        : resultPlayer);
      this.resultValue = Object.freeze({ ...this.resultValue, players: Object.freeze(resultPlayers) });
    }
    return true;
  }

  hasConfirmedName(playerId: string): boolean {
    return this.players.some(player => player.playerId === playerId && player.nameConfirmed);
  }

  expectHumanPlayers(count: number, automaticSetup = true, policy: TriviaRosterPolicy = {}): boolean {
    if (!Number.isSafeInteger(count) || count < TRIVIA_MIN_PLAYERS || count > TRIVIA_MAX_PLAYERS) return false;
    if (this.rosterFrozen && this.phase !== 'results') return count === this.expectedPlayerCountValue;
    this.expectedPlayerCountValue = count as 1 | 2 | 3 | 4;
    this.automaticSetupValue = automaticSetup;
    this.stationFixedValue = policy.stationFixed ?? false;
    this.allowReplayValue = policy.allowReplay ?? !this.stationFixedValue;
    return true;
  }

  setRosterPolicy(policy: TriviaRosterPolicy): boolean {
    if (this.rosterFrozen || this.phase !== 'lobby') return false;
    this.stationFixedValue = policy.stationFixed ?? this.stationFixedValue;
    this.allowReplayValue = policy.allowReplay ?? !this.stationFixedValue;
    return true;
  }

  setPreferredLocale(locale: SupportedLocale): boolean {
    if (this.rosterFrozen || this.phase !== 'lobby') return false;
    this.locale = locale;
    return true;
  }

  voteCategory(playerId: string, category: TriviaRoundCategoryId): boolean {
    if (this.phase !== 'category_select' || !TRIVIA_ROUND_CATEGORY_IDS.includes(category)) return false;
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!player) return false;
    player.categoryVote = category;
    return true;
  }

  advance(playerId?: string): boolean {
    this.tick();
    if (this.phase !== 'results' && this.automaticSetupValue && (!playerId || !this.hasPlayer(playerId))) return false;
    if (this.phase === 'lobby' && this.canFreezeRoster()) {
      this.rosterFrozen = true;
      this.phase = 'category_select';
      this.categoryValue = null;
      this.resultValue = null;
      return true;
    }
    if (this.phase === 'category_select' && this.canFreezeRoster()) {
      this.beginLoading();
      return true;
    }
    if (this.phase === 'results' && this.allowReplayValue && this.players.length) {
      this.resetPlayersForRound();
      this.phase = 'category_select';
      this.categoryValue = null;
      this.resultValue = null;
      return true;
    }
    return false;
  }

  ready(generation: number): boolean {
    if (this.phase !== 'loading' || generation !== this.loadingGenerationValue || !this.round.length) return false;
    if (this.displayReadyValue) return true;
    this.displayReadyValue = true;
    this.startCountdown(this.now());
    return true;
  }

  retryLoading(generation: number): boolean {
    if (this.phase !== 'loading' || generation !== this.loadingGenerationValue) return false;
    this.loadingGenerationValue += 1;
    this.displayReadyValue = false;
    this.loadingDeadlineAt = this.now() + this.loadingTimeoutMs;
    return true;
  }

  invalidateDisplayReady(): boolean {
    if (this.phase !== 'loading') return false;
    this.loadingGenerationValue += 1;
    this.displayReadyValue = false;
    this.loadingDeadlineAt = this.now() + this.loadingTimeoutMs;
    return true;
  }

  /** Trusted phone-prompt seam. Readiness is scoped to the currently visible question. */
  questionPromptReady(playerId: string, questionId: string): boolean {
    const current = this.currentQuestion();
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (this.phase !== 'question_prompt' || current?.question.id !== questionId || !player?.connected) return false;
    this.promptReadyPlayerIds.add(playerId);
    this.maybeStartAnswerCue(this.now());
    return true;
  }

  /** Trusted answer-cue seam. Readiness is scoped to the current question and never resets its timer. */
  questionAnswerCueReady(playerId: string, questionId: string): boolean {
    const current = this.currentQuestion();
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (this.phase !== 'answer_cue' || current?.question.id !== questionId || !player?.connected) return false;
    this.answerCueReadyPlayerIds.add(playerId);
    this.maybeStartAnswering(this.now());
    return true;
  }

  /** Trusted voice/DTMF seam. Non-final transcripts never lock an answer. */
  answer(playerId: string, spokenOrChoiceId: string, final = true): boolean {
    const answeredAtMs = this.now();
    return this.commitAnswer(playerId, spokenOrChoiceId, final, answeredAtMs, answeredAtMs);
  }

  /** Trusted final seam using the matching interim/onset timestamp for speed scoring. */
  answerAt(playerId: string, spokenOrChoiceId: string, final: boolean, answeredAtMs: number): boolean {
    return this.commitAnswer(playerId, spokenOrChoiceId, final, answeredAtMs, this.now());
  }

  private commitAnswer(playerId: string, spokenOrChoiceId: string, final: boolean,
    answeredAtMs: number, receivedAtMs: number): boolean {
    if (this.phase !== 'question') this.tick();
    if (this.phase !== 'question' || !final || this.answeringStartsAt === null
      || this.questionEndsAt === null || this.finalAnswerDeadlineAt === null
      || !Number.isSafeInteger(answeredAtMs)
      || answeredAtMs < this.answeringStartsAt - TRIVIA_ANSWER_START_DELAY_MS
      || answeredAtMs > this.questionEndsAt
      || !Number.isFinite(receivedAtMs) || receivedAtMs < answeredAtMs
      || (answeredAtMs < this.answeringStartsAt && receivedAtMs >= this.answeringStartsAt)
      || receivedAtMs > this.finalAnswerDeadlineAt) return false;
    const player = this.players.find(candidate => candidate.playerId === playerId);
    const current = this.currentQuestion();
    if (!player?.connected || player.submittedChoiceId !== null || !current) return false;
    const choiceId = this.resolveChoice(current, spokenOrChoiceId);
    if (!choiceId) return false;

    const elapsedMs = Math.max(answeredAtMs, this.answeringStartsAt) - this.answeringStartsAt;
    const scored = scoreTriviaAnswer(choiceId === current.question.correctChoiceId, elapsedMs, player.currentStreak);
    player.submittedChoiceId = choiceId;
    player.submittedElapsedMs = elapsedMs;
    player.submittedCorrect = scored.correct;
    player.submittedPoints = scored.points;
    if (this.players.every(candidate => candidate.submittedChoiceId !== null)) this.revealQuestion(receivedAtMs);
    return true;
  }

  /** Advances absolute deadlines and catches up across delayed event-loop ticks. */
  tick(): boolean {
    const now = this.now();
    let changed = false;
    for (let transitions = 0; transitions < 48; transitions++) {
      if (this.phase === 'loading' && this.loadingDeadlineAt !== null && now >= this.loadingDeadlineAt) {
        const generation = this.loadingGenerationValue;
        const displayReady = this.displayReadyValue;
        this.phase = 'category_select';
        this.loadingGenerationValue += 1;
        this.displayReadyValue = false;
        this.loadingDeadlineAt = null;
        this.categoryValue = null;
        this.round = [];
        for (const player of this.players) player.categoryVote = null;
        this.events.push({ type: 'loading_timeout', loadingGeneration: generation, displayReady, atMs: now });
        changed = true;
        continue;
      }
      if (this.phase === 'countdown' && this.countdownEndsAt !== null) {
        changed = this.emitCountdownEvents(now) || changed;
        if (now >= this.countdownEndsAt) {
          this.startQuestion(0, this.countdownEndsAt);
          changed = true;
          continue;
        }
      }
      if (this.phase === 'question_prompt' && this.questionPromptEndsAt !== null && now >= this.questionPromptEndsAt) {
        this.beginAnswerCue(this.questionPromptEndsAt);
        changed = true;
        continue;
      }
      if (this.phase === 'answer_cue' && this.answerCueEndsAt !== null && now >= this.answerCueEndsAt) {
        this.beginAnswering(this.answerCueEndsAt);
        changed = true;
        continue;
      }
      if (this.phase === 'question' && this.finalAnswerDeadlineAt !== null && now >= this.finalAnswerDeadlineAt) {
        this.revealQuestion(this.finalAnswerDeadlineAt);
        changed = true;
        continue;
      }
      if (this.phase === 'reveal' && this.revealEndsAt !== null && now >= this.revealEndsAt) {
        const nextIndex = (this.questionIndexValue ?? -1) + 1;
        if (nextIndex < this.round.length) this.startQuestion(nextIndex, this.revealEndsAt);
        else this.finishRound(this.revealEndsAt);
        changed = true;
        continue;
      }
      break;
    }
    return changed;
  }

  drainEvents(): TriviaEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  state(locale: SupportedLocale = this.locale): TriviaState {
    return projectTriviaState({
      roomCode: this.code,
      phase: this.phase,
      expectedPlayerCount: this.expectedPlayerCountValue,
      automaticSetup: this.automaticSetupValue,
      preferredLocale: this.locale,
      category: this.categoryValue,
      categoryVoteCounts: this.categoryVoteCounts(),
      players: this.players,
      serverNowMs: this.now(),
      loadingGeneration: this.loadingGenerationValue,
      displayReady: this.displayReadyValue,
      questionIndex: this.questionIndexValue,
      countdownEndsAtMs: this.countdownEndsAt,
      questionPromptEndsAtMs: this.questionPromptEndsAt,
      answerCueEndsAtMs: this.answerCueEndsAt,
      answeringStartsAtMs: this.answeringStartsAt,
      questionEndsAtMs: this.questionEndsAt,
      revealEndsAtMs: this.revealEndsAt,
      currentQuestion: this.currentQuestion(),
      result: this.resultValue,
    }, locale);
  }

  hasPlayer(playerId: string): boolean { return this.players.some(player => player.playerId === playerId); }
  canControlSetup(playerId: string): boolean { return this.hasPlayer(playerId); }
  get playerCount(): number { return this.players.length; }
  get expectedPlayerCount(): 1 | 2 | 3 | 4 { return this.expectedPlayerCountValue; }
  get hasExpectedPlayers(): boolean { return this.players.length === this.expectedPlayerCountValue; }
  get stationFixed(): boolean { return this.stationFixedValue; }
  get allowReplay(): boolean { return this.allowReplayValue; }
  get isEmpty(): boolean { return this.players.length === 0; }
  get isTimingActive(): boolean {
    return this.phase === 'loading' || this.phase === 'countdown'
      || this.phase === 'question_prompt' || this.phase === 'answer_cue'
      || this.phase === 'question' || this.phase === 'reveal';
  }

  private canFreezeRoster(): boolean {
    return this.players.length >= TRIVIA_MIN_PLAYERS
      && this.players.length === this.expectedPlayerCountValue
      && (!this.stationFixedValue || this.hasValidStationPlayerOrder())
      && this.players.every(player => player.nameConfirmed);
  }

  private hasValidStationPlayerOrder(): boolean {
    return this.players.every(player => (
      player.playerOrder >= 0 && player.playerOrder < this.expectedPlayerCountValue
    )) && new Set(this.players.map(player => player.playerOrder)).size === this.players.length;
  }

  private beginLoading(): void {
    this.categoryValue = this.resolveCategoryVote();
    this.round = Object.freeze(buildTriviaRound(
      this.questions,
      this.categoryValue,
      `${this.seed}:generation:${this.loadingGenerationValue + 1}`,
    ));
    this.phase = 'loading';
    this.loadingGenerationValue += 1;
    this.displayReadyValue = false;
    this.loadingDeadlineAt = this.now() + this.loadingTimeoutMs;
    this.countdownEndsAt = null;
    this.countdownValue = null;
    this.questionIndexValue = null;
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.answeringStartsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.revealEndsAt = null;
    this.resultValue = null;
    this.resetPlayersForRound(false);
  }

  private startCountdown(startedAtMs: number): void {
    this.phase = 'countdown';
    this.loadingDeadlineAt = null;
    this.countdownEndsAt = startedAtMs + this.countdownMs;
    this.countdownValue = 3;
    this.events.push({ type: 'countdown', count: 3, atMs: startedAtMs });
  }

  private emitCountdownEvents(now: number): boolean {
    if (this.countdownEndsAt === null || this.countdownValue === null) return false;
    const step = this.countdownMs / 3;
    const startedAt = this.countdownEndsAt - this.countdownMs;
    let changed = false;
    for (const [count, atMs] of [[2, startedAt + step], [1, startedAt + step * 2]] as const) {
      if (this.countdownValue > count && now >= atMs) {
        this.countdownValue = count;
        this.events.push({ type: 'countdown', count, atMs });
        changed = true;
      }
    }
    return changed;
  }

  private startQuestion(index: number, startedAtMs: number): void {
    const current = this.round[index];
    if (!current) throw new Error('trivia round is missing a planned question');
    this.phase = 'question_prompt';
    this.countdownEndsAt = null;
    this.countdownValue = null;
    this.questionIndexValue = index;
    this.questionPromptEndsAt = startedAtMs + this.questionPromptTimeoutMs;
    this.answerCueEndsAt = null;
    this.answeringStartsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.revealEndsAt = null;
    this.promptReadyPlayerIds.clear();
    this.answerCueReadyPlayerIds.clear();
    for (const player of this.players) this.clearSubmittedAnswer(player);
    this.events.push({
      type: 'question_started',
      questionId: current.question.id,
      questionIndex: index,
      endsAtMs: this.questionPromptEndsAt,
    });
    this.maybeStartAnswerCue(startedAtMs);
  }

  private maybeStartAnswerCue(startedAtMs: number): void {
    if (this.phase !== 'question_prompt') return;
    if (this.players.length > 0
      && this.players.every(player => this.promptReadyPlayerIds.has(player.playerId))) this.beginAnswerCue(startedAtMs);
  }

  private beginAnswerCue(startedAtMs: number): void {
    if (this.phase !== 'question_prompt') return;
    const current = this.currentQuestion();
    if (!current) return;
    this.phase = 'answer_cue';
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = startedAtMs + this.answerCueTimeoutMs;
    this.answerCueReadyPlayerIds.clear();
    this.events.push({
      type: 'answer_cue_started',
      questionId: current.question.id,
      endsAtMs: this.answerCueEndsAt,
    });
    this.maybeStartAnswering(startedAtMs);
  }

  private maybeStartAnswering(startedAtMs: number): void {
    if (this.phase !== 'answer_cue') return;
    if (this.players.length > 0
      && this.players.every(player => this.answerCueReadyPlayerIds.has(player.playerId))) this.beginAnswering(startedAtMs);
  }

  private beginAnswering(transitionedAtMs: number): void {
    if (this.phase !== 'answer_cue') return;
    const current = this.currentQuestion();
    if (!current) return;
    this.phase = 'question';
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    const startedAtMs = transitionedAtMs + TRIVIA_ANSWER_START_DELAY_MS;
    this.answeringStartsAt = startedAtMs;
    this.questionEndsAt = startedAtMs + TRIVIA_ANSWER_WINDOW_MS;
    this.finalAnswerDeadlineAt = this.questionEndsAt + this.finalAnswerGraceMs;
    this.events.push({
      type: 'answering_started',
      questionId: current.question.id,
      startsAtMs: startedAtMs,
      endsAtMs: this.questionEndsAt,
    });
  }

  private revealQuestion(revealedAtMs: number): void {
    if (this.phase !== 'question') return;
    const current = this.currentQuestion();
    if (!current) return;
    this.phase = 'reveal';
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.revealEndsAt = revealedAtMs + this.revealMs;
    this.events.push({ type: 'question_revealed', questionId: current.question.id, atMs: revealedAtMs });
    for (const player of this.players) {
      player.rawScore += player.submittedPoints;
      player.currentStreak = player.submittedCorrect ? player.currentStreak + 1 : 0;
      player.bestStreak = Math.max(player.bestStreak, player.currentStreak);
      if (player.submittedCorrect && player.submittedElapsedMs !== null) {
        player.correctCount += 1;
        player.cumulativeCorrectTimeMs += player.submittedElapsedMs;
      }
      if (player.submittedCorrect !== null) {
        this.events.push({
          type: 'answer_result',
          playerId: player.playerId,
          correct: player.submittedCorrect,
          points: player.submittedPoints,
          rawScore: player.rawScore,
        });
      }
    }
  }

  private finishRound(completedAtMs: number): void {
    if (this.phase !== 'reveal' || !this.categoryValue) return;
    const ranked = rankTriviaPlayers(this.players.map(player => ({
      playerId: player.playerId,
      rawScore: player.rawScore,
      correctCount: player.correctCount,
      cumulativeCorrectTimeMs: player.cumulativeCorrectTimeMs,
      playerOrder: player.playerOrder,
    })));
    const playersById = new Map(this.players.map(player => [player.playerId, player]));
    const resultPlayers = ranked.map((rankedPlayer): TriviaResultPlayer => {
      const player = playersById.get(rankedPlayer.playerId)!;
      player.rank = rankedPlayer.rank;
      player.normalizedScore = rankedPlayer.normalizedScore;
      return Object.freeze({
        playerId: player.playerId,
        name: player.name,
        playerOrder: player.playerOrder,
        rank: rankedPlayer.rank,
        rawScore: player.rawScore,
        normalizedScore: rankedPlayer.normalizedScore,
        correctCount: player.correctCount,
        bestStreak: player.bestStreak,
        cumulativeCorrectTimeMs: player.cumulativeCorrectTimeMs,
      });
    });
    const questionIds = this.round.map(item => item.question.id).join(':');
    this.resultValue = Object.freeze({
      resultId: `trivia-${triviaSeed(`${this.seed}:${this.code}:${this.loadingGenerationValue}:${questionIds}`).toString(36)}-${this.loadingGenerationValue}`,
      generation: this.loadingGenerationValue,
      category: this.categoryValue,
      contentRevision: this.contentRevision,
      players: Object.freeze(resultPlayers),
      completedAtMs,
    });
    this.phase = 'results';
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.answeringStartsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.revealEndsAt = null;
    const standings = this.state().standings as readonly TriviaPublicStanding[];
    this.events.push({ type: 'round_finished', standings, result: this.resultValue, atMs: completedAtMs });
  }

  private resolveChoice(current: TriviaRoundQuestion, answer: string): string | null {
    if (typeof answer !== 'string') return null;
    const trimmed = answer.normalize('NFC').trim();
    if (/^[1-4]$/.test(trimmed)) return current.choiceOrder[Number(trimmed) - 1] ?? null;
    const direct = trimmed.toLowerCase();
    if (current.question.locales[this.locale].choices.some(choice => choice.id === direct)) return direct;
    return resolveTriviaChoiceId(current.question, this.locale, trimmed);
  }

  private resolveCategoryVote(): TriviaRoundCategoryId {
    const counts = this.categoryVoteCounts();
    const highest = Math.max(...TRIVIA_ROUND_CATEGORY_IDS.map(category => counts[category]));
    if (highest === 0) return 'mixed';
    const winners = TRIVIA_ROUND_CATEGORY_IDS.filter(category => counts[category] === highest);
    return winners.length === 1 ? winners[0]! : 'mixed';
  }

  private categoryVoteCounts(): TriviaCategoryVoteCounts {
    const counts = Object.fromEntries(
      TRIVIA_ROUND_CATEGORY_IDS.map(category => [category, 0]),
    ) as unknown as Record<TriviaRoundCategoryId, number>;
    for (const player of this.players) if (player.categoryVote) counts[player.categoryVote] += 1;
    return Object.freeze(counts);
  }

  private currentQuestion(): TriviaRoundQuestion | null {
    if (this.questionIndexValue === null
      || (this.phase !== 'question_prompt' && this.phase !== 'answer_cue'
        && this.phase !== 'question' && this.phase !== 'reveal')) return null;
    return this.round[this.questionIndexValue] ?? null;
  }

  private resetPlayersForRound(clearVotes = true): void {
    for (const player of this.players) {
      player.rawScore = 0;
      player.correctCount = 0;
      player.bestStreak = 0;
      player.currentStreak = 0;
      player.cumulativeCorrectTimeMs = 0;
      player.rank = undefined;
      player.normalizedScore = undefined;
      if (clearVotes) player.categoryVote = null;
      this.clearSubmittedAnswer(player);
    }
  }

  private clearSubmittedAnswer(player: RoomPlayer): void {
    player.submittedChoiceId = null;
    player.submittedElapsedMs = null;
    player.submittedCorrect = null;
    player.submittedPoints = 0;
  }

  private resetEmptyRoom(): void {
    this.phase = 'lobby';
    this.expectedPlayerCountValue = 1;
    this.automaticSetupValue = false;
    this.stationFixedValue = false;
    this.allowReplayValue = true;
    this.rosterFrozen = false;
    this.categoryValue = null;
    this.round = [];
    this.displayReadyValue = false;
    this.loadingDeadlineAt = null;
    this.countdownEndsAt = null;
    this.countdownValue = null;
    this.questionIndexValue = null;
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.answeringStartsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.revealEndsAt = null;
    this.promptReadyPlayerIds.clear();
    this.answerCueReadyPlayerIds.clear();
    this.resultValue = null;
  }
}

function cleanName(name: string): string {
  if (typeof name !== 'string') return 'Player';
  return name.normalize('NFC').trim().slice(0, 40) || 'Player';
}

function cleanRevision(revision: string): string {
  if (typeof revision !== 'string' || !revision.trim() || revision.length > 128 || /\p{Cc}/u.test(revision)) {
    throw new TypeError('contentRevision must be a bounded non-empty string');
  }
  return revision.trim();
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function boundedPromptDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new RangeError('questionPromptTimeoutMs must be an integer from 1 to 120000');
  }
  return value;
}

function boundedCueDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError('answerCueTimeoutMs must be an integer from 1 to 60000');
  }
  return value;
}
