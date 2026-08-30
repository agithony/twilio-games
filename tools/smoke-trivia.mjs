// Deterministic real-browser smoke for Voice Trivia. Run with the Vite client already running.
// The injected WebSocket emits public server projections, so no game server or Twilio call is needed.
import puppeteer from 'puppeteer-core';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const client = process.env.CLIENT_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const consoleErrors = [];
const pageErrors = [];
const httpErrors = [];
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', error => pageErrors.push(error.stack ?? String(error)));
page.on('response', response => {
  if (response.status() >= 400) httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
});

await page.evaluateOnNewDocument(() => {
  const NativeWebSocket = window.WebSocket;
  const categoryVoteCounts = {
    general: 0, science: 0, geography: 0, history: 0, entertainment: 0,
    sports: 0, technology: 2, twilio: 0, mixed: 0,
  };
  const player = {
    playerId: 'player-1', name: 'Ada', nameConfirmed: true, playerOrder: 0,
    connected: true, answered: false, rawScore: 0, correctCount: 0, bestStreak: 0,
  };
  const question = {
    id: 'technology-001', category: 'technology', difficulty: 'medium',
    prompt: 'Which protocol provides full-duplex communication over one connection?',
    choices: [
      { id: 'a', text: 'SMTP' },
      { id: 'b', text: 'WebSocket' },
      { id: 'c', text: 'FTP' },
      { id: 'd', text: 'POP3' },
    ],
  };
  let activeSocket;

  const state = phase => {
    const now = Date.now();
    const disclosed = phase === 'reveal' || phase === 'results';
    const scoredPlayer = disclosed
      ? { ...player, answered: true, rawScore: 1300, correctCount: 1, bestStreak: 1 }
      : { ...player, answered: phase === 'question' };
    const standing = {
      ...scoredPlayer, rank: 1, normalizedScore: 10078, cumulativeCorrectTimeMs: 1500,
    };
    const resultPlayer = {
      playerId: player.playerId, name: player.name, playerOrder: 0, rank: 1,
      rawScore: 1300, normalizedScore: 10078, correctCount: 1, bestStreak: 1,
      cumulativeCorrectTimeMs: 1500,
    };
    return {
      type: 'trivia_state', roomCode: 'SMOKE', phase, expectedPlayerCount: 1,
      hasExpectedPlayers: true, automaticSetup: true, preferredLocale: 'en-US',
      category: phase === 'lobby' ? null : 'technology', categoryVoteCounts,
      players: [scoredPlayer], serverNowMs: now,
      loadingGeneration: 1, displayReady: true,
      questionIndex: ['question_prompt', 'answer_cue', 'question', 'reveal'].includes(phase) ? 0 : null,
      countdownEndsAtMs: phase === 'countdown' ? now + 3000 : null,
      questionPromptEndsAtMs: null,
      answerCueEndsAtMs: phase === 'answer_cue' ? now + 25000 : null,
      answeringStartsAtMs: phase === 'question' ? now + 3000 : null,
      questionEndsAtMs: phase === 'question' ? now + 13000 : null,
      revealEndsAtMs: phase === 'reveal' ? now + 4000 : null,
      question: ['question_prompt', 'answer_cue', 'question', 'reveal'].includes(phase) ? question : null,
      reveal: phase === 'reveal' ? {
        questionId: question.id,
        correctChoiceId: 'b',
        explanation: 'WebSocket keeps a two-way connection open.',
      } : null,
      standings: phase === 'reveal' || phase === 'results' ? [standing] : null,
      result: phase === 'results' ? {
        resultId: 'smoke-result', generation: 1, category: 'technology',
        contentRevision: 'smoke-revision', players: [resultPlayer], completedAtMs: now,
      } : null,
    };
  };

  const emit = message => {
    const socket = activeSocket;
    queueMicrotask(() => socket?.onmessage?.({ data: JSON.stringify(message) }));
  };
  class SmokeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = SmokeWebSocket.CONNECTING;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;

    constructor(url, protocols) {
      if (new URL(String(url), location.href).pathname !== '/trivia') {
        return protocols === undefined
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);
      }
      this.url = url;
      activeSocket = this;
      setTimeout(() => {
        this.readyState = SmokeWebSocket.OPEN;
        this.onopen?.({ type: 'open' });
        emit({ type: 'trivia_capabilities', displayAuth: false });
      }, 0);
    }

    send(raw) {
      const message = JSON.parse(String(raw));
      if (message.type === 'clock_sync') {
        emit({ type: 'clock_sync', clientSentAtMs: message.clientSentAtMs, serverNowMs: Date.now() });
      } else if (message.type === 'spectate') emit(state('lobby'));
    }

    close() {
      this.readyState = SmokeWebSocket.CLOSED;
      this.onclose?.({ code: 1000 });
    }
  }

  Object.defineProperty(window, 'WebSocket', { configurable: true, writable: true, value: SmokeWebSocket });
  window.__triviaSmokePhase = phase => {
    if (phase === 'reveal') {
      emit({
        type: 'trivia_events',
        events: [{
          type: 'answer_result', playerId: player.playerId, correct: true,
          points: 1300, rawScore: 1300,
        }],
      });
    }
    emit(state(phase));
  };
});

