import { updateThemeToggleIcon } from './icon-controls';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'twilio-theme';

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  meta?.setAttribute('content', theme === 'dark' ? '#000D25' : '#FFFFFF');
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* Storage may be unavailable. */ }
}

export function wireThemeToggle(
  button: HTMLElement,
  labels: { light: string; dark: string },
): () => void {
  const render = () => updateThemeToggleIcon(button, currentTheme(), labels.light, labels.dark);
  const toggle = () => { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); render(); };
  const sync = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || (event.newValue !== 'dark' && event.newValue !== 'light')) return;
    setTheme(event.newValue); render();
  };
  button.addEventListener('click', toggle);
  window.addEventListener('storage', sync);
  render();
  return () => { button.removeEventListener('click', toggle); window.removeEventListener('storage', sync); };
}
