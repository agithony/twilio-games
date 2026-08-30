import { describe, expect, it } from 'vitest';
import {
  TRIVIA_SPEECH_MAX_ATTEMPTS,
  TRIVIA_SPEECH_RETRY_DELAY_MS,
  TriviaVoiceSession,
  matchTriviaAnswer,
  matchTriviaCategory,
  type TriviaVoiceChoice,
  type TriviaVoiceSnapshot,
} from '../server/trivia-voice';
import { TRIVIA_ANSWER_START_DELAY_MS } from '../server/trivia-room';
import { TRIVIA_ROUND_CATEGORY_IDS } from '../shared/trivia';
import type {
  TriviaCategoryVoteCounts,
  TriviaPublicStanding,
  TriviaResult,
} from '../shared/trivia-protocol';
import type { SupportedLocale } from '../shared/i18n/locales';

const choices: readonly TriviaVoiceChoice[] = [
  { id: 'rome', text: 'Rome', aliases: ['the eternal city'] },
  { id: 'paris', text: 'Paris', aliases: ['the city of light'] },
  { id: 'madrid', text: 'Madrid', aliases: ['capital of Spain'] },
  { id: 'vienna', text: 'Vienna', aliases: ['Wien'] },
];

const portugueseChoices: readonly TriviaVoiceChoice[] = [
  { id: 'rome', text: 'Roma', aliases: ['a cidade eterna'] },
  { id: 'paris', text: 'Paris', aliases: ['a cidade luz'] },
  { id: 'madrid', text: 'Madri', aliases: ['capital da Espanha'] },
  { id: 'vienna', text: 'Viena', aliases: ['Wien'] },
];

describe('TriviaVoiceSession setup and categories', () => {
  it.each([
    {
      locale: 'en-US' as const,
      name: 'Ada',
      category: 'I would like science',
      welcome: /Welcome to Voice Trivia, Ada/,
      categoryPrompt: /Choose a category.*1, General Knowledge.*2, Science.*Mixed/i,
      selected: /Science selected/,
      preparing: /Preparing the trivia round/,
    },
    {
      locale: 'pt-BR' as const,
      name: 'Ana',
      category: 'eu quero ciencias',
      welcome: /Quiz por Voz, Ana/,
      categoryPrompt: /Escolha uma categoria.*1, Conhecimentos Gerais.*2, Ciências.*Misturado/i,
      selected: /Categoria Ciências selecionada/i,
      preparing: /Preparando a rodada de quiz/,
    },
  ])('captures a final name and completes deterministic category setup in $locale', row => {
    const game = harness(baseState({
      myName: null,
      nameConfirmed: false,
      players: [player({ name: row.locale === 'pt-BR' ? 'Jogador' : 'Player', nameConfirmed: false })],
    }), row.locale);
    game.setup();

    expect(game.spoken.at(-1)?.text).toMatch(row.locale === 'pt-BR' ? /primeiro nome/i : /first name/i);
    game.prompt(row.name, false);
    expect(game.state.phase).toBe('lobby');
    game.prompt(row.name);

    expect(game.calls.setName).toEqual([row.name]);
    expect(game.state.phase).toBe('category_select');
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(row.welcome);
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(row.categoryPrompt);

    game.prompt(row.category);
    expect(game.calls.votes).toEqual(['science']);
    expect(game.state.phase).toBe('loading');
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(row.selected);
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(row.preparing);
  });

  it('waits for every expected caller to confirm a name before one trusted advance', () => {
    const game = harness(baseState({
      myName: 'Ada',
      nameConfirmed: true,
      expectedPlayerCount: 2,
      hasExpectedPlayers: true,
      automaticSetup: true,
      players: [
        player({ playerId: 't1', name: 'Ada' }),
        player({ playerId: 't2', name: 'Player', nameConfirmed: false }),
      ],
    }));
    game.session.setExpectedPlayers(2);
    game.session.setAuthoritativeName('Ada');
    game.setup();

    expect(game.calls.bindExpectedPlayers).toEqual([2]);
    expect(game.calls.advances).toBe(0);
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(/Waiting for all 2 players/i);

    game.setState({
      players: [player({ playerId: 't1', name: 'Ada' }), player({ playerId: 't2', name: 'Grace' })],
    });
    game.session.onStateChanged();

    expect(game.calls.advances).toBe(1);
    expect(game.state.phase).toBe('category_select');
  });

  it('passes only a validated station participant index into the authoritative bind', () => {
    const game = harness(baseState());
    game.session.setStationManaged(true);
    game.session.setStationAssignment(3);
    game.setup();
    expect(game.calls.bindParticipantIndexes).toEqual([3]);
    expect(() => game.session.setStationAssignment(-1)).toThrow(RangeError);
    expect(() => game.session.setStationAssignment(4)).toThrow(RangeError);

    const standalone = harness(baseState());
    standalone.setup();
    expect(standalone.calls.bindParticipantIndexes).toEqual([undefined]);
  });

  it('coordinates four independent callers through one authoritative lobby and vote', () => {
    let phase: TriviaVoiceSnapshot['phase'] = 'lobby';
    let loadingGeneration = 0;
    let successfulAdvances = 0;
    const players: Array<TriviaVoiceSnapshot['players'][number]> = [];
    const votes = new Map<string, (typeof TRIVIA_ROUND_CATEGORY_IDS)[number]>();
    const sessions: TriviaVoiceSession[] = [];
    const counts = () => {
      const result = { ...emptyVotes() };
      for (const category of votes.values()) result[category] += 1;
      return result;
    };
    const notify = () => sessions.forEach(session => session.onStateChanged());
    const snapshot = (playerId: string): TriviaVoiceSnapshot => {
      const me = players.find(candidate => candidate.playerId === playerId)!;
      return baseState({
        phase,
        myName: me.name,
        nameConfirmed: me.nameConfirmed,
        expectedPlayerCount: 4,
        hasExpectedPlayers: players.length === 4,
        automaticSetup: true,
        players: players.slice(),
        categoryVoteCounts: counts(),
        loadingGeneration,
      });
    };

    for (let index = 0; index < 4; index++) {
      let session!: TriviaVoiceSession;
      session = new TriviaVoiceSession({
        bind: () => {
          const playerId = `t${index + 1}`;
          players.push(player({ playerId, name: 'Player', nameConfirmed: false }));
          return { playerId, resumed: false };
        },
        leave: () => {},
        setName: (_code, playerId, name) => {
          const playerIndex = players.findIndex(candidate => candidate.playerId === playerId);
          players[playerIndex] = { ...players[playerIndex]!, name, nameConfirmed: true };
          notify();
          return true;
        },
        voteCategory: (_code, playerId, category) => {
          const accepted = phase === 'category_select';
          if (!accepted) return false;
          votes.set(playerId, category);
          notify();
          return true;
        },
        advance: () => {
          if (phase === 'lobby' && players.length === 4 && players.every(candidate => candidate.nameConfirmed)) {
            phase = 'category_select';
          } else if (phase === 'category_select' && votes.size === 4) {
            phase = 'loading';
            loadingGeneration = 1;
          } else return false;
          successfulAdvances += 1;
          notify();
          return true;
        },
        questionPromptReady: () => false,
        questionAnswerCueReady: () => false,
        answerAt: () => false,
        snapshot: (_code, playerId) => snapshot(playerId),
        say: () => {},
      });
      session.setExpectedPlayers(4);
      sessions.push(session);
      session.handleMessage(JSON.stringify({
        type: 'setup', callSid: `CA-${index}`, customParameters: { roomCode: 'TEAM' },
      }));
    }

    ['Ada', 'Grace', 'Linus', 'Margaret'].forEach((name, index) => {
      sessions[index]!.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: name, last: true }));
    });
    expect(phase).toBe('category_select');
    expect(new Set(sessions.map(session => session.boundPlayerId))).toHaveLength(4);

    ['science', 'history', 'science', 'science'].forEach((category, index) => {
      sessions[index]!.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: category, last: true }));
    });
    expect(phase).toBe('loading');
    expect(successfulAdvances).toBe(2);
  });

  it('rejects command-like names and unknown categories without mutating authority', () => {
    const unnamed = harness(baseState({
      myName: null,
      nameConfirmed: false,
      players: [player({ name: 'Player', nameConfirmed: false })],
    }));
    unnamed.setup();
    unnamed.prompt('science');
    expect(unnamed.calls.setName).toEqual([]);
    expect(unnamed.spoken.at(-1)?.text).toMatch(/only your first name/i);

    const category = harness(baseState({ phase: 'category_select' }));
    category.setup();
    category.prompt('purple elephants');
    expect(category.calls.votes).toEqual([]);
    expect(category.spoken.at(-1)?.text).toMatch(/did not recognize that category/i);
  });

  it('matches category labels, aliases, cardinals, and ordinals without AI', () => {
    expect(matchTriviaCategory('category number two')).toBe('science');
    expect(matchTriviaCategory('tech')).toBe('technology');
    expect(matchTriviaCategory('9')).toBe('mixed');
    expect(matchTriviaCategory('eu prefiro a terceira', 'pt-BR')).toBe('geography');
    expect(matchTriviaCategory('filmes e musica', 'pt-BR')).toBe('entertainment');
    expect(matchTriviaCategory('something unrelated')).toBeNull();
  });

  it('reopens category selection with reachable guidance after a loading timeout', () => {
    const game = harness(baseState({ phase: 'loading', loadingGeneration: 3 }), 'en-US', { resumed: true });
    game.setup();
    game.setState({ phase: 'category_select', categoryVoteCounts: emptyVotes(), loadingGeneration: 4 });
    game.session.onStateChanged();

    const speech = game.spoken.map(item => item.text).join(' ');
    expect(speech).toMatch(/display did not become ready.*choose a category again/i);
    expect(speech).toMatch(/Choose a category/i);
    expect(game.calls.advances).toBe(0);
  });
});

