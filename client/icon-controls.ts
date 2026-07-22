const SUN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"></path></svg>`;
const MOON_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"></path></svg>`;

export const OPERATOR_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"></circle><path d="M3.5 19a5.5 5.5 0 0 1 11 0"></path><circle cx="18" cy="15" r="2.5"></circle><path d="M18 10.5v2M18 17.5v2M13.5 15h2M20.5 15h2M14.8 11.8l1.4 1.4M19.8 16.8l1.4 1.4M21.2 11.8l-1.4 1.4M16.2 16.8l-1.4 1.4"></path></svg>`;

export function updateThemeToggleIcon(
  button: HTMLElement,
  currentTheme: string,
  lightLabel: string,
  darkLabel: string,
): void {
  const switchesToLight = currentTheme === 'dark';
  const label = switchesToLight ? lightLabel : darkLabel;
  button.innerHTML = switchesToLight ? SUN_ICON : MOON_ICON;
  button.setAttribute('title', label);
  button.setAttribute('aria-label', label);
  button.removeAttribute('aria-pressed');
}
