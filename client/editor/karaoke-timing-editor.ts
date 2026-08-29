import { parseKaraokeSong, type KaraokeSong, type KaraokeWord } from '../../shared/karaoke';
import { KARAOKE_RUNTIME_SONGS } from '../../shared/karaoke-songs';
import {
  EMPTY_KARAOKE_TIMING_CONFIG,
  applyKaraokeWordTimingGroupDrag,
  applyKaraokeWordTimingDrag,
  applyKaraokeTimingConfig,
  karaokeTimingConfigFromSongs,
  parseKaraokeTimingConfig,
  type KaraokeTimingConfig,
  type KaraokeWordTimingDrag,
  type KaraokeWordTimingDragMode,
  type KaraokeWordTimingSnapshot,
} from '../../shared/karaoke-timings';
import { authHeaders, promptForToken } from './editor-auth';

type EditableWord = { -readonly [K in keyof KaraokeWord]: KaraokeWord[K] };
type DragMode = KaraokeWordTimingDragMode;

interface WordDrag extends KaraokeWordTimingDrag {
  kind: 'word';
  wordId: string;
  pointerX: number;
}

interface GroupDrag {
  kind: 'group';
  pointerX: number;
  firstIndex: number;
  lastIndex: number;
  snapshot: KaraokeWordTimingSnapshot[];
}

interface MarqueeSelection {
  pointerX: number;
  startMs: number;
  moved: boolean;
  baseIds: Set<string>;
}

const LANE_HEIGHT = 68;
const RULER_HEIGHT = 34;

export class KaraokeTimingEditor {
  private readonly audio = new Audio();
  private readonly editable = new Map<string, EditableWord[]>();
  private selectedSongId = KARAOKE_RUNTIME_SONGS[0]!.id;
  private selectedWordId = KARAOKE_RUNTIME_SONGS[0]!.chart.words[0]!.id;
  private selectedWordIds = new Set([this.selectedWordId]);
  private loaded = false;
  private etag = '';
  private savedConfigJson = JSON.stringify(EMPTY_KARAOKE_TIMING_CONFIG);
  private zoom = 72;
  private drag: WordDrag | GroupDrag | null = null;
  private marquee: MarqueeSelection | null = null;
  private suppressTimelineClick = false;
  private auditionStopMs: number | null = null;
  private animationFrame = 0;
  private waveformGeneration = 0;
  private readonly waveformCache = new Map<string, Float32Array>();

  constructor(private readonly root: HTMLElement) {
    const params = new URLSearchParams(location.search);
    const requestedSong = params.get('song');
    const initialSong = KARAOKE_RUNTIME_SONGS.find(song => song.id === requestedSong) ?? KARAOKE_RUNTIME_SONGS[0]!;
    this.selectedSongId = initialSong.id;
    this.selectedWordId = initialSong.chart.words[0]!.id;
    this.selectedWordIds = new Set([this.selectedWordId]);
    for (const song of KARAOKE_RUNTIME_SONGS) {
      this.editable.set(song.id, song.chart.words.map(word => ({ ...word })));
    }
    const token = params.get('token');
    const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : '';
    this.root.innerHTML = `
      <div class="kte">
        <header>
          <strong>Voice Karaoke <span>Word Timing</span></strong>
          <a href="/editor">All editors</a>
          <nav aria-label="Karaoke editor tools"><a href="?game=karaoke${tokenQuery}">Venue</a><a class="active" href="?game=karaoke&tool=timing${tokenQuery}">Word timing</a></nav>
          <label>Song <select id="ktSong">${KARAOKE_RUNTIME_SONGS.map(song => `<option value="${song.id}">${escapeHtml(song.title)}</option>`).join('')}</select></label>
          <span class="grow"></span><i id="ktStatus" role="status" aria-live="polite">Loading timings...</i>
          <button id="ktSave" class="save" disabled>Save timings</button>
        </header>
        <aside class="word-list"><h2>Words</h2><div id="ktWords"></div></aside>
        <main>
          <section class="transport">
            <button id="ktPlay" aria-label="Play or pause">Play</button>
            <button id="ktAudition">Preview word</button>
            <output id="ktTime">00:00.000</output>
            <input id="ktScrub" aria-label="Audio playhead" type="range" min="0" max="45000" step="10" value="0">
            <label><input id="ktLoop" type="checkbox"> Loop selection</label>
            <label>Zoom <input id="ktZoom" type="range" min="36" max="160" step="4" value="72"></label>
          </section>
          <div id="ktTimelineViewport" class="timeline-viewport" aria-label="Draggable word timing timeline">
            <div id="ktTimeline" class="timeline"></div>
          </div>
          <p class="hint">Drag empty timeline space to select a section, or Shift-click a word range. Drag any selected target to offset the section. Target edges adjust one word's start or stop.</p>
        </main>
        <aside id="ktInspector" class="inspector"></aside>
      </div>`;
    this.injectStyles();
    this.audio.preload = 'auto';
    this.bind();
    this.renderAll();
    void this.load();
    (window as unknown as { __karaokeTimingEditor?: KaraokeTimingEditor }).__karaokeTimingEditor = this;
  }

