// ONE source of truth for the "how to play" legend, shown on the lobby screen before a race. This
// game is played BY VOICE over a phone call (Twilio Conversation Relay), so the legend teaches the
// SPOKEN commands — no keyboard keys are shown anywhere (the shared screen isn't how you drive).
//
// Not player-specific (it's just "here's what to shout"), so it's safe on a shared screen with many
// players — unlike the live personal gauge, which we gate to a single local player.
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import { RACER_MESSAGES, type RacerMessageKey } from '../shared/i18n/racer';
import { createTranslator } from '../shared/i18n/translate';

interface Row { say: RacerMessageKey; action: RacerMessageKey; hint?: RacerMessageKey[]; accent?: 'power' }

const ROWS: Row[] = [
  { say: 'controls.lanes.say', action: 'controls.lanes.action' },
  { say: 'controls.boost.say', action: 'controls.boost.action', hint: ['controls.boost.hint'] },
  { say: 'controls.brake.say', action: 'controls.brake.action' },
  // NITRO's explanation is the longest — split it across lines so it never runs off one line.
  { say: 'controls.nitro.say', action: 'controls.nitro.action', accent: 'power',
    hint: ['controls.nitro.hintSmash', 'controls.nitro.hintRefill'] },
];

/**
 * The controls legend as an HTML string (shown in the lobby, pre-race). Values are static.
 * `orbUrl` (a rendered boost-orb thumbnail) is shown on the NITRO row so players learn what the
 * orbs on the track look like — the same thing the in-race HUD gauge shows. '' → no image, just text.
 */
export function controlsLegendHtml(orbUrl = '', locale: SupportedLocale = DEFAULT_LOCALE): string {
  const text = createTranslator(locale, RACER_MESSAGES);
  const rows = ROWS.map(r => {
    const orb = r.accent === 'power' && orbUrl
      ? `<img class="cl-orb" src="${orbUrl}" alt="${text('controls.orbAlt')}" />` : '';
    // Each hint line is its own block-level span so a multi-line hint stacks instead of running on.
    const hint = (r.hint ?? []).map(h => `<span class="cl-hint">${text(h)}</span>`).join('');
    return `
    <div class="cl-row${r.accent === 'power' ? ' cl-power' : ''}">
      <span class="cl-say">${text(r.say)}</span>
      <span class="cl-action">${orb}${text(r.action)}${hint}</span>
    </div>`;
  }).join('');
  return `
    <div class="controls-legend">
      <div class="cl-title">${text('controls.title')}</div>
      <div class="cl-sub">${text('controls.subtitle')}</div>
      ${rows}
    </div>`;
}
