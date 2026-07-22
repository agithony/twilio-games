import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../client/arcade/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../client/arcade/arcade.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../client/arcade/arcade.css', import.meta.url), 'utf8');
const home = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const join = readFileSync(new URL('../client/join/index.html', import.meta.url), 'utf8');
const joinScript = readFileSync(new URL('../client/join/join.ts', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../client/vite.config.ts', import.meta.url), 'utf8');
const racerMain = readFileSync(new URL('../client/main.ts', import.meta.url), 'utf8');
const racerScreens = readFileSync(new URL('../client/screens.ts', import.meta.url), 'utf8');
const homeScript = readFileSync(new URL('../client/home.ts', import.meta.url), 'utf8');
const stationClient = readFileSync(new URL('../client/station-client.ts', import.meta.url), 'utf8');
const stationDisplay = readFileSync(new URL('../client/station-display.ts', import.meta.url), 'utf8');
const monsters = readFileSync(new URL('../client/battle/monsters.ts', import.meta.url), 'utf8');
const fighter = readFileSync(new URL('../client/fighter/fighter.ts', import.meta.url), 'utf8');
const musicToggle = readFileSync(new URL('../client/music-toggle.ts', import.meta.url), 'utf8');
const iconControls = readFileSync(new URL('../client/icon-controls.ts', import.meta.url), 'utf8');
const stationGameSelect = /<select id="station-game">[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';

describe('Arcade browser UI', () => {
  it('preserves the player fallback and makes live station controls primary for operators', () => {
    expect(home).not.toContain('href="/arcade/"');
    expect(joinScript).toContain("'Continue in browser'");
    expect(join).not.toContain('fallback form');
    expect(join).not.toContain('<details');
    expect(joinScript).toContain('requestedStation ?? arcade.arcade.cabinetId');
    for (const id of [
      'registration-form', 'wallet-panel', 'challenge-panel', 'join-form',
      'queue-actions', 'station-panel', 'station-phase', 'station-revision',
      'station-deadline', 'station-round', 'station-match', 'station-ready',
      'station-reason', 'mode-form',
      'admin-voice-en-us', 'admin-voice-pt-br', 'voice-number-status',
      'admin-challenge-panel', 'admin-challenges', 'admin-challenge-form',
      'post-game-status',
    ]) expect(html).toContain(`id="${id}"`);
    expect(html.indexOf('id="station-panel"')).toBeLessThan(html.indexOf('class="panel settings-panel"'));
    expect(html).not.toContain('diagnostics-panel');
    expect(html).not.toContain('seed-challenge');
    expect(script).not.toContain('seedChallenge');
    expect(html).not.toContain('Advanced diagnostics');
    for (const endpoint of [
      '/api/arcade/session', '/api/arcade/register', '/api/arcade/wallet',
      '/api/arcade/challenges', '/api/arcade/station/coin', '/api/admin/arcade/station',
    ]) expect(script).toContain(endpoint);
  });

  it('restores a clean video-card launcher when station mode is off', () => {
    expect(home).toContain('id="standaloneView"');
    expect(homeScript).toContain("show('standalone')");
    expect(homeScript).toContain("if(standaloneMode){show('standalone');renderStandaloneLauncher();}");
    for (const video of ['vr-demo.mp4','vm-demo.mp4','vf-demo.mp4']) expect(homeScript).toContain(video);
    expect(homeScript).not.toContain('Arcade station mode is off');
    expect(homeScript).not.toContain('Joining unavailable');
    const standaloneRenderer=/function renderStandaloneLauncher\(\)[\s\S]*?\n}\n/.exec(homeScript)?.[0]??'';
    expect(standaloneRenderer).not.toMatch(/playNow|keepPriority|currentReadyCount/);
  });

  it('offers every phase-sensitive station transition with playable games only', () => {
    for (const id of [
      'close-recruiting', 'select-station-game', 'request-launch',
      'fail-launch', 'emergency-complete', 'advance-results', 'open-station-reset',
    ]) expect(html).toContain(`id="${id}"`);
    for (const route of [
      '/api/admin/arcade/station/recruiting/close',
      '/api/admin/arcade/station/game/select',
      '/api/admin/arcade/station/launch/request',
      '/api/admin/arcade/station/launch/fail',
      '/api/admin/arcade/station/match/complete',
      '/api/admin/arcade/station/results/advance',
      '/api/admin/arcade/station/reset',
    ]) expect(script).toContain(route);
    expect(stationGameSelect).toContain('value="racer"');
    expect(stationGameSelect).toContain('value="monsters"');
    expect(stationGameSelect).toContain('value="fighter"');
    expect(stationGameSelect).not.toContain('value="trivia"');
    expect(script).toContain("show('recruiting-control',phase==='RECRUITING')");
    expect(script).toContain("show('selection-control',phase==='GAME_SELECTION')");
    expect(script).toContain("show('playing-control',phase==='PLAYING')");
    expect(script).toContain("show('results-control',phase==='RESULTS')");
  });

  it('keeps emergency reset in the operator danger zone behind typed confirmation and a reason', () => {
    for (const id of [
      'reset-control', 'station-reset-dialog', 'station-reset-form', 'station-reset-reason',
      'station-reset-confirmation', 'confirm-station-reset',
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('Type <code>RESET EVENT</code> to confirm');
    expect(html).toMatch(/id="station-reset-reason"[^>]*required[^>]*maxlength="200"/);
    expect(html.indexOf('id="operations"')).toBeLessThan(html.indexOf('id="reset-control"'));
    expect(script).toContain("const STATION_RESET_CONFIRMATION='RESET EVENT'");
    expect(script).toContain("show('reset-control',actionable)");
    expect(script).toContain("state.operatorStation?.station.phase==='ATTRACT'");
    expect(script).toContain("stationAction('reset')");
    expect(css).toContain('.reset-danger-zone{');
    expect(css).toContain('.reset-dialog::backdrop{');
  });

  it('uses reasons, station ETags, idempotency, and conflict refresh for transitions', () => {
    expect(script).toContain("response.headers.get('ETag')");
    expect(script).toContain('reasonInput.value.trim()');
    expect(script).toContain("'If-Match':state.operatorStationEtag");
    expect(script).toContain("'Idempotency-Key':crypto.randomUUID()");
    expect(script).toContain('error.status===412');
    expect(script).toContain('await refreshOperatorStation()');
    expect(script).toContain('The event changed before this action finished.');
    expect(script).toContain("const body=action==='select'?{game,reason}:{reason}");
    expect(script).not.toContain('authorization:');
    expect(html).not.toMatch(/name="(?:stationId|roundId|matchId|readyEntryId|authorization)"/);
  });

  it('refreshes the station over SSE with a polling fallback', () => {
    expect(script).toContain("new EventSource('/api/arcade/events')");
    expect(script).toContain("addEventListener('arcade_station_updated'");
    expect(script).toContain('startOperatorPolling()');
    expect(script).toContain('setInterval(');
    expect(script).toContain(',5000)');
    expect(script).toContain('refreshOperatorStation(),refreshOperatorConfiguration()');
    expect(script).toContain("error instanceof ApiError&&error.status===412");
  });

  it('keeps local browser traffic same-origin through Vite', () => {
    expect(vite).toContain("'/api':");
    expect(vite).toContain("'/auth':");
    expect(vite).toContain("arcade: resolve(__dirname, 'arcade/index.html')");
    expect(vite).toContain("url === '/arcade'");
    expect(vite).toContain("url === '/operator'");
    expect(vite).toContain("url === '/player'");
  });

  it('uses Twilio typography, theme tokens, and a persistent theme toggle', () => {
    expect(css).toContain("font-family:'Twilio Sans Display'");
    expect(css).toContain('--th-bg:#000D25');
    expect(css).toContain('--red:#EF223A');
    expect(html).toContain("localStorage.getItem('twilio-theme')");
    expect(script).toContain("storageSet('twilio-theme'");
    expect(css).not.toMatch(/purple|amber|emerald|green|orange|yellow/i);
    expect(script).not.toContain('selectedOperatorEntries');
    expect(script).not.toContain('/api/admin/arcade/queue');
    expect(script).toContain("['localhost','127.0.0.1']");
  });

  it('uses compact icon-only header controls and exposes the operator from home', () => {
    expect(home).toContain('id="operatorLink"');
    expect(home).toContain('href="/operator"');
    expect(home).toMatch(/id="themeToggle"[^>]*>[\s\S]*?<svg/);
    expect(join).toMatch(/id="themeToggle"[^>]*>[\s\S]*?<svg/);
    expect(html).toContain('class="button quiet icon-button"');
    expect(iconControls).toContain('updateThemeToggleIcon');
    expect(musicToggle).not.toContain("className = 'music-toggle-label'");
    expect(musicToggle).toContain("btn.setAttribute('aria-label', label)");
  });

  it('separates player/operator views and renders the persistent join QR', () => {
    expect(script).not.toContain("get('operator') === '1'");
    expect(script).toContain("location.pathname === '/operator'");
    expect(html).toContain('href="/operator"');
    expect(html).toContain('TWILIO GAMES');
    expect(html).not.toMatch(/TWILIO ARCADE|ARCADE COINS/);
    expect(joinScript).toContain('`/player?cabinet=');
    expect(script).toContain('effectivePublicVisitorBaseUrl(state.deployment?.publicBaseUrl)');
    expect(script).toContain("selectedMode!=='off'&&!Object.values(station.games).some");
    expect(script).toContain("state.config?.arcade.mode==='coin_only'");
    expect(html).toContain('id="player-qr"');
    expect(html).toContain('id="sms-status"');
    expect(html).toContain('id="whatsapp-status"');
    for (const value of ['per_player', 'free']) {
      expect(html).toContain(`option value="${value}"`);
    }
    expect(html).not.toContain('option value="per_match"');
    expect(html).not.toContain('option value="host_sponsors"');
    expect(html).toContain('id="admin-starting-coins"');
    expect(html).toMatch(/id="admin-starting-coins"[^>]*min="1"[^>]*max="100"/);
    expect(html).toContain('One coin per player');
    expect(script).toContain("const minimumBalance=chargePolicy==='free'?0:1");
    expect(script).toContain("chargePolicy==='free'?0:startingBalance");
    expect(script).toContain('renderRuntimeSummary');
    expect(script).toContain("voiceNumbers={'en-US':voiceEn||null,'pt-BR':voicePt||null}");
    expect(racerMain).toContain('stationJoinUrl(cfg.arcade.cabinetId, locale)');
    expect(racerScreens).toContain('screen.lobby.coinQrCaption');
  });

  it('manages configured challenges through the staff-only versioned config editor', () => {
    expect(html.indexOf('id="admin-console"')).toBeLessThan(html.indexOf('id="admin-challenge-panel"'));
    for (const id of [
      'add-admin-challenge', 'admin-challenge-id', 'admin-challenge-title', 'admin-challenge-url',
      'admin-challenge-reward', 'admin-challenge-claims', 'admin-challenge-enabled',
      'admin-challenge-order', 'admin-challenge-starts', 'admin-challenge-ends',
      'cancel-admin-challenge',
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/id="admin-challenge-url"[^>]*type="url"/);
    expect(script).toContain('renderAdminChallenges()');
    expect(script).toContain('(settings.earning as AdminConfig[\'earning\']).challenges=challenges');
    expect(script).toContain("method:'PATCH'");
    expect(script).toContain("'If-Match':`\"arcade-config-${version}\"`");
    expect(script).toContain('Challenge settings changed in another operator session.');
    expect(script).toContain("destination.protocol!=='https:'");
    expect(script).not.toMatch(/seedChallenge|voice-docs|Voice Docs/i);
    expect(css).toContain('.challenge-admin-panel{grid-column:1/-1}');
  });

  it('reports only the implemented post-game delivery capability', () => {
    expect(html).toContain('<b>Result messages</b>');
    expect(script).toContain("postGame.includeCoinBalance?' with coin balance':''");
    expect(html).not.toMatch(/includeScore|includeLeaderboard|includeRematchLink|includeAchievement|includeIntelligenceTip/);
  });

  it('separates onboarding from proactive messaging and exposes reasoned retries', () => {
    for (const id of [
      'messaging-effective', 'messaging-onboarding-sms', 'messaging-onboarding-whatsapp',
      'messaging-identities', 'messaging-capacity', 'messaging-drafts', 'messaging-cleanup',
      'messaging-outbound-sms', 'messaging-outbound-whatsapp', 'messaging-last-error',
      'messaging-counts', 'messaging-failure-list',
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('See which channels players can use and whether game updates are being delivered.');
    expect(script).toContain("api<AdminStatus>('/api/admin/arcade/status')");
    expect(script).toContain('messaging?.storage?.cleanupEligible');
    expect(script).toContain('failure.retryEligible');
    expect(script).toContain("requestOperatorReason('Try this message again'");
    expect(script).toContain('/api/admin/arcade/messaging/notifications/${encodeURIComponent(failure.notificationId)}/retry');
    expect(script).toContain("'Idempotency-Key':crypto.randomUUID()");
    expect(script).toContain('operatorMessagingPoll=window.setInterval');
    expect(css).toContain('.messaging-panel{grid-column:1/-1');
  });

  it('does not wire browser speech synthesis into the Voice Racer display', () => {
    expect(racerMain).toContain('new Announcer({ sink: null');
    expect(racerMain).not.toContain('browserSpeechSink');
  });

  it('keeps kiosk authorization out of navigation URLs and disables local station players', () => {
    expect(stationClient).toContain("sessionStorage.setItem(DISPLAY_TOKEN_STORAGE_KEY");
    expect(stationClient).toContain("fragment.delete('displayToken')");
    expect(stationClient).not.toContain("url.searchParams.get('displayToken')");
    expect(stationClient).not.toContain("url.searchParams.set('displayToken'");
    expect(stationDisplay).not.toContain("homeUrl.searchParams.set('displayToken'");
    expect(homeScript).not.toContain("url.searchParams.set('displayToken'");
    expect(racerMain).toContain('isDisplay && !stationDisplay.active');
    expect(monsters).toContain('!isDisplay || stationDisplay.active');
    expect(fighter).toContain('if (stationDisplay.active) return');
    expect(racerMain).toContain('watchVoiceNumber(locale');
    expect(monsters).toContain('watchVoiceNumber(locale');
    expect(fighter).toContain('watchVoiceNumber(locale');
    expect(racerMain).toContain('QRCode.toDataURL(`tel:${number}`');
    expect(monsters).toContain('QRCode.toDataURL(`tel:${number}`');
    expect(fighter).toContain('QRCode.toDataURL(`tel:${number}`');
    expect(racerScreens).toContain('/brand/join-qr.png?v=2');
    expect(monsters).toContain("phoneQr = '/brand/join-qr.png?v=2'");
    expect(fighter).toContain("phoneQr = '/brand/join-qr.png?v=2'");
  });

  it('localizes Portuguese browser registration and protects newer operator state', () => {
    expect(script).toContain("document.documentElement.lang='pt-BR'");
    expect(script).toContain('Tudo pronto');
    expect(script).toContain('state.operatorStation&&(!view||');
    expect(script).toContain("ATTRACT:'Waiting for players'");
  });

  it('keeps player copy simple and groups operator settings by task', () => {
    for (const phrase of ['HttpOnly', 'lead PII', 'Coin ledger', 'ready pool', "cabinet's"]) {
      expect(html).not.toContain(phrase);
    }
    expect(html).toContain("Tell us who's playing");
    expect(html).toContain('Join the next game');
    for (const heading of ['Event', 'Ways to join and play', 'Games', 'Timing']) {
      expect(html).toContain(`>${heading}<`);
    }
    expect(css).toContain('.settings-layout{display:grid;grid-template-columns:repeat(12');
    expect(css).toContain('.choice-card:has(input:checked)');
    expect(script).toContain("document.body.classList.add(operatorView?'operator-page':'player-page')");
  });
});
