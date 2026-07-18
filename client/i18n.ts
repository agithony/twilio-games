import {
  DEFAULT_LOCALE,
  LOCALE_PROFILES,
  SUPPORTED_LOCALES,
  resolveLocale,
  type SupportedLocale,
} from '../shared/i18n/locales';
import { COMMON_MESSAGES } from '../shared/i18n/common';
import { createTranslator } from '../shared/i18n/translate';

const STORAGE_KEY = 'twilio-games-locale';

export function getLocale(): SupportedLocale {
  const query = new URLSearchParams(location.search).get('locale');
  if (query) return resolveLocale(query);
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return resolveLocale(saved);
  } catch { /* storage can be unavailable in private browsing */ }
  for (const candidate of navigator.languages ?? [navigator.language]) {
    const resolved = resolveLocale(candidate, DEFAULT_LOCALE);
    if (candidate.toLowerCase().startsWith(resolved.split('-')[0]!.toLowerCase())) return resolved;
  }
  return DEFAULT_LOCALE;
}

export const locale = getLocale();
export const commonText = createTranslator(locale, COMMON_MESSAGES);

export function applyDocumentLocale(): void {
  const profile = LOCALE_PROFILES[locale];
  document.documentElement.lang = locale;
  document.documentElement.dir = profile.direction;
  try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* best effort */ }
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!link.href.startsWith(location.origin)) continue;
    const url = new URL(link.href);
    url.searchParams.set('locale', locale);
    link.href = url.href;
  }
}

export function setLocale(next: SupportedLocale): void {
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* best effort */ }
  const url = new URL(location.href);
  url.searchParams.set('locale', next);
  location.href = url.href;
}

export function injectLanguagePicker(containerId?: string): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = `language-picker${containerId === 'header-controls' ? '' : ' language-picker-floating'}`;
  label.title = commonText('language.label');
  label.setAttribute('aria-label', commonText('language.label'));

  const globe = document.createElement('span');
  globe.className = 'language-picker-icon';
  globe.setAttribute('aria-hidden', 'true');
  globe.textContent = '文';

  const select = document.createElement('select');
  select.setAttribute('aria-label', commonText('language.label'));
  for (const id of SUPPORTED_LOCALES) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = locale === 'pt-BR' && id === 'en-US' ? 'Inglês' : LOCALE_PROFILES[id].label;
    option.selected = id === locale;
    select.append(option);
  }
  select.addEventListener('change', () => setLocale(resolveLocale(select.value)));
  for (const eventName of ['keydown', 'keyup', 'keypress'] as const) {
    label.addEventListener(eventName, event => event.stopPropagation());
  }
  label.append(globe, select);

  injectPickerStyle();
  const container = containerId ? document.getElementById(containerId) : null;
  if (container) container.append(label);
  else document.body.append(label);
  return label;
}

function injectPickerStyle(): void {
  if (document.getElementById('language-picker-style')) return;
  const style = document.createElement('style');
  style.id = 'language-picker-style';
  style.textContent = `
    .language-picker { display:inline-flex; align-items:center; gap:6px; width:176px; min-height:34px; padding:0 9px;
      border:1px solid var(--th-card-border, rgba(255,255,255,.14)); border-radius:8px;
      background:var(--th-raised, rgba(12,18,40,.82)); color:var(--th-text, #fff);
      font:600 13px 'Twilio Sans Text',ui-sans-serif,system-ui,sans-serif; }
    .language-picker select { width:136px; min-width:0; border:0; outline:0; background:transparent; color:inherit;
      font:inherit; cursor:pointer; }
    .language-picker select option { color:#121c2d; background:#fff; }
    .language-picker-icon { font-family:ui-sans-serif,system-ui,sans-serif; font-size:13px; }
    .language-picker-floating { position:fixed; right:16px; bottom:62px; z-index:120;
      border-radius:12px; min-height:36px; backdrop-filter:blur(10px); }
    @media (max-width:640px) { .language-picker { width:128px; } .language-picker select { width:94px; } }
  `;
  document.head.append(style);
}

applyDocumentLocale();
