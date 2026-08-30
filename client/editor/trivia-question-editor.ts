import {
  TRIVIA_CATEGORY_IDS,
  TRIVIA_CHOICE_COUNT,
  TRIVIA_DIFFICULTIES,
  parseTriviaQuestionBank,
  type TriviaCategoryId,
  type TriviaDifficulty,
  type TriviaQuestionBank,
} from '../../shared/trivia';
import { authHeaders, promptForToken } from './editor-auth';
import './trivia-question-editor.css';

type DraftChoice = { id: string; text: string; aliases: string[] };
type DraftLocale = { prompt: string; choices: DraftChoice[]; explanation: string };
type DraftQuestion = {
  id: string;
  category: TriviaCategoryId;
  difficulty: TriviaDifficulty;
  correctChoiceId: string;
  locales: { 'en-US': DraftLocale; 'pt-BR': DraftLocale };
  source: { url: string; title: string; accessed: string };
  review: {
    status: 'reviewed';
    reviewedBy: string;
    reviewedAt: string;
    factChecked: boolean;
    provenance: 'human-authored' | 'ai-assisted-draft';
  };
};
type DraftBank = { version: number; questions: DraftQuestion[] };

const CATEGORY_LABELS: Record<TriviaCategoryId, string> = {
  general: 'General', science: 'Science', geography: 'Geography', history: 'History',
  entertainment: 'Entertainment', sports: 'Sports', technology: 'Technology', twilio: 'Twilio',
};

export class TriviaQuestionEditor {
  private bank: DraftBank | null = null;
  private selectedIndex = 0;
  private savedJson = '';
  private etag = '';
  private loaded = false;
  private busy = false;
  private readonly reviewInvalidated = new Set<number>();
  private loadedProvenance: DraftQuestion['review']['provenance'][] = [];

