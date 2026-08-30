import { parseCrMessage } from './conversation-relay';
import {
  TRIVIA_ROUND_CATEGORY_IDS,
  type PublicTriviaReveal,
  type TriviaRoundCategoryId,
} from '../shared/trivia';
import {
  type TriviaCategoryVoteCounts,
  type TriviaPhase,
  type TriviaPublicStanding,
  type TriviaResult,
} from '../shared/trivia-protocol';
import {
  TRIVIA_CATEGORY_ALIASES,
  TRIVIA_CATEGORY_LABELS,
  TRIVIA_MESSAGES,
  type TriviaMessageKey,
} from '../shared/i18n/trivia';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import {
  createTranslator,
  formatList,
  formatNumber,
  normalizeForMatching,
  type LocalizedCatalog,
  type MessageValues,
} from '../shared/i18n/translate';
import { parseFirstName } from '../shared/spoken-name';

const FINAL_REPEAT_GUARD_MS = 5_000;
export const TRIVIA_SPEECH_RETRY_DELAY_MS = 300;
export const TRIVIA_SPEECH_MAX_ATTEMPTS = 3;

export interface TriviaVoiceChoice {
  readonly id: string;
  readonly text: string;
  /** Server-only spoken forms. They are never sent through the browser trivia protocol. */
  readonly aliases?: readonly string[];
}

export interface TriviaVoiceQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly choices: readonly TriviaVoiceChoice[];
}

export interface TriviaVoicePlayer {
  readonly playerId: string;
  readonly name: string;
  readonly nameConfirmed: boolean;
  readonly connected: boolean;
  readonly rawScore: number;
  readonly correctCount: number;
}

/** The authoritative, server-only projection needed by one trivia caller. */
export interface TriviaVoiceSnapshot {
  readonly phase: TriviaPhase;
  readonly myName: string | null;
  readonly nameConfirmed: boolean;
  readonly expectedPlayerCount: 1 | 2 | 3 | 4;
  readonly hasExpectedPlayers: boolean;
  readonly automaticSetup: boolean;
  readonly players: readonly TriviaVoicePlayer[];
  readonly categoryVoteCounts: TriviaCategoryVoteCounts;
  readonly loadingGeneration: number;
  readonly questionIndex: number | null;
  readonly answeringStartsAtMs: number | null;
  readonly questionEndsAtMs: number | null;
  readonly question: TriviaVoiceQuestion | null;
  readonly reveal: PublicTriviaReveal | null;
  readonly standings: readonly TriviaPublicStanding[] | null;
  readonly result: TriviaResult | null;
  readonly myAnswered: boolean;
  /** Lets a replacement transport avoid replaying an already-settled prompt. */
  readonly myPromptReady: boolean;
  /** Lets a replacement transport avoid replaying an already-settled answer cue. */
  readonly myAnswerCueReady: boolean;
  /** Supports an accurate reveal delta after a transport reconnect. */
  readonly myQuestionPoints: number;
}

export interface TriviaVoiceDeps {
  /** Binds a caller or restores its existing player slot. */
  bind(
    code: string,
    name: string,
    callSid: string,
    locale: SupportedLocale,
    nameConfirmed: boolean,
    expectedPlayers: 1 | 2 | 3 | 4,
    participantIndex?: number,
  ): { playerId: string; resumed: boolean } | null;
  /** The integration may defer the actual removal to provide a reconnect grace period. */
  leave(code: string, playerId: string, callSid: string): void;
  setName(code: string, playerId: string, name: string): boolean;
  voteCategory(code: string, playerId: string, category: TriviaRoundCategoryId): boolean;
  advance(code: string, playerId: string): boolean;
  questionPromptReady(code: string, playerId: string, questionId: string): boolean;
  questionAnswerCueReady(code: string, playerId: string, questionId: string): boolean;
  answerAt(code: string, playerId: string, choiceId: string, final: true, answeredAtMs: number): boolean;
  snapshot(code: string, playerId: string, locale: SupportedLocale): TriviaVoiceSnapshot | null;
  /** Optional pure resolver for aliases not included on the server-only voice question. */
  resolveAnswer?(
    code: string,
    questionId: string,
    spoken: string,
    locale: SupportedLocale,
  ): string | null;
  /** Resolve true only after Relay reports successful playback of all text chunks. */
  say(text: string, isCurrent?: () => boolean): void | Promise<boolean>;
  /** Cancels queued or in-flight speech before a newly published question is spoken. */
  preemptSpeech(): void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type ExtraMessageKey =
  | 'waitingPlayers'
  | 'revealCorrect'
  | 'revealIncorrect'
  | 'standing'
  | 'winner'
  | 'tie';

const EXTRA_MESSAGES: LocalizedCatalog<ExtraMessageKey> = {
  'en-US': {
    waitingPlayers: 'Waiting for all {count} players to join and confirm their names.',
    revealCorrect: 'The answer was {choice}, {answer}; your answer was correct and gained {points} points; standings: {standings}.',
    revealIncorrect: 'The answer was {choice}, {answer}; your answer was not correct and gained {points} points; standings: {standings}.',
    standing: '{rank}, {name}, {score} points',
    winner: '{name} wins with a leaderboard score of {score}.',
    tie: 'It is a tie between {names}, each with a leaderboard score of {score}.',
  },
  'pt-BR': {
    waitingPlayers: 'Aguardando os {count} jogadores entrarem e confirmarem seus nomes.',
    revealCorrect: 'A resposta era {choice}, {answer}; você acertou e ganhou {points} pontos; classificação: {standings}.',
    revealIncorrect: 'A resposta era {choice}, {answer}; você não acertou e ganhou {points} pontos; classificação: {standings}.',
    standing: '{rank}, {name}, {score} pontos',
    winner: '{name} venceu com pontuação no ranking de {score}.',
    tie: 'Houve empate entre {names}, cada um com pontuação no ranking de {score}.',
  },
};

export class TriviaVoiceSession {
  private code: string | null = null;
  private playerId: string | null = null;
  private callSid: string | null = null;
  private commandLocale: SupportedLocale = DEFAULT_LOCALE;
  private authoritativeName: string | null = null;
  private expectedPlayers: 1 | 2 | 3 | 4 = 1;
  private stationManaged = false;
  private stationParticipantIndex: number | undefined;
  private active = true;
  private awaitingName = false;
  private namePrompted = false;
  private processingState = false;
  private deferState = false;
  private stateDirty = false;
  private lastPhase: TriviaPhase | null = null;
  private lobbyAttempt = '';
  private lobbyWaitingCue = '';
  private categoryAdvanceAttempt = '';
  private readonly preparingGenerations = new Set<number>();
  private activeQuestionKey: string | null = null;
  private observedStateQuestionKey: string | null = null;
  private inputStreamScope: string | null = null;
  private readonly promptAttempts = new Set<string>();
  private promptAttemptToken: symbol | null = null;
  private answerOnset: { scope: string; choiceId: string; atMs: number } | null = null;
  private observedInputScope: string | null = null;
  private readonly lockedQuestions = new Set<string>();
  private readonly answerCueAttempts = new Set<string>();
  private answerCueAttemptToken: symbol | null = null;
  private readonly announcedAnswerStarts = new Set<string>();
  private readonly answerStartAttempts = new Set<string>();
  private readonly announcedReveals = new Set<string>();
  private readonly revealAttempts = new Set<string>();
  private readonly announcedResults = new Set<string>();
  private readonly resultAttempts = new Set<string>();
  private readonly requiredSpeechAttempts = new Map<string, number>();
  private readonly requiredSpeechTimers = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    settle: () => void;
  }>();
  private lastFinal: { text: string; afterContext: string; at: number } | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  private text: (key: TriviaMessageKey, values?: MessageValues) => string =
    createTranslator(DEFAULT_LOCALE, TRIVIA_MESSAGES);
  private extra: (key: ExtraMessageKey, values?: MessageValues) => string =
    createTranslator(DEFAULT_LOCALE, EXTRA_MESSAGES);

