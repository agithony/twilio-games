// ONE source of truth for the "how to play" legend, shown on the lobby screen before a race. This
// game is played BY VOICE over a phone call (Twilio Conversation Relay), so the legend teaches the
// SPOKEN commands — no keyboard keys are shown anywhere (the shared screen isn't how you drive).
//
// Not player-specific (it's just "here's what to shout"), so it's safe on a shared screen with many
// players — unlike the live personal gauge, which we gate to a single local player.

interface Row { say: string; action: string; hint?: string | string[]; accent?: 'power' }

const ROWS: Row[] = [
  { say: '“Left” · “Right”', action: 'Change lanes' },
  { say: '“Boost” / “Go”', action: 'Go faster', hint: 'keep saying it to build speed' },
  { say: '“Brake” / “Slow”', action: 'Slow down' },
  // NITRO's explanation is the longest — split it across lines so it never runs off one line.
  { say: '“Nitro”', action: 'NITRO DASH', accent: 'power',
    hint: ['SMASH through barriers!', 'One charge · Grab a glowing orb to refill'] },
];

/**
 * The controls legend as an HTML string (shown in the lobby, pre-race). Values are static.
 * `orbUrl` (a rendered boost-orb thumbnail) is shown on the NITRO row so players learn what the
 * orbs on the track look like — the same thing the in-race HUD gauge shows. '' → no image, just text.
 */
export function controlsLegendHtml(orbUrl = ''): string {
  const rows = ROWS.map(r => {
    const orb = r.accent === 'power' && orbUrl
      ? `<img class="cl-orb" src="${orbUrl}" alt="boost orb" />` : '';
    // Each hint line is its own block-level span so a multi-line hint stacks instead of running on.
    const hintLines = r.hint ? (Array.isArray(r.hint) ? r.hint : [r.hint]) : [];
    const hint = hintLines.map(h => `<span class="cl-hint">${h}</span>`).join('');
    return `
    <div class="cl-row${r.accent === 'power' ? ' cl-power' : ''}">
      <span class="cl-say">${r.say}</span>
      <span class="cl-action">${orb}${r.action}${hint}</span>
    </div>`;
  }).join('');
  return `
    <div class="controls-legend">
      <div class="cl-title">How to play</div>
      <div class="cl-sub">Just talk — shout your moves into the call</div>
      ${rows}
    </div>`;
}