  constructor(private readonly root: HTMLElement) {
    this.root.innerHTML = `
      <div class="tqe">
        <header class="tqe-header">
          <div><strong>Voice Trivia</strong><span>Question Bank</span></div>
          <a href="/editor">All editors</a>
          <span class="tqe-grow"></span>
          <i id="tqStatus" role="status" aria-live="polite">Authorizing question bank...</i>
          <button id="tqReload" type="button">Reload</button>
          <button id="tqSave" class="save" type="button" disabled>Save bank</button>
        </header>
        <aside class="tqe-sidebar">
          <div class="tqe-sidebar-heading"><h1>Questions</h1><span id="tqVisibleCount">0</span></div>
          <label>Search<input id="tqSearch" type="search" placeholder="ID or English prompt"></label>
          <div class="tqe-filters">
            <label>Category<select id="tqCategoryFilter"><option value="">All</option>${categoryOptions()}</select></label>
            <label>Difficulty<select id="tqDifficultyFilter"><option value="">All</option>${difficultyOptions()}</select></label>
          </div>
          <div id="tqCounts" class="tqe-counts" aria-label="Question counts"></div>
          <nav id="tqList" class="tqe-list" aria-label="Trivia questions"></nav>
        </aside>
        <main class="tqe-main">
          <div id="tqSecurityWarning" class="tqe-security" role="alert"><strong>Answer-key security</strong><span>This bank contains correct answers and private voice aliases. It is server-only content. Never expose this API or payload to public game clients.</span></div>
          <form id="tqForm" hidden>
            <section class="tqe-section tqe-identity">
              <div class="tqe-section-heading"><span>01</span><div><h2>Question setup</h2><p>IDs and choice order are shared across both languages.</p></div></div>
              <div class="tqe-grid tqe-grid-four">
                <label>Question ID<input id="tqId" required maxlength="64" autocomplete="off"></label>
                <label>Category<select id="tqCategory" required>${categoryOptions()}</select></label>
                <label>Difficulty<select id="tqDifficulty" required>${difficultyOptions()}</select></label>
                <label>Correct choice<select id="tqCorrect" required></select></label>
              </div>
            </section>
            <section class="tqe-section">
              <div class="tqe-section-heading"><span>02</span><div><h2>English (United States)</h2><p>Player-facing copy and private spoken aliases.</p></div></div>
              <label>Prompt<textarea id="tqEnPrompt" required maxlength="240" rows="3"></textarea></label>
              <div class="tqe-choice-grid">${choiceFields('En')}</div>
              <label>Explanation<textarea id="tqEnExplanation" required maxlength="360" rows="3"></textarea></label>
            </section>
            <section class="tqe-section">
              <div class="tqe-section-heading"><span>03</span><div><h2>Portuguese (Brazil)</h2><p>Choice IDs and order must match English.</p></div></div>
              <label>Prompt<textarea id="tqPtPrompt" required maxlength="240" rows="3"></textarea></label>
              <div class="tqe-choice-grid">${choiceFields('Pt')}</div>
              <label>Explanation<textarea id="tqPtExplanation" required maxlength="360" rows="3"></textarea></label>
            </section>
            <section class="tqe-section">
              <div class="tqe-section-heading"><span>04</span><div><h2>Source and review</h2><p>Every saved question must be fact-checked and reviewed.</p></div></div>
              <div id="tqReviewWarning" class="tqe-security" role="alert" hidden><strong>Review required</strong><span>This question changed. Enter a new reviewer and review date, then confirm fact-checking before saving.</span></div>
              <div class="tqe-grid tqe-grid-two">
                <label class="tqe-wide">Source URL<input id="tqSourceUrl" required type="url" maxlength="512" placeholder="https://..."></label>
                <label>Source title<input id="tqSourceTitle" required maxlength="160"></label>
                <label>Source accessed<input id="tqSourceAccessed" required type="date"></label>
                <label>Review status<select id="tqReviewStatus" required><option value="reviewed">Reviewed</option></select></label>
                <label>Reviewed by<input id="tqReviewedBy" required maxlength="100"></label>
                <label>Reviewed at<input id="tqReviewedAt" required type="date"></label>
                <label>Provenance<select id="tqProvenance" disabled aria-describedby="tqProvenanceHelp"><option value="human-authored">Human-authored</option><option value="ai-assisted-draft">AI-assisted draft</option></select><small id="tqProvenanceHelp">Original authorship provenance is immutable. A later review cannot relabel AI-assisted content as human-authored.</small></label>
                <label class="tqe-check"><input id="tqFactChecked" type="checkbox" required><span>Fact checked</span></label>
              </div>
            </section>
          </form>
          <div id="tqEmpty" class="tqe-empty">Loading the protected question bank...</div>
        </main>
      </div>`;
    this.bind();
    void this.load();
    addEventListener('beforeunload', event => {
      if (!this.isDirty()) return;
      event.preventDefault();
      event.returnValue = '';
    });
    (window as unknown as { __triviaQuestionEditor?: TriviaQuestionEditor }).__triviaQuestionEditor = this;
  }

