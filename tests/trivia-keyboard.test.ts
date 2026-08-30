import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isInteractiveTriviaShortcutTarget,
  triviaLocalKeyboardCommand,
  triviaLocalKeyboardTestingAllowed,
  type TriviaLocalKeyboardContext,
} from '../client/trivia/trivia-client-utils';
import { renderTriviaView, triviaDisplayCopy } from '../client/trivia/trivia-view';
import { parseTriviaClientMessage, type TriviaState } from '../shared/trivia-protocol';

function state(overrides: Partial<TriviaState> = {}): TriviaState {
  return {
    roomCode: '4821', phase: 'lobby', expectedPlayerCount: 1, hasExpectedPlayers: true,
    automaticSetup: false, preferredLocale: 'en-US', category: null,
    categoryVoteCounts: {
      general: 0, science: 0, geography: 0, history: 0, entertainment: 0,
      sports: 0, technology: 0, twilio: 0, mixed: 0,
    },
    players: [{
      playerId: 't1', name: 'Local Player', nameConfirmed: true, playerOrder: 0,
      connected: true, answered: false, rawScore: 0, correctCount: 0, bestStreak: 0,
    }],
    serverNowMs: 1_000, loadingGeneration: 0, displayReady: false, questionIndex: null,
    countdownEndsAtMs: null, questionPromptEndsAtMs: null, answerCueEndsAtMs: null,
    answeringStartsAtMs: null, questionEndsAtMs: null, revealEndsAtMs: null,
    question: null, reveal: null, standings: null, result: null,
    ...overrides,
  } as TriviaState;
}

function context(overrides: Partial<TriviaLocalKeyboardContext> = {}): TriviaLocalKeyboardContext {
  return {
    allowed: true, testerEnabled: true, joined: true, connected: true, isHost: true,
    state: state(), ...overrides,
  };
}

describe('Trivia hidden local keyboard mode', () => {
  it('strictly parses only the dedicated opaque keyboard answer command', () => {
    expect(parseTriviaClientMessage('{"type":"keyboard_answer","choiceId":"a"}'))
      .toEqual({ type: 'keyboard_answer', choiceId: 'a' });
    for (const value of [
      { type: 'keyboard_answer' },
      { type: 'keyboard_answer', choiceId: 'e' },
      { type: 'keyboard_answer', choiceId: 1 },
      { type: 'keyboard_answer', choiceId: 'a', score: 100 },
    ]) expect(parseTriviaClientMessage(JSON.stringify(value)).type).toBe('error');
    expect(parseTriviaClientMessage('{"type":"answer","choiceId":"a"}')).toMatchObject({
      type: 'error', code: 'unknown_type',
    });
  });

  it('resolves only phase-valid controls in displayed order', () => {
    expect(triviaLocalKeyboardCommand('p', context({ testerEnabled: false, joined: false })))
      .toEqual({ type: 'join' });
    expect(triviaLocalKeyboardCommand('p', context({ testerEnabled: false, joined: false, isHost: false })))
      .toBeNull();
    expect(triviaLocalKeyboardCommand('p', context({ state: state({ phase: 'question_prompt' }) }))).toBeNull();
    expect(triviaLocalKeyboardCommand('p', context({ state: state({ phase: 'results' }) })))
      .toEqual({ type: 'leave' });
    expect(triviaLocalKeyboardCommand('Enter', context())).toEqual({ type: 'advance' });

    const category = state({ phase: 'category_select' });
    expect(triviaLocalKeyboardCommand('Enter', context({ state: category }))).toBeNull();
    expect(triviaLocalKeyboardCommand('1', context({ state: category })))
      .toEqual({ type: 'select_category', category: 'general' });
    expect(triviaLocalKeyboardCommand('9', context({ state: category })))
      .toEqual({ type: 'select_category', category: 'mixed' });
    const voted = state({
      phase: 'category_select',
      categoryVoteCounts: { ...category.categoryVoteCounts, science: 1 },
    });
    expect(triviaLocalKeyboardCommand('Enter', context({ state: voted }))).toEqual({ type: 'advance' });

    const question = state({
      phase: 'question', questionIndex: 0, answeringStartsAtMs: 2_000, questionEndsAtMs: 12_000,
      question: {
        id: 'science-001', category: 'science', difficulty: 'easy', prompt: 'Prompt',
        choices: [
          { id: 'd', text: 'Fourth' }, { id: 'b', text: 'Second' },
          { id: 'a', text: 'First' }, { id: 'c', text: 'Third' },
        ],
      },
    });
    expect(triviaLocalKeyboardCommand('A', context({ state: question })))
      .toEqual({ type: 'keyboard_answer', choiceId: 'd' });
    expect(triviaLocalKeyboardCommand('2', context({ state: question })))
      .toEqual({ type: 'keyboard_answer', choiceId: 'b' });
    expect(triviaLocalKeyboardCommand('1', context({ state: question, joined: false }))).toBeNull();
  });

  it('is loopback/default-room/standalone only and excludes interactive targets', () => {
    expect(triviaLocalKeyboardTestingAllowed('localhost', false, '4821')).toBe(true);
    expect(triviaLocalKeyboardTestingAllowed('127.0.0.1', false, '4821')).toBe(true);
    expect(triviaLocalKeyboardTestingAllowed('games.example', false, '4821')).toBe(false);
    expect(triviaLocalKeyboardTestingAllowed('localhost', true, '4821')).toBe(false);
    expect(triviaLocalKeyboardTestingAllowed('localhost', false, 'OTHER')).toBe(false);
    expect(isInteractiveTriviaShortcutTarget({ closest: () => ({}) } as unknown as EventTarget)).toBe(true);
    expect(isInteractiveTriviaShortcutTarget({ closest: () => null } as unknown as EventTarget)).toBe(false);
  });

  it('keeps HTML, rendered output, and localized copy free of keyboard-control hints', () => {
    const html = readFileSync(new URL('../client/trivia.html', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../client/trivia/trivia.ts', import.meta.url), 'utf8');
    const rendered = renderTriviaView(state(), {
      locale: 'en-US', roomCode: '4821', serverNowMs: 1_000, connectionState: 'connected',
    }).html;
    const copy = JSON.stringify([triviaDisplayCopy('en-US'), triviaDisplayCopy('pt-BR')]);
    const visibleHint = /keyboard controls?|keyboard hint|press p|teclado|pressione p/i;
    expect(html).not.toMatch(visibleHint);
    expect(rendered).toContain('Local Player');
    expect(rendered).not.toMatch(visibleHint);
    expect(copy).not.toMatch(visibleHint);
    expect(rendered).not.toMatch(/mode badge|toast|guide/i);
    expect(source).toContain("locale === 'pt-BR' ? 'Jogador local' : 'Local Player'");
    expect(source).not.toContain('Keyboard Player');
    expect(source).toContain('event.repeat || event.isComposing');
    expect(source).toContain('event.altKey || event.ctrlKey || event.metaKey || event.shiftKey');
    expect(source.indexOf('if (!command) return;')).toBeLessThan(source.indexOf('event.preventDefault();'));
  });
});
