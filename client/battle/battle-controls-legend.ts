// ONE source of truth for the "how to play" legend for Voice Monsters — the battler's analog of the
// racer's controls-legend.ts, so both games teach controls the same way. Played BY VOICE over a phone
// call (Twilio Conversation Relay), so it teaches the SPOKEN turn commands; the on-screen number keys
// are shown as a secondary hint for playing on the shared screen.
interface Row { say: string; action: string; hint?: string; accent?: 'power' }

const ROWS: Row[] = [
  { say: '“Fight” + a move', action: 'Attack', hint: 'say the move name, or 1-4' },
  { say: '“Guard”', action: 'Brace', hint: 'halve the next hit + heal a little' },
  { say: '“Item” / “Potion”', action: 'Heal', hint: 'restore health · 2 per battle' },
  { say: '“Taunt”', action: 'Rattle the foe', accent: 'power', hint: 'their next attack may miss' },
];

/** The battle controls legend as an HTML string (shown in the lobby / monster-select). Values static. */
export function battleControlsLegendHtml(): string {
  const rows = ROWS.map(r => {
    const hint = r.hint ? `<span class="cl-hint">${r.hint}</span>` : '';
    return `
    <div class="cl-row${r.accent === 'power' ? ' cl-power' : ''}">
      <span class="cl-say">${r.say}</span>
      <span class="cl-action">${r.action}${hint}</span>
    </div>`;
  }).join('');
  return `
    <div class="controls-legend">
      <div class="cl-title">How to battle</div>
      <div class="cl-sub">Turn-based — just talk</div>
      ${rows}
    </div>`;
}