describe('TriviaVoiceSession question playback and answers', () => {
  it('releases prompt and cue barriers only after successful playback and retries contextually', async () => {
    const failed = harness(questionPromptState(), 'en-US', {
      deferQuestion: true, deferCue: true, resumed: true, manualTimers: true,
    });
    failed.setup();
    failed.session.onStateChanged();
    expect(failed.questionSpeech()).toHaveLength(2);
    expect(failed.questionSpeech().map(item => item.text).join(' ')).not.toMatch(/answer now/i);
    expect(failed.calls.promptReady).toEqual([]);
    failed.settleQuestionChunk(0, false);
    await Promise.resolve();
    expect(failed.calls.promptReady).toEqual([]);
    failed.settleQuestionChunk(1, false);
    await eventually(() => failed.retryTimerCount === 1);
    expect(failed.calls.promptReady).toEqual([]);
    expect(failed.state.phase).toBe('question_prompt');

    failed.runNextRetryTimer();
    expect(failed.questionSpeech()).toHaveLength(4);
    failed.settleQuestion(true);
    await eventually(() => failed.calls.promptReady.length === 1);
    expect(failed.calls.promptReady).toEqual(['question-1']);
    expect(failed.spoken.filter(item => item.text === 'Get ready.')).toHaveLength(1);
    expect(failed.spoken.filter(item => item.text === 'Say your answer now.')).toHaveLength(0);
    expect(failed.state.phase).toBe('answer_cue');
    expect(failed.calls.cueReady).toEqual([]);
    failed.settleCue(false);
    await eventually(() => failed.retryTimerCount === 1);
    expect(failed.calls.cueReady).toEqual([]);
    expect(failed.state.phase).toBe('answer_cue');
    failed.runNextRetryTimer();
    expect(failed.spoken.filter(item => item.text === 'Get ready.')).toHaveLength(2);
    failed.settleCue(true);
    await failed.session.whenSpeechSettled();
    expect(failed.calls.cueReady).toEqual(['question-1']);
    expect(failed.state.phase).toBe('question');
    expect(failed.spoken.filter(item => item.text === 'Say your answer now.')).toHaveLength(1);

    const played = harness(questionPromptState(), 'en-US', { deferQuestion: true, resumed: true });
    played.setup();
    expect(played.questionSpeech()).toHaveLength(2);
    expect(played.questionSpeech().map(item => item.text).join(' ')).toMatch(
      /Question 1.*capital of France.*choices are A, Rome.*B, Paris.*C, Madrid.*D, Vienna/i,
    );
    played.settleQuestion(true);
    await played.session.whenSpeechSettled();

    expect(played.calls.promptReady).toEqual(['question-1']);
    expect(played.state.phase).toBe('question');
    played.session.onStateChanged();
    expect(played.spoken.filter(item => item.text === 'Say your answer now.')).toHaveLength(1);
  });

  it('waits for staggered two-chunk playback from all four callers before one synchronized cue each', async () => {
    let phase: TriviaVoiceSnapshot['phase'] = 'question_prompt';
    const promptReady = new Set<string>();
    const cueReady = new Set<string>();
    const sessions: TriviaVoiceSession[] = [];
    const outputs: string[][] = Array.from({ length: 4 }, () => []);
    const settlements: Array<Array<(played: boolean) => void>> = Array.from({ length: 4 }, () => []);
    const cueSettlements: Array<Array<(played: boolean) => void>> = Array.from({ length: 4 }, () => []);
    const players = Array.from({ length: 4 }, (_, index) => player({
      playerId: `t${index + 1}`,
      name: `Player ${index + 1}`,
    }));
    const snapshot = (playerId: string) => questionPromptState({
      phase,
      expectedPlayerCount: 4,
      hasExpectedPlayers: true,
      automaticSetup: true,
      players,
      myName: players.find(candidate => candidate.playerId === playerId)!.name,
      myPromptReady: promptReady.has(playerId),
      myAnswerCueReady: cueReady.has(playerId),
      answeringStartsAtMs: phase === 'question' ? 5_000 : null,
      questionEndsAtMs: phase === 'question' ? 15_000 : null,
    });

    for (let index = 0; index < 4; index++) {
      const playerId = `t${index + 1}`;
      const session = new TriviaVoiceSession({
        bind: () => ({ playerId, resumed: true }),
        leave: () => {}, setName: () => false, voteCategory: () => false, advance: () => false,
        answerAt: () => false,
        questionPromptReady: () => {
          promptReady.add(playerId);
          if (promptReady.size === 4) {
            phase = 'answer_cue';
            sessions.forEach(candidate => candidate.onStateChanged());
          }
          return true;
        },
        questionAnswerCueReady: () => {
          cueReady.add(playerId);
          if (cueReady.size === 4) {
            phase = 'question';
            sessions.forEach(candidate => candidate.onStateChanged());
          }
          return true;
        },
        snapshot: () => snapshot(playerId),
        say: text => {
          outputs[index]!.push(text);
          if (text === 'Say your answer now.') return;
          if (text === 'Get ready.') {
            return new Promise<boolean>(resolve => cueSettlements[index]!.push(resolve));
          }
          if (!/Question 1|choices are/i.test(text)) return;
          return new Promise<boolean>(resolve => settlements[index]!.push(resolve));
        },
      });
      sessions.push(session);
      session.handleMessage(JSON.stringify({
        type: 'setup', callSid: `CA-${index}`, customParameters: { roomCode: 'FOUR' },
      }));
    }

    for (let index = 0; index < 4; index++) {
      expect(settlements[index]).toHaveLength(2);
      settlements[index]![0]!(true);
      await Promise.resolve();
      expect(promptReady.has(`t${index + 1}`)).toBe(false);
      settlements[index]![1]!(true);
      await eventually(() => promptReady.has(`t${index + 1}`));
      expect(phase).toBe(index === 3 ? 'answer_cue' : 'question_prompt');
    }
    for (let index = 0; index < 4; index++) {
      expect(outputs[index]!.filter(text => text === 'Get ready.')).toHaveLength(1);
      expect(outputs[index]!.filter(text => text === 'Say your answer now.')).toHaveLength(0);
      expect(cueSettlements[index]).toHaveLength(1);
      cueSettlements[index]![0]!(true);
      await sessions[index]!.whenSpeechSettled();
      expect(phase).toBe(index === 3 ? 'question' : 'answer_cue');
    }
    sessions.forEach(session => session.onStateChanged());
    expect(outputs.every(output => output.filter(text => text === 'Get ready.').length === 1)).toBe(true);
    expect(outputs.every(output => output.filter(text => text === 'Say your answer now.').length === 1)).toBe(true);
  });

  it('keeps maximum valid prompt and four-choice content in two Relay-safe chunks', async () => {
    const longPrompt = 'P'.repeat(240);
    const longChoices = choices.map((choice, index) => ({ ...choice, text: String(index + 1).repeat(100) }));
    const game = harness(questionPromptState({
      question: { id: 'question-1', prompt: longPrompt, choices: longChoices },
    }), 'en-US', { deferQuestion: true, resumed: true });
    game.setup();

    expect(game.questionSpeech()).toHaveLength(2);
    expect(game.questionSpeech().every(item => Array.from(item.text).length <= 500)).toBe(true);
    const complete = game.questionSpeech().map(item => item.text).join(' ');
    expect(complete).toContain(longPrompt);
    for (const choice of longChoices) expect(complete).toContain(choice.text);
    game.settleQuestion(true);
    await game.session.whenSpeechSettled();
  });

  it('preserves the earliest matching interim onset and accepts its final during server grace', () => {
    const game = harness(questionState());
    game.setup();
    game.setNow(1_234);
    game.prompt('I think the answer is the city of light', false);
    game.setNow(1_800);
    game.prompt('the city of light', false);
    game.setNow(11_500);
    game.prompt('My final answer is Paris');

    expect(game.calls.answers).toEqual([{
      choiceId: 'paris',
      final: true,
      answeredAtMs: 1_234,
    }]);
    expect(game.spoken.map(item => item.text)).toContain('Answer locked.');
  });

  it('accepts valid pre-start speech and DTMF with normal locked acknowledgement', () => {
    const speech = harness(questionState({ answeringStartsAtMs: 4_000, questionEndsAtMs: 14_000 }));
    speech.setNow(2_000);
    speech.setup();
    speech.prompt('Paris');
    expect(speech.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 2_000 }]);
    expect(speech.spoken.map(item => item.text)).toContain('Answer locked.');
    expect(speech.spoken.map(item => item.text)).not.toContain('Time is up.');

    const dtmf = harness(questionState({ answeringStartsAtMs: 4_000, questionEndsAtMs: 14_000 }));
    dtmf.setNow(2_500);
    dtmf.setup();
    dtmf.dtmf('1');
    expect(dtmf.calls.answers).toEqual([{ choiceId: 'rome', final: true, answeredAtMs: 2_500 }]);
    expect(dtmf.spoken.map(item => item.text)).toContain('Answer locked.');
    expect(dtmf.spoken.map(item => item.text)).not.toContain('Time is up.');
  });

  it('clears unknown and pre-question onsets before a valid pre-start final', async () => {
    const game = harness(answerCueState(), 'en-US', { deferCue: true });
    game.setNow(1_000);
    game.setup();
    game.prompt('Paris', false);
    game.settleCue(true);
    await game.session.whenSpeechSettled();
    expect(game.state.phase).toBe('question');
    game.setNow(1_500);
    game.prompt('not a displayed answer');
    expect(game.calls.answers).toEqual([]);
    game.setNow(2_000);
    game.prompt('Paris');
    expect(game.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 2_000 }]);
  });

  it('does not reuse an onset after an unknown final, candidate change, or interrupt', () => {
    const unknown = harness(questionState());
    unknown.setup();
    unknown.setNow(1_100);
    unknown.prompt('Paris', false);
    unknown.setNow(2_000);
    unknown.prompt('something unknown');
    unknown.setNow(4_000);
    unknown.prompt('Paris');
    expect(unknown.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 4_000 }]);

    const changed = harness(questionState());
    changed.setup();
    changed.setNow(1_100);
    changed.prompt('Paris', false);
    changed.setNow(2_000);
    changed.prompt('Rome', false);
    changed.setNow(3_000);
    changed.prompt('Paris');
    expect(changed.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 3_000 }]);

    const interrupted = harness(questionState());
    interrupted.setup();
    interrupted.setNow(1_100);
    interrupted.prompt('Paris', false);
    interrupted.interrupt();
    interrupted.setNow(5_000);
    interrupted.prompt('Paris');
    expect(interrupted.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 5_000 }]);
  });

  it('locks a wrong displayed choice and acknowledges it without revealing correctness early', () => {
    const game = harness(questionState());
    game.setup();
    const before = game.spoken.length;
    game.setNow(2_000);
    game.prompt('A');

    expect(game.calls.answers[0]).toMatchObject({ choiceId: 'rome', answeredAtMs: 2_000 });
    expect(game.state.phase).toBe('reveal');
    const answerSpeech = game.spoken.slice(before).map(item => item.text);
    expect(answerSpeech[0]).toBe('Answer locked.');
    expect(answerSpeech[0]).not.toMatch(/correct|incorrect|not correct/i);
    expect(answerSpeech[1]).toMatch(/answer was B, Paris.*not correct.*standings/i);
  });

  it('ignores duplicate locks and an interim stream that crosses a question boundary', () => {
    const game = harness(questionState());
    game.setup();
    game.setNow(1_100);
    game.prompt('Paris');
    game.prompt('Paris');
    expect(game.calls.answers).toHaveLength(1);

    game.prompt('Rome', false);
    game.setState({
      phase: 'question',
      questionIndex: 1,
      question: { id: 'question-2', prompt: 'Pick a city.', choices },
      reveal: null,
      myAnswered: false,
      myQuestionPoints: 0,
      answeringStartsAtMs: 20_000,
      questionEndsAtMs: 30_000,
      players: [player({ rawScore: 1_300, correctCount: 1 })],
      standings: null,
    });
    game.setNow(20_100);
    game.session.onStateChanged();
    game.prompt('Rome');
    expect(game.calls.answers).toHaveLength(1);

    game.prompt('Rome');
    expect(game.calls.answers).toHaveLength(2);
    expect(game.calls.answers[1]).toMatchObject({ choiceId: 'rome', answeredAtMs: 20_100 });
  });

  it('accepts category DTMF 1-9 while keeping answer DTMF restricted to 1-4', () => {
    const category = harness(baseState({ phase: 'category_select' }));
    category.setup();
    category.dtmf('9');
    expect(category.calls.votes).toEqual(['mixed']);

    const answer = harness(questionState());
    answer.setup();
    answer.dtmf('5');
    expect(answer.calls.answers).toEqual([]);
    answer.setNow(1_500);
    answer.dtmf('2');
    expect(answer.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 1_500 }]);
  });

  it('matches letters, numbers, text, aliases, and full natural phrases unambiguously', () => {
    const question = questionState().question!;
    expect(matchTriviaAnswer('A', question)).toBe('rome');
    expect(matchTriviaAnswer('option B', question)).toBe('paris');
    expect(matchTriviaAnswer('2', question)).toBe('paris');
    expect(matchTriviaAnswer('the second choice', question)).toBe('paris');
    expect(matchTriviaAnswer('I think the answer is the city of light', question)).toBe('paris');
    expect(matchTriviaAnswer('Paris or Rome', question)).toBeNull();

    const ptQuestion = { ...question, prompt: 'Qual e a capital da Franca?', choices: portugueseChoices };
    expect(matchTriviaAnswer('a resposta seria b', ptQuestion, 'pt-BR')).toBe('paris');
    expect(matchTriviaAnswer('eu acho que e a cidade luz', ptQuestion, 'pt-BR')).toBe('paris');
  });

  it('uses Portuguese question and choice speech from the localized voice snapshot', async () => {
    const game = harness(questionPromptState({
      question: { id: 'question-1', prompt: 'Qual e a capital da Franca?', choices: portugueseChoices },
    }), 'pt-BR', { deferQuestion: true, resumed: true });
    game.setup();
    expect(game.questionSpeech().map(item => item.text).join(' ')).toMatch(
      /Pergunta 1.*capital da Franca.*opções são A, Roma.*B, Paris.*C, Madri.*D, Viena/i,
    );
    expect(game.questionSpeech().map(item => item.text).join(' ')).not.toMatch(/resposta agora/i);
    game.settleQuestion(true);
    await game.session.whenSpeechSettled();
    expect(game.calls.promptReady).toEqual(['question-1']);
    expect(game.spoken.filter(item => item.text === 'Prepare-se.')).toHaveLength(1);
    expect(game.spoken.filter(item => item.text === 'Diga sua resposta agora.')).toHaveLength(1);
  });

  it('automatically retries interrupted answer-start, reveal, and result speech only in the current phase', async () => {
    const answer = harness(questionState(), 'en-US', { deferAnswerStart: true, manualTimers: true });
    answer.setup();
    expect(answer.spoken.filter(item => item.text === 'Say your answer now.')).toHaveLength(1);
    answer.interrupt();
    answer.settleAnswerStart(false);
    await eventually(() => answer.retryTimerCount === 1);
    answer.runNextRetryTimer();
    expect(answer.spoken.filter(item => item.text === 'Say your answer now.')).toHaveLength(2);
    answer.settleAnswerStart(true);
    await answer.session.whenSpeechSettled();
    answer.session.onStateChanged();
    expect(answer.spoken.filter(item => item.text === 'Say your answer now.')).toHaveLength(2);

    const reveal = harness(revealState(), 'en-US', { deferReveal: true, resumed: true, manualTimers: true });
    reveal.setup();
    expect(reveal.spoken.filter(item => /answer was B, Paris/i.test(item.text))).toHaveLength(1);
    reveal.interrupt();
    reveal.settleReveal(false);
    await eventually(() => reveal.retryTimerCount === 1);
    reveal.runNextRetryTimer();
    expect(reveal.spoken.filter(item => /answer was B, Paris/i.test(item.text))).toHaveLength(2);
    reveal.settleReveal(true);
    await reveal.session.whenSpeechSettled();

    const result = harness(resultState([
      resultPlayer('t1', 'Ada', 2_600, 2, 1),
    ]), 'en-US', { deferResult: true, resumed: true, manualTimers: true });
    result.setup();
    expect(result.spoken.filter(item => /Ada wins with 2,600 points/i.test(item.text))).toHaveLength(1);
    result.interrupt();
    result.settleResult(false);
    await eventually(() => result.retryTimerCount === 1);
    result.runNextRetryTimer();
    expect(result.spoken.filter(item => /Ada wins with 2,600 points/i.test(item.text))).toHaveLength(2);
    result.settleResult(true);
    await result.session.whenSpeechSettled();
    result.session.onStateChanged();
    expect(result.spoken.filter(item => /Ada wins with 2,600 points/i.test(item.text))).toHaveLength(2);
  });

  it('bounds automatic required-speech retries with increasing backoff', async () => {
    const game = harness(questionState(), 'en-US', {
      alwaysFailAnswerStart: true,
      manualTimers: true,
    });
    game.setup();
    await eventually(() => game.retryTimerCount === 1);
    expect(game.retryDelays).toEqual([TRIVIA_SPEECH_RETRY_DELAY_MS]);

    game.runNextRetryTimer();
    await eventually(() => game.retryTimerCount === 1);
    expect(game.retryDelays).toEqual([
      TRIVIA_SPEECH_RETRY_DELAY_MS,
      TRIVIA_SPEECH_RETRY_DELAY_MS * 2,
    ]);
    game.runNextRetryTimer();
    await eventually(() => game.spoken.filter(item => item.text === 'Say your answer now.').length
      === TRIVIA_SPEECH_MAX_ATTEMPTS && game.retryTimerCount === 0);
    await game.session.whenSpeechSettled();

    game.session.onStateChanged();
    expect(game.spoken.filter(item => item.text === 'Say your answer now.')).toHaveLength(
      TRIVIA_SPEECH_MAX_ATTEMPTS,
    );
  });

  it('drops a scheduled required-speech retry after the guarded phase becomes stale', async () => {
    const game = harness(questionPromptState(), 'en-US', {
      deferQuestion: true,
      manualTimers: true,
      resumed: true,
    });
    game.setup();
    game.settleQuestion(false);
    await eventually(() => game.retryTimerCount === 1);
    game.setState({ phase: 'answer_cue', myPromptReady: true });

    game.runNextRetryTimer();
    await game.session.whenSpeechSettled();
    expect(game.questionSpeech()).toHaveLength(2);
    expect(game.calls.promptReady).toEqual([]);
  });
});

