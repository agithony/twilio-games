import { parseCrMessage } from './conversation-relay';
import type { KaraokeSong } from '../shared/karaoke';
import type { KaraokePhase, KaraokeResult } from '../shared/karaoke-protocol';
import { KARAOKE_MESSAGES, type KaraokeMessageKey } from '../shared/i18n/karaoke';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import {
  createTranslator,
  formatList,
  formatNumber,
  normalizeForMatching,
  type MessageValues,
} from '../shared/i18n/translate';
import { parseFirstName } from '../shared/spoken-name';
import type { KaraokeAnalyticsSetupAction } from './analytics-observer';

const FINAL_REPEAT_GUARD_MS = 5_000;
type KaraokeVoiceSong = Pick<KaraokeSong, 'id' | 'title' | 'locale'>;
type KaraokeVoiceResult = Pick<KaraokeResult, 'generation' | 'score' | 'bestCombo'>;

/** The Karaoke room fields needed to route one singer's setup and result speech. */
export interface KaraokeVoiceSnapshot {
  phase: KaraokePhase;
  myName: string | null;
  nameConfirmed: boolean;
  catalog: readonly KaraokeVoiceSong[];
  selectedSong: KaraokeVoiceSong | null;
  selectedByPlayerId: string | null;
  loadingGeneration: number;
  displayReady: boolean;
  score: number;
  bestCombo: number;
  result: KaraokeVoiceResult | null;
}

export interface KaraokeVoiceEndHandoff {
  type: 'end';
  handoffData: string;
}

export interface KaraokeVoiceDeps {
  /** Binds a new caller or resumes the existing call/player binding. */
  bind(
    code: string,
    name: string,
    callSid: string,
    locale: SupportedLocale,
    nameConfirmed: boolean,
  ): { playerId: string; resumed: boolean } | null;
  leave(code: string, playerId: string, callSid: string): void;
  setName(code: string, playerId: string, name: string): boolean;
  selectSong(code: string, playerId: string, songId: string): boolean;
  advance(code: string, playerId: string): boolean;
  snapshot(code: string, playerId: string, locale?: SupportedLocale): KaraokeVoiceSnapshot | null;
  say(text: string, isCurrent?: () => boolean): void | Promise<boolean>;
  /** The host sends this envelope to Conversation Relay and owns the subsequent media path. */
  requestMediaHandoff(handoff: KaraokeVoiceEndHandoff): void;
  onSetupAction?(action: KaraokeAnalyticsSetupAction): void;
}

export class KaraokeVoiceSession {
  private code: string | null = null;
  private playerId: string | null = null;
  private callSid: string | null = null;
  private commandLocale: SupportedLocale = DEFAULT_LOCALE;
  private authoritativeName: string | null = null;
  private stationManaged = false;
  private awaitingName = false;
  private applyingChange = false;
  private lastPhase: KaraokePhase | null = null;
  private lastSelectedSongId: string | null = null;
  private lastFinal: { text: string; beforeContext: string; afterContext: string; at: number } | null = null;
  private readonly handedOffGenerations = new Set<number>();
  private readonly announcedResultGenerations = new Set<number>();
  private consentReadySongId: string | null = null;
  private consentAttempt: symbol | null = null;
  private readonly preparationAnnouncedGenerations = new Set<number>();
  private text: (key: KaraokeMessageKey, values?: MessageValues) => string =
    createTranslator(DEFAULT_LOCALE, KARAOKE_MESSAGES);

  constructor(private readonly deps: KaraokeVoiceDeps) {}

  get boundRoomCode(): string | null { return this.code; }
  get boundPlayerId(): string | null { return this.playerId; }
  get locale(): SupportedLocale { return this.commandLocale; }

  setStationManaged(active: boolean): void { this.stationManaged = active; }
  setAuthoritativeName(name: string | null): void {
    this.authoritativeName = name?.trim().slice(0, 40) || null;
  }

