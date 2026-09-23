const ENTER_FULLSCREEN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"></path></svg>`;
const EXIT_FULLSCREEN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"></path></svg>`;

export interface FullscreenToggleLabels {
  enter: string;
  exit: string;
}

export function wireFullscreenToggle(
  button: HTMLButtonElement,
  labels: FullscreenToggleLabels,
): () => void {
  const supported = document.fullscreenEnabled !== false
    && typeof document.documentElement.requestFullscreen === 'function'
    && typeof document.exitFullscreen === 'function';
  button.hidden = !supported;
  if (!supported) return () => undefined;

  const render = (): void => {
    const active = document.fullscreenElement !== null;
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
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } finally {
      pending = false;
      render();
    }
  };
  const handleClick = (): void => { void toggle().catch(render); };

  button.addEventListener('click', handleClick);
  document.addEventListener('fullscreenchange', render);
  document.addEventListener('fullscreenerror', render);
  render();

  return () => {
    button.removeEventListener('click', handleClick);
    document.removeEventListener('fullscreenchange', render);
    document.removeEventListener('fullscreenerror', render);
  };
}