describe('TriviaVoiceSession reconnect, reveal, and lifecycle', () => {
  it('does not replay a settled prompt or cue or relock an answer after reconnect', async () => {
    const settled = questionPromptState({ myPromptReady: true });
    const resumedPrompt = harness(settled, 'en-US', { resumed: true });
    resumedPrompt.setup();
    expect(resumedPrompt.questionSpeech()).toHaveLength(0);
    expect(resumedPrompt.calls.promptReady).toEqual([]);

    const missingCue = harness(answerCueState(), 'en-US', { resumed: true });
    missingCue.setup();
    await missingCue.session.whenSpeechSettled();
    expect(missingCue.spoken.filter(item => item.text === 'Get ready.')).toHaveLength(1);
    expect(missingCue.calls.cueReady).toEqual(['question-1']);

    const settledCue = harness(answerCueState({ myAnswerCueReady: true }), 'en-US', { resumed: true });
    settledCue.setup();
    expect(settledCue.spoken.filter(item => item.text === 'Get ready.')).toHaveLength(0);
    expect(settledCue.calls.cueReady).toEqual([]);

    const resumedActive = harness(questionState(), 'en-US', { resumed: true });
    resumedActive.setNow(5_000);
    resumedActive.setup();
    resumedActive.session.onStateChanged();
    expect(resumedActive.spoken.map(item => item.text)).toContain('Answer now. You have 6 seconds remaining.');
    expect(resumedActive.questionSpeech()).toHaveLength(2);
    expect(resumedActive.questionSpeech().map(item => item.text).join(' ')).toMatch(/capital of France.*A, Rome.*B, Paris/i);
    expect(resumedActive.spoken.map(item => item.text).join(' ')).not.toMatch(/You are back/i);
    expect(resumedActive.spoken.filter(item => /seconds remaining/.test(item.text))).toHaveLength(1);
    expect(resumedActive.state).toMatchObject({ answeringStartsAtMs: 1_000, questionEndsAtMs: 11_000 });

    const resumedLock = harness(questionState({ myAnswered: true }), 'en-US', { resumed: true });
    resumedLock.setup();
    expect(resumedLock.spoken.filter(item => item.text === 'Say your answer now.')).toHaveLength(0);
    expect(resumedLock.questionSpeech()).toHaveLength(0);
    resumedLock.prompt('Paris');
    resumedLock.dtmf('2');
    expect(resumedLock.calls.answers).toEqual([]);
  });

  it('announces reveal delta and standings once, then terminal winner or tie once', () => {
    const reveal = harness(revealState({ myQuestionPoints: 1_300 }), 'en-US', { resumed: true });
    reveal.setup();
    reveal.session.onStateChanged();
    expect(reveal.spoken.filter(item => /answer was B, Paris/i.test(item.text))).toHaveLength(1);
    expect(reveal.spoken.map(item => item.text).join(' ')).toMatch(/gained 1,300 points.*standings: 1, Ada, 1,300 points/i);

    const tieBrokenResult = resultState([
      resultPlayer('t1', 'Ada', 2_600, 2, 1),
      resultPlayer('t2', 'Grace', 2_600, 2, 2),
    ]);
    const result = harness(tieBrokenResult, 'en-US', { resumed: true });
    result.setup();
    result.session.onStateChanged();
    expect(result.spoken.filter(item => /Ada wins with 2,600 points/i.test(item.text))).toHaveLength(1);
    expect(result.spoken.map(item => item.text).join(' ')).not.toMatch(/tie between/i);
    expect(result.spoken.map(item => item.text).join(' ')).toMatch(/Ada, your score is 2,600.*2 of eight/i);

    const trueTie = harness(resultState([
      resultPlayer('t1', 'Ada', 2_600, 2, 1),
      resultPlayer('t2', 'Grace', 2_600, 2, 1),
    ]), 'en-US', { resumed: true });
    trueTie.setup();
    expect(trueTie.spoken.filter(item => /tie between Ada and Grace/i.test(item.text))).toHaveLength(1);

    const winner = harness(resultState([
      resultPlayer('t1', 'Ada', 2_600, 2, 1),
      resultPlayer('t2', 'Grace', 1_200, 1, 2),
    ]), 'en-US', { resumed: true });
    winner.setup();
    expect(winner.spoken.map(item => item.text).join(' ')).toMatch(/Ada wins with 2,600 points/i);
  });

  it('invalidates pending playback on close, sends nothing afterward, and settles cleanly', async () => {
    const game = harness(questionPromptState(), 'en-US', { deferQuestion: true, resumed: true });
    game.setup();
    expect(game.questionSpeech()).toHaveLength(2);
    const speechCount = game.spoken.length;

    game.session.handleClose();
    game.settleQuestion(true);
    await game.session.whenSpeechSettled();
    game.session.onStateChanged();
    game.prompt('Paris');

    expect(game.calls.promptReady).toEqual([]);
    expect(game.calls.leaves).toBe(1);
    expect(game.spoken).toHaveLength(speechCount);
  });

  it('lets a replacement transport retain the slot without scheduling a leave', () => {
    const game = harness(questionState(), 'en-US', { resumed: true });
    game.setup();
    game.session.handleReplaced();
    expect(game.calls.leaves).toBe(0);
    expect(game.session.boundPlayerId).toBeNull();
  });
});