  handleMessage(raw: string): void {
    const message = parseCrMessage(raw);
    if (message.type === 'setup') {
      this.handleSetup(message.callSid, message.customParameters);
      return;
    }
    if (!this.code || !this.playerId) return;

    if (message.type === 'interrupt') {
      this.lastFinal = null;
      const snapshot = this.currentSnapshot();
      if (snapshot?.phase === 'results' && snapshot.result) {
        this.announcedResultGenerations.delete(snapshot.result.generation);
        this.announceResult(snapshot);
      } else if (snapshot?.phase === 'loading') {
        this.preparationAnnouncedGenerations.delete(snapshot.loadingGeneration);
        this.acknowledgeLoading(snapshot);
      }
      return;
    }
    if (message.type === 'dtmf') {
      this.handleDtmf(message.digit);
      return;
    }
    if (message.type === 'prompt' && !message.last) {
      const snapshot = this.currentSnapshot();
      if (snapshot?.phase === 'results' && snapshot.result) {
        this.announcedResultGenerations.delete(snapshot.result.generation);
        this.announceResult(snapshot);
      } else if (snapshot?.phase === 'loading') {
        this.preparationAnnouncedGenerations.delete(snapshot.loadingGeneration);
        this.acknowledgeLoading(snapshot);
      }
      return;
    }
    if (message.type !== 'prompt') return;

    const snapshot = this.currentSnapshot();
    if (!snapshot) return;
    if (snapshot.phase === 'loading') {
      this.preparationAnnouncedGenerations.delete(snapshot.loadingGeneration);
      this.acknowledgeLoading(snapshot);
      return;
    }
    if (isRelaySilentPhase(snapshot.phase)) return;
    if (snapshot.phase === 'results' && snapshot.result) {
      this.lastFinal = null;
      this.announcedResultGenerations.delete(snapshot.result.generation);
    }
    const normalized = normalizeForMatching(message.voicePrompt, this.commandLocale);
    if (!normalized) {
      if (snapshot.phase === 'results') this.announceResult(snapshot);
      return;
    }
    const beforeContext = this.finalContext(snapshot);
    const now = Date.now();
    if (this.lastFinal?.text === normalized && this.lastFinal.afterContext === beforeContext
      && now - this.lastFinal.at < FINAL_REPEAT_GUARD_MS
      && !(snapshot.phase === 'song_select' && isExplicitStart(message.voicePrompt, this.commandLocale))) return;

    this.handleFinalPrompt(message.voicePrompt, snapshot);
    this.lastFinal = {
      text: normalized,
      beforeContext,
      afterContext: this.finalContext(this.currentSnapshot()),
      at: now,
    };
  }

  onStateChanged(): void {
    const snapshot = this.currentSnapshot();
    if (!snapshot) return;
    if (snapshot.phase === 'loading') this.acknowledgeLoading(snapshot);

    if (this.applyingChange || isRelaySilentPhase(snapshot.phase)) {
      this.remember(snapshot);
      return;
    }
    if (snapshot.phase === 'results') {
      this.announceResult(snapshot);
    } else if (snapshot.phase !== this.lastPhase) {
      this.speakContext(snapshot);
    } else if (snapshot.phase === 'song_select'
      && snapshot.selectedSong
      && snapshot.selectedSong.id !== this.lastSelectedSongId
      && snapshot.selectedByPlayerId === this.playerId) {
      this.deps.say(this.text('voice.songSelected', { title: snapshot.selectedSong.title }));
      this.speakStartConsent();
    }
    this.remember(snapshot);
  }

  handleClose(): void {
    if (this.code && this.playerId) {
      const phase = this.currentSnapshot()?.phase;
      const preserveForMedia = phase === 'loading' || phase === 'countdown'
        || phase === 'performing' || phase === 'finalizing';
      if (!preserveForMedia && !(this.stationManaged && phase === 'results')) {
        this.deps.leave(this.code, this.playerId, this.callSid ?? '');
      }
    }
    this.clearBinding();
  }

  handleReplaced(): void { this.clearBinding(); }

  announceLoadingTimeout(): void {
    if (this.code && this.playerId) this.deps.say(this.text('voice.loadingTimeout'));
  }

