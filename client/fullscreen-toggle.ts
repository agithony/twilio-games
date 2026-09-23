const ENTER_FULLSCREEN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"></path></svg>`;
const EXIT_FULLSCREEN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"></path></svg>`;

export interface FullscreenToggleLabels {
  enter: string;
  exit: string;
}

function fullscreenOwnerDocument(): Document {
  try {
    if (typeof window !== 'undefined' && window.top && window.top !== window
      && window.top.location.origin === window.location.origin) return window.top.document;
  } catch {
    // Cross-origin parents cannot participate in this page's fullscreen state.
  }
  return document;
}

export function wireFullscreenToggle(
  button: HTMLButtonElement,
  labels: FullscreenToggleLabels,
  owner = fullscreenOwnerDocument(),
): () => void {
  const supported = owner.fullscreenEnabled !== false
    && typeof owner.documentElement.requestFullscreen === 'function'
    && typeof owner.exitFullscreen === 'function';
  button.hidden = !supported;
  if (!supported) return () => undefined;

  const render = (): void => {
    const active = owner.fullscreenElement !== null;
    const label = active ? labels.exit : labels.enter;
    button.innerHTML = active ? EXIT_FULLSCREEN_ICON : ENTER_FULLSCREEN_ICON;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(active));
  };

  let pending = false;
  const toggle = async (): Promise<void> => {
    if (pending) return;
    pending = true;
    try {
      if (owner.fullscreenElement) await owner.exitFullscreen();
      else await owner.documentElement.requestFullscreen();
    } finally {
      pending = false;
      render();
    }
  };
  const handleClick = (): void => { void toggle().catch(render); };

  button.addEventListener('click', handleClick);
  owner.addEventListener('fullscreenchange', render);
  owner.addEventListener('fullscreenerror', render);
  const lifecycleWindow = button.ownerDocument?.defaultView;
  const handlePageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) cleanup();
  };
  lifecycleWindow?.addEventListener('pagehide', handlePageHide);
  render();

  function cleanup(): void {
    button.removeEventListener('click', handleClick);
    owner.removeEventListener('fullscreenchange', render);
    owner.removeEventListener('fullscreenerror', render);
    lifecycleWindow?.removeEventListener('pagehide', handlePageHide);
  }
  return cleanup;
}

export function injectFullscreenToggle(
  containerId: string,
  labels: FullscreenToggleLabels,
  controlClass = '',
): HTMLButtonElement | null {
  const container = document.getElementById(containerId);
  if (!container) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `fullscreen-toggle${controlClass ? ` ${controlClass}` : ''}`;
  container.append(button);
  wireFullscreenToggle(button, labels);
  return button;
}
