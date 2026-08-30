import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TriviaContentStore } from '../server/trivia-content-store';
import {
  parseTriviaQuestionBankJson,
  parseTriviaQuestion,
  TRIVIA_CATEGORY_IDS,
  TRIVIA_QUESTION_BANK_SIZE,
  TRIVIA_QUESTIONS_PER_CATEGORY,
} from '../shared/trivia';

const json = readFileSync(new URL('../content/trivia/questions.json', import.meta.url), 'utf8');
const raw = JSON.parse(json) as {
  questions: Array<{
    id: string;
    category: string;
    difficulty: string;
    correctChoiceId: string;
    locales: Record<string, {
      prompt: string;
      explanation: string;
      choices: Array<{ id: string; text: string; aliases: string[] }>;
    }>;
    source: { url: string; title: string; accessed: string };
    review: {
      status: string;
      reviewedBy: string;
      reviewedAt: string;
      factChecked: boolean;
      provenance: string;
    };
  }>;
};
const bank = parseTriviaQuestionBankJson(json);
const locales = ['en-US', 'pt-BR'] as const;
const choiceIds = ['a', 'b', 'c', 'd'];
const directories: string[] = [];
const stopWords = new Set([
  'and', 'are', 'como', 'das', 'does', 'dos', 'for', 'from', 'how', 'into', 'para', 'por', 'qual', 'que',
  'the', 'uma', 'what', 'when', 'where', 'which', 'who', 'with', 'was', 'were',
]);

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function contentTokens(value: string): string[] {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\d+/g, ' number ')
    .match(/[a-z]+/g)?.filter(token => token.length > 2 && !stopWords.has(token)) ?? [];
}

function nearDuplicatePairs(locale: typeof locales[number]): string[] {
  const duplicates: string[] = [];
  for (let left = 0; left < bank.questions.length; left++) {
    const leftTokens = new Set(contentTokens(bank.questions[left]!.locales[locale].prompt));
    for (let right = left + 1; right < bank.questions.length; right++) {
      const rightTokens = new Set(contentTokens(bank.questions[right]!.locales[locale].prompt));
      const shared = [...leftTokens].filter(token => rightTokens.has(token)).length;
      const union = leftTokens.size + rightTokens.size - shared;
      if (shared >= 4 && shared / union >= 0.72) {
        duplicates.push(`${bank.questions[left]!.id}/${bank.questions[right]!.id}`);
      }
    }
  }
  return duplicates;
}