interface HarnessOptions {
  deferQuestion?: boolean;
  deferCue?: boolean;
  deferAnswerStart?: boolean;
  deferReveal?: boolean;
  deferResult?: boolean;
  alwaysFailAnswerStart?: boolean;
  manualTimers?: boolean;
  resumed?: boolean;
}

function harness(initial: TriviaVoiceSnapshot, locale: SupportedLocale = 'en-US', options: HarnessOptions = {}) {
  let state = initial;
  let now = state.answeringStartsAtMs ?? 0;
  let categoryVote: string | null = null;
  let questionResolvers: Array<(played: boolean) => void> = [];
  let cueResolver: ((played: boolean) => void) | null = null;
  let answerStartResolvers: Array<(played: boolean) => void> = [];
  let revealResolvers: Array<(played: boolean) => void> = [];
  let resultResolvers: Array<(played: boolean) => void> = [];
  const retryTimers: Array<{ callback: () => void; delayMs: number }> = [];
  const retryDelays: number[] = [];
  const spoken: { text: string; isCurrent?: () => boolean }[] = [];
  const calls = {
    bindExpectedPlayers: [] as number[],
    bindParticipantIndexes: [] as Array<number | undefined>,
    setName: [] as string[],
    votes: [] as string[],
    advances: 0,
    promptReady: [] as string[],
    cueReady: [] as string[],
    answers: [] as { choiceId: string; final: true; answeredAtMs: number }[],
    leaves: 0,
  };

  const setState = (patch: Partial<TriviaVoiceSnapshot>) => { state = { ...state, ...patch }; };
  const updateMe = (patch: Partial<TriviaVoiceSnapshot['players'][number]>) => {
    const players = state.players.map(candidate => candidate.playerId === 't1' ? { ...candidate, ...patch } : candidate);
    const me = players.find(candidate => candidate.playerId === 't1')!;
    setState({ players, myName: me.name, nameConfirmed: me.nameConfirmed });
  };

  const timerDeps = options.manualTimers ? {
    setTimer: (callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs };
      retryTimers.push(timer);
      retryDelays.push(delayMs);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
      const index = retryTimers.indexOf(timer as unknown as { callback: () => void; delayMs: number });
      if (index >= 0) retryTimers.splice(index, 1);
    },
  } : {};

  const session = new TriviaVoiceSession({
    bind: (_code, _name, _callSid, _locale, _nameConfirmed, expectedPlayers, participantIndex) => {
      calls.bindExpectedPlayers.push(expectedPlayers);
      calls.bindParticipantIndexes.push(participantIndex);
      return { playerId: 't1', resumed: options.resumed === true };
    },
    leave: () => { calls.leaves += 1; },
    setName: (_code, _playerId, name) => {
      calls.setName.push(name);
      updateMe({ name, nameConfirmed: true });
      return true;
    },
    voteCategory: (_code, _playerId, category) => {
      calls.votes.push(category);
      const counts = { ...state.categoryVoteCounts };
      if (categoryVote) counts[categoryVote as keyof TriviaCategoryVoteCounts] -= 1;
      counts[category] += 1;
      categoryVote = category;
      setState({ categoryVoteCounts: counts });
      return state.phase === 'category_select';
    },
    advance: () => {
      calls.advances += 1;
      if (state.phase === 'lobby' && state.hasExpectedPlayers
        && state.players.every(candidate => candidate.nameConfirmed)) {
        setState({ phase: 'category_select' });
        return true;
      }
      const voteCount = TRIVIA_ROUND_CATEGORY_IDS.reduce(
        (total, category) => total + state.categoryVoteCounts[category], 0,
      );
      if (state.phase === 'category_select' && voteCount >= state.expectedPlayerCount) {
        setState({ phase: 'loading', loadingGeneration: state.loadingGeneration + 1 });
        return true;
      }
      if (state.phase === 'results' && !state.automaticSetup) {
        setState({ phase: 'category_select', result: null });
        return true;
      }
      return false;
    },
    questionPromptReady: (_code, _playerId, questionId) => {
      calls.promptReady.push(questionId);
      if (state.phase !== 'question_prompt' || state.question?.id !== questionId) return false;
      setState({
        phase: 'answer_cue',
        myPromptReady: true,
        myAnswerCueReady: false,
        answeringStartsAtMs: null,
        questionEndsAtMs: null,
      });
      return true;
    },
    questionAnswerCueReady: (_code, _playerId, questionId) => {
      calls.cueReady.push(questionId);
      if (state.phase !== 'answer_cue' || state.question?.id !== questionId) return false;
      setState({
        phase: 'question',
        myAnswerCueReady: true,
        answeringStartsAtMs: now + TRIVIA_ANSWER_START_DELAY_MS,
        questionEndsAtMs: now + TRIVIA_ANSWER_START_DELAY_MS + 10_000,
      });
      return true;
    },
    answerAt: (_code, _playerId, choiceId, final, answeredAtMs) => {
      calls.answers.push({ choiceId, final, answeredAtMs });
      if (state.phase !== 'question' || state.myAnswered) return false;
      const points = choiceId === 'paris' ? 1_300 : 0;
      const current = state.players.find(candidate => candidate.playerId === 't1')!;
      updateMe({
        rawScore: current.rawScore + points,
        correctCount: current.correctCount + (points > 0 ? 1 : 0),
      });
      const standings = standingsFor(state.players);
      setState({
        phase: 'reveal',
        myAnswered: true,
        myQuestionPoints: points,
        reveal: { questionId: state.question!.id, correctChoiceId: 'paris', explanation: 'Paris is the capital.' },
        standings,
      });
      return true;
    },
    snapshot: () => state,
    say: (text, isCurrent) => {
      spoken.push({ text, ...(isCurrent ? { isCurrent } : {}) });
      if (options.deferCue && text === (locale === 'pt-BR' ? 'Prepare-se.' : 'Get ready.')) {
        return new Promise<boolean>(resolve => { cueResolver = resolve; });
      }
      if (options.deferQuestion && /Question \d|Pergunta \d|choices are|opções são/i.test(text)) {
        return new Promise<boolean>(resolve => { questionResolvers.push(resolve); });
      }
      if (options.deferAnswerStart && /^(?:Say your answer now\.|Answer now\.)/.test(text)) {
        return new Promise<boolean>(resolve => { answerStartResolvers.push(resolve); });
      }
      if (options.alwaysFailAnswerStart && /^(?:Say your answer now\.|Answer now\.)/.test(text)) {
        return Promise.resolve(false);
      }
      if (options.deferReveal && /answer was|resposta era/i.test(text)) {
        return new Promise<boolean>(resolve => { revealResolvers.push(resolve); });
      }
      if (options.deferResult && state.phase === 'results') {
        return new Promise<boolean>(resolve => { resultResolvers.push(resolve); });
      }
    },
    now: () => now,
    ...timerDeps,
  });

  return {
    session,
    spoken,
    calls,
    retryDelays,
    get retryTimerCount() { return retryTimers.length; },
    get state() { return state; },
    setState,
    setNow(value: number) { now = value; },
    setup(callSid = 'CA-TRIVIA') {
      session.handleMessage(JSON.stringify({
        type: 'setup',
        callSid,
        customParameters: { roomCode: ' voice ', commandLocale: locale },
      }));
    },
    prompt(voicePrompt: string, last = true) {
      session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt, last }));
    },
    dtmf(digit: string) { session.handleMessage(JSON.stringify({ type: 'dtmf', digit })); },
    interrupt() { session.handleMessage(JSON.stringify({ type: 'interrupt' })); },
    settleQuestion(played: boolean) {
      if (!questionResolvers.length) throw new Error('question playback is not pending');
      const resolvers = questionResolvers;
      questionResolvers = [];
      resolvers.forEach(resolve => resolve(played));
    },
    settleQuestionChunk(index: number, played: boolean) {
      const resolve = questionResolvers[index];
      if (!resolve) throw new Error('question playback chunk is not pending');
      questionResolvers[index] = (() => {}) as (played: boolean) => void;
      resolve(played);
    },
    settleCue(played: boolean) {
      if (!cueResolver) throw new Error('answer cue playback is not pending');
      const resolve = cueResolver;
      cueResolver = null;
      resolve(played);
    },
    settleAnswerStart(played: boolean) {
      settleResolvers(answerStartResolvers, played, 'answer-start');
      answerStartResolvers = [];
    },
    settleReveal(played: boolean) {
      settleResolvers(revealResolvers, played, 'reveal');
      revealResolvers = [];
    },
    settleResult(played: boolean) {
      settleResolvers(resultResolvers, played, 'result');
      resultResolvers = [];
    },
    runNextRetryTimer() {
      const timer = retryTimers.shift();
      if (!timer) throw new Error('required speech retry is not scheduled');
      timer.callback();
    },
    questionSpeech() {
      return spoken.filter(item => /Question 1|Pergunta 1|choices are|opções são/i.test(item.text));
    },
  };
}