  constructor(private readonly deps: TriviaVoiceDeps) {}

  get boundRoomCode(): string | null { return this.code; }
  get boundPlayerId(): string | null { return this.playerId; }
  get locale(): SupportedLocale { return this.commandLocale; }

  setAuthoritativeName(name: string | null): void {
    this.authoritativeName = name?.trim().slice(0, 40) || null;
  }

  setExpectedPlayers(count: number): void {
    if (!Number.isSafeInteger(count) || count < 1 || count > 4) {
      throw new RangeError('expected trivia players must be an integer from 1 to 4');
    }
    this.expectedPlayers = count as 1 | 2 | 3 | 4;
  }

  setStationManaged(active: boolean): void { this.stationManaged = active; }

  setStationAssignment(participantIndex: number): void {
    if (!Number.isSafeInteger(participantIndex) || participantIndex < 0 || participantIndex > 3) {
      throw new RangeError('trivia participant index must be an integer from 0 to 3');
    }
    this.stationParticipantIndex = participantIndex;
  }

  handleMessage(raw: string): void {
    if (!this.active) return;
    const message = parseCrMessage(raw);
    if (message.type === 'setup') {
      this.handleSetup(message.callSid, message.customParameters);
      return;
    }
    if (!this.code || !this.playerId) return;

    if (message.type === 'interrupt') {
      this.inputStreamScope = null;
      this.lastFinal = null;
      return;
    }
    if (message.type === 'dtmf') {
      this.inputStreamScope = null;
      this.answerOnset = null;
      this.handleDtmf(message.digit.trim());
      return;
    }
    if (message.type !== 'prompt') return;

    const snapshot = this.currentSnapshot();
    if (!snapshot) return;
    this.observeQuestion(snapshot);
    if (!message.last) {
      this.handleInterim(message.voicePrompt, snapshot);
      return;
    }

    const streamScope = this.inputStreamScope;
    this.inputStreamScope = null;
    const answerOnset = this.answerOnset;
    this.answerOnset = null;
    if (streamScope !== null && streamScope !== inputScope(snapshot)) return;
    const normalized = normalizeForMatching(message.voicePrompt, this.commandLocale);
    if (!normalized) return;
    const now = this.now();
    const beforeContext = this.finalContext(snapshot);
    if (this.lastFinal?.text === normalized && this.lastFinal.afterContext === beforeContext
      && now - this.lastFinal.at < FINAL_REPEAT_GUARD_MS) return;

    this.handleFinal(message.voicePrompt, snapshot, answerOnset);
    this.lastFinal = {
      text: normalized,
      afterContext: this.finalContext(this.currentSnapshot()),
      at: now,
    };
  }

  /** Called whenever the authoritative room publishes new state. */
  onStateChanged(): void {
    if (!this.active || !this.code || !this.playerId) return;
    if (this.deferState || this.processingState) {
      this.stateDirty = true;
      return;
    }
    this.processingState = true;
    try {
      do {
        this.stateDirty = false;
        const snapshot = this.currentSnapshot();
        if (snapshot) this.processSnapshot(snapshot);
      } while (this.stateDirty && this.active);
    } finally {
      this.processingState = false;
    }
  }

  async whenSpeechSettled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  handleClose(): void {
    if (!this.active) return;
    const code = this.code;
    const playerId = this.playerId;
    const callSid = this.callSid ?? '';
    this.clear();
    if (code && playerId) this.deps.leave(code, playerId, callSid);
  }

  /** A replacement transport owns the binding, so this transport must not schedule a leave. */
  handleReplaced(): void { this.clear(); }