describe('production trivia content quality', () => {
  it('strictly parses with stable IDs, exact category counts, and complete locales', () => {
    expect(bank.questions).toHaveLength(TRIVIA_QUESTION_BANK_SIZE);
    expect(new Set(bank.questions.map(question => question.id)).size).toBe(TRIVIA_QUESTION_BANK_SIZE);

    for (const category of TRIVIA_CATEGORY_IDS) {
      const questions = bank.questions.filter(question => question.category === category);
      expect(questions).toHaveLength(TRIVIA_QUESTIONS_PER_CATEGORY);
      expect(questions.map(question => question.id)).toEqual(
        Array.from({ length: TRIVIA_QUESTIONS_PER_CATEGORY }, (_, index) => `${category}-${String(index + 1).padStart(3, '0')}`),
      );
      expect(Object.fromEntries(['easy', 'medium', 'hard'].map(difficulty => [
        difficulty,
        questions.filter(question => question.difficulty === difficulty).length,
      ]))).toEqual({ easy: 6, medium: 13, hard: 6 });
    }

    for (const question of bank.questions) {
      expect(Object.keys(question.locales).sort()).toEqual([...locales].sort());
      for (const locale of locales) {
        const content = question.locales[locale];
        expect(content.prompt.trim()).not.toBe('');
        expect(content.explanation.trim()).not.toBe('');
        expect(content.choices.map(choice => choice.id)).toEqual(choiceIds);
        expect(new Set(content.choices.map(choice => choice.text.toLocaleLowerCase(locale))).size).toBe(4);
        for (const choice of content.choices) {
          expect(choice.aliases.length).toBeLessThanOrEqual(12);
          expect(choice.aliases, `${question.id}:${locale}:${choice.id}`).not.toContain(
            locale === 'pt-BR' ? `opção ${choice.id.toUpperCase()}` : `choice ${choice.id.toUpperCase()}`,
          );
        }
      }
      expect(choiceIds).toContain(question.correctChoiceId);
    }
  });

  it('rejects semantic or reordered choice IDs and non-opaque answer keys in either locale', () => {
    for (const locale of locales) {
      const semantic = structuredClone(raw.questions[0]!);
      semantic.locales[locale]!.choices[0]!.id = 'correct-answer';
      expect(() => parseTriviaQuestion(semantic)).toThrow(/opaque choice ID a/);

      const reordered = structuredClone(raw.questions[0]!);
      [reordered.locales[locale]!.choices[0], reordered.locales[locale]!.choices[1]] =
        [reordered.locales[locale]!.choices[1]!, reordered.locales[locale]!.choices[0]!];
      expect(() => parseTriviaQuestion(reordered)).toThrow(/opaque choice ID a/);
    }

    const semanticKey = structuredClone(raw.questions[0]!);
    semanticKey.correctChoiceId = 'paris';
    expect(() => parseTriviaQuestion(semanticKey)).toThrow(/opaque choice IDs a, b, c, or d/);
  });

  it('rejects localized text whose NFKC form expands beyond its character bound', () => {
    const expanding = structuredClone(raw.questions[0]!);
    expanding.locales['en-US']!.prompt = '\uFB03'.repeat(81);
    expect(Array.from(expanding.locales['en-US']!.prompt)).toHaveLength(81);
    expect(Array.from(expanding.locales['en-US']!.prompt.normalize('NFKC'))).toHaveLength(243);
    expect(() => parseTriviaQuestion(expanding)).toThrow(/locales\.en-US\.prompt.*at most 240/);
  });

  it('keeps answer positions balanced without relying on a repeated sequence', () => {
    for (const category of TRIVIA_CATEGORY_IDS) {
      const questions = bank.questions.filter(question => question.category === category);
      const counts = choiceIds.map(id => questions.filter(question => question.correctChoiceId === id).length);
      expect(Math.max(...counts) - Math.min(...counts), category).toBeLessThanOrEqual(1);
      expect(counts.reduce((total, count) => total + count, 0)).toBe(TRIVIA_QUESTIONS_PER_CATEGORY);
    }

    const answerRun = bank.questions.map(question => question.correctChoiceId).join('');
    expect(answerRun).not.toContain('abcdabcdabcdabcd');
  });

  it('guards prompt uniqueness, lexical diversity, and template repetition', () => {
    for (const locale of locales) {
      const normalized = bank.questions.map(question => contentTokens(question.locales[locale].prompt).join(' '));
      expect(new Set(normalized).size, locale).toBe(TRIVIA_QUESTION_BANK_SIZE);
      expect(nearDuplicatePairs(locale), locale).toEqual([]);
    }

    for (const category of TRIVIA_CATEGORY_IDS) {
      const questions = bank.questions.filter(question => question.category === category);
      const vocabulary = new Set(questions.flatMap(question => contentTokens(question.locales['en-US'].prompt)));
      expect(vocabulary.size, `${category} prompt vocabulary`).toBeGreaterThanOrEqual(70);

      const openingCounts = new Map<string, number>();
      for (const question of questions) {
        const opening = question.locales['en-US'].prompt.toLowerCase().replace(/\d+/g, '#')
          .match(/[a-z#]+/g)?.slice(0, 4).join(' ') ?? '';
        openingCounts.set(opening, (openingCounts.get(opening) ?? 0) + 1);
      }
      expect(Math.max(...openingCounts.values()), `${category} repeated opening`).toBeLessThanOrEqual(6);
      expect(new Set(questions.map(question => question.source.url)).size, `${category} source diversity`)
        .toBeGreaterThanOrEqual(22);
    }
  });

  it('requires specific HTTPS citations and honest AI-assisted review metadata', () => {
    const genericSources = new Set([
      'https://www.britannica.com/topic/history',
      'https://www.oscars.org/oscars',
      'https://olympics.com/ioc/olympic-games',
      'https://www.twilio.com/docs',
    ]);

    for (const question of raw.questions) {
      const source = new URL(question.source.url);
      expect(source.protocol, question.id).toBe('https:');
      expect(source.username + source.password + source.hash, question.id).toBe('');
      expect(source.pathname, question.id).not.toMatch(/^\/?(?:docs)?\/?$/);
      expect(genericSources.has(question.source.url), question.id).toBe(false);
      expect(question.source.title.length, question.id).toBeGreaterThan(8);
      expect(question.source.accessed, question.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(question.review).toEqual({
        status: 'reviewed',
        reviewedBy: 'OpenAI GPT-5.6 Sol (AI-assisted editorial audit)',
        reviewedAt: '2026-08-29',
        factChecked: true,
        provenance: 'ai-assisted-draft',
      });
    }
  });

  it('rejects obvious English-copy leakage in Brazilian Portuguese content', () => {
    const englishLeak = /\b(?:what|which|where|when|who|how)\s+(?:is|are|was|were|did|does|do)\b|\b(?:the correct answer is|option [a-d]|in which year|where were|which twilio term)\b|\b(?:did|does|was|were)\s+the\b/i;
    const portugueseGrammar = /\b(?:a|o|as|os|de|da|do|das|dos|em|no|na|nos|nas|que|qual|como|para|por|com|ou|um|uma|é|foi|se)\b/i;

    for (const question of bank.questions) {
      const english = question.locales['en-US'];
      const portuguese = question.locales['pt-BR'];
      expect(portuguese.prompt, question.id).not.toBe(english.prompt);
      expect(portuguese.explanation, question.id).not.toBe(english.explanation);
      expect(portuguese.prompt, question.id).toMatch(portugueseGrammar);
      expect(portuguese.explanation, question.id).toMatch(portugueseGrammar);
      expect([portuguese.prompt, portuguese.explanation, ...portuguese.choices.flatMap(choice => choice.aliases)], question.id)
        .not.toEqual(expect.arrayContaining([expect.stringMatching(englishLeak)]));
    }
  });
});

describe('TriviaContentStore replacement invariants', () => {
  async function loadedStore(): Promise<{ store: TriviaContentStore; live: string }> {
    const directory = await mkdtemp(path.join(tmpdir(), 'trivia-content-store-'));
    directories.push(directory);
    const live = path.join(directory, 'live.json');
    const bundled = path.join(directory, 'bundled.json');
    await writeFile(bundled, json, 'utf8');
    const store = new TriviaContentStore(live, bundled);
    await store.load();
    return { store, live };
  }

  it('rejects question ID renames and swaps without changing memory, ETag, or disk', async () => {
    const { store, live } = await loadedStore();
    const originalEtag = store.etag;
    const originalFile = await readFile(live, 'utf8');
    const renamed = structuredClone(raw);
    renamed.questions[0]!.id = 'general-renamed';
    const swapped = structuredClone(raw);
    [swapped.questions[0]!.id, swapped.questions[1]!.id] = [
      swapped.questions[1]!.id,
      swapped.questions[0]!.id,
    ];

    for (const attack of [renamed, swapped]) {
      await expect(store.replace(parseTriviaQuestionBankJson(JSON.stringify(attack)), originalEtag))
        .rejects.toMatchObject({ code: 'IMMUTABLE_TRIVIA_PROVENANCE' });
      expect(store.etag).toBe(originalEtag);
      expect(store.bank.questions[0]!.id).toBe(raw.questions[0]!.id);
      expect(await readFile(live, 'utf8')).toBe(originalFile);
    }
  });

  it('rejects provenance relabeling and accepts reviewed fact edits', async () => {
    const { store, live } = await loadedStore();
    const originalEtag = store.etag;
    const originalFile = await readFile(live, 'utf8');
    const relabeled = structuredClone(raw);
    relabeled.questions[0]!.review.provenance = 'human-authored';
    await expect(store.replace(parseTriviaQuestionBankJson(JSON.stringify(relabeled)), originalEtag))
      .rejects.toMatchObject({ code: 'IMMUTABLE_TRIVIA_PROVENANCE' });
    expect(store.etag).toBe(originalEtag);
    expect(await readFile(live, 'utf8')).toBe(originalFile);

    const edited = structuredClone(raw);
    const revisedPrompt = `${edited.questions[0]!.locales['en-US']!.prompt} Choose the best answer.`;
    edited.questions[0]!.locales['en-US']!.prompt = revisedPrompt;
    edited.questions[0]!.review.reviewedBy = 'Integration Reviewer';
    edited.questions[0]!.review.reviewedAt = '2026-08-30';
    edited.questions[0]!.source.accessed = '2026-08-30';
    const saved = await store.replace(parseTriviaQuestionBankJson(JSON.stringify(edited)), originalEtag);
    expect(saved.questions[0]!.locales['en-US'].prompt).toBe(revisedPrompt);
    expect(saved.questions[0]!.review).toMatchObject({
      reviewedBy: 'Integration Reviewer',
      reviewedAt: '2026-08-30',
      provenance: raw.questions[0]!.review.provenance,
    });
    expect(store.etag).not.toBe(originalEtag);
    expect(await readFile(live, 'utf8')).toContain('Choose the best answer.');
  });
});