function baseState(overrides: Partial<TriviaVoiceSnapshot> = {}): TriviaVoiceSnapshot {
  return {
    phase: 'lobby',
    myName: 'Ada',
    nameConfirmed: true,
    expectedPlayerCount: 1,
    hasExpectedPlayers: true,
    automaticSetup: false,
    players: [player()],
    categoryVoteCounts: emptyVotes(),
    loadingGeneration: 0,
    questionIndex: null,
    answeringStartsAtMs: null,
    questionEndsAtMs: null,
    question: null,
    reveal: null,
    standings: null,
    result: null,
    myAnswered: false,
    myPromptReady: false,
    myAnswerCueReady: false,
    myQuestionPoints: 0,
    ...overrides,
  };
}

function questionPromptState(overrides: Partial<TriviaVoiceSnapshot> = {}): TriviaVoiceSnapshot {
  return baseState({
    phase: 'question_prompt',
    loadingGeneration: 1,
    questionIndex: 0,
    question: { id: 'question-1', prompt: 'What is the capital of France?', choices },
    ...overrides,
  });
}

function questionState(overrides: Partial<TriviaVoiceSnapshot> = {}): TriviaVoiceSnapshot {
  return questionPromptState({
    phase: 'question',
    answeringStartsAtMs: 1_000,
    questionEndsAtMs: 11_000,
    ...overrides,
  });
}