  snapshot(): TriviaQuestionBank | null {
    if (!this.bank) return null;
    return parseTriviaQuestionBank(this.bank);
  }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Trivia question editor is missing ${selector}`);
    return element;
  }

  private setValue(selector: string, value: string): void {
    this.required<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector).value = value;
  }

  private bind(): void {
    this.required<HTMLButtonElement>('#tqSave').onclick = () => void this.save();
    this.required<HTMLButtonElement>('#tqReload').onclick = () => {
      if (this.isDirty() && !confirm('Discard local question changes and reload the server bank?')) return;
      void this.load();
    };
    for (const selector of ['#tqSearch', '#tqCategoryFilter', '#tqDifficultyFilter']) {
      this.required<HTMLInputElement | HTMLSelectElement>(selector).oninput = () => this.renderQuestionList();
    }
    this.required('#tqList').addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-question-index]');
      if (!button) return;
      this.commitForm();
      this.selectedIndex = Number(button.dataset.questionIndex);
      this.renderQuestionList();
      this.renderForm();
      this.required('#tqForm').scrollTo({ top: 0 });
    });
    this.required<HTMLFormElement>('#tqForm').addEventListener('submit', event => event.preventDefault());
    this.required<HTMLFormElement>('#tqForm').addEventListener('input', event => {
      const before = this.currentReviewFingerprint();
      this.commitForm();
      const targetId = (event.target as HTMLElement).id;
      if (before !== this.currentReviewFingerprint()) this.invalidateReview(this.selectedIndex);
      if (REVIEW_CONTROL_IDS.has(targetId)) this.confirmReviewIfComplete(this.selectedIndex);
      if (targetId.startsWith('tqChoiceId-') || targetId.startsWith('tqEnChoice-')) {
        this.renderCorrectChoices(this.bank?.questions[this.selectedIndex]?.correctChoiceId);
      }
      this.renderCounts();
      this.renderQuestionList();
      this.updateDirty();
    });
  }

  private async load(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    this.flash('Authorizing question bank...', false);
    const get = () => fetch('/api/trivia-questions', {
      cache: 'no-store', credentials: 'same-origin', headers: authHeaders({ Accept: 'application/json' }),
    });
    try {
      let response = await get();
      if (response.status === 401 && promptForToken()) response = await get();
      if (!response.ok) throw new Error(await responseMessage(response));
      const parsed = parseTriviaQuestionBank(await response.json() as unknown);
      const etag = response.headers.get('ETag') ?? '';
      if (!etag) throw new Error('question response is missing its ETag');
      const selectedId = this.bank?.questions[this.selectedIndex]?.id;
      this.bank = cloneBank(parsed);
      this.loadedProvenance = this.bank.questions.map(question => question.review.provenance);
      this.selectedIndex = Math.max(0, selectedId ? this.bank.questions.findIndex(question => question.id === selectedId) : 0);
      this.savedJson = JSON.stringify(parsed);
      this.etag = etag;
      this.loaded = true;
      this.reviewInvalidated.clear();
      this.renderAll();
      this.flash(`Protected bank loaded: ${parsed.questions.length} questions`, false);
    } catch (error) {
      if (!this.bank) {
        this.required<HTMLFormElement>('#tqForm').hidden = true;
        const empty = this.required('#tqEmpty');
        empty.hidden = false;
        empty.textContent = 'The protected question bank could not be loaded. Check editor authorization and retry.';
      }
      this.flash(`Load failed: ${(error as Error).message}`, true);
    } finally {
      this.setBusy(false);
      this.updateDirty();
    }
  }

  private renderAll(): void {
    this.renderCounts();
    this.renderQuestionList();
    this.renderForm();
  }

  private renderCounts(): void {
    const host = this.required('#tqCounts');
    host.replaceChildren();
    const questions = this.bank?.questions ?? [];
    host.append(countChip('Total', questions.length));
    for (const category of TRIVIA_CATEGORY_IDS) {
      const matching = questions.filter(question => question.category === category);
      const detail = TRIVIA_DIFFICULTIES.map(difficulty =>
        `${difficulty.slice(0, 1).toUpperCase()} ${matching.filter(question => question.difficulty === difficulty).length}`,
      ).join(' / ');
      host.append(countChip(CATEGORY_LABELS[category], matching.length, detail));
    }
  }

  private renderQuestionList(): void {
    const host = this.required('#tqList');
    host.replaceChildren();
    const query = this.required<HTMLInputElement>('#tqSearch').value.trim().toLocaleLowerCase('en-US');
    const category = this.required<HTMLSelectElement>('#tqCategoryFilter').value;
    const difficulty = this.required<HTMLSelectElement>('#tqDifficultyFilter').value;
    const visible = (this.bank?.questions ?? []).map((question, index) => ({ question, index })).filter(({ question }) =>
      (!query || `${question.id} ${question.locales['en-US'].prompt}`.toLocaleLowerCase('en-US').includes(query))
      && (!category || question.category === category)
      && (!difficulty || question.difficulty === difficulty));
    this.required('#tqVisibleCount').textContent = String(visible.length);
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'tqe-list-empty';
      empty.textContent = this.bank ? 'No questions match these filters.' : 'No bank loaded.';
      host.append(empty);
      return;
    }
    for (const { question, index } of visible) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.questionIndex = String(index);
      button.classList.toggle('selected', index === this.selectedIndex);
      button.setAttribute('aria-current', index === this.selectedIndex ? 'true' : 'false');
      const id = document.createElement('strong');
      const meta = document.createElement('span');
      const prompt = document.createElement('small');
      id.textContent = question.id || '(missing ID)';
      meta.textContent = `${CATEGORY_LABELS[question.category]} / ${question.difficulty}${this.reviewInvalidated.has(index) ? ' / REVIEW REQUIRED' : ''}`;
      prompt.textContent = question.locales['en-US'].prompt || '(missing prompt)';
      button.append(id, meta, prompt);
      host.append(button);
    }
  }

  private renderForm(): void {
    const question = this.bank?.questions[this.selectedIndex];
    const form = this.required<HTMLFormElement>('#tqForm');
    const empty = this.required('#tqEmpty');
    form.hidden = !question;
    empty.hidden = Boolean(question);
    if (!question) return;
    this.setValue('#tqId', question.id);
    this.setValue('#tqCategory', question.category);
    this.setValue('#tqDifficulty', question.difficulty);
    this.setValue('#tqEnPrompt', question.locales['en-US'].prompt);
    this.setValue('#tqPtPrompt', question.locales['pt-BR'].prompt);
    this.setValue('#tqEnExplanation', question.locales['en-US'].explanation);
    this.setValue('#tqPtExplanation', question.locales['pt-BR'].explanation);
    for (let index = 0; index < TRIVIA_CHOICE_COUNT; index++) {
      const english = question.locales['en-US'].choices[index]!;
      const portuguese = question.locales['pt-BR'].choices[index]!;
      this.setValue(`#tqChoiceId-${index}`, english.id);
      this.setValue(`#tqEnChoice-${index}`, english.text);
      this.setValue(`#tqEnAliases-${index}`, english.aliases.join('\n'));
      this.setValue(`#tqPtChoice-${index}`, portuguese.text);
      this.setValue(`#tqPtAliases-${index}`, portuguese.aliases.join('\n'));
    }
    this.setValue('#tqSourceUrl', question.source.url);
    this.setValue('#tqSourceTitle', question.source.title);
    this.setValue('#tqSourceAccessed', question.source.accessed);
    this.setValue('#tqReviewStatus', question.review.status);
    this.setValue('#tqReviewedBy', question.review.reviewedBy);
    this.setValue('#tqReviewedAt', question.review.reviewedAt);
    this.setValue('#tqProvenance', question.review.provenance);
    this.required<HTMLInputElement>('#tqFactChecked').checked = question.review.factChecked;
    this.renderCorrectChoices(question.correctChoiceId);
    this.renderReviewState();
  }

  private renderCorrectChoices(selected?: string): void {
    const select = this.required<HTMLSelectElement>('#tqCorrect');
    const current = selected ?? select.value;
    select.replaceChildren();
    for (let index = 0; index < TRIVIA_CHOICE_COUNT; index++) {
      const id = this.required<HTMLInputElement>(`#tqChoiceId-${index}`).value.trim();
      const text = this.required<HTMLInputElement>(`#tqEnChoice-${index}`).value.trim();
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `${String.fromCharCode(65 + index)}: ${text || id || 'unnamed choice'}`;
      select.append(option);
    }
    select.value = current;
  }

  private commitForm(): void {
    const question = this.bank?.questions[this.selectedIndex];
    if (!question || this.required<HTMLFormElement>('#tqForm').hidden) return;
    const ids = Array.from({ length: TRIVIA_CHOICE_COUNT }, (_, index) =>
      this.required<HTMLInputElement>(`#tqChoiceId-${index}`).value.trim());
    const oldCorrectIndex = question.locales['en-US'].choices.findIndex(choice => choice.id === question.correctChoiceId);
    let correctChoiceId = this.required<HTMLSelectElement>('#tqCorrect').value;
    if (!ids.includes(correctChoiceId) && oldCorrectIndex >= 0) correctChoiceId = ids[oldCorrectIndex]!;
    const choices = (locale: 'En' | 'Pt'): DraftChoice[] => ids.map((id, index) => ({
      id,
      text: this.required<HTMLInputElement>(`#tq${locale}Choice-${index}`).value,
      aliases: aliasLines(this.required<HTMLTextAreaElement>(`#tq${locale}Aliases-${index}`).value),
    }));
    this.bank!.questions[this.selectedIndex] = {
      id: this.required<HTMLInputElement>('#tqId').value,
      category: this.required<HTMLSelectElement>('#tqCategory').value as TriviaCategoryId,
      difficulty: this.required<HTMLSelectElement>('#tqDifficulty').value as TriviaDifficulty,
      correctChoiceId,
      locales: {
        'en-US': {
          prompt: this.required<HTMLTextAreaElement>('#tqEnPrompt').value,
          choices: choices('En'),
          explanation: this.required<HTMLTextAreaElement>('#tqEnExplanation').value,
        },
        'pt-BR': {
          prompt: this.required<HTMLTextAreaElement>('#tqPtPrompt').value,
          choices: choices('Pt'),
          explanation: this.required<HTMLTextAreaElement>('#tqPtExplanation').value,
        },
      },
      source: {
        url: this.required<HTMLInputElement>('#tqSourceUrl').value,
        title: this.required<HTMLInputElement>('#tqSourceTitle').value,
        accessed: this.required<HTMLInputElement>('#tqSourceAccessed').value,
      },
      review: {
        status: this.required<HTMLSelectElement>('#tqReviewStatus').value as 'reviewed',
        reviewedBy: this.required<HTMLInputElement>('#tqReviewedBy').value,
        reviewedAt: this.required<HTMLInputElement>('#tqReviewedAt').value,
        factChecked: this.required<HTMLInputElement>('#tqFactChecked').checked,
        provenance: this.loadedProvenance[this.selectedIndex] ?? question.review.provenance,
      },
    };
  }

  private currentReviewFingerprint(): string {
    const question = this.bank?.questions[this.selectedIndex];
    if (!question) return '';
    return JSON.stringify({
      id: question.id,
      category: question.category,
      difficulty: question.difficulty,
      correctChoiceId: question.correctChoiceId,
      locales: question.locales,
      source: question.source,
      provenance: question.review.provenance,
    });
  }

  private invalidateReview(index: number): void {
    const question = this.bank?.questions[index];
    if (!question) return;
    this.reviewInvalidated.add(index);
    question.review.reviewedBy = '';
    question.review.reviewedAt = '';
    question.review.factChecked = false;
    this.setValue('#tqReviewedBy', '');
    this.setValue('#tqReviewedAt', '');
    this.required<HTMLInputElement>('#tqFactChecked').checked = false;
    this.renderReviewState();
    this.flash('Question content changed. A new review and fact-check confirmation are required.', true);
  }

  private confirmReviewIfComplete(index: number): void {
    const question = this.bank?.questions[index];
    if (!question || !this.reviewInvalidated.has(index) || !reviewIsComplete(question)) return;
    this.reviewInvalidated.delete(index);
    this.renderReviewState();
    this.flash('Review refreshed for this question. Save is available when all changes are reviewed.', false);
  }

  private renderReviewState(): void {
    const pending = this.reviewInvalidated.has(this.selectedIndex);
    this.required('#tqReviewWarning').hidden = !pending;
    for (const selector of ['#tqReviewedBy', '#tqReviewedAt', '#tqFactChecked']) {
      const control = this.required(selector);
      if (pending) control.setAttribute('aria-describedby', 'tqReviewWarning');
      else control.removeAttribute('aria-describedby');
    }
  }

  private async save(): Promise<void> {
    if (!this.loaded || !this.bank || !this.etag || this.busy) {
      this.flash('Cannot save until the protected bank and ETag finish loading', true);
      return;
    }
    const before = this.currentReviewFingerprint();
    this.commitForm();
    if (before !== this.currentReviewFingerprint()) this.invalidateReview(this.selectedIndex);
    if (this.reviewInvalidated.size > 0) {
      this.flash('Review every changed question with a new reviewer, date, and fact-check confirmation before saving.', true);
      return;
    }
    let validated: TriviaQuestionBank;
    try {
      validated = parseTriviaQuestionBank(this.bank);
    } catch (error) {
      this.flash(`Local validation failed. Nothing was sent: ${(error as Error).message}`, true);
      return;
    }
    const post = () => fetch('/api/trivia-questions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json', 'If-Match': this.etag }),
      body: JSON.stringify(validated),
    });
    this.setBusy(true);
    this.flash('Saving protected question bank...', false);
    try {
      let response = await post();
      if (response.status === 401 && promptForToken()) response = await post();
      if (response.status === 412) throw new Error('Question bank changed elsewhere. Reload before saving.');
      if (!response.ok) throw new Error(await responseMessage(response));
      const saved = parseTriviaQuestionBank(await response.json() as unknown);
      const nextEtag = response.headers.get('ETag') ?? '';
      if (!nextEtag) throw new Error('save response is missing its ETag');
      const selectedId = this.bank.questions[this.selectedIndex]?.id;
      this.bank = cloneBank(saved);
      this.loadedProvenance = this.bank.questions.map(question => question.review.provenance);
      this.selectedIndex = Math.max(0, selectedId ? this.bank.questions.findIndex(question => question.id === selectedId) : 0);
      this.savedJson = JSON.stringify(saved);
      this.etag = nextEtag;
      this.reviewInvalidated.clear();
      this.renderAll();
      this.flash(`Question bank saved: ${saved.questions.length} strictly validated questions`, false);
    } catch (error) {
      this.flash(`Save failed: ${(error as Error).message}`, true);
    } finally {
      this.setBusy(false);
      this.updateDirty();
    }
  }

  private isDirty(): boolean {
    return Boolean(this.bank && this.savedJson && JSON.stringify(this.bank) !== this.savedJson);
  }

  private updateDirty(): void {
    const pendingReview = this.reviewInvalidated.size > 0;
    const save = this.required<HTMLButtonElement>('#tqSave');
    save.disabled = this.busy || !this.loaded || !this.isDirty() || pendingReview;
    save.title = pendingReview ? 'Review every changed question before saving' : '';
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.required<HTMLButtonElement>('#tqReload').disabled = busy;
    this.required<HTMLFormElement>('#tqForm').classList.toggle('busy', busy);
    this.updateDirty();
  }

  private flash(message: string, error: boolean): void {
    const status = this.required('#tqStatus');
    status.textContent = message;
    status.classList.toggle('error', error);
  }
}