  private handleSetup(callSid: string, parameters: Record<string, string>): void {
    if (this.playerId) return;
    const code = parameters['roomCode']?.trim().toUpperCase();
    if (!code) return;
    this.commandLocale = resolveLocale(parameters['commandLocale'] ?? parameters['locale']);
    this.text = createTranslator(this.commandLocale, TRIVIA_MESSAGES);
    this.extra = createTranslator(this.commandLocale, EXTRA_MESSAGES);
    const binding = this.deps.bind(
      code,
      this.authoritativeName ?? this.text('voice.playerPlaceholder'),
      callSid,
      this.commandLocale,
      this.authoritativeName !== null,
      this.expectedPlayers,
      this.stationManaged ? this.stationParticipantIndex : undefined,
    );
    if (!binding) {
      void this.speak(this.text('voice.roomUnavailable'));
      return;
    }

    this.code = code;
    this.playerId = binding.playerId;
    this.callSid = callSid;
    const snapshot = this.currentSnapshot();
    if (!snapshot) return;
    this.awaitingName = !snapshot.nameConfirmed;
    this.lastPhase = snapshot.phase;
    this.observedStateQuestionKey = questionKey(snapshot);
    this.observeQuestion(snapshot);

    if (binding.resumed) {
      if (snapshot.phase === 'question_prompt') {
        this.presentQuestion(snapshot);
        return;
      }
      if (snapshot.phase === 'answer_cue') {
        this.presentAnswerCue(snapshot);
        return;
      }
      if (snapshot.phase === 'question') {
        if (!snapshot.myAnswered) this.presentAnswerStart(snapshot, true);
        return;
      }
      void this.speak(snapshot.nameConfirmed && snapshot.myName
        ? this.text('voice.returnedName', { name: snapshot.myName })
        : this.text('voice.returned'));
      this.speakContext(snapshot);
      return;
    }

    void this.speak(this.text('voice.welcome'));
    if (!snapshot.nameConfirmed) {
      this.askName();
      return;
    }
    if (snapshot.myName) void this.speak(this.text('voice.welcomeName', { name: snapshot.myName }));
    void this.speak(this.text('voice.gameplay'));
    this.onStateChanged();
  }

  private handleInterim(spoken: string, snapshot: TriviaVoiceSnapshot): void {
    this.inputStreamScope ??= inputScope(snapshot);
    if (snapshot.phase !== 'question' || snapshot.myAnswered || !this.activeQuestionKey) {
      this.answerOnset = null;
      return;
    }
    const choiceId = this.resolveAnswer(spoken, snapshot);
    if (!choiceId || snapshot.answeringStartsAtMs === null || snapshot.questionEndsAtMs === null) {
      this.answerOnset = null;
      return;
    }
    const now = this.now();
    if (now < snapshot.answeringStartsAtMs || now > snapshot.questionEndsAtMs) {
      this.answerOnset = null;
      return;
    }
    const scope = inputScope(snapshot);
    if (this.answerOnset?.scope !== scope || this.answerOnset.choiceId !== choiceId) {
      this.answerOnset = { scope, choiceId, atMs: now };
    }
  }

  private handleFinal(
    spoken: string,
    snapshot: TriviaVoiceSnapshot,
    answerOnset: { scope: string; choiceId: string; atMs: number } | null,
  ): void {
    if (this.awaitingName || !snapshot.nameConfirmed) {
      this.captureName(spoken);
      return;
    }
    if (snapshot.phase === 'category_select') {
      this.chooseCategory(spoken, snapshot);
      return;
    }
    if (snapshot.phase === 'question') {
      this.commitAnswer(spoken, snapshot, answerOnset);
      return;
    }
    if (snapshot.phase === 'results' && isPlayAgain(spoken, this.commandLocale)) {
      if (this.stationManaged) {
        void this.speak(this.text('voice.stationRequeue'), this.phaseGuard('results'));
        return;
      }
      const advanced = this.applyAuthority(() => this.deps.advance(this.code!, this.playerId!));
      if (!advanced) void this.speak(this.text('voice.notReady'), this.phaseGuard('results'));
      this.onStateChanged();
    }
  }

  private captureName(spoken: string): void {
    const name = parseTriviaName(spoken, this.commandLocale);
    if (!name) {
      void this.speak(this.text('voice.invalidName'));
      return;
    }
    const accepted = this.applyAuthority(() => this.deps.setName(this.code!, this.playerId!, name));
    const snapshot = this.currentSnapshot();
    if (!accepted || !snapshot?.nameConfirmed) {
      void this.speak(this.text('voice.invalidName'));
      this.onStateChanged();
      return;
    }
    this.awaitingName = false;
    this.namePrompted = false;
    void this.speak(this.text('voice.welcomeName', { name: snapshot.myName ?? name }));
    void this.speak(this.text('voice.gameplay'));
    this.onStateChanged();
  }

  private chooseCategory(spoken: string, snapshot: TriviaVoiceSnapshot): void {
    const category = matchTriviaCategory(spoken, this.commandLocale);
    if (!category) {
      void this.speak(this.text('voice.unknownCategory'), this.phaseGuard('category_select'));
      return;
    }
    const accepted = this.applyAuthority(() => this.deps.voteCategory(
      this.code!, this.playerId!, category,
    ));
    if (accepted) {
      void this.speak(this.text('voice.categorySelected', {
        category: TRIVIA_CATEGORY_LABELS[this.commandLocale][category],
      }), this.categoryOrLoadingGuard());
    } else {
      void this.speak(this.text('voice.unknownCategory'), this.phaseGuard(snapshot.phase));
    }
    this.onStateChanged();
  }

  private commitAnswer(
    spoken: string,
    snapshot: TriviaVoiceSnapshot,
    answerOnset: { scope: string; choiceId: string; atMs: number } | null = null,
  ): void {
    const questionKey = this.activeQuestionKey;
    if (!questionKey || snapshot.myAnswered || this.lockedQuestions.has(questionKey)) return;
    const choiceId = this.resolveAnswer(spoken, snapshot);
    if (!choiceId) {
      void this.speak(this.text('voice.answerUnknown'), this.questionGuard(questionKey, ['question']));
      return;
    }
    if (snapshot.answeringStartsAtMs === null || snapshot.questionEndsAtMs === null) return;
    const answeredAtMs = answerOnset?.scope === inputScope(snapshot) && answerOnset.choiceId === choiceId
      ? answerOnset.atMs
      : this.now();
    if (answeredAtMs < snapshot.answeringStartsAtMs) return;
    if (answeredAtMs > snapshot.questionEndsAtMs) {
      void this.speak(this.text('voice.answerTooLate'), this.questionGuard(questionKey, ['question']));
      return;
    }

    const accepted = this.applyAuthority(() => this.deps.answerAt(
      this.code!, this.playerId!, choiceId, true, answeredAtMs,
    ));
    if (accepted) {
      this.lockedQuestions.add(questionKey);
      void this.speak(this.text('voice.answerAccepted'), this.questionGuard(questionKey, ['question', 'reveal']));
    } else if (!this.currentSnapshot()?.myAnswered) {
      void this.speak(this.text('voice.answerTooLate'), this.questionGuard(questionKey, ['question']));
    }
    this.onStateChanged();
  }