  private handleSetup(callSid: string, parameters: Record<string, string>): void {
    if (this.playerId) return;
    const code = parameters['roomCode']?.trim().toUpperCase();
    if (!code) return;
    this.commandLocale = resolveLocale(parameters['commandLocale'] ?? parameters['locale']);
    this.text = createTranslator(this.commandLocale, KARAOKE_MESSAGES);
    const binding = this.deps.bind(
      code,
      this.authoritativeName ?? this.text('voice.callerPlaceholder'),
      callSid,
      this.commandLocale,
      this.authoritativeName !== null,
    );
    if (!binding) {
      this.deps.say(this.text('voice.roomUnavailable'));
      return;
    }

    this.code = code;
    this.playerId = binding.playerId;
    this.callSid = callSid;
    const snapshot = this.currentSnapshot();
    if (!snapshot) return;
    this.awaitingName = !snapshot.nameConfirmed;
    this.remember(snapshot);

    if (snapshot.phase === 'loading') {
      this.acknowledgeLoading(snapshot);
      return;
    }
    if (snapshot.phase === 'countdown' || snapshot.phase === 'performing') return;
    if (snapshot.phase === 'results') {
      this.announceResult(snapshot);
      return;
    }

    if (binding.resumed) {
      this.deps.say(snapshot.nameConfirmed && snapshot.myName
        ? this.text('voice.returnedName', { name: snapshot.myName })
        : this.text('voice.returned'));
      this.speakContext(snapshot);
      return;
    }

    this.deps.say(this.text('voice.welcome'));
    if (!snapshot.nameConfirmed) {
      this.deps.say(this.text('voice.askName'));
      return;
    }
    this.finishIntroduction(snapshot);
  }

  private handleFinalPrompt(spoken: string, snapshot: KaraokeVoiceSnapshot): void {
    if (this.awaitingName || !snapshot.nameConfirmed) {
      this.captureName(spoken);
      return;
    }
    if (snapshot.phase === 'lobby') {
      this.finishIntroduction(snapshot);
      return;
    }
    if (snapshot.phase === 'song_select') {
      const song = matchKaraokeSong(spoken, this.catalogForLocale(snapshot), this.commandLocale);
      if (song) {
        this.selectSong(song, snapshot);
        return;
      }
      if (isExplicitStart(spoken, this.commandLocale)) {
        this.startSelectedSong(snapshot);
        return;
      }
      if (isHelpRequest(spoken, this.commandLocale)) {
        this.speakSongSelection(snapshot);
        return;
      }
      this.deps.say(this.text('voice.unknownSong'));
      return;
    }
    if (snapshot.phase === 'results') {
      if (isExplicitRematch(spoken, this.commandLocale)) {
        this.applyingChange = true;
        const advanced = this.deps.advance(this.code!, this.playerId!);
        this.applyingChange = false;
        const next = this.currentSnapshot();
        if (advanced && next?.phase === 'song_select') {
          this.remember(next);
          this.speakSongSelection(next);
        } else this.announceResult(snapshot);
      } else this.announceResult(snapshot);
    }
  }

  private captureName(spoken: string): void {
    const name = parseKaraokeName(spoken, this.commandLocale);
    if (!name) {
      this.deps.say(this.text('voice.invalidName'));
      return;
    }
    this.applyingChange = true;
    const accepted = this.deps.setName(this.code!, this.playerId!, name);
    this.applyingChange = false;
    const snapshot = this.currentSnapshot();
    if (!accepted || !snapshot?.nameConfirmed) {
      this.deps.say(this.text('voice.invalidName'));
      return;
    }
    this.awaitingName = false;
    this.deps.onSetupAction?.('confirm_name');
    this.deps.say(this.text('voice.welcomeName', { name: snapshot.myName ?? name }));
    this.deps.say(this.text('voice.gameplay'));
    this.advanceConfirmedLobby(snapshot);
  }

