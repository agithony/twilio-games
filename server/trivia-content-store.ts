import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  parseTriviaQuestionBankJson,
  type TriviaQuestionBank,
} from '../shared/trivia';

export interface TriviaContentStatus {
  readonly state: 'unloaded' | 'ready' | 'error';
  readonly source: 'live' | 'seed' | null;
  readonly revision: string | null;
  readonly etag: string | null;
  readonly questionCount: number | null;
  readonly lastError: string | null;
}

export class TriviaContentStore {
  private bankValue: TriviaQuestionBank | null = null;
  private revisionValue: string | null = null;
  private etagValue: string | null = null;
  private sourceValue: 'live' | 'seed' | null = null;
  private lastError: string | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly livePath: string,
    private readonly bundledPath: string,
  ) {
    if (!livePath || !bundledPath) throw new TypeError('Trivia live and bundled content paths are required');
  }

  async load(): Promise<TriviaQuestionBank> {
    try {
      const bundled = parseTriviaQuestionBankJson(await readFile(this.bundledPath, 'utf8'));
      let bank: TriviaQuestionBank;
      let source: 'live' | 'seed';
      try {
        bank = parseTriviaQuestionBankJson(await readFile(this.livePath, 'utf8'));
        source = 'live';
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        bank = bundled;
        source = 'seed';
        if (path.resolve(this.livePath) !== path.resolve(this.bundledPath)) {
          await writeDurableAtomic(this.livePath, serializeBank(bank));
        }
      }
      this.apply(bank, source);
      return bank;
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  get bank(): TriviaQuestionBank {
    if (!this.bankValue) throw new Error('Trivia content has not loaded');
    return this.bankValue;
  }

  get revision(): string {
    if (!this.revisionValue) throw new Error('Trivia content has not loaded');
    return this.revisionValue;
  }

  get etag(): string {
    if (!this.etagValue) throw new Error('Trivia content has not loaded');
    return this.etagValue;
  }

  async replace(bank: TriviaQuestionBank, expectedEtag: string): Promise<TriviaQuestionBank> {
    let saved!: TriviaQuestionBank;
    const operation = this.writes.then(async () => {
      if (!this.bankValue || !this.etagValue) throw new Error('Trivia content has not loaded');
      if (expectedEtag !== this.etagValue) {
        throw Object.assign(new Error('Trivia question bank changed; reload before saving'), {
          code: 'PRECONDITION_FAILED',
          etag: this.etagValue,
        });
      }
      const parsed = parseTriviaQuestionBankJson(JSON.stringify(bank));
      assertImmutableQuestionIdentity(this.bankValue, parsed);
      await writeDurableAtomic(this.livePath, serializeBank(parsed));
      this.apply(parsed, 'live');
      saved = parsed;
    });
    this.writes = operation.then(() => undefined, () => undefined);
    await operation;
    return saved;
  }

  getStatus(): TriviaContentStatus {
    return Object.freeze({
      state: this.bankValue ? 'ready' : this.lastError ? 'error' : 'unloaded',
      source: this.sourceValue,
      revision: this.revisionValue,
      etag: this.etagValue,
      questionCount: this.bankValue?.questions.length ?? null,
      lastError: this.lastError,
    });
  }

  async flush(): Promise<void> {
    await this.writes;
  }

  private apply(bank: TriviaQuestionBank, source: 'live' | 'seed'): void {
    const digest = createHash('sha256').update(JSON.stringify(bank)).digest('hex');
    this.bankValue = bank;
    this.revisionValue = `sha256:${digest}`;
    this.etagValue = `"trivia-questions-${digest.slice(0, 24)}"`;
    this.sourceValue = source;
    this.lastError = null;
  }
}

function assertImmutableQuestionIdentity(current: TriviaQuestionBank, replacement: TriviaQuestionBank): void {
  const currentIds = current.questions.map(question => question.id);
  const replacementIds = replacement.questions.map(question => question.id);
  const currentIdSet = new Set(currentIds);
  if (replacementIds.some(id => !currentIdSet.has(id))
    || currentIds.some(id => !replacementIds.includes(id))
    || replacementIds.some((id, index) => id !== currentIds[index])) {
    throw immutableProvenanceError();
  }
  const provenanceById = new Map(current.questions.map(question => [question.id, question.review.provenance]));
  if (replacement.questions.some(question => (
    question.review.provenance !== provenanceById.get(question.id)
  ))) throw immutableProvenanceError();
}

function immutableProvenanceError(): Error & { code: string } {
  return Object.assign(new Error('Trivia question IDs and provenance cannot be changed'), {
    code: 'IMMUTABLE_TRIVIA_PROVENANCE',
  });
}

function serializeBank(bank: TriviaQuestionBank): string {
  return `${JSON.stringify(bank, null, 2)}\n`;
}

async function writeDurableAtomic(file: string, contents: string): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let renamed = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    renamed = true;
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code)) throw error;
  } finally {
    await handle?.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