  private handleDtmf(digit: string): void {
    const snapshot = this.currentSnapshot();
    if (!snapshot) return;
    this.observeQuestion(snapshot);
    if (!snapshot.nameConfirmed) {
      this.askName();
      return;
    }
    if (snapshot.phase === 'category_select' && /^[1-9]$/.test(digit)) this.chooseCategory(digit, snapshot);
    else if (snapshot.phase === 'question' && /^[1-4]$/.test(digit)) this.commitAnswer(digit, snapshot);
  }

  private processSnapshot(snapshot: TriviaVoiceSnapshot): void {
    const previousPhase = this.lastPhase;
    this.lastPhase = snapshot.phase;
    const nextQuestionKey = questionKey(snapshot);
    if (nextQuestionKey && nextQuestionKey !== this.observedStateQuestionKey) {
      this.observedStateQuestionKey = nextQuestionKey;
      this.deps.preemptSpeech();
    }
    this.observeQuestion(snapshot);
    if (!snapshot.nameConfirmed) {
      this.awaitingName = true;
      this.askName();
      return;
    }

    if (snapshot.phase === 'lobby') {
      this.advanceLobby(snapshot);
      return;
    }
    if (snapshot.phase === 'category_select') {
      if (previousPhase === 'loading') {
        this.categoryAdvanceAttempt = '';
        void this.speak(this.text('voice.loadingTimeout'), this.phaseGuard('category_select'));
      }
      if (previousPhase !== 'category_select') this.speakCategories();
      this.advanceCategoryWhenReady(snapshot);
      return;
    }
    if (snapshot.phase === 'loading') {
      if (!this.preparingGenerations.has(snapshot.loadingGeneration)) {
        this.preparingGenerations.add(snapshot.loadingGeneration);
        void this.speak(this.text('voice.preparing'), this.loadingGuard(snapshot.loadingGeneration));
      }
      return;
    }
    if (snapshot.phase === 'question_prompt') {
      this.presentQuestion(snapshot);
      return;
    }
    if (snapshot.phase === 'answer_cue') {
      this.presentAnswerCue(snapshot);
      return;
    }
    if (snapshot.phase === 'question') {
      this.presentAnswerStart(snapshot);
      return;
    }
    if (snapshot.phase === 'reveal') {
      this.announceReveal(snapshot);
      return;
    }
    if (snapshot.phase === 'results') this.announceResult(snapshot);
  }

  private advanceLobby(snapshot: TriviaVoiceSnapshot): void {
    const confirmed = snapshot.players.filter(player => player.nameConfirmed).length;
    const context = `${snapshot.players.length}:${confirmed}:${snapshot.expectedPlayerCount}`;
    const ready = snapshot.hasExpectedPlayers
      && snapshot.players.length === snapshot.expectedPlayerCount
      && confirmed === snapshot.expectedPlayerCount;
    if (!ready) {
      if (this.lobbyWaitingCue !== context) {
        this.lobbyWaitingCue = context;
        void this.speak(this.extra('waitingPlayers', { count: snapshot.expectedPlayerCount }), this.phaseGuard('lobby'));
      }
      return;
    }
    if (this.lobbyAttempt === context) return;
    this.lobbyAttempt = context;
    const advanced = this.applyAuthority(() => this.deps.advance(this.code!, this.playerId!));
    if (!advanced && this.currentSnapshot()?.phase === 'lobby') {
      void this.speak(this.text('voice.notReady'), this.phaseGuard('lobby'));
    }
    this.onStateChanged();
  }

  private advanceCategoryWhenReady(snapshot: TriviaVoiceSnapshot): void {
    const voteCount = TRIVIA_ROUND_CATEGORY_IDS.reduce(
      (total, category) => total + snapshot.categoryVoteCounts[category],
      0,
    );
    if (!snapshot.hasExpectedPlayers || voteCount < snapshot.expectedPlayerCount) return;
    const context = TRIVIA_ROUND_CATEGORY_IDS.map(category => snapshot.categoryVoteCounts[category]).join(':');
    if (this.categoryAdvanceAttempt === context) return;
    this.categoryAdvanceAttempt = context;
    this.applyAuthority(() => this.deps.advance(this.code!, this.playerId!));
    this.onStateChanged();
  }

  private speakContext(snapshot: TriviaVoiceSnapshot): void {
    if (!snapshot.nameConfirmed) {
      this.askName();
    } else if (snapshot.phase === 'lobby') {
      this.onStateChanged();
    } else if (snapshot.phase === 'category_select') {
      this.speakCategories();
      this.advanceCategoryWhenReady(snapshot);
    } else if (snapshot.phase === 'loading') {
      this.processSnapshot(snapshot);
    } else if (snapshot.phase === 'question_prompt') {
      this.presentQuestion(snapshot);
    } else if (snapshot.phase === 'answer_cue') {
      this.presentAnswerCue(snapshot);
    } else if (snapshot.phase === 'question') {
      this.presentAnswerStart(snapshot);
    } else if (snapshot.phase === 'reveal') {
      this.announceReveal(snapshot);
    } else if (snapshot.phase === 'results') {
      this.announceResult(snapshot);
    }
  }