  snapshot(): KaraokeTimingConfig { return this.currentConfig(); }
  wordsSnapshot(): readonly Pick<KaraokeWord, 'id' | 'startMs' | 'endMs'>[] {
    return this.words().map(({ id, startMs, endMs }) => ({ id, startMs, endMs }));
  }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Karaoke timing editor is missing ${selector}`);
    return element;
  }

  private bind(): void {
    this.required<HTMLSelectElement>('#ktSong').onchange = event => {
      this.selectSong((event.target as HTMLSelectElement).value);
    };
    this.required<HTMLButtonElement>('#ktPlay').onclick = () => void this.togglePlayback();
    this.required<HTMLButtonElement>('#ktAudition').onclick = () => void this.auditionSelected();
    this.required<HTMLButtonElement>('#ktSave').onclick = () => void this.save();
    this.required<HTMLInputElement>('#ktScrub').oninput = event => {
      this.seek(Number((event.target as HTMLInputElement).value));
    };
    this.required<HTMLInputElement>('#ktZoom').oninput = event => {
      this.zoom = Number((event.target as HTMLInputElement).value);
      this.renderTimeline();
      this.updatePlayhead();
    };
    this.audio.addEventListener('play', () => {
      this.required<HTMLButtonElement>('#ktPlay').textContent = 'Pause';
      this.startAnimation();
    });
    this.audio.addEventListener('pause', () => {
      this.required<HTMLButtonElement>('#ktPlay').textContent = 'Play';
      this.updatePlayhead();
    });
    this.audio.addEventListener('ended', () => this.updatePlayhead());
    this.audio.addEventListener('error', () => this.flash('This song audio could not be loaded', true));

    this.root.addEventListener('click', event => this.onClick(event));
    this.root.addEventListener('change', event => this.onChange(event));
    this.required('#ktTimeline').addEventListener('pointerdown', event => this.beginPointer(event as PointerEvent));
    addEventListener('pointermove', event => this.continuePointer(event));
    addEventListener('pointerup', () => this.endPointer());
    addEventListener('pointercancel', () => this.endPointer());
    addEventListener('keydown', event => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.code === 'Space') { event.preventDefault(); void this.togglePlayback(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); this.seek(this.audio.currentTime * 1_000 - (event.shiftKey ? 1_000 : 100)); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); this.seek(this.audio.currentTime * 1_000 + (event.shiftKey ? 1_000 : 100)); }
    });
  }

  private async load(): Promise<void> {
    try {
      const response = await fetch('/api/karaoke-timings', { cache: 'no-store' });
      if (!response.ok) throw new Error(`timing request failed (${response.status})`);
      const config = parseKaraokeTimingConfig(await response.json() as unknown, KARAOKE_RUNTIME_SONGS);
      this.etag = response.headers.get('ETag') ?? '';
      if (!this.etag) throw new Error('timing response is missing its ETag');
      this.installSongs(applyKaraokeTimingConfig(KARAOKE_RUNTIME_SONGS, config));
      this.savedConfigJson = JSON.stringify(config);
      this.loaded = true;
      this.flash('Timings loaded', false);
    } catch (error) {
      this.loaded = false;
      this.installSongs(KARAOKE_RUNTIME_SONGS);
      this.flash(`Using compiled timings: ${(error as Error).message}`, true);
    }
    this.selectSong(this.selectedSongId);
    this.updateDirty();
  }

  private installSongs(songs: readonly KaraokeSong[]): void {
    this.editable.clear();
    for (const song of songs) this.editable.set(song.id, song.chart.words.map(word => ({ ...word })));
  }

  private selectSong(songId: string): void {
    const song = KARAOKE_RUNTIME_SONGS.find(candidate => candidate.id === songId) ?? KARAOKE_RUNTIME_SONGS[0]!;
    this.selectedSongId = song.id;
    this.required<HTMLSelectElement>('#ktSong').value = song.id;
    const words = this.words();
    if (!words.some(word => word.id === this.selectedWordId)) this.selectedWordId = words[0]!.id;
    this.selectedWordIds = new Set([this.selectedWordId]);
    this.audio.pause();
    this.auditionStopMs = null;
    if (song.audioUrl) {
      this.audio.src = song.audioUrl;
      this.audio.load();
    } else {
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.seek(0);
    this.renderAll();
  }

  private words(): EditableWord[] {
    return this.editable.get(this.selectedSongId)!;
  }

  private sourceSong(): KaraokeSong {
    return KARAOKE_RUNTIME_SONGS.find(song => song.id === this.selectedSongId)!;
  }

  private selectedWord(): EditableWord {
    return this.words().find(word => word.id === this.selectedWordId) ?? this.words()[0]!;
  }

  private selectedWords(): EditableWord[] {
    return this.words().filter(word => this.selectedWordIds.has(word.id));
  }

  private renderAll(): void {
    this.renderWordList();
    this.renderTimeline();
    this.renderInspector();
    this.updatePlayhead();
  }

  private renderWordList(): void {
    this.required('#ktWords').innerHTML = this.words().map((word, index) => `
      <button data-list-word="${word.id}" class="${this.selectedWordIds.has(word.id) ? 'selected' : ''}">
        <span>${index + 1}. ${escapeHtml(word.text)}</span><small>${formatTime(word.startMs)} - ${formatTime(word.endMs)}</small>
      </button>`).join('');
  }

  private renderTimeline(): void {
    const viewport = this.required<HTMLElement>('#ktTimelineViewport');
    const timeline = this.required<HTMLElement>('#ktTimeline');
    const scrollLeft = viewport.scrollLeft;
    const width = 45 * this.zoom;
    timeline.style.width = `${width}px`;
    timeline.style.height = `${RULER_HEIGHT + LANE_HEIGHT * 4}px`;
    const markers = Array.from({ length: 46 }, (_, second) => `
      <span class="tick${second % 5 === 0 ? ' major' : ''}" style="left:${second * this.zoom}px">${second % 5 === 0 ? `${second}s` : ''}</span>`).join('');
    const lanes = Array.from({ length: 4 }, (_, lane) => `<div class="lane lane-${lane}" style="top:${RULER_HEIGHT + lane * LANE_HEIGHT}px"><b>Lane ${lane + 1}</b></div>`).join('');
    const targets = this.words().map(word => {
      const left = word.startMs / 1_000 * this.zoom;
      const widthPx = Math.max(18, (word.endMs - word.startMs) / 1_000 * this.zoom);
      return `<div class="word lane-${word.lane}${this.selectedWordIds.has(word.id) ? ' selected' : ''}" data-word-id="${word.id}" role="button" tabindex="0" title="${escapeHtml(word.text)}: ${formatTime(word.startMs)} - ${formatTime(word.endMs)}" style="left:${left}px;top:${RULER_HEIGHT + word.lane * LANE_HEIGHT + 10}px;width:${widthPx}px"><span class="handle start" data-edge="start"></span><em>${escapeHtml(word.text)}</em><span class="handle end" data-edge="end"></span></div>`;
    }).join('');
    timeline.innerHTML = `<canvas id="ktWaveform" class="waveform"></canvas><div class="ruler">${markers}</div>${lanes}${targets}<div id="ktPlayhead" class="playhead"></div>`;
    viewport.scrollLeft = scrollLeft;
    const generation = ++this.waveformGeneration;
    void this.drawWaveform(generation);
  }

  private renderInspector(): void {
    const word = this.selectedWord();
    const selected = this.selectedWords();
    const sourceWords = new Map(this.sourceSong().chart.words.map(candidate => [candidate.id, candidate]));
    const changed = selected.some(candidate => {
      const source = sourceWords.get(candidate.id)!;
      return source.startMs !== candidate.startMs || source.endMs !== candidate.endMs;
    });
    this.required<HTMLButtonElement>('#ktAudition').textContent = selected.length > 1 ? 'Preview section' : 'Preview word';
    this.required('#ktInspector').innerHTML = `
      <h2>${selected.length > 1 ? `${selected.length} words selected` : escapeHtml(word.text)}</h2><p class="word-id">${selected.length > 1 ? `${formatTime(selected[0]!.startMs)} - ${formatTime(selected.at(-1)!.endMs)} · primary: ` : ''}${word.id}</p>
      <label>Start <input id="ktStart" type="number" min="0" max="44900" step="10" value="${word.startMs}"> ms</label>
      <div class="nudges"><button data-nudge="start:-100">-100</button><button data-nudge="start:-10">-10</button><button data-nudge="start:10">+10</button><button data-nudge="start:100">+100</button></div>
      <label>Stop <input id="ktEnd" type="number" min="100" max="45000" step="10" value="${word.endMs}"> ms</label>
      <div class="nudges"><button data-nudge="end:-100">-100</button><button data-nudge="end:-10">-10</button><button data-nudge="end:10">+10</button><button data-nudge="end:100">+100</button></div>
      <label>Length <output>${word.endMs - word.startMs} ms</output></label>
      <h3>Move ${selected.length > 1 ? 'selection' : 'whole target'}</h3><div class="nudges"><button data-nudge="move:-100">-100</button><button data-nudge="move:-10">-10</button><button data-nudge="move:10">+10</button><button data-nudge="move:100">+100</button></div>
      <p>Lane ${word.lane + 1} · MIDI ${word.targetMidi}</p>
      <button id="ktResetWord" ${changed ? '' : 'disabled'}>Reset ${selected.length > 1 ? 'selected words' : 'this word'}</button>
      <button id="ktResetSong">Reset entire song</button>`;
  }

  private onClick(event: MouseEvent): void {
    if (this.suppressTimelineClick) { this.suppressTimelineClick = false; return; }
    const target = event.target as HTMLElement;
    const listWord = target.closest<HTMLElement>('[data-list-word]');
    if (listWord) { this.selectWord(listWord.dataset.listWord!, true, event.shiftKey); return; }
    const timelineWord = target.closest<HTMLElement>('[data-word-id]');
    if (timelineWord) { this.selectWord(timelineWord.dataset.wordId!, false, event.shiftKey); return; }
    const nudge = target.closest<HTMLButtonElement>('[data-nudge]');
    if (nudge) {
      const [mode, amount] = nudge.dataset.nudge!.split(':') as [DragMode, string];
      this.nudge(mode, Number(amount));
      return;
    }
    if (target.closest('#ktResetWord')) { this.resetWord(); return; }
    if (target.closest('#ktResetSong')) { this.resetSong(); return; }
    if (target.closest('#ktTimeline')) {
      const timeline = this.required<HTMLElement>('#ktTimeline');
      const milliseconds = (event.clientX - timeline.getBoundingClientRect().left) / this.zoom * 1_000;
      this.seek(milliseconds);
    }
  }

  private onChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.id === 'ktStart') this.setBoundary('start', Number(input.value));
    else if (input.id === 'ktEnd') this.setBoundary('end', Number(input.value));
  }

  private selectWord(wordId: string, scrollTimeline: boolean, extend = false): void {
    if (!this.words().some(word => word.id === wordId)) return;
    if (extend && !(this.selectedWordIds.size > 1 && this.selectedWordIds.has(wordId))) this.extendSelection(wordId);
    else if (!this.selectedWordIds.has(wordId) || this.selectedWordIds.size === 1) {
      this.selectedWordIds = new Set([wordId]);
    }
    this.selectedWordId = wordId;
    this.renderWordList();
    this.renderTimeline();
    this.renderInspector();
    if (scrollTimeline) this.scrollWordIntoView();
  }

  private extendSelection(wordId: string): void {
    const anchor = this.words().findIndex(word => word.id === this.selectedWordId);
    const target = this.words().findIndex(word => word.id === wordId);
    const first = Math.min(anchor, target);
    const last = Math.max(anchor, target);
    this.selectedWordIds = new Set(this.words().slice(first, last + 1).map(word => word.id));
  }

  private normalizeSelection(ids: Set<string>): Set<string> {
    const indexes = this.words().flatMap((word, index) => ids.has(word.id) ? [index] : []);
    if (!indexes.length) return new Set(this.selectedWordIds);
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    return new Set(this.words().slice(first, last + 1).map(word => word.id));
  }

  private selectedRange(): [number, number] {
    const indexes = this.words().flatMap((word, index) => this.selectedWordIds.has(word.id) ? [index] : []);
    return [Math.min(...indexes), Math.max(...indexes)];
  }

  private syncSelectionClasses(): void {
    for (const target of this.root.querySelectorAll<HTMLElement>('[data-word-id]')) {
      target.classList.toggle('selected', this.selectedWordIds.has(target.dataset.wordId!));
    }
    for (const target of this.root.querySelectorAll<HTMLElement>('[data-list-word]')) {
      target.classList.toggle('selected', this.selectedWordIds.has(target.dataset.listWord!));
    }
  }

  private pointerTime(event: PointerEvent): number {
    const timeline = this.required<HTMLElement>('#ktTimeline');
    return clamp((event.clientX - timeline.getBoundingClientRect().left) / this.zoom * 1_000, 0, 45_000);
  }

  private beginPointer(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-word-id]');
    if (!target) {
      const startMs = this.pointerTime(event);
      this.marquee = {
        pointerX: event.clientX,
        startMs,
        moved: false,
        baseIds: event.shiftKey ? new Set(this.selectedWordIds) : new Set(),
      };
      const selection = document.createElement('div');
      selection.id = 'ktMarquee';
      selection.className = 'marquee';
      selection.style.left = `${startMs / 1_000 * this.zoom}px`;
      this.required('#ktTimeline').append(selection);
      event.preventDefault();
      return;
    }
    const wordId = target.dataset.wordId!;
    const edge = (event.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge;
    if (edge === 'start' || edge === 'end') this.selectedWordIds = new Set([wordId]);
    else if (event.shiftKey) this.extendSelection(wordId);
    else if (!this.selectedWordIds.has(wordId)) this.selectedWordIds = new Set([wordId]);
    this.selectedWordId = wordId;
    const [firstIndex, lastIndex] = this.selectedRange();
    this.drag = edge !== 'start' && edge !== 'end' && firstIndex !== lastIndex
      ? {
          kind: 'group', pointerX: event.clientX, firstIndex, lastIndex,
          snapshot: this.words().map(word => ({ startMs: word.startMs, endMs: word.endMs })),
        }
      : {
          kind: 'word', wordId, pointerX: event.clientX,
          ...this.wordDrag(edge === 'start' || edge === 'end' ? edge : 'move'),
        };
    this.renderWordList();
    this.renderTimeline();
    this.renderInspector();
    event.preventDefault();
  }

  private continuePointer(event: PointerEvent): void {
    if (this.marquee) {
      const distance = event.clientX - this.marquee.pointerX;
      if (!this.marquee.moved && Math.abs(distance) < 4) return;
      this.marquee.moved = true;
      const currentMs = this.pointerTime(event);
      const startMs = Math.min(this.marquee.startMs, currentMs);
      const endMs = Math.max(this.marquee.startMs, currentMs);
      const selected = new Set(this.marquee.baseIds);
      for (const word of this.words()) {
        if (word.endMs > startMs && word.startMs < endMs) selected.add(word.id);
      }
      if (selected.size) {
        this.selectedWordIds = this.normalizeSelection(selected);
        this.selectedWordId = this.words().find(word => selected.has(word.id))!.id;
      }
      const marquee = this.root.querySelector<HTMLElement>('#ktMarquee');
      if (marquee) {
        marquee.style.left = `${startMs / 1_000 * this.zoom}px`;
        marquee.style.width = `${Math.max(2, (endMs - startMs) / 1_000 * this.zoom)}px`;
      }
      this.syncSelectionClasses();
      this.renderInspector();
      event.preventDefault();
      return;
    }
    if (!this.drag) return;
    const drag = this.drag;
    const delta = Math.round(((event.clientX - drag.pointerX) / this.zoom * 1_000) / 10) * 10;
    if (delta === 0) return;
    if (drag.kind === 'group') {
      applyKaraokeWordTimingGroupDrag(
        this.words(), drag.firstIndex, drag.lastIndex, drag.snapshot, delta,
      );
    } else {
      const word = this.words().find(candidate => candidate.id === drag.wordId);
      if (!word) return;
      applyKaraokeWordTimingDrag(this.words(), this.words().indexOf(word), drag, delta);
    }
    this.afterEdit(true);
    event.preventDefault();
  }

  private endPointer(): void {
    if (this.marquee) {
      if (!this.marquee.moved) this.seek(this.marquee.startMs);
      else this.suppressTimelineClick = true;
      this.root.querySelector('#ktMarquee')?.remove();
      this.marquee = null;
    }
    this.drag = null;
  }

  private setBoundary(mode: 'start' | 'end', value: number): void {
    if (!Number.isFinite(value)) { this.renderInspector(); return; }
    const word = this.selectedWord();
    const drag = this.wordDrag(mode);
    applyKaraokeWordTimingDrag(
      this.words(),
      this.words().indexOf(word),
      drag,
      Math.round(value) - (mode === 'start' ? word.startMs : word.endMs),
    );
    this.afterEdit(true);
  }

  private nudge(mode: DragMode, delta: number): void {
    const word = this.selectedWord();
    if (mode === 'start') this.setBoundary('start', word.startMs + delta);
    else if (mode === 'end') this.setBoundary('end', word.endMs + delta);
    else {
      const [firstIndex, lastIndex] = this.selectedRange();
      if (firstIndex !== lastIndex) {
        applyKaraokeWordTimingGroupDrag(
          this.words(), firstIndex, lastIndex,
          this.words().map(candidate => ({ startMs: candidate.startMs, endMs: candidate.endMs })),
          delta,
        );
      } else {
        applyKaraokeWordTimingDrag(this.words(), this.words().indexOf(word), this.wordDrag('move'), delta);
      }
      this.afterEdit(true);
    }
  }

  private wordDrag(mode: DragMode): KaraokeWordTimingDrag {
    const word = this.selectedWord();
    const index = this.words().indexOf(word);
    return {
      mode,
      startMs: word.startMs,
      endMs: word.endMs,
      previousEndMs: index === 0 ? 0 : this.words()[index - 1]!.endMs,
      nextStartMs: index === this.words().length - 1 ? 45_000 : this.words()[index + 1]!.startMs,
    };
  }

  private afterEdit(renderList: boolean): void {
    if (renderList) this.renderWordList();
    this.renderTimeline();
    this.renderInspector();
    this.updateDirty();
    this.updatePlayhead();
  }

  private resetWord(): void {
    const sourceWords = new Map(this.sourceSong().chart.words.map(word => [word.id, word]));
    const old = this.words().map(word => ({ startMs: word.startMs, endMs: word.endMs }));
    for (const target of this.selectedWords()) {
      const source = sourceWords.get(target.id)!;
      target.startMs = source.startMs;
      target.endMs = source.endMs;
    }
    try { void this.currentSong(); }
    catch (error) {
      this.words().forEach((word, index) => Object.assign(word, old[index]));
      this.flash(`Cannot reset this selection: ${(error as Error).message}`, true);
    }
    this.afterEdit(true);
  }

  private resetSong(): void {
    this.editable.set(this.selectedSongId, this.sourceSong().chart.words.map(word => ({ ...word })));
    this.selectedWordId = this.words()[0]!.id;
    this.selectedWordIds = new Set([this.selectedWordId]);
    this.renderAll();
    this.updateDirty();
    this.flash('Song restored to compiled timings', false);
  }

  private currentSong(): KaraokeSong {
    const source = this.sourceSong();
    return parseKaraokeSong({ ...source, chart: { ...source.chart, words: this.words() } });
  }

  private effectiveSongs(): readonly KaraokeSong[] {
    return KARAOKE_RUNTIME_SONGS.map(source => parseKaraokeSong({
      ...source,
      chart: { ...source.chart, words: this.editable.get(source.id)! },
    }));
  }

  private currentConfig(): KaraokeTimingConfig {
    return karaokeTimingConfigFromSongs(KARAOKE_RUNTIME_SONGS, this.effectiveSongs());
  }

  private updateDirty(): void {
    let dirty = false;
    try { dirty = JSON.stringify(this.currentConfig()) !== this.savedConfigJson; }
    catch (error) { this.flash(`Invalid chart: ${(error as Error).message}`, true); }
    this.required<HTMLButtonElement>('#ktSave').disabled = !this.loaded || !dirty;
  }

  private async save(): Promise<void> {
    if (!this.loaded || !this.etag) { this.flash('Cannot save until timings finish loading', true); return; }
    let config: KaraokeTimingConfig;
    try { config = this.currentConfig(); }
    catch (error) { this.flash(`Cannot save: ${(error as Error).message}`, true); return; }
    const post = () => fetch('/api/karaoke-timings', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'If-Match': this.etag }),
      body: JSON.stringify(config),
    });
    const saveButton = this.required<HTMLButtonElement>('#ktSave');
    saveButton.disabled = true;
    try {
      let response = await post();
      if (response.status === 401 && promptForToken()) response = await post();
      if (response.status === 412) throw new Error('Timings changed elsewhere. Reload before saving.');
      if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
      const saved = parseKaraokeTimingConfig(await response.json() as unknown, KARAOKE_RUNTIME_SONGS);
      this.etag = response.headers.get('ETag') ?? this.etag;
      this.savedConfigJson = JSON.stringify(saved);
      this.flash('Timings saved and applied to future performances', false);
    } catch (error) {
      this.flash(`Save failed: ${(error as Error).message}`, true);
    }
    this.updateDirty();
  }

  private async togglePlayback(): Promise<void> {
    if (!this.sourceSong().audioUrl) { this.flash('This song has no authored audio file', true); return; }
    this.auditionStopMs = null;
    if (this.audio.paused) {
      try { await this.audio.play(); }
      catch { this.flash('Audio playback requires a browser interaction', true); }
    } else this.audio.pause();
  }

  private async auditionSelected(): Promise<void> {
    if (!this.sourceSong().audioUrl) { this.flash('This song has no authored audio file', true); return; }
    const selected = this.selectedWords();
    this.audio.currentTime = Math.max(0, selected[0]!.startMs - 900) / 1_000;
    this.auditionStopMs = Math.min(45_000, selected.at(-1)!.endMs + 650);
    try { await this.audio.play(); }
    catch { this.flash('Audio playback requires a browser interaction', true); }
  }

  private seek(milliseconds: number): void {
    const value = clamp(Number.isFinite(milliseconds) ? milliseconds : 0, 0, 45_000);
    this.audio.currentTime = value / 1_000;
    this.auditionStopMs = null;
    this.updatePlayhead();
  }

  private startAnimation(): void {
    cancelAnimationFrame(this.animationFrame);
    const tick = () => {
      const now = this.audio.currentTime * 1_000;
      const loop = this.required<HTMLInputElement>('#ktLoop').checked;
      if (this.auditionStopMs !== null && now >= this.auditionStopMs) {
        if (loop) {
          this.audio.currentTime = Math.max(0, this.selectedWords()[0]!.startMs - 500) / 1_000;
        } else {
          this.audio.pause();
          this.auditionStopMs = null;
        }
      }
      this.updatePlayhead();
      if (!this.audio.paused) this.animationFrame = requestAnimationFrame(tick);
    };
    this.animationFrame = requestAnimationFrame(tick);
  }

  private updatePlayhead(): void {
    const milliseconds = clamp(this.audio.currentTime * 1_000 || 0, 0, 45_000);
    const playhead = this.root.querySelector<HTMLElement>('#ktPlayhead');
    if (playhead) playhead.style.transform = `translateX(${milliseconds / 1_000 * this.zoom}px)`;
    const scrub = this.required<HTMLInputElement>('#ktScrub');
    if (document.activeElement !== scrub) scrub.value = String(Math.round(milliseconds));
    this.required<HTMLOutputElement>('#ktTime').textContent = formatClock(milliseconds);
  }

  private scrollWordIntoView(): void {
    const word = this.selectedWord();
    const viewport = this.required<HTMLElement>('#ktTimelineViewport');
    const center = word.startMs / 1_000 * this.zoom;
    viewport.scrollTo({ left: Math.max(0, center - viewport.clientWidth / 2), behavior: 'smooth' });
  }

  private async drawWaveform(generation: number): Promise<void> {
    const canvas = this.root.querySelector<HTMLCanvasElement>('#ktWaveform');
    const song = this.sourceSong();
    if (!canvas || !song.audioUrl) return;
    let peaks = this.waveformCache.get(song.id);
    if (!peaks) {
      try {
        const response = await fetch(song.audioUrl);
        if (!response.ok) return;
        const context = new AudioContext();
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const channel = buffer.getChannelData(0);
        peaks = waveformPeaks(channel, 1_800);
        this.waveformCache.set(song.id, peaks);
        await context.close();
      } catch { return; }
    }
    if (generation !== this.waveformGeneration || !canvas.isConnected) return;
    canvas.width = Math.min(8_192, Math.ceil(45 * this.zoom));
    canvas.height = RULER_HEIGHT + LANE_HEIGHT * 4;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = 'rgba(76, 219, 255, .28)';
    context.lineWidth = 1;
    const center = RULER_HEIGHT + LANE_HEIGHT * 2;
    context.beginPath();
    peaks.forEach((peak, index) => {
      const x = index / Math.max(1, peaks!.length - 1) * canvas.width;
      const height = peak * LANE_HEIGHT * 1.75;
      context.moveTo(x, center - height);
      context.lineTo(x, center + height);
    });
    context.stroke();
  }

  private flash(message: string, error: boolean): void {
    const status = this.required('#ktStatus');
    status.textContent = message;
    status.classList.toggle('error', error);
  }

  private injectStyles(): void {
    if (document.getElementById('karaoke-timing-editor-styles')) return;
    const style = document.createElement('style');
    style.id = 'karaoke-timing-editor-styles';
    style.textContent = `
      .kte{position:fixed;inset:0;background:#07101f;color:#f5f7fb;font:13px system-ui,sans-serif;overflow:hidden;--red:#ef233c;--cyan:#4cdbff}.kte *{box-sizing:border-box}.kte button,.kte select,.kte input{font:inherit}.kte header{position:absolute;z-index:5;top:0;left:0;right:0;height:56px;display:flex;align-items:center;gap:9px;padding:0 14px;background:#111a2df2;border-bottom:1px solid #35415d}.kte header strong{font-size:16px}.kte header strong span{color:#ff7385}.kte header>a,.kte header nav a{color:#aebbd1;text-decoration:none}.kte header nav{display:flex;padding:3px;background:#080e1c;border-radius:8px}.kte header nav a{padding:6px 9px;border-radius:6px}.kte header nav a.active{background:#263653;color:#fff}.kte header label{display:flex;align-items:center;gap:6px}.kte .grow{flex:1}.kte header i{max-width:270px;color:#44df91;font-size:11px;font-style:normal}.kte header i.error{color:#ff93a2}.kte button,.kte select,.kte input{color:#fff;background:#202c46;border:1px solid #465572;border-radius:6px;padding:6px 8px}.kte button{cursor:pointer}.kte button:disabled{opacity:.42;cursor:not-allowed}.kte .save{background:var(--red);border-color:var(--red);font-weight:800}.kte .word-list{position:absolute;top:56px;left:0;bottom:0;width:220px;padding:12px;background:#10192bea;border-right:1px solid #35415d;overflow:auto}.kte h2{margin:0 0 10px;font-size:16px}.kte h3{margin:20px 0 7px;color:#9eabc2;font-size:11px;text-transform:uppercase;letter-spacing:.07em}.kte .word-list button{display:flex;width:100%;justify-content:space-between;gap:6px;margin:3px 0;text-align:left}.kte .word-list button.selected{background:#29426d;border-color:var(--cyan)}.kte .word-list small{color:#8290aa;font-size:10px}.kte main{position:absolute;top:56px;left:220px;right:286px;bottom:0;padding:18px;overflow:hidden}.kte .transport{display:grid;grid-template-columns:auto auto auto minmax(160px,1fr) auto auto;align-items:center;gap:10px;margin-bottom:14px}.kte .transport output{font:12px ui-monospace,monospace;color:var(--cyan)}.kte .transport input[type=range]{padding:0;accent-color:var(--red)}.kte .transport label{display:flex;align-items:center;gap:6px;white-space:nowrap}.kte .transport label:last-child input{width:90px}.kte .timeline-viewport{position:absolute;top:72px;left:18px;right:18px;bottom:58px;overflow:auto;background:#070c17;border:1px solid #35415d;border-radius:9px;touch-action:pan-x pan-y}.kte .timeline{position:relative;min-width:100%;user-select:none}.kte .ruler{position:absolute;z-index:1;top:0;left:0;right:0;height:${RULER_HEIGHT}px;background:#111a2d;border-bottom:1px solid #394560}.kte .tick{position:absolute;top:18px;bottom:0;border-left:1px solid #26324a;color:#7e8ba5;font-size:9px;padding-left:3px}.kte .tick.major{top:0;border-color:#60708d;padding-top:3px}.kte .lane{position:absolute;left:0;right:0;height:${LANE_HEIGHT}px;border-bottom:1px solid #202b40;background:rgba(255,255,255,.012)}.kte .lane b{position:sticky;z-index:1;left:4px;display:inline-block;margin:5px;color:#66738c;font-size:9px}.kte .waveform{position:absolute;z-index:1;inset:0;width:100%;height:100%;pointer-events:none}.kte .word{position:absolute;z-index:2;height:44px;display:flex;align-items:center;justify-content:center;min-width:10px;border:1px solid color-mix(in srgb,var(--lane) 72%,white);border-radius:6px;background:color-mix(in srgb,var(--lane) 72%,#10182a);box-shadow:0 3px 9px #0008;cursor:grab;overflow:visible;touch-action:none}.kte .word:active{cursor:grabbing}.kte .word.selected{z-index:3;outline:2px solid #fff;box-shadow:0 0 0 4px #4cdbff55,0 5px 15px #000}.kte .word em{max-width:calc(100% - 12px);overflow:hidden;color:#fff;font-size:11px;font-style:normal;font-weight:750;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}.kte .lane-0{--lane:#ef3340}.kte .lane-1{--lane:#ff8a20}.kte .lane-2{--lane:#3187f5}.kte .lane-3{--lane:#9a55eb}.kte .handle{position:absolute;z-index:4;top:-1px;bottom:-1px;width:9px;background:#fff9;cursor:ew-resize}.kte .handle.start{left:-4px;border-radius:5px 0 0 5px}.kte .handle.end{right:-4px;border-radius:0 5px 5px 0}.kte .playhead{position:absolute;z-index:4;top:0;bottom:0;left:0;width:2px;background:#fff;box-shadow:0 0 8px #fff;pointer-events:none}.kte .playhead:before{content:'';position:absolute;top:0;left:-5px;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid #fff}.kte .hint{position:absolute;left:20px;right:20px;bottom:14px;margin:0;color:#8997af;font-size:11px}.kte .inspector{position:absolute;top:56px;right:0;bottom:0;width:286px;padding:17px;background:#10192bea;border-left:1px solid #35415d;overflow:auto}.kte .inspector label{display:flex;align-items:center;justify-content:space-between;gap:7px;margin:10px 0;color:#b8c2d4}.kte .inspector input{width:112px;text-align:right}.kte .inspector output{color:#fff;font:12px ui-monospace,monospace}.kte .inspector>button{width:100%;margin-top:9px}.kte .word-id{overflow-wrap:anywhere;color:#75839d;font:10px ui-monospace,monospace}.kte .nudges{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}.kte .nudges button{padding:5px 2px;font-size:10px}
      .kte .word{min-width:18px}.kte .word em{max-width:calc(100% - 8px)}.kte .handle{width:6px}.kte .handle.start{left:-3px}.kte .handle.end{right:-3px}.kte .marquee{position:absolute;z-index:5;top:${RULER_HEIGHT}px;bottom:0;min-width:2px;border:1px solid #fff;background:#4cdbff2e;box-shadow:inset 0 0 0 1px #4cdbff66;pointer-events:none}
      @media(max-width:1000px){.kte header strong span,.kte header i{display:none}.kte .word-list{width:170px}.kte main{left:170px;right:250px}.kte .inspector{width:250px}.kte .transport{grid-template-columns:auto auto auto 1fr}.kte .transport label{display:none}}
      @media(max-width:720px){.kte header{height:100px;align-content:center;flex-wrap:wrap}.kte header .grow{display:none}.kte header label{order:3;width:calc(100% - 130px)}.kte header label select{flex:1}.kte .save{margin-left:auto}.kte .word-list{top:100px;bottom:42%;width:130px}.kte main{top:100px;left:130px;right:0;bottom:42%;padding:10px}.kte .transport{grid-template-columns:auto auto 1fr;gap:5px}.kte .transport #ktAudition{display:none}.kte .timeline-viewport{top:54px;left:10px;right:10px;bottom:38px}.kte .hint{left:10px;right:10px;bottom:7px;font-size:9px}.kte .inspector{top:58%;left:0;right:0;bottom:0;width:auto;border-left:0;border-top:1px solid #35415d}.kte .word-list button{display:block}.kte .word-list small{display:block;margin-top:2px}.kte .inspector h3{margin-top:10px}}
    `;
    document.head.append(style);
  }
}

function waveformPeaks(samples: Float32Array, count: number): Float32Array {
  const peaks = new Float32Array(count);
  const stride = Math.max(1, Math.floor(samples.length / count));
  let maximum = 0;
  for (let index = 0; index < count; index++) {
    let peak = 0;
    const start = index * stride;
    const end = Math.min(samples.length, start + stride);
    for (let sample = start; sample < end; sample++) peak = Math.max(peak, Math.abs(samples[sample]!));
    peaks[index] = peak;
    maximum = Math.max(maximum, peak);
  }
  if (maximum > 0) {
    for (let index = 0; index < peaks.length; index++) peaks[index] = peaks[index]! / maximum;
  }
  return peaks;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatTime(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3);
}

function formatClock(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor(milliseconds / 1_000) % 60;
  const millis = Math.floor(milliseconds) % 1_000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
