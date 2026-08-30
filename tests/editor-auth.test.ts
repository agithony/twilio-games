import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubBrowser(url: string): {
  values: Map<string, string>;
  replaceState: ReturnType<typeof vi.fn>;
} {
  const values = new Map<string, string>();
  const replaceState = vi.fn();
  vi.stubGlobal('location', { href: url });
  vi.stubGlobal('history', { state: { page: 'editor' }, replaceState });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  return { values, replaceState };
}

describe('editor credential capture', () => {
  it('prefers a fragment token, stores it, and scrubs query and fragment credentials', async () => {
    const browser = stubBrowser('https://games.example/editor?game=karaoke&token=query-secret#tool=timing&token=fragment-secret');

    const auth = await import('../client/editor/editor-auth');

    expect(browser.values.get('voiceRacer.editorToken')).toBe('fragment-secret');
    expect(browser.replaceState).toHaveBeenCalledWith(
      { page: 'editor' },
      '',
      '/editor?game=karaoke#tool=timing',
    );
    expect(auth.authHeaders({ Accept: 'application/json' })).toEqual({
      Accept: 'application/json',
      'x-editor-token': 'fragment-secret',
    });
  });

  it('scrubs a query token without accepting or storing it', async () => {
    const browser = stubBrowser('https://games.example/editor?game=racer&token=ignored-secret#preview');

    const auth = await import('../client/editor/editor-auth');

    expect(browser.values.has('voiceRacer.editorToken')).toBe(false);
    expect(browser.replaceState).toHaveBeenCalledWith(
      { page: 'editor' },
      '',
      '/editor?game=racer#preview',
    );
    expect(auth.authHeaders()).toEqual({});
  });

  it('keeps tokenless local development header-free and does not rewrite its URL', async () => {
    const browser = stubBrowser('http://localhost:5173/editor?game=trivia');

    const auth = await import('../client/editor/editor-auth');

    expect(browser.replaceState).not.toHaveBeenCalled();
    expect(auth.authHeaders({ Accept: 'application/json' })).toEqual({ Accept: 'application/json' });
  });

  it('has no editor help text or navigation that recommends or creates token query URLs', () => {
    const editorRoot = fileURLToPath(new URL('../client/editor/', import.meta.url));
    const files = (readdirSync(editorRoot, { recursive: true }) as string[])
      .filter(file => file.endsWith('.ts') || file.endsWith('.html'));
    for (const file of files) {
      const source = readFileSync(`${editorRoot}/${file}`, 'utf8');
      expect(source, file).not.toMatch(/\?token=|&token=|tokenQuery|tokenQ/);
      expect(source, file).not.toMatch(/searchParams\.get\(['"]token/);
    }
  });
});