  private speakCategories(): void {
    const labels = TRIVIA_ROUND_CATEGORY_IDS.slice(0, -1).map((category, index) =>
      `${index + 1}, ${TRIVIA_CATEGORY_LABELS[this.commandLocale][category]}`);
    const mixed = TRIVIA_CATEGORY_LABELS[this.commandLocale].mixed;
    const prompt = this.text('voice.chooseCategory', {
      categories: formatList(this.commandLocale, labels),
    }).replace(mixed, `9, ${mixed}`);
    void this.speak(prompt, this.phaseGuard('category_select'));
  }

  private presentQuestion(snapshot: TriviaVoiceSnapshot): void {
    const question = snapshot.question;
    const questionKey = this.activeQuestionKey;
    const attemptKey = `prompt:${questionKey}`;
    if (!question || !questionKey || snapshot.myPromptReady || this.promptAttempts.has(questionKey)
      || !this.beginRequiredSpeech(attemptKey)) return;
    this.promptAttempts.add(questionKey);
    const token = Symbol(questionKey);
    this.promptAttemptToken = token;
    const prompts = this.questionPrompts(snapshot);
    const guard = this.questionGuard(questionKey, ['question_prompt']);
    const delivery = Promise.all(prompts.map(prompt => this.speak(prompt, guard)));
    const settlement = delivery.then(played => {
      if (this.promptAttemptToken !== token) return;
      this.promptAttemptToken = null;
      if (!played.every(result => result) || !guard() || !this.code || !this.playerId) {
        this.promptAttempts.delete(questionKey);
        this.retryRequiredSpeech(attemptKey, guard, () => {
          const current = this.currentSnapshot();
          if (current) this.presentQuestion(current);
        });
        return;
      }
      const accepted = this.applyAuthority(() => (
        this.deps.questionPromptReady(this.code!, this.playerId!, question.id)
      ));
      if (!accepted) this.promptAttempts.delete(questionKey);
      this.finishRequiredSpeech(attemptKey);
      if (accepted) this.onStateChanged();
    }).catch(() => {
      if (this.promptAttemptToken === token) {
        this.promptAttemptToken = null;
        this.promptAttempts.delete(questionKey);
        this.retryRequiredSpeech(attemptKey, guard, () => {
          const current = this.currentSnapshot();
          if (current) this.presentQuestion(current);
        });
      }
    });
    this.track(settlement);
  }

  private presentAnswerCue(snapshot: TriviaVoiceSnapshot): void {
    const questionKey = this.activeQuestionKey;
    const question = snapshot.question;
    const attemptKey = `cue:${questionKey}`;
    if (!questionKey || !question || snapshot.myAnswerCueReady || this.answerCueAttempts.has(questionKey)
      || !this.beginRequiredSpeech(attemptKey)) return;
    this.answerCueAttempts.add(questionKey);
    const token = Symbol(questionKey);
    this.answerCueAttemptToken = token;
    const guard = this.questionGuard(questionKey, ['answer_cue']);
    const settlement = this.speak(this.text('voice.getReady'), guard).then(played => {
      if (this.answerCueAttemptToken !== token) return;
      this.answerCueAttemptToken = null;
      if (!played || !guard() || !this.code || !this.playerId) {
        this.answerCueAttempts.delete(questionKey);
        this.retryRequiredSpeech(attemptKey, guard, () => {
          const current = this.currentSnapshot();
          if (current) this.presentAnswerCue(current);
        });
        return;
      }
      const accepted = this.applyAuthority(() => (
        this.deps.questionAnswerCueReady(this.code!, this.playerId!, question.id)
      ));
      if (!accepted) this.answerCueAttempts.delete(questionKey);
      this.finishRequiredSpeech(attemptKey);
      if (accepted) this.onStateChanged();
    }).catch(() => {
      if (this.answerCueAttemptToken === token) {
        this.answerCueAttemptToken = null;
        this.answerCueAttempts.delete(questionKey);
        this.retryRequiredSpeech(attemptKey, guard, () => {
          const current = this.currentSnapshot();
          if (current) this.presentAnswerCue(current);
        });
      }
    });
    this.track(settlement);
  }

  private presentAnswerStart(snapshot: TriviaVoiceSnapshot, resumed = false): void {
    const questionKey = this.activeQuestionKey;
    const attemptKey = `answer-start:${questionKey}`;
    if (!questionKey || snapshot.myAnswered || this.announcedAnswerStarts.has(questionKey)
      || this.answerStartAttempts.has(questionKey) || !this.beginRequiredSpeech(attemptKey)) return;
    const remainingSeconds = snapshot.answeringStartsAtMs === null || snapshot.questionEndsAtMs === null
      ? 0
      : Math.max(0, Math.ceil((snapshot.questionEndsAtMs
        - Math.max(this.now(), snapshot.answeringStartsAtMs)) / 1_000));
    const prompts = [...this.questionPrompts(snapshot)];
    if (resumed) prompts.push(this.text('voice.answerResume', { seconds: remainingSeconds }));
    const guard = this.unansweredQuestionGuard(questionKey);
    this.answerStartAttempts.add(questionKey);
    const settlement = Promise.all(prompts.map(prompt => this.speak(prompt, guard))).then(played => {
      this.answerStartAttempts.delete(questionKey);
      if (played.every(result => result) && guard()) {
        this.announcedAnswerStarts.add(questionKey);
        this.finishRequiredSpeech(attemptKey);
      } else this.retryRequiredSpeech(attemptKey, guard, () => {
        const current = this.currentSnapshot();
        if (current) this.presentAnswerStart(current, resumed);
      });
    }).catch(() => {
      this.answerStartAttempts.delete(questionKey);
      this.retryRequiredSpeech(attemptKey, guard, () => {
        const current = this.currentSnapshot();
        if (current) this.presentAnswerStart(current, resumed);
      });
    });
    this.track(settlement);
  }

