// Thin OpenAI Chat Completions transport for the conversational AI host. Kept SDK-free (raw fetch)
// so the model is a pure env choice (OPENAI_MODEL) and upgrades need no dependency bump. The brain
// (system prompt, tools, action interpretation) lives in game-host.ts; this only moves bytes.
//
// Behind the LlmClient interface so game-host + tests use a fake, and so a missing key degrades
// gracefully to NullLlmClient (the scripted phrase-bank lines still play — the demo never breaks).

export interface LlmTurn { role: 'user' | 'assistant'; content: string }

/** A function the model may call to ACT on the game (pick a car, choose a map, start the race). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema for the args
}

/** One tool invocation the model requested. */
export interface ToolCall { name: string; args: Record<string, unknown> }

/** What the model returned: something to SAY + any actions to take. */
export interface LlmReply { say: string; toolCalls: ToolCall[] }

export interface LlmClient {
  /** One turn: system prompt + conversation history + available tools → reply. Never throws (returns
   *  a safe empty reply on failure) so a flaky API call can't break the call flow. */
  respond(system: string, history: LlmTurn[], tools: ToolSpec[]): Promise<LlmReply>;
  readonly enabled: boolean;   // false when no key → callers fall back to scripted lines
}

/** No-LLM stand-in: used when OPENAI_API_KEY is unset. respond() returns nothing to say + no actions,
 *  so callers know to fall back to the curated phrase banks. */
export class NullLlmClient implements LlmClient {
  readonly enabled = false;
  async respond(): Promise<LlmReply> { return { say: '', toolCalls: [] }; }
}

export interface OpenAiOpts {
  apiKey: string;
  model?: string;                  // default env OPENAI_MODEL or a sensible fallback
  baseUrl?: string;                // override for proxies / Azure OpenAI
  maxTokens?: number;
  timeoutMs?: number;              // hard cap so a slow API can't hang the call
  fetchImpl?: typeof fetch;        // injectable for tests
}

export class OpenAiClient implements LlmClient {
  readonly enabled = true;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: OpenAiOpts) {
    this.model = opts.model || 'gpt-4o-mini';
    this.baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.maxTokens = opts.maxTokens ?? 120;   // short spoken replies
    this.timeoutMs = opts.timeoutMs ?? 6000;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  async respond(system: string, history: LlmTurn[], tools: ToolSpec[]): Promise<LlmReply> {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'system', content: system }, ...history],
      ...(tools.length ? {
        tools: tools.map(t => ({ type: 'function', function: {
          name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: 'auto',
      } : {}),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.doFetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) { console.log(`[LLM] HTTP ${res.status}`); return { say: '', toolCalls: [] }; }
      const data = await res.json() as OpenAiResponse;
      return parseOpenAiReply(data);
    } catch (e) {
      console.log(`[LLM] error: ${(e as Error).message}`);
      return { say: '', toolCalls: [] };   // never throw into the call flow
    } finally {
      clearTimeout(timer);
    }
  }
}

interface OpenAiResponse {
  choices?: { message?: { content?: string | null;
    tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
}

/** Pull the spoken text + tool calls out of a Chat Completions response, tolerant of shape drift. */
export function parseOpenAiReply(data: OpenAiResponse): LlmReply {
  const msg = data.choices?.[0]?.message ?? {};
  const say = (msg.content ?? '').trim();
  const toolCalls: ToolCall[] = [];
  for (const tc of msg.tool_calls ?? []) {
    const name = tc.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
    toolCalls.push({ name, args });
  }
  return { say, toolCalls };
}
