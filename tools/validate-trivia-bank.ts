import { readFileSync } from 'node:fs';
import {
  parseTriviaQuestionBankJson,
  TRIVIA_CATEGORY_IDS,
  TRIVIA_QUESTIONS_PER_CATEGORY,
} from '../shared/trivia';

const source = new URL('../content/trivia/questions.json', import.meta.url);
const bank = parseTriviaQuestionBankJson(readFileSync(source, 'utf8'));

for (const category of TRIVIA_CATEGORY_IDS) {
  const count = bank.questions.filter(question => question.category === category).length;
  if (count !== TRIVIA_QUESTIONS_PER_CATEGORY) {
    throw new Error(`${category} has ${count} questions; expected ${TRIVIA_QUESTIONS_PER_CATEGORY}`);
  }
}

console.log(`Validated Voice Trivia production bank: ${bank.questions.length} questions across ${TRIVIA_CATEGORY_IDS.length} categories.`);