  private announceReveal(snapshot: TriviaVoiceSnapshot): void {
    const question = snapshot.question;
    const reveal = snapshot.reveal;
    const questionKey = this.activeQuestionKey;
    const attemptKey = `reveal:${questionKey}`;
    if (!question || !reveal || !questionKey || this.announcedReveals.has(questionKey)
      || this.revealAttempts.has(questionKey) || !this.beginRequiredSpeech(attemptKey)) return;
    const correctIndex = question.choices.findIndex(choice => choice.id === reveal.correctChoiceId);
    const correctChoice = question.choices[correctIndex];
    if (!correctChoice) return;
    const points = snapshot.myQuestionPoints;
    const standings = (snapshot.standings ?? []).map(standing => this.extra('standing', {
      rank: standing.rank,
      name: standing.name,
      score: formatNumber(this.commandLocale, standing.rawScore),
    }));
    const guard = this.questionGuard(questionKey, ['reveal']);
    this.revealAttempts.add(questionKey);
    const settlement = this.speak(this.extra(points > 0 ? 'revealCorrect' : 'revealIncorrect', {
      choice: this.choiceNumber(correctIndex),
      answer: correctChoice.text,
      points: formatNumber(this.commandLocale, points),
      standings: standings.length ? formatList(this.commandLocale, standings) : '-',
    }), guard).then(played => {
      this.revealAttempts.delete(questionKey);
      if (played && guard()) {
        this.announcedReveals.add(questionKey);
        this.finishRequiredSpeech(attemptKey);
      } else this.retryRequiredSpeech(attemptKey, guard, () => {
        const current = this.currentSnapshot();
        if (current) this.announceReveal(current);
      });
    }).catch(() => {
      this.revealAttempts.delete(questionKey);
      this.retryRequiredSpeech(attemptKey, guard, () => {
        const current = this.currentSnapshot();
        if (current) this.announceReveal(current);
      });
    });
    this.track(settlement);
  }

  private announceResult(snapshot: TriviaVoiceSnapshot): void {
    const result = snapshot.result;
    const attemptKey = `result:${result?.resultId ?? ''}`;
    if (!result || this.announcedResults.has(result.resultId) || this.resultAttempts.has(result.resultId)
      || !this.beginRequiredSpeech(attemptKey)) return;
    const winners = result.players.filter(player => player.rank === 1);
    const winningScore = winners[0]?.normalizedScore ?? 0;
    const outcome = winners.length > 1
      ? this.extra('tie', {
          names: formatList(this.commandLocale, winners.map(player => player.name)),
          score: formatNumber(this.commandLocale, winningScore),
        })
      : this.extra('winner', {
          name: winners[0]?.name ?? snapshot.myName ?? this.text('voice.playerPlaceholder'),
          score: formatNumber(this.commandLocale, winningScore),
        });
    const mine = result.players.find(player => player.playerId === this.playerId);
    const guard = this.resultGuard(result.resultId);
    const prompts = [outcome];
    if (mine) prompts.push(this.text('voice.result', {
      name: mine.name,
      score: formatNumber(this.commandLocale, mine.normalizedScore),
      correct: formatNumber(this.commandLocale, mine.correctCount),
    }));
    prompts.push(this.text(this.stationManaged ? 'voice.stationRequeue' : 'voice.playAgain'));
    this.resultAttempts.add(result.resultId);
    const settlement = Promise.all(prompts.map(prompt => this.speak(prompt, guard))).then(played => {
      this.resultAttempts.delete(result.resultId);
      if (played.every(resultPlayed => resultPlayed) && guard()) {
        this.announcedResults.add(result.resultId);
        this.finishRequiredSpeech(attemptKey);
      } else this.retryRequiredSpeech(attemptKey, guard, () => {
        const current = this.currentSnapshot();
        if (current) this.announceResult(current);
      });
    }).catch(() => {
      this.resultAttempts.delete(result.resultId);
      this.retryRequiredSpeech(attemptKey, guard, () => {
        const current = this.currentSnapshot();
        if (current) this.announceResult(current);
      });
    });
    this.track(settlement);
  }

  private questionPrompts(snapshot: TriviaVoiceSnapshot): string[] {
    const question = snapshot.question;
    if (!question) return [];
    const choices = question.choices.map((choice, index) => `${this.choiceNumber(index)}, ${choice.text}`);
    return [this.text('voice.question', {
      number: (snapshot.questionIndex ?? 0) + 1,
      prompt: question.prompt,
    }), this.text('voice.questionChoices', {
      choices: choices.join('; '),
    })];
  }

  private choiceNumber(index: number): string {
    return (this.commandLocale === 'pt-BR'
      ? ['Um', 'Dois', 'Três', 'Quatro']
      : ['One', 'Two', 'Three', 'Four'])[index] ?? String(index + 1);
  }

  private resolveAnswer(spoken: string, snapshot: TriviaVoiceSnapshot): string | null {
    const question = snapshot.question;
    if (!question) return null;
    const local = matchTriviaAnswer(spoken, question, this.commandLocale);
    const resolved = local ?? this.deps.resolveAnswer?.(
      this.code!, question.id, spoken, this.commandLocale,
    ) ?? null;
    return question.choices.some(choice => choice.id === resolved) ? resolved : null;
  }

  private observeQuestion(snapshot: TriviaVoiceSnapshot): void {
    const scope = inputScope(snapshot);
    if (scope !== this.observedInputScope) {
      this.observedInputScope = scope;
      this.answerOnset = null;
    }
    const key = questionKey(snapshot);
    if (!key || key === this.activeQuestionKey) return;
    this.activeQuestionKey = key;
    this.answerOnset = null;
    this.lastFinal = null;
  }

  private askName(): void {
    if (this.namePrompted) return;
    this.namePrompted = true;
    void this.speak(this.text('voice.askName'));
  }

  private currentSnapshot(): TriviaVoiceSnapshot | null {
    return this.code && this.playerId
      ? this.deps.snapshot(this.code, this.playerId, this.commandLocale)
      : null;
  }

  private finalContext(snapshot: TriviaVoiceSnapshot | null): string {
    const votes = snapshot
      ? TRIVIA_ROUND_CATEGORY_IDS.map(category => snapshot.categoryVoteCounts[category]).join(',')
      : '';
    return `${snapshot?.phase ?? 'unavailable'}:${snapshot?.nameConfirmed ? 1 : 0}:`
      + `${questionKey(snapshot)}:${snapshot?.myAnswered ? 1 : 0}:${votes}`;
  }