  private finishIntroduction(snapshot: KaraokeVoiceSnapshot): void {
    if (!snapshot.nameConfirmed) {
      this.awaitingName = true;
      this.deps.say(this.text('voice.askName'));
      return;
    }
    if (snapshot.myName) this.deps.say(this.text('voice.welcomeName', { name: snapshot.myName }));
    this.deps.say(this.text('voice.gameplay'));
    this.advanceConfirmedLobby(snapshot);
  }

  private advanceConfirmedLobby(snapshot: KaraokeVoiceSnapshot): void {
    if (snapshot.phase === 'lobby' && snapshot.nameConfirmed) {
      this.applyingChange = true;
      const advanced = this.deps.advance(this.code!, this.playerId!);
      this.applyingChange = false;
      if (advanced) this.deps.onSetupAction?.('open_song_selection');
    }
    const next = this.currentSnapshot() ?? snapshot;
    this.remember(next);
    if (next.phase === 'song_select') this.speakSongSelection(next);
  }

  private selectSong(song: KaraokeVoiceSong, snapshot: KaraokeVoiceSnapshot): void {
    this.applyingChange = true;
    const selected = this.deps.selectSong(this.code!, this.playerId!, song.id);
    this.applyingChange = false;
    const next = this.currentSnapshot() ?? snapshot;
    this.remember(next);
    if (selected && next.selectedSong?.id === song.id && next.selectedByPlayerId === this.playerId) {
      this.consentReadySongId = null;
      this.deps.onSetupAction?.('select_song');
      this.deps.say(this.text('voice.songSelected', { title: next.selectedSong.title }));
      this.speakStartConsent();
    } else {
      this.deps.say(this.text('voice.unknownSong'));
    }
  }

  private startSelectedSong(snapshot: KaraokeVoiceSnapshot): void {
    if (!snapshot.selectedSong || snapshot.selectedByPlayerId !== this.playerId) {
      this.deps.say(this.text('voice.chooseFirst'));
      return;
    }
    if (this.consentReadySongId !== snapshot.selectedSong.id) {
      this.speakStartConsent();
      return;
    }
    this.applyingChange = true;
    const advanced = this.deps.advance(this.code!, this.playerId!);
    this.applyingChange = false;
    const next = this.currentSnapshot() ?? snapshot;
    this.remember(next);
    if (!advanced || next.phase !== 'loading') {
      this.deps.say(this.text('voice.notReady'));
      return;
    }
    this.deps.onSetupAction?.('start_song');
    this.consentReadySongId = null;
    this.acknowledgeLoading(next);
  }

  private handleDtmf(digit: string): void {
    const snapshot = this.currentSnapshot();
    if (!snapshot) return;
    if (snapshot.phase === 'loading') {
      this.preparationAnnouncedGenerations.delete(snapshot.loadingGeneration);
      this.acknowledgeLoading(snapshot);
      return;
    }
    if (isRelaySilentPhase(snapshot.phase)) return;
    if (snapshot.phase === 'results' && snapshot.result) {
      this.announcedResultGenerations.delete(snapshot.result.generation);
      this.announceResult(snapshot);
      return;
    }
    if (snapshot.phase !== 'song_select') {
      if (!snapshot.nameConfirmed) this.deps.say(this.text('voice.askName'));
      return;
    }
    if (digit === '*') {
      this.speakSongSelection(snapshot);
      return;
    }
    if (digit === '#') {
      if (!snapshot.selectedSong || snapshot.selectedByPlayerId !== this.playerId) {
        this.deps.say(this.text('voice.chooseFirst'));
      } else {
        this.consentReadySongId = null;
        this.speakStartConsent();
      }
      return;
    }
    const index = digit === '0' ? 9 : /^[1-9]$/.test(digit) ? Number(digit) - 1 : -1;
    const song = this.catalogForLocale(snapshot)[index];
    if (song) this.selectSong(song, snapshot);
  }

  private speakContext(snapshot: KaraokeVoiceSnapshot): void {
    if (isRelaySilentPhase(snapshot.phase)) return;
    if (!snapshot.nameConfirmed) {
      this.awaitingName = true;
      this.deps.say(this.text('voice.askName'));
    } else if (snapshot.phase === 'lobby') {
      this.finishIntroduction(snapshot);
    } else if (snapshot.phase === 'song_select') {
      this.speakSongSelection(snapshot);
    } else if (snapshot.phase === 'results') {
      this.announceResult(snapshot);
    }
  }

