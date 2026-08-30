export interface TriviaClockSyncSample {
  serverNowMs: number;
  clientSentAtMs?: number;
  clientReceivedAtMs: number;
}

export interface TriviaQuestionTiming {
  remainingMs: number;
  remainingSeconds: number;
  progress: number;
}

export type TriviaLocalKeyboardCommand =
  | { type: 'join' }
  | { type: 'leave' }
  | { type: 'advance' }
  | { type: 'select_category'; category: TriviaRoundCategoryId }
  | { type: 'keyboard_answer'; choiceId: string };

export interface TriviaLocalKeyboardContext {
  allowed: boolean;
  testerEnabled: boolean;
  joined: boolean;
  connected: boolean;
  isHost: boolean;
  state: TriviaState | null;
}

/** Starts the shared countdown clip once, exactly when a server-timed generation first displays 3. */
export class TriviaCountdownSoundCue {
  private generation = 0;
  private played = false;

  update(phase: TriviaState['phase'], loadingGeneration: number, locale: 'en-US' | 'pt-BR',
    count: number, play: () => void): void {
    if (loadingGeneration !== this.generation) {
      this.generation = loadingGeneration;
      this.played = false;
    }
    if (phase !== 'countdown' || locale !== 'en-US' || loadingGeneration < 1 || count !== 3 || this.played) return;
    this.played = true;
    play();
  }
}

/** Maintains a monotonic estimate of server time using the lowest-latency sync response. */
export class TriviaServerClock {
  private offsetMs = 0;
  private bestRoundTripMs = Number.POSITIVE_INFINITY;
  private hasReliableEstimate = false;
  private hasEstimate = false;
  private lastNowMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly localEpochAtAnchorMs = Date.now(),
    private readonly monotonicAnchorMs = performance.now(),
  ) {}

  observeSync(sample: TriviaClockSyncSample): boolean {
    if (![sample.serverNowMs, sample.clientReceivedAtMs].every(Number.isFinite)) return false;
    if (sample.clientSentAtMs === undefined) {
      if (this.hasEstimate) return false;
      this.offsetMs = sample.serverNowMs - sample.clientReceivedAtMs;
      this.hasEstimate = true;
      this.lastNowMs = Number.NEGATIVE_INFINITY;
      return true;
    }
    if (!Number.isFinite(sample.clientSentAtMs) || sample.clientReceivedAtMs < sample.clientSentAtMs) return false;
    const roundTripMs = sample.clientReceivedAtMs - sample.clientSentAtMs;
    if (this.hasReliableEstimate && roundTripMs > this.bestRoundTripMs) return false;
    const firstReliableEstimate = !this.hasReliableEstimate;
    const midpointMs = sample.clientSentAtMs + roundTripMs / 2;
    this.offsetMs = sample.serverNowMs - midpointMs;
    this.bestRoundTripMs = roundTripMs;
    this.hasReliableEstimate = true;
    this.hasEstimate = true;
    if (firstReliableEstimate) this.lastNowMs = Number.NEGATIVE_INFINITY;
    return true;
  }

  now(monotonicNowMs = performance.now()): number {
    const elapsedMs = Number.isFinite(monotonicNowMs)
      ? Math.max(0, monotonicNowMs - this.monotonicAnchorMs)
      : 0;
    this.lastNowMs = Math.max(this.lastNowMs, this.localEpochAtAnchorMs + elapsedMs + this.offsetMs);
    return this.lastNowMs;
  }
}

/** Derives the visible clock exclusively from authoritative start/end timestamps. */
export function triviaQuestionTiming(
  answeringStartsAtMs: number,
  questionEndsAtMs: number,
  serverNowMs: number,
): TriviaQuestionTiming {
  if (![answeringStartsAtMs, questionEndsAtMs, serverNowMs].every(Number.isFinite)
    || questionEndsAtMs <= answeringStartsAtMs) {
    return { remainingMs: 0, remainingSeconds: 0, progress: 0 };
  }
  const durationMs = questionEndsAtMs - answeringStartsAtMs;
  const remainingMs = Math.max(0, Math.min(durationMs, questionEndsAtMs - serverNowMs));
  return {
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1_000),
    progress: remainingMs / durationMs,
  };
}