  private phaseGuard(phase: TriviaPhase): () => boolean {
    return () => this.currentSnapshot()?.phase === phase;
  }

  private loadingGuard(generation: number): () => boolean {
    return () => {
      const snapshot = this.currentSnapshot();
      return snapshot?.phase === 'loading' && snapshot.loadingGeneration === generation;
    };
  }

  private categoryOrLoadingGuard(): () => boolean {
    return () => {
      const phase = this.currentSnapshot()?.phase;
      return phase === 'category_select' || phase === 'loading';
    };
  }

  private questionGuard(question: string, phases: readonly TriviaPhase[]): () => boolean {
    return () => {
      const snapshot = this.currentSnapshot();
      return Boolean(snapshot && phases.includes(snapshot.phase) && questionKey(snapshot) === question);
    };
  }

  private unansweredQuestionGuard(question: string): () => boolean {
    return () => {
      const snapshot = this.currentSnapshot();
      return Boolean(snapshot && snapshot.phase === 'question' && !snapshot.myAnswered
        && questionKey(snapshot) === question);
    };
  }

  private resultGuard(resultId: string): () => boolean {
    return () => this.currentSnapshot()?.result?.resultId === resultId;
  }

  private speak(text: string, guard?: () => boolean): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    const isCurrent = () => this.active && (!guard || guard());
    let delivery: void | Promise<boolean>;
    try {
      if (!isCurrent()) return Promise.resolve(false);
      delivery = this.deps.say(text, isCurrent);
    } catch {
      return Promise.resolve(false);
    }
    const settled = delivery && typeof delivery.then === 'function'
      ? Promise.resolve(delivery).then(played => played === true, () => false)
      : Promise.resolve(true);
    return this.track(settled);
  }

  private beginRequiredSpeech(key: string): boolean {
    if (this.requiredSpeechTimers.has(key)) return false;
    const attempts = this.requiredSpeechAttempts.get(key) ?? 0;
    if (attempts >= TRIVIA_SPEECH_MAX_ATTEMPTS) return false;
    this.requiredSpeechAttempts.set(key, attempts + 1);
    return true;
  }

  private retryRequiredSpeech(key: string, guard: () => boolean, retry: () => void): void {
    if (!this.active || !guard()) {
      this.requiredSpeechAttempts.delete(key);
      return;
    }
    const attempts = this.requiredSpeechAttempts.get(key) ?? 0;
    if (attempts >= TRIVIA_SPEECH_MAX_ATTEMPTS || this.requiredSpeechTimers.has(key)) return;
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    const callback = () => {
      const scheduled = this.requiredSpeechTimers.get(key);
      if (!scheduled || scheduled.settle !== settle) return;
      this.requiredSpeechTimers.delete(key);
      settle();
      if (this.active && guard()) retry();
      else this.requiredSpeechAttempts.delete(key);
    };
    const delay = TRIVIA_SPEECH_RETRY_DELAY_MS * attempts;
    const timer = this.deps.setTimer?.(callback, delay) ?? setTimeout(callback, delay);
    this.requiredSpeechTimers.set(key, { timer, settle });
    this.track(pending);
  }

  private finishRequiredSpeech(key: string): void {
    this.cancelRequiredSpeechRetry(key);
    this.requiredSpeechAttempts.delete(key);
  }

  private cancelRequiredSpeechRetry(key: string): void {
    const scheduled = this.requiredSpeechTimers.get(key);
    if (!scheduled) return;
    this.requiredSpeechTimers.delete(key);
    if (this.deps.clearTimer) this.deps.clearTimer(scheduled.timer);
    else clearTimeout(scheduled.timer);
    scheduled.settle();
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => { this.pending.delete(promise); },
      () => { this.pending.delete(promise); },
    );
    return promise;
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private applyAuthority<T>(action: () => T): T {
    this.deferState = true;
    try { return action(); } finally { this.deferState = false; }
  }

  private clear(): void {
    this.active = false;
    for (const key of [...this.requiredSpeechTimers.keys()]) this.cancelRequiredSpeechRetry(key);
    this.requiredSpeechAttempts.clear();
    this.promptAttemptToken = null;
    this.answerCueAttemptToken = null;
    this.inputStreamScope = null;
    this.answerOnset = null;
    this.observedInputScope = null;
    this.observedStateQuestionKey = null;
    this.code = null;
    this.playerId = null;
    this.callSid = null;
    this.stateDirty = false;
  }
}

