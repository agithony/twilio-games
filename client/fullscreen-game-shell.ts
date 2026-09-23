export interface FullscreenGameShell {
  readonly active: boolean;
  launch(target: string): boolean;
}

interface FullscreenGameShellOptions {
  onOpen?(): void;
}

export function createFullscreenGameShell(options: FullscreenGameShellOptions = {}): FullscreenGameShell {
  let frame: HTMLIFrameElement | null = null;

  const handleLoad = (): void => {
    if (!frame) return;
    frame.contentWindow?.focus();
  };

  return {
    get active(): boolean { return frame !== null; },
    launch(target: string): boolean {
      if (!document.fullscreenElement) return false;
      const targetUrl = new URL(target, location.href);
      if (targetUrl.origin !== location.origin || ['/', '/index.html'].includes(targetUrl.pathname)) return false;

      if (frame) {
        frame.src = targetUrl.href;
        return true;
      }

      frame = document.createElement('iframe');
      frame.className = 'fullscreen-game-frame';
      frame.title = 'Twilio Games gameplay';
      frame.allow = 'autoplay; fullscreen';
      frame.addEventListener('load', handleLoad);
      frame.src = targetUrl.href;
      for (const child of document.body.children) {
        const launcherElement = child as HTMLElement;
        launcherElement.inert = true;
        launcherElement.setAttribute('aria-hidden', 'true');
      }
      document.body.classList.add('fullscreen-game-active');
      document.body.append(frame);
      options.onOpen?.();
      return true;
    },
  };
}
