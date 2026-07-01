// ONE source of truth for the "how to play" legend, shown on the lobby screen before a race. This
// game is played BY VOICE over a phone call (Twilio Conversation Relay), so the legend teaches the
// SPOKEN commands — no keyboard keys are shown anywhere (the shared screen isn't how you drive).
//
// Not player-specific (it's just "here's what to shout"), so it's safe on a shared screen with many
// players — unlike the live personal gauge, which we gate to a single local player.

interface Row { say: string; action: string; hint?: string; accent?: 'power' }

const ROWS: Row[] = [
  { say: '“Left” · “Right”', action: 'Change lane' },
  { say: '“Boost” / “Go”', action: 'Go faster', hint: 'keep saying it to build speed' },
  { say: '“Brake” / “Slow”', action: 'Slow down' },
  { say: '“Power”', action: 'NITRO DASH', accent: 'power',
    hint: 'SMASH through barriers, unstoppable! one charge — grab a glowing orb to refill' },
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
    return `
    <div class="cl-row${r.accent === 'power' ? ' cl-power' : ''}">
      <span class="cl-say">${r.say}</span>
      <span class="cl-action">${orb}${r.action}${r.hint ? `<span class="cl-hint">${r.hint}</span>` : ''}</span>
    </div>`;
  }).join('');
  return `
    <div class="controls-legend">
      <div class="cl-title">How to play</div>
      <div class="cl-sub">Just talk — shout your moves into the call</div>
      ${rows}
    </div>`;
}
