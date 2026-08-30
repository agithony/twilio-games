import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hub = readFileSync(new URL('../client/editor/hub.ts', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../client/editor/trivia-question-editor.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../client/editor/trivia-question-editor.css', import.meta.url), 'utf8');
const mapWorld = readFileSync(new URL('../client/map-world.ts', import.meta.url), 'utf8');

describe('Voice Trivia protected question-bank editor', () => {
  it('is linked from the unified hub without propagating editor credentials', () => {
    expect(hub).toContain('href="?game=trivia"');
    expect(hub).toContain("game === 'trivia'");
    expect(hub).toContain("import('./trivia-question-editor')");
    const links = [...hub.matchAll(/class="hub-card" href="([^"]+)"/g)].map(match => match[1]);
    expect(links).toHaveLength(5);
    expect(links.every(link => [...new URLSearchParams(link!.slice(1)).keys()].every(key => key === 'game' || key === 'tool'))).toBe(true);
    expect(hub).not.toMatch(/[?&]token=/);
    expect(editor).not.toMatch(/[?&]token=/);
  });

  it('exposes every bilingual question, source, answer, and review field', () => {
    for (const control of [
      'id="tqId"', 'id="tqCategory"', 'id="tqDifficulty"', 'id="tqCorrect"',
      'id="tqEnPrompt"', 'id="tqPtPrompt"', 'id="tqEnExplanation"', 'id="tqPtExplanation"',
      'id="tqSourceUrl"', 'id="tqSourceTitle"', 'id="tqSourceAccessed"',
      'id="tqReviewStatus"', 'id="tqReviewedBy"', 'id="tqReviewedAt"',
      'id="tqFactChecked"', 'id="tqProvenance"',
    ]) expect(editor).toContain(control);
    expect(editor).toContain('tq${locale}Choice-${index}');
    expect(editor).toContain('tq${locale}Aliases-${index}');
    expect(editor).toContain('TRIVIA_CATEGORY_IDS');
    expect(editor).toContain('TRIVIA_DIFFICULTIES');
    expect(editor).toContain('id="tqCounts"');
    expect(editor).toContain('Optional private voice aliases, one per line (0-12)');
    expect(editor).not.toMatch(/Aliases-\$\{index\}" required/);
  });

  it('keeps loaded authorship provenance immutable in the emitted bank', () => {
    expect(editor).toContain('id="tqProvenance" disabled aria-describedby="tqProvenanceHelp"');
    expect(editor).toContain('Original authorship provenance is immutable.');
    expect(editor).toContain("private loadedProvenance: DraftQuestion['review']['provenance'][] = []");
    expect(editor).toContain('this.loadedProvenance = this.bank.questions.map(question => question.review.provenance)');
    expect(editor).toContain('provenance: this.loadedProvenance[this.selectedIndex] ?? question.review.provenance');
    expect(editor).toContain('provenance: question.review.provenance');
    expect(editor).not.toContain("provenance: this.required<HTMLSelectElement>('#tqProvenance').value");
  });

  it('authenticates both requests and protects writes with the loaded ETag', () => {
    expect(editor.match(/fetch\('\/api\/trivia-questions'/g)).toHaveLength(2);
    expect(editor).toContain("headers: authHeaders({ Accept: 'application/json' })");
    expect(editor).toContain("method: 'POST'");
    expect(editor).toContain("'If-Match': this.etag");
    expect(editor).toContain("response.headers.get('ETag')");
    expect(editor).toContain('promptForToken()');
    expect(editor).toContain("credentials: 'same-origin'");
    expect(editor).toContain('Question bank changed elsewhere. Reload before saving.');
    expect(mapWorld).toContain("method: 'DELETE'");
    expect(mapWorld).toContain('headers: authHeaders()');
    expect(mapWorld).not.toContain('withToken');
    expect(mapWorld).not.toMatch(/\/api\/maps[^`'\"]*token=/);
  });

  it('invalidates stale review metadata after substantive changes and blocks save until reconfirmed', () => {
    expect(editor).toContain('id="tqReviewWarning"');
    expect(editor).toContain('before !== this.currentReviewFingerprint()');
    for (const field of ['category', 'difficulty', 'correctChoiceId', 'locales', 'source']) {
      expect(editor).toContain(`${field}: question.${field}`);
    }
    expect(editor).toContain("question.review.reviewedBy = ''");
    expect(editor).toContain("question.review.reviewedAt = ''");
    expect(editor).toContain('question.review.factChecked = false');
    expect(editor).toContain("const REVIEW_CONTROL_IDS = new Set(['tqReviewedBy', 'tqReviewedAt', 'tqFactChecked'])");
    expect(editor).toContain('this.reviewInvalidated.size > 0');
    expect(editor).toContain('!this.isDirty() || pendingReview');
    const save = /private async save\(\): Promise<void> \{[\s\S]*?\n  \}/.exec(editor)?.[0] ?? '';
    expect(save.indexOf('this.reviewInvalidated.size > 0')).toBeLessThan(save.indexOf('parseTriviaQuestionBank(this.bank)'));
  });

  it('strictly validates the complete bank before posting and warns against disclosure', () => {
    const save = /private async save\(\): Promise<void> \{[\s\S]*?\n  \}/.exec(editor)?.[0] ?? '';
    expect(save).toContain('validated = parseTriviaQuestionBank(this.bank)');
    expect(save.indexOf('parseTriviaQuestionBank(this.bank)')).toBeLessThan(save.indexOf("fetch('/api/trivia-questions'"));
    expect(editor).toContain('Local validation failed. Nothing was sent:');
    expect(editor).toContain('Answer-key security');
    expect(editor).toContain('Never expose this API or payload to public game clients.');

    const clientRoot = fileURLToPath(new URL('../client/', import.meta.url));
    const endpointUsers = (readdirSync(clientRoot, { recursive: true }) as string[])
      .filter(file => file.endsWith('.ts'))
      .filter(file => readFileSync(`${clientRoot}/${file}`, 'utf8').includes('/api/trivia-questions'));
    expect(endpointUsers).toEqual(['editor/trivia-question-editor.ts']);
  });

  it('keeps the editor usable at desktop and mobile widths', () => {
    expect(css).toContain('.tqe{position:fixed');
    expect(css).toContain('@media(max-width:900px)');
    expect(css).toContain('@media(max-width:600px)');
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
  });
});
