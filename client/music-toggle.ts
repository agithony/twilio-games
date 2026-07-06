/**
 * Music Toggle UI: Creates and manages a mute/unmute button for all pages
 */

import { getMusicManager } from './music-manager';


const ICON_UNMUTED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
  <path d="M15.54 8.46a7 7 0 0 1 0 9.9M19.07 4.93a10 10 0 0 1 0 14.14"></path>
</svg>`;

const ICON_MUTED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
  <line x1="23" y1="9" x2="17" y2="15"></line>
  <line x1="17" y1="9" x2="23" y2="15"></line>
</svg>`;

export function createMusicToggle(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'music-toggle';
  btn.className = 'music-toggle';
  btn.title = 'Toggle music on/off';
  btn.setAttribute('aria-label', 'Toggle music');

  const icon = document.createElement('span');
  icon.className = 'music-toggle-icon';
  
  const label = document.createElement('span');
  label.className = 'music-toggle-label';

  btn.appendChild(icon);
  btn.appendChild(label);

  const updateButton = () => {
    const isMuted = getMusicManager().getIsMuted();
    icon.innerHTML = isMuted ? ICON_MUTED : ICON_UNMUTED;
    label.textContent = isMuted ? 'Music Off' : 'Music On';
    btn.setAttribute('aria-pressed', String(!isMuted));
  };

  btn.addEventListener('click', () => {
    getMusicManager().toggleMute();
    updateButton();
  });

  updateButton();
  return btn;
}

export function injectMusicToggle(containerId: string): void {
  const container = document.getElementById(containerId);
  if (container) {
    const toggle = createMusicToggle();
    container.appendChild(toggle);
  }
}