function categoryOptions(): string {
  return TRIVIA_CATEGORY_IDS.map(category => `<option value="${category}">${CATEGORY_LABELS[category]}</option>`).join('');
}

function difficultyOptions(): string {
  return TRIVIA_DIFFICULTIES.map(difficulty => `<option value="${difficulty}">${difficulty[0]!.toUpperCase()}${difficulty.slice(1)}</option>`).join('');
}

function choiceFields(locale: 'En' | 'Pt'): string {
  return Array.from({ length: TRIVIA_CHOICE_COUNT }, (_, index) => `
    <fieldset class="tqe-choice">
      <legend>Choice ${String.fromCharCode(65 + index)}</legend>
      ${locale === 'En' ? `<label>Shared choice ID<input id="tqChoiceId-${index}" required maxlength="64" autocomplete="off"></label>` : ''}
      <label>Choice text<input id="tq${locale}Choice-${index}" required maxlength="100"></label>
      <label>Optional private voice aliases, one per line (0-12)<textarea id="tq${locale}Aliases-${index}" maxlength="1211" rows="4" spellcheck="false"></textarea></label>
    </fieldset>`).join('');
}

function aliasLines(value: string): string[] {
  return value.split(/\r?\n/).map(alias => alias.trim()).filter(Boolean);
}

const REVIEW_CONTROL_IDS = new Set(['tqReviewedBy', 'tqReviewedAt', 'tqFactChecked']);

function reviewIsComplete(question: DraftQuestion): boolean {
  return question.review.status === 'reviewed'
    && question.review.reviewedBy.trim().length > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(question.review.reviewedAt)
    && question.review.factChecked;
}

function cloneBank(bank: TriviaQuestionBank): DraftBank {
  return JSON.parse(JSON.stringify(bank)) as DraftBank;
}

function countChip(label: string, value: number, detail = ''): HTMLElement {
  const chip = document.createElement('div');
  const name = document.createElement('span');
  const count = document.createElement('strong');
  name.textContent = label;
  count.textContent = String(value);
  chip.append(name, count);
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    chip.append(small);
  }
  return chip;
}

async function responseMessage(response: Response): Promise<string> {
  const fallback = `request failed (${response.status})`;
  const body = (await response.text()).trim();
  if (!body) return fallback;
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string }; message?: string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error.message === 'string') return parsed.error.message;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch { /* Plain-text API errors are already safe to display as textContent. */ }
  return body;
}
