import { describe, expect, it, vi } from 'vitest';
import { createDubLinkShortener } from '../server/dub-link-shortener';

describe('Dub link shortener', () => {
  it('is disabled unless both a key and valid domain are configured', () => {
    expect(createDubLinkShortener({ apiKey: '', domain: 'go.example.com' })).toBeUndefined();
    expect(createDubLinkShortener({ apiKey: 'dub-key', domain: '' })).toBeUndefined();
    expect(createDubLinkShortener({ apiKey: 'dub-key', domain: 'not a host' })).toBeUndefined();
  });

  it('upserts a deterministic private link and validates the returned destination', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      return new Response(JSON.stringify({
        url: body.url,
        shortLink: `https://${body.domain}/${body.key}`,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const shorten = createDubLinkShortener({ apiKey: 'dub-key', domain: 'go.example.com', folderId: 'folder-1', fetchImpl })!;
    const destination = 'https://games.example.com/challenge/?locale=en-US#opaque-token';
    const first = await shorten(destination, 'challenge-provider-key');
    const second = await shorten(destination, 'challenge-provider-key');
    expect(first).toBe(second);
    expect(first).toMatch(/^https:\/\/go\.example\.com\/challenge-provider-key-[a-f0-9]{16}$/);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({ method: 'PUT', redirect: 'error' });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer dub-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      url: destination, domain: 'go.example.com', folderId: 'folder-1', doIndex: false, trackConversion: false,
    });
  });

  it('fails closed to the caller fallback for malformed Dub responses', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      url: 'https://games.example.com/challenge/#token',
      shortLink: 'https://attacker.example/bad',
    }), { status: 200 })) as typeof fetch;
    const shorten = createDubLinkShortener({ apiKey: 'dub-key', domain: 'go.example.com', fetchImpl })!;
    expect(await shorten('https://games.example.com/challenge/#token', 'challenge-key')).toBeNull();
  });
});