  private speakSongSelection(snapshot: KaraokeVoiceSnapshot): void {
    if (snapshot.selectedSong && snapshot.selectedByPlayerId === this.playerId) {
      this.deps.say(this.text('voice.startRequired', { title: snapshot.selectedSong.title }));
      this.speakStartConsent();
      return;
    }
    const catalog = this.catalogForLocale(snapshot);
    if (!catalog.length) {
      this.deps.say(this.text('voice.noSongs'));
      return;
    }
    const choices = catalog.map((song, index) => `${index + 1}, ${song.title}`);
    this.deps.say(this.text('voice.catalog', { songs: formatList(this.commandLocale, choices) }));
  }

  private speakStartConsent(): void {
    const songId = this.currentSnapshot()?.selectedSong?.id;
    if (!songId) return;
    this.consentReadySongId = null;
    const attempt = Symbol(songId);
    this.consentAttempt = attempt;
    const delivery = this.deps.say(this.text('voice.startConsent'));
    const complete = (played: boolean) => {
      if (!played || this.consentAttempt !== attempt) return;
      const current = this.currentSnapshot();
      if (current?.phase === 'song_select' && current.selectedSong?.id === songId
        && current.selectedByPlayerId === this.playerId) this.consentReadySongId = songId;
    };
    if (delivery && typeof delivery.then === 'function') void delivery.then(complete, () => complete(false));
    else complete(true);
  }

  private acknowledgeLoading(snapshot: KaraokeVoiceSnapshot): void {
    if (snapshot.phase !== 'loading' || snapshot.loadingGeneration < 1) return;
    const generation = snapshot.loadingGeneration;
    if (!this.preparationAnnouncedGenerations.has(generation)) {
      this.preparationAnnouncedGenerations.add(generation);
      this.deps.say(this.text('voice.preparing'));
    }
    this.requestHandoff(snapshot);
  }

  private announceResult(snapshot: KaraokeVoiceSnapshot): void {
    const result = snapshot.result;
    if (!result || this.announcedResultGenerations.has(result.generation)) return;
    this.announcedResultGenerations.add(result.generation);
    this.deps.say(this.text('voice.result', {
      name: snapshot.myName ?? this.text('voice.callerPlaceholder'),
      score: formatNumber(this.commandLocale, result.score),
      combo: formatNumber(this.commandLocale, result.bestCombo),
    }), this.resultGuard(result.generation));
    this.deps.say(this.text(this.stationManaged ? 'voice.stationRequeue' : 'voice.singAgain'),
      this.resultGuard(result.generation));
  }

  private requestHandoff(snapshot: KaraokeVoiceSnapshot): void {
    if (snapshot.phase !== 'loading' || !snapshot.displayReady || !snapshot.selectedSong || snapshot.loadingGeneration < 1
      || this.handedOffGenerations.has(snapshot.loadingGeneration)) return;
    this.handedOffGenerations.add(snapshot.loadingGeneration);
    this.deps.requestMediaHandoff({
      type: 'end',
      handoffData: JSON.stringify({
        reasonCode: 'karaoke-media',
        roomCode: this.code,
        playerId: this.playerId,
        songId: snapshot.selectedSong.id,
        loadingGeneration: snapshot.loadingGeneration,
        locale: this.commandLocale,
      }),
    });
  }

  private catalogForLocale(snapshot: KaraokeVoiceSnapshot): readonly KaraokeVoiceSong[] {
    const localized = snapshot.catalog.filter(song => song.locale === this.commandLocale);
    return localized.length ? localized : snapshot.catalog;
  }

  private currentSnapshot(): KaraokeVoiceSnapshot | null {
    return this.code && this.playerId
      ? this.deps.snapshot(this.code, this.playerId, this.commandLocale)
      : null;
  }

