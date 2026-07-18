import { commonText } from './i18n';

const STYLE_ID = 'magic-hat-style';

export function injectMagicHat(): void {
  if (document.querySelector('.magic-hat')) return;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style'); style.id = STYLE_ID; style.textContent = CSS;
    document.head.appendChild(style);
  }
  const badge = document.createElement('aside');
  badge.className = 'magic-hat'; badge.tabIndex = 0; badge.setAttribute('aria-label', commonText('attribution.builtBy'));
  badge.innerHTML = `
    <svg class="magic-hat-svg" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <ellipse cx="32" cy="54" rx="28" ry="5" fill="#0A0A0A"/>
      <ellipse cx="32" cy="52" rx="26" ry="3.5" fill="#1C1C1C"/>
      <path d="M14 52 L14 20 Q14 14 20 14 L44 14 Q50 14 50 20 L50 52 Z" fill="#0A0A0A"/>
      <path d="M14 52 L14 20 Q14 14 20 14 L44 14 Q50 14 50 20 L50 52 Z" fill="url(#magicHatShine)" opacity=".35"/>
      <rect x="14" y="44" width="36" height="6" fill="#EF223A"/>
      <rect x="14" y="44" width="36" height="1.5" fill="#A81025"/>
      <path d="M18 18 L18 46" stroke="#2A2A2A" stroke-width="1.5" stroke-linecap="round" opacity=".7"/>
      <defs><linearGradient id="magicHatShine" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF" stop-opacity=".3"/><stop offset="1" stop-color="#FFF" stop-opacity="0"/></linearGradient></defs>
    </svg>
    <span class="magic-hat-sparkle mh1" aria-hidden="true">&#10023;</span>
    <span class="magic-hat-sparkle mh2" aria-hidden="true">&#10022;</span>
    <span class="magic-hat-sparkle mh3" aria-hidden="true">&#10023;</span>
    <div class="magic-hat-bubble">
      <strong>${commonText('attribution.builtBy')}</strong>
      <a href="https://twil.io/magic" target="_blank" rel="noopener noreferrer">${commonText('attribution.visit')}</a>
      <div class="magic-hat-slack">${commonText('attribution.slack')}</div>
    </div>`;
  document.body.appendChild(badge);
}

const CSS = `
@keyframes magic-hat-wobble{0%,100%{transform:rotate(-4deg) scale(1.08)}50%{transform:rotate(4deg) scale(1.08)}}
@keyframes magic-hat-sparkle-rise{0%{opacity:0;transform:translate(0,0) scale(.4)}30%{opacity:1}100%{opacity:0;transform:translate(var(--hx,0),-34px) scale(1.1)}}
.magic-hat{position:fixed;bottom:max(16px,env(safe-area-inset-bottom));left:max(16px,env(safe-area-inset-left));width:72px;height:72px;z-index:60;cursor:pointer;outline:none}
.magic-hat-svg{width:56px;height:56px;filter:drop-shadow(0 4px 8px rgba(0,0,0,.4)) drop-shadow(0 0 8px rgba(239,34,58,.6)) drop-shadow(0 0 22px rgba(239,34,58,.4));transform-origin:50% 90%;transition:transform .4s cubic-bezier(.2,.9,.3,1.2),filter .4s ease}
.magic-hat:hover .magic-hat-svg,.magic-hat:focus .magic-hat-svg,.magic-hat:focus-within .magic-hat-svg{animation:magic-hat-wobble .6s ease-in-out;filter:drop-shadow(0 4px 8px rgba(0,0,0,.4)) drop-shadow(0 0 10px rgba(239,34,58,.85)) drop-shadow(0 0 28px rgba(239,34,58,.65))}
.magic-hat-sparkle{position:absolute;color:#E9C46A;font-size:12px;pointer-events:none;opacity:0;top:6px;text-shadow:0 0 8px rgba(233,196,106,.9)}
.magic-hat:hover .magic-hat-sparkle,.magic-hat:focus .magic-hat-sparkle,.magic-hat:focus-within .magic-hat-sparkle{animation:magic-hat-sparkle-rise .9s ease-out forwards}
.magic-hat-sparkle.mh1{left:14px;--hx:-10px;animation-delay:.05s}.magic-hat-sparkle.mh2{left:26px;--hx:0;animation-delay:.15s}.magic-hat-sparkle.mh3{left:38px;--hx:12px;animation-delay:.25s}
.magic-hat-bubble{position:absolute;bottom:6px;left:64px;min-width:230px;padding:12px 16px;background:#fff;border:1px solid rgba(107,63,160,.35);border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.18),0 0 20px rgba(107,63,160,.12);opacity:0;transform:translateX(-10px) scale(.9);transform-origin:left bottom;transition:opacity .3s ease .05s,transform .35s cubic-bezier(.2,.9,.3,1.2) .05s;pointer-events:none;white-space:nowrap;font-family:'Twilio Sans Text',system-ui,sans-serif;text-align:left}
.magic-hat-bubble::before{content:"";position:absolute;left:-7px;bottom:18px;width:13px;height:13px;background:#fff;border-left:1px solid rgba(107,63,160,.35);border-bottom:1px solid rgba(107,63,160,.35);transform:rotate(45deg)}
.magic-hat-bubble strong{display:block;margin-bottom:4px;color:#171717;font-size:13px}.magic-hat-bubble a{display:block;margin-top:2px;color:#2188EF;font-size:12px;text-decoration:none}.magic-hat-bubble a:hover,.magic-hat-bubble a:focus{text-decoration:underline}.magic-hat-slack{margin-top:4px;color:#737373;font-size:12px}
.magic-hat:hover .magic-hat-bubble,.magic-hat:focus .magic-hat-bubble,.magic-hat:focus-within .magic-hat-bubble{opacity:1;transform:translateX(0) scale(1);pointer-events:auto}
@media(max-width:640px){.magic-hat{width:60px;height:60px}.magic-hat-svg{width:46px;height:46px}.magic-hat-bubble{left:52px;min-width:210px}}
@media(prefers-reduced-motion:reduce){.magic-hat-svg,.magic-hat-bubble,.magic-hat-sparkle{animation:none!important;transition:none!important}}
`;