export function matchTriviaCategory(
  spoken: string,
  locale: SupportedLocale = DEFAULT_LOCALE,
): TriviaRoundCategoryId | null {
  if (typeof spoken !== 'string' || Array.from(spoken).length > 200) return null;
  const normalized = normalizeForMatching(spoken, locale);
  if (!normalized) return null;
  const numbered = matchSelectionNumber(normalized, TRIVIA_ROUND_CATEGORY_IDS.length, locale, 'category');
  if (numbered !== null) return TRIVIA_ROUND_CATEGORY_IDS[numbered] ?? null;
  const matches = TRIVIA_ROUND_CATEGORY_IDS.filter(category => {
    const forms = [TRIVIA_CATEGORY_LABELS[locale][category], ...TRIVIA_CATEGORY_ALIASES[locale][category]];
    return forms.some(form => containsPhrase(normalized, normalizeForMatching(form, locale)));
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function matchTriviaAnswer(
  spoken: string,
  question: TriviaVoiceQuestion,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string | null {
  if (typeof spoken !== 'string' || Array.from(spoken).length > 300 || question.choices.length !== 4) return null;
  const normalized = normalizeForMatching(spoken, locale);
  if (!normalized) return null;
  const letter = matchSelectionLetter(normalized, locale);
  if (letter !== null) return question.choices[letter]?.id ?? null;
  const numbered = matchSelectionNumber(normalized, question.choices.length, locale, 'answer');
  if (numbered !== null) return question.choices[numbered]?.id ?? null;

  const matches = new Set<string>();
  for (const choice of question.choices) {
    for (const form of [choice.text, ...(choice.aliases ?? [])]) {
      const candidate = normalizeForMatching(form, locale);
      if (!candidate) continue;
      if (matchesBoundedAnswerForm(normalized, candidate, locale)) matches.add(choice.id);
    }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

function parseTriviaName(spoken: string, locale: SupportedLocale): string | null {
  const normalized = normalizeForMatching(spoken, locale);
  const nonName = locale === 'pt-BR'
    ? /\b(?:ajuda|categoria|ciencia|conhecimentos|entretenimento|esporte|geografia|historia|misturado|quiz|tecnologia|trivia|twilio)\b/
    : /\b(?:category|entertainment|general|geography|help|history|mixed|quiz|science|sports|technology|trivia|twilio)\b/;
  return nonName.test(normalized) ? null : parseFirstName(spoken, locale);
}

function isPlayAgain(spoken: string, locale: SupportedLocale): boolean {
  const normalized = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /^(?:jogar novamente|jogar de novo|de novo|nova rodada|revanche)$/.test(normalized)
    : /^(?:play again|again|another round|new round|rematch)$/.test(normalized);
}

function questionKey(snapshot: TriviaVoiceSnapshot | null): string | null {
  if (!snapshot?.question || snapshot.questionIndex === null) return null;
  return `${snapshot.loadingGeneration}:${snapshot.questionIndex}:${snapshot.question.id}`;
}

function inputScope(snapshot: TriviaVoiceSnapshot): string {
  return `${snapshot.phase}:${questionKey(snapshot) ?? ''}:${snapshot.nameConfirmed ? 1 : 0}`;
}

function matchSelectionLetter(text: string, locale: SupportedLocale): number | null {
  const exactAliases = [
    ['a', 'ay', 'aye', 'alpha', 'ah', 'alfa'],
    ['b', 'bee', 'bravo'],
    ['c', 'sea', 'charlie'],
    ['d', 'dee', 'delta'],
  ];
  const markedAliases = [
    [...exactAliases[0]!, 'eh', 'hey'],
    [...exactAliases[1]!, 'be'],
    [...exactAliases[2]!, 'see', 'ce', 'se'],
    [...exactAliases[3]!, 'the', 'de'],
  ];
  const exact = exactAliases.findIndex(forms => forms.includes(text));
  if (exact >= 0) return exact;
  for (let index = 0; index < markedAliases.length; index++) {
    const forms = markedAliases[index]!.map(escapePattern).join('|');
    const marked = locale === 'pt-BR'
      ? new RegExp(`^(?:(?:(?:minha|a) )?(?:resposta|escolha|opcao|letra)(?: correta)?(?: e| seria)?|(?:eu )?acho que (?:e|a resposta e)) (?:${forms})(?: por favor)?$`)
      : new RegExp(`^(?:(?:my (?:final )?|the )?(?:answer|choice|option|letter)(?: is| would be)?|i think (?:it|(?:the )?answer) is) (?:${forms})(?: please)?$`);
    if (marked.test(text)) return index;
  }
  return null;
}

function matchSelectionNumber(
  text: string,
  maximum: number,
  locale: SupportedLocale,
  kind: 'answer' | 'category',
): number | null {
  const numbers = locale === 'pt-BR'
    ? ['(?:um|uma)', '(?:dois|duas)', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove']
    : ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const ordinals = locale === 'pt-BR'
    ? ['primeir[oa]', 'segund[oa]', 'terceir[oa]', 'quart[oa]', 'quint[oa]', 'sext[oa]', 'setim[oa]', 'oitav[oa]', 'non[oa]']
    : ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
  const noun = kind === 'category'
    ? (locale === 'pt-BR' ? 'categoria(?: numero)?' : 'category(?: number)?')
    : (locale === 'pt-BR' ? '(?:resposta|opcao|numero)' : '(?:answer|choice|option|number)');
  for (let index = 0; index < maximum; index++) {
    const digit = String(index + 1);
    const word = numbers[index]!;
    const ordinal = ordinals[index]!;
    const selection = `(?:${digit}|${word}|${ordinal})`;
    const polite = locale === 'pt-BR' ? '(?: por favor)?' : '(?: please)?';
    const bare = new RegExp(`^${selection}${polite}$`);
    const marked = locale === 'pt-BR'
      ? new RegExp(`^(?:(?:minha|a) )?(?:${noun})(?: e| seria)? (?:a |o )?${selection}${polite}$|^(?:a |o )?${selection} (?:${noun})${polite}$`)
      : new RegExp(`^(?:my (?:final )?|the )?(?:${noun})(?: is| would be)? (?:the )?${selection}${polite}$|^(?:the )?${selection} (?:${noun})${polite}$`);
    const natural = locale === 'pt-BR'
      ? new RegExp(`^(?:eu )?(?:acho que (?:e|a resposta e)|escolho|quero|prefiro) (?:a |o )?${selection}${polite}$`).test(text)
      : new RegExp(`^(?:i think (?:it|(?:the )?answer) is|i(?: would|'d)? (?:choose|pick|want|prefer)) (?:the )?${selection}${polite}$`).test(text);
    if (bare.test(text) || marked.test(text) || natural) return index;
  }
  return null;
}

function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|\\b)${escaped}(?:$|\\b)`).test(text);
}

function matchesBoundedAnswerForm(
  text: string,
  candidate: string,
  locale: SupportedLocale,
): boolean {
  if (text === candidate) return true;
  const form = escapePattern(candidate).replace(/\s+/g, '\\s+');
  return locale === 'pt-BR'
    ? new RegExp(`^(?:(?:(?:minha|a) )?(?:resposta|escolha|opcao)(?: e| seria)?|(?:eu )?acho que (?:e|a resposta e|isso e)) (?:a |o )?${form}(?: por favor)?$|^${form} por favor$`).test(text)
    : new RegExp(`^(?:(?:my (?:final )?|the )?(?:answer|choice|option)(?: is| would be)?|i think (?:it|(?:the )?answer) is) (?:the )?${form}(?: please)?$|^${form} please$`).test(text);
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