  private finalContext(snapshot: KaraokeVoiceSnapshot | null): string {
    return `${snapshot?.phase ?? 'unavailable'}:${snapshot?.nameConfirmed ? 'named' : 'unnamed'}:`
      + `${snapshot?.selectedSong?.id ?? ''}:${snapshot?.selectedByPlayerId ?? ''}:`
      + `${snapshot?.loadingGeneration ?? 0}:${snapshot?.result?.generation ?? 0}`;
  }

  private remember(snapshot: KaraokeVoiceSnapshot): void {
    this.lastPhase = snapshot.phase;
    this.lastSelectedSongId = snapshot.selectedSong?.id ?? null;
  }

  private resultGuard(generation: number): () => boolean {
    return () => this.currentSnapshot()?.result?.generation === generation;
  }

  private clearBinding(): void {
    this.code = null;
    this.playerId = null;
    this.callSid = null;
    this.awaitingName = false;
    this.applyingChange = false;
    this.lastPhase = null;
    this.lastSelectedSongId = null;
    this.lastFinal = null;
    this.consentReadySongId = null;
    this.consentAttempt = null;
    this.preparationAnnouncedGenerations.clear();
  }
}

export function matchKaraokeSong(
  spoken: string,
  songs: readonly KaraokeVoiceSong[],
  locale: SupportedLocale = DEFAULT_LOCALE,
): KaraokeVoiceSong | null {
  const text = normalizeForMatching(spoken, locale);
  const digit = text.match(/\b(10|[1-9])\b/);
  const numberWords = locale === 'pt-BR'
    ? ['um', 'dois', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez']
    : ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const ordinalWords = locale === 'pt-BR'
    ? [/\bprimeir[oa]\b/, /\bsegund[oa]\b/]
    : [/\bfirst\b/, /\bsecond\b/];
  const wordIndex = numberWords.findIndex(word => new RegExp(`\\b${word}\\b`).test(text));
  const ordinalIndex = ordinalWords.findIndex(pattern => pattern.test(text));
  const index = digit ? Number(digit[1]) - 1 : ordinalIndex >= 0 ? ordinalIndex : wordIndex;
  if (index >= 0 && songs[index]) return songs[index];
  return songs.find(song => {
    const title = normalizeForMatching(song.title, locale);
    const titleWithoutArticle = locale === 'en-US' ? title.replace(/^(?:a|an|the)\s+/, '') : title;
    return containsPhrase(text, title) || (titleWithoutArticle !== title && containsPhrase(text, titleWithoutArticle));
  }) ?? null;
}

function parseKaraokeName(spoken: string, locale: SupportedLocale): string | null {
  const normalized = normalizeForMatching(spoken, locale);
  const setupWords = locale === 'pt-BR'
    ? /\b(?:ajuda|cancao|cancoes|cantar|karaoke|musica|musicas|regras)\b/
    : /\b(?:help|instructions|karaoke|music|rules|sing|singing|song|songs)\b/;
  return setupWords.test(normalized) ? null : parseFirstName(spoken, locale);
}

function isExplicitStart(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /^(?:(?:sim|por favor) )?(?:comecar|comecar a cantar|iniciar|iniciar a musica|vamos comecar|pront[oa] para comecar)(?: por favor)?$/.test(text)
    : /^(?:(?:yes|please) )?(?:start|start singing|begin|begin singing|let s start|i am ready to start|ready to start)(?: please)?$/.test(text);
}

function isHelpRequest(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /\b(?:ajuda|instrucoes|musicas|o que posso dizer)\b/.test(text)
    : /\b(?:help|instructions|songs|what can i say)\b/.test(text);
}

function isExplicitRematch(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /^(?:sim|cantar de novo|de novo|outra musica|outra cancao|escolher outra musica|revanche)$/.test(text)
    : /^(?:yes|sing again|again|another song|choose another song|rematch)$/.test(text);
}

function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|\\b)${escaped}(?:$|\\b)`).test(text);
}

function isRelaySilentPhase(phase: KaraokePhase): boolean {
  return phase === 'loading' || phase === 'countdown' || phase === 'performing' || phase === 'finalizing';
}