export function triviaCountdownCount(countdownEndsAtMs: number, serverNowMs: number): 1 | 2 | 3 {
  const count = Math.ceil((countdownEndsAtMs - serverNowMs) / 1_000);
  return Math.max(1, Math.min(3, Number.isFinite(count) ? count : 3)) as 1 | 2 | 3;
}

export function resolveTriviaWebSocketUrl(
  page: Pick<Location, 'protocol' | 'host'>,
  override?: string | null,
  display = true,
): string {
  const pageUrl = new URL(`${page.protocol}//${page.host}`);
  const defaultUrl = `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}/trivia`;
  const parsed = new URL(override ?? defaultUrl);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new TypeError('ws override must use ws or wss');
  if (parsed.pathname !== '/trivia') throw new TypeError('ws override must use the Trivia endpoint');
  if (parsed.username || parsed.password || parsed.hash) throw new TypeError('ws override must not contain credentials or a fragment');
  const targetProtocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  const sameOrigin = targetProtocol === pageUrl.protocol && parsed.host === pageUrl.host;
  const loopbackDevelopment = pageUrl.protocol === 'http:' && targetProtocol === 'http:'
    && isLoopback(pageUrl.hostname) && isLoopback(parsed.hostname);
  if (!sameOrigin && (!loopbackDevelopment || display)) {
    throw new TypeError(display
      ? 'display websocket must be same-origin'
      : 'ws override must be same-origin or loopback development');
  }
  if (display) parsed.searchParams.set('display', '1');
  else parsed.searchParams.delete('display');
  return parsed.toString();
}

export function triviaDisplayPairingRequired(
  hostname: string,
  stationLaunchRequested: boolean,
  displayToken: string | null,
): boolean {
  return !isLoopback(hostname) && stationLaunchRequested && !displayToken;
}

export function triviaLocalKeyboardTestingAllowed(
  hostname: string,
  stationDisplay: boolean,
  roomCode: string,
): boolean {
  return !stationDisplay && roomCode.trim().toUpperCase() === DEFAULT_ROOM && isLoopback(hostname);
}

export function triviaLocalKeyboardCommand(
  key: string,
  context: TriviaLocalKeyboardContext,
): TriviaLocalKeyboardCommand | null {
  if (!context.allowed || !context.state) return null;
  const normalized = key.toLowerCase();
  if (normalized === 'p') {
    if (context.testerEnabled) {
      return context.state.phase === 'lobby' || context.state.phase === 'results' ? { type: 'leave' } : null;
    }
    return context.state.phase === 'lobby' && context.connected && context.isHost ? { type: 'join' } : null;
  }
  if (!context.joined || !context.connected) return null;

  if (key === 'Enter' && context.isHost) {
    if (context.state.phase === 'lobby' || context.state.phase === 'results') return { type: 'advance' };
    if (context.state.phase === 'category_select'
      && TRIVIA_ROUND_CATEGORY_IDS.some(category => context.state!.categoryVoteCounts[category] > 0)) {
      return { type: 'advance' };
    }
  }
  if (context.state.phase === 'category_select' && /^[1-9]$/.test(key)) {
    const category = TRIVIA_ROUND_CATEGORY_IDS[Number(key) - 1];
    return category ? { type: 'select_category', category } : null;
  }
  if (context.state.phase === 'question') {
    const index = /^[1-4]$/.test(key) ? Number(key) - 1 : /^[a-d]$/.test(normalized)
      ? normalized.charCodeAt(0) - 97 : -1;
    const choiceId = context.state.question.choices[index]?.id;
    return choiceId ? { type: 'keyboard_answer', choiceId } : null;
  }
  return null;
}

export function isInteractiveTriviaShortcutTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return !!element?.closest?.('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="button"]');
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}
import { DEFAULT_ROOM } from '../../shared/constants';
import { TRIVIA_ROUND_CATEGORY_IDS, type TriviaRoundCategoryId } from '../../shared/trivia';
import type { TriviaState } from '../../shared/trivia-protocol';
