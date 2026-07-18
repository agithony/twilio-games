// ONE source of truth for the "how to play" legend for Voice Monsters — the battler's analog of the
// racer's controls-legend.ts, so both games teach controls the same way. Played BY VOICE over a phone
// call (Twilio Conversation Relay), so it teaches the SPOKEN turn commands; the on-screen number keys
// are shown as a secondary hint for playing on the shared screen.
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { MONSTERS_MESSAGES } from '../../shared/i18n/monsters';
import { createTranslator } from '../../shared/i18n/translate';

interface Row { say: string; action: string; hint?: string; accent?: 'power' }

/** The battle controls legend as an HTML string (shown in the lobby / monster-select). Values static. */
export function battleControlsLegendHtml(locale: SupportedLocale = DEFAULT_LOCALE): string {
  const text = createTranslator(locale, MONSTERS_MESSAGES);
  const rows: Row[] = [
    { say: text('legend.fightSay'), action: text('legend.fightAction'), hint: text('legend.fightHint') },
    { say: text('legend.guardSay'), action: text('legend.guardAction'), hint: text('legend.guardHint') },
    { say: text('legend.itemSay'), action: text('legend.itemAction'), hint: text('legend.itemHint') },
    { say: text('legend.tauntSay'), action: text('legend.tauntAction'), accent: 'power', hint: text('legend.tauntHint') },
  ];
  const html = rows.map(r => {
    const hint = r.hint ? `<span class="cl-hint">${r.hint}</span>` : '';
    return `
    <div class="cl-row${r.accent === 'power' ? ' cl-power' : ''}">
      <span class="cl-say">${r.say}</span>
      <span class="cl-action">${r.action}${hint}</span>
    </div>`;
  }).join('');
  return `
    <div class="controls-legend">
      <div class="cl-title">${text('legend.title')}</div>
      <div class="cl-sub">${text('legend.subtitle')}</div>
      ${html}
    </div>`;
}
