import { createHash } from 'node:crypto';

const DUB_API_URL = 'https://api.dub.co/links/upsert';
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface DubLinkShortenerOptions {
  readonly apiKey?: string;
  readonly domain?: string;
  readonly folderId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createDubLinkShortener(options: DubLinkShortenerOptions): ((url: string, key: string) => Promise<string | null>) | undefined {
  const apiKey = options.apiKey?.trim() ?? '';
  const domain = options.domain?.trim().toLowerCase() ?? '';
  const folderId = options.folderId?.trim() ?? '';
  if (!apiKey || !domain || !/^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z]{2,63}$/.test(domain)) return undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_500;
  return async (urlInput, keyInput) => {
    let destination: URL;
    try { destination = new URL(urlInput); } catch { return null; }
    if (destination.protocol !== 'https:') return null;
    const key = `${keyInput.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80)}-${createHash('sha256').update(urlInput).digest('hex').slice(0, 16)}`;
    try {
      const response = await fetchImpl(DUB_API_URL, {
        method: 'PUT',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: destination.toString(), domain, key, doIndex: false, trackConversion: false,
          ...(folderId ? { folderId } : {}),
        }),
      });
      if (!response.ok) return null;
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return null;
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (payload.url !== destination.toString() || typeof payload.shortLink !== 'string') return null;
      const short = new URL(payload.shortLink);
      if (short.protocol !== 'https:' || short.hostname.toLowerCase() !== domain || short.pathname !== `/${key}`) return null;
      return short.toString();
    } catch {
      return null;
    }
  };
}