function answerCueState(overrides: Partial<TriviaVoiceSnapshot> = {}): TriviaVoiceSnapshot {
  return questionPromptState({
    phase: 'answer_cue',
    myPromptReady: true,
    ...overrides,
  });
}

function revealState(overrides: Partial<TriviaVoiceSnapshot> = {}): TriviaVoiceSnapshot {
  const players = [player({ rawScore: 1_300, correctCount: 1 })];
  return questionState({
    phase: 'reveal',
    players,
    myAnswered: true,
    myQuestionPoints: 1_300,
    reveal: { questionId: 'question-1', correctChoiceId: 'paris', explanation: 'Paris is the capital.' },
    standings: standingsFor(players),
    ...overrides,
  });
}

function resultState(players: TriviaResult['players']): TriviaVoiceSnapshot {
  const result: TriviaResult = {
    resultId: `result-${players.map(candidate => candidate.rawScore).join('-')}`,
    generation: 1,
    category: 'mixed',
    contentRevision: 'test',
    players,
    completedAtMs: 50_000,
  };
  const publicPlayers = players.map(candidate => player({
    playerId: candidate.playerId,
    name: candidate.name,
    rawScore: candidate.rawScore,
    correctCount: candidate.correctCount,
  }));
  return baseState({
    phase: 'results',
    players: publicPlayers,
    myName: players[0]?.name ?? null,
    result,
    standings: standingsFor(publicPlayers),
  });
}

