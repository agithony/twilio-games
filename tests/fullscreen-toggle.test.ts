import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { wireFullscreenToggle } from '../client/fullscreen-toggle';

function createButton(): HTMLButtonElement {
  const attributes = new Map<string, string>();
  return Object.assign(new EventTarget(), {
    hidden: false,
    innerHTML: '',
    title: '',
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name) ?? null,
  }) as unknown as HTMLButtonElement;
}

function createDocument(fullscreenEnabled = true): Document {
  const stub = Object.assign(new EventTarget(), {
    fullscreenEnabled,
    fullscreenElement: null as Element | null,
    documentElement: {} as HTMLElement,
    exitFullscreen: vi.fn(async () => {
      stub.fullscreenElement = null;
      stub.dispatchEvent(new Event('fullscreenchange'));
    }),
  });
  stub.documentElement = {
    requestFullscreen: vi.fn(async () => {
      stub.fullscreenElement = stub.documentElement as Element;
      stub.dispatchEvent(new Event('fullscreenchange'));
    }),
  } as unknown as HTMLElement;
  return stub as unknown as Document;
}

afterEach(() => vi.unstubAllGlobals());

describe('fullscreen toggle', () => {
  it('enters and exits browser fullscreen while keeping its accessible state current', async () => {
    const documentStub = createDocument();
    const button = createButton();
    vi.stubGlobal('document', documentStub);

    wireFullscreenToggle(button, { enter: 'Enter fullscreen', exit: 'Exit fullscreen' });
    expect(button.title).toBe('Enter fullscreen');
    expect(button.getAttribute('aria-pressed')).toBe('false');

    button.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(documentStub.documentElement.requestFullscreen).toHaveBeenCalledOnce());
    expect(button.title).toBe('Exit fullscreen');
    expect(button.getAttribute('aria-pressed')).toBe('true');

    button.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(documentStub.exitFullscreen).toHaveBeenCalledOnce());
    expect(button.title).toBe('Enter fullscreen');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('hides the control when fullscreen is unavailable', () => {
    const button = createButton();
    vi.stubGlobal('document', createDocument(false));

    wireFullscreenToggle(button, { enter: 'Enter fullscreen', exit: 'Exit fullscreen' });

    expect(button.hidden).toBe(true);
  });

  it('places the control in the upper-right header icon group', () => {
    const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
    const controls = html.slice(html.indexOf('<div id="header-controls">'), html.indexOf('</header>'));
    expect(controls).toContain('id="fullscreenToggle"');
    expect(controls).toContain('class="header-icon-button"');
  });
});
