import { createHash } from 'node:crypto';

const DUB_API_URL = 'https://api.dub.co/links';
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_KEY_ATTEMPTS = 8;

export interface DubLinkShortenerOptions {
  readonly apiKey?: string;
  readonly domain?: string;
  readonly folderId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly generateKey?: (attempt: number) => string;
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
    if (destination.protocol !== 'https:' || destination.pathname !== '/challenge/' || !destination.hash) return null;
    if (!keyInput.startsWith('challenge-')) return null;
    try {
      for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
        const suffix = options.generateKey?.(attempt) ?? createHash('sha256')
          .update(`${keyInput}\0${destination.toString()}\0${attempt}`)
          .digest('base64url')
          .slice(0, 8);
        if (!/^[A-Za-z0-9_-]{8}$/.test(suffix)) return null;
        const key = `challenge-${suffix}`;
        const response = await fetchImpl(DUB_API_URL, {
          method: 'POST',
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
        if (response.status === 409 || response.status === 422) {
          const lookup = new URL(`${DUB_API_URL}/info`);
          lookup.searchParams.set('domain', domain);
          lookup.searchParams.set('key', key);
          const existing = await fetchImpl(lookup, {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          });
          if (existing.ok) {
            const existingLink = await validatedShortLink(existing, destination, domain, key);
            if (existingLink) return existingLink;
          } else if (existing.status !== 404) return null;
          if (response.status === 422) return null;
          continue;
        }
        if (!response.ok) return null;
        return await validatedShortLink(response, destination, domain, key);
      }
      return null;
    } catch {
      return null;
    }
  };
}

async function validatedShortLink(response: Response, destination: URL, domain: string, key: string): Promise<string | null> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return null;
  const payload = JSON.parse(text) as Record<string, unknown>;
  if (payload.url !== destination.toString() || typeof payload.shortLink !== 'string') return null;
  const short = new URL(payload.shortLink);
  if (short.protocol !== 'https:' || short.hostname.toLowerCase() !== domain || short.pathname !== `/${key}`) return null;
  return short.toString();
}