function player(overrides: Partial<TriviaVoiceSnapshot['players'][number]> = {}): TriviaVoiceSnapshot['players'][number] {
  return {
    playerId: 't1',
    name: 'Ada',
    nameConfirmed: true,
    connected: true,
    rawScore: 0,
    correctCount: 0,
    ...overrides,
  };
}

function standingsFor(players: readonly TriviaVoiceSnapshot['players'][number][]): TriviaPublicStanding[] {
  return players.map((candidate, index) => ({
    ...candidate,
    playerOrder: index,
    answered: true,
    bestStreak: candidate.correctCount,
    rank: index + 1,
    normalizedScore: candidate.rawScore,
    cumulativeCorrectTimeMs: 0,
  }));
}

function resultPlayer(
  playerId: string,
  name: string,
  rawScore: number,
  correctCount: number,
  rank: number,
): TriviaResult['players'][number] {
  return {
    playerId,
    name,
    playerOrder: rank - 1,
    rank,
    rawScore,
    normalizedScore: rawScore,
    correctCount,
    bestStreak: correctCount,
    cumulativeCorrectTimeMs: 0,
  };
}

function emptyVotes(): TriviaCategoryVoteCounts {
  return Object.fromEntries(TRIVIA_ROUND_CATEGORY_IDS.map(category => [category, 0])) as unknown as TriviaCategoryVoteCounts;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition did not settle');
}

function settleResolvers(
  resolvers: Array<(played: boolean) => void>,
  played: boolean,
  label: string,
): void {
  if (!resolvers.length) throw new Error(`${label} playback is not pending`);
  for (const resolve of resolvers) resolve(played);
}