try {
  await page.goto(`${client}/trivia.html?locale=en-US&room=SMOKE`, {
    waitUntil: 'networkidle2',
    timeout: 30_000,
  });
  await page.waitForSelector('[data-view="lobby"]', { timeout: 10_000 });
  const lobby = await page.evaluate(() => ({
    phase: document.body.dataset.phase,
    connection: document.getElementById('connection-status')?.textContent,
    player: document.querySelector('.roster-player strong')?.textContent,
  }));

  await page.evaluate(() => window.__triviaSmokePhase('answer_cue'));
  await page.waitForSelector('[data-view="answer_cue"]', { timeout: 5_000 });
  const cue = await page.evaluate(() => ({
    phase: document.body.dataset.phase,
    status: document.querySelector('.prompt-status strong')?.textContent,
    timer: document.getElementById('question-seconds')?.textContent,
  }));

  await page.evaluate(() => window.__triviaSmokePhase('question'));
  await page.waitForSelector('[data-view="question"]', { timeout: 5_000 });
  const preStart = await page.evaluate(() => ({
    status: document.querySelector('.question-prestart strong')?.textContent,
    timer: document.getElementById('question-seconds')?.textContent,
  }));
  await page.waitForSelector('#question-seconds', { timeout: 5_000 });
  const question = await page.evaluate(() => ({
    phase: document.body.dataset.phase,
    prompt: document.querySelector('.question-board h1')?.textContent,
    choices: [...document.querySelectorAll('.choice-grid li strong')].map(node => node.textContent),
    seconds: document.getElementById('question-seconds')?.textContent,
    interactiveControls: document.querySelectorAll('#trivia-stage button, #trivia-stage input, #trivia-stage form').length,
    busy: document.getElementById('trivia-stage')?.getAttribute('aria-busy'),
  }));

  await page.evaluate(() => window.__triviaSmokePhase('reveal'));
  await page.waitForSelector('[data-view="reveal"] .correct-choice', { timeout: 5_000 });
  const reveal = await page.evaluate(() => ({
    correct: document.querySelector('.correct-choice strong')?.textContent,
    explanation: document.querySelector('.explanation p')?.textContent,
    scoreDelta: document.querySelector('.standing-row small')?.textContent,
  }));

  await page.evaluate(() => window.__triviaSmokePhase('results'));
  await page.waitForSelector('[data-view="results"]', { timeout: 5_000 });
  const results = await page.evaluate(() => ({
    winner: document.querySelector('.winner-panel h1')?.textContent,
    normalizedScore: document.querySelector('.winner-panel > strong')?.firstChild?.textContent,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));

  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const mobile = await page.evaluate(() => ({
    view: document.querySelector('[data-view="results"]')?.getAttribute('data-view'),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));

  const ok = lobby.phase === 'lobby' && lobby.connection === 'Live' && lobby.player === 'Ada'
    && cue.phase === 'answer_cue' && cue.status === 'Phones are synchronizing the answer cue.' && !cue.timer
    && preStart.status?.includes('Answers open in') && !preStart.timer
    && question.phase === 'question' && question.prompt?.startsWith('Which protocol')
    && question.choices.join(',') === 'SMTP,WebSocket,FTP,POP3'
    && Number(question.seconds) >= 9 && question.interactiveControls === 0
    && question.busy === 'false'
    && reveal.correct === 'WebSocket'
    && reveal.explanation === 'WebSocket keeps a two-way connection open.'
    && reveal.scoreDelta?.includes('Correct') && reveal.scoreDelta.includes('+1300')
    && results.winner === 'Ada' && results.normalizedScore?.trim() === '10,078'
    && !results.horizontalOverflow && mobile.view === 'results' && !mobile.horizontalOverflow
    && consoleErrors.length === 0 && pageErrors.length === 0 && httpErrors.length === 0;
  console.log(JSON.stringify({
    result: ok ? 'PASS' : 'FAIL', lobby, cue, preStart, question, reveal, results, mobile,
    consoleErrors, pageErrors, httpErrors,
  }, null, 2));
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ error: String(error), consoleErrors, pageErrors, httpErrors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
