import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../client/arcade/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../client/arcade/arcade.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../client/arcade/arcade.css', import.meta.url), 'utf8');
const home = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const join = readFileSync(new URL('../client/join/index.html', import.meta.url), 'utf8');
const joinScript = readFileSync(new URL('../client/join/join.ts', import.meta.url), 'utf8');
const joinCss = readFileSync(new URL('../client/join/join.css', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../client/vite.config.ts', import.meta.url), 'utf8');
const racerMain = readFileSync(new URL('../client/main.ts', import.meta.url), 'utf8');
const racerScreens = readFileSync(new URL('../client/screens.ts', import.meta.url), 'utf8');
const homeScript = readFileSync(new URL('../client/home.ts', import.meta.url), 'utf8');
const homeCss = readFileSync(new URL('../client/home.css', import.meta.url), 'utf8');
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
    expect(homeScript).toContain("if(standaloneMode){renderStandaloneLauncher();show('standalone');}");
    for (const video of ['vr-demo.mp4','vm-demo.mp4','vf-demo.mp4']) expect(homeScript).toContain(video);
    expect(homeScript).not.toContain('Arcade station mode is off');
    expect(homeScript).not.toContain('Joining unavailable');
    const standaloneRenderer=/function renderStandaloneLauncher\(\)[\s\S]*?\n}\n/.exec(homeScript)?.[0]??'';
    expect(standaloneRenderer).not.toMatch(/playNow|keepPriority|currentReadyCount/);
  });

  it('renders selection as a stable video-backed vote display with automatic fallback copy', () => {
    expect(stationClient).toContain('choices: number');
    expect(homeScript).toContain("{ racer: 1, monsters: 2, fighter: 3 }");
    expect(homeScript).toContain('impact.choices');
    expect(homeScript).toContain('Ready players: text the number shown or game name.');
    expect(homeScript).not.toContain('Ready players: text 1, 2, 3');
    expect(homeScript).toContain('If time runs out or votes tie, the station chooses automatically.');
    expect(homeScript).toContain('Playing this round: {count}');
    expect(homeScript).toContain('Waiting for next game: {count}');
    expect(homeScript).not.toContain("'{count} keep priority'");
    expect(homeScript).toContain('No navegador, escolham na página do jogador.');
    for (const video of ['vr-demo.mp4','vm-demo.mp4','vf-demo.mp4']) expect(homeScript).toContain(video);
    expect(homeScript).toContain("document.createElement('article')");
    expect(homeScript).not.toContain("card.addEventListener('click'");
    expect(homeScript).toContain('if (lineup !== selectionLineup)');
    expect(homeScript).toContain('buildGameCard(impact)');
    expect(homeScript).toContain('gameCards.querySelector<HTMLElement>');
    const cardUpdater = /function renderGameCards\(station: PublicStation\)[\s\S]*?\n}/.exec(homeScript)?.[0] ?? '';
    expect(cardUpdater.match(/replaceChildren/g)).toHaveLength(1);
    expect(homeScript).toContain('data-src="${selectionVideos[impact.id]}"');
    expect(homeScript).toContain('preload="none"');
    expect(homeScript).toContain('game-media-fallback');
    expect(homeScript).toContain("addEventListener('error'");
    expect(homeCss).toContain('.game-command strong');
    expect(homeCss).toMatch(/@media \(max-width:600px\)[\s\S]*?\.game-card \{/);
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
    expect(script).toContain("show('recruiting-control',!paused&&phase==='RECRUITING')");
    expect(script).toContain("show('selection-control',!paused&&phase==='GAME_SELECTION')");
    expect(script).toContain("show('playing-control',!paused&&phase==='PLAYING')");
    expect(script).toContain("show('results-control',!paused&&phase==='RESULTS')");
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
    expect(script).toContain('if(stationActionSaving)return');
    expect(script).toContain('stationResetIdempotencyKey??=crypto.randomUUID()');
    expect(script).toContain('stationResetEtag??=state.operatorStationEtag');
    expect(script).toMatch(/function cancelStationReset\(\):void\{\s*if\(stationActionSaving\)return;/);
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
    expect(html).toMatch(/id="refresh"[^>]*icon-button[^>]*aria-label="Refresh page data"[^>]*>\s*<svg/);
    expect(html).toContain('id="admin-login-label"');
    expect(html).toContain('class="google-signin"');
    expect(html.indexOf('id="admin-locked"')).toBeLessThan(html.indexOf('id="admin-login"'));
    expect(script).toContain("el('admin-login-label').textContent");
    expect(css).toContain('.auth-gate{display:grid');
    expect(css).toContain('.google-signin{min-height:52px');
    expect(css).toContain('white-space:normal');
    expect(script).toContain("refresh.setAttribute('aria-label','Atualizar dados')");
    expect(script).not.toContain("el('refresh').textContent='Atualizar'");
    expect(css).toMatch(/@media\(max-width:560px\)[\s\S]*?\.top-actions\{width:100%;justify-content:flex-start}/);
    expect(css).toContain('.top-actions #view-link{flex:1 1 auto');
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
    expect(racerMain).toContain('stationDisplay.active || cfg.arcade?.mode === \'off\'');
    expect(racerScreens).toContain('screen.lobby.coinQrCaption');
  });

  it('uses a semantic operator information architecture with linked live summaries', () => {
    expect(html).toContain('<main id="operations"');
    const consoleMarkup = /<div id="admin-console"[\s\S]*?<\/main>/.exec(html)?.[0] ?? '';
    for (const [label, target] of [
      ['Overview', 'operator-overview'],
      ['Live event', 'live-event'],
      ['Messages', 'messages'],
      ['Setup', 'setup'],
    ]) expect(consoleMarkup).toMatch(new RegExp(`<button[^>]+role="tab"[^>]+aria-controls="${target}"[^>]*>${label}</button>`));
    expect(consoleMarkup).toContain('role="tablist"');
    expect(consoleMarkup.match(/role="tabpanel"/g)).toHaveLength(4);
    expect(consoleMarkup.match(/role="tab"/g)).toHaveLength(4);
    expect(consoleMarkup).toMatch(/id="operator-overview"[^>]*role="tabpanel"(?![^>]*hidden)/);
    for (const id of ['live-event','messages','setup']) expect(consoleMarkup).toMatch(new RegExp(`id="${id}"[^>]*role="tabpanel"[^>]*hidden`));
    const sectionPositions = ['operator-overview', 'live-event', 'messages', 'setup'].map(id => consoleMarkup.indexOf(`id="${id}"`));
    expect(sectionPositions).toEqual([...sectionPositions].sort((left, right) => left - right));
    for (const label of ['Event', 'Live game', 'Players', 'Messaging']) {
      expect(consoleMarkup).toContain(`<span>${label}</span>`);
    }
    expect(script).toContain('function renderOperatorOverview():void');
    expect(script).toContain("!station?'Waiting for players'");
    expect(script).toContain("entry.status!=='LEFT'");
    expect(script).toContain('messaging?.counts.FAILED??0');
    expect(script).toMatch(/function renderRuntimeSummary\([\s\S]*?renderOperatorOverview\(\);\s*}/);
    expect(script).toMatch(/function renderOperatorStation\([\s\S]*?renderOperatorOverview\(\);\s*}/);
    expect(script).toMatch(/function renderMessagingStatus\([\s\S]*?renderOperatorOverview\(\);/);
    expect(script).toContain('function initializeOperatorTabs():void');
    expect(script).toContain("event.key==='ArrowRight'");
    expect(script).toContain("event.key==='ArrowLeft'");
    expect(script).toContain("event.key==='Home'");
    expect(script).toContain("event.key==='End'");
    expect(script).toContain("window.addEventListener('popstate'");
    expect(script).toContain("window.addEventListener('hashchange'");
    expect(script).toContain("tab.setAttribute('aria-selected',String(active))");
    expect(script.indexOf('const OPERATOR_TABS')).toBeLessThan(script.indexOf('initializeOperatorTabs();'));
    expect(css).toContain('.operator-page .shell{width:min(1200px');
    expect(css).toContain('.operator-nav{position:sticky');
    expect(css).toContain('.operator-page .notice{position:static');
    expect(css).toContain('overflow-x:auto');
    expect(css).toContain('.operator-nav button[aria-selected="true"]');
    expect(css).toContain('.operator-section:focus-visible');
    expect(css).toContain('.overview-grid{display:grid;grid-template-columns:repeat(4');
    expect(css).toContain('@media(max-width:999px){.operator-page .overview-grid{grid-template-columns:repeat(2');
    expect(css).toContain('.operator-page .overview-grid{grid-template-columns:1fr}');
    const operatorReordering = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(match => match[1]?.includes('.operator-page') && /(?:^|;)\s*order\s*:/.test(match[2] ?? ''));
    expect(operatorReordering).toEqual([]);
  });

  it('keeps secondary operator tools collapsed and primary operations visible', () => {
    expect(html).toMatch(/<details class="operator-details station-activity-details">\s*<summary>Recent activity<\/summary>/);
    expect(html).toMatch(/<details class="operator-details messaging-details">\s*<summary>Delivery metrics<\/summary>/);
    expect(html).toMatch(/<details class="advanced-settings">\s*<summary>Timing<\/summary>/);
    expect(html).toMatch(/<details id="admin-challenge-panel"[^>]*setup-details/);
    expect(html).toMatch(/<details class="panel compact qr-operator-panel setup-details">/);
    expect(html).toMatch(/<details id="display-connect-panel"[^>]*setup-details/);
    for (const id of ['station-phase', 'station-controls', 'station-ready', 'messaging-failure-list']) {
      const beforeControl = html.slice(0, html.indexOf(`id="${id}"`));
      expect(beforeControl.lastIndexOf('<details')).toBeLessThanOrEqual(beforeControl.lastIndexOf('</details>'));
    }
    expect(html).toMatch(/id="settings-savebar" class="settings-savebar" hidden/);
    expect(script).toContain("el('settings-savebar').hidden=!dirty");
    expect(script).toContain("el('voice-number-fields').hidden=!voice");
    expect(script).toContain('refreshOperatorConfiguration(true)');
    expect(css).toContain('.settings-savebar{position:sticky');
    expect(css).toContain('.operator-page .settings-savebar{position:static');
    expect(css).toContain('.settings-layout{display:grid;grid-template-columns:repeat(2');
    expect(css).toContain('.operator-page .challenge-form{grid-template-columns:repeat(2');
  });

  it('presents future voice games as static setup concepts only', () => {
    const concepts = /<div class="coming-soon-concepts"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
    expect(concepts).toContain('<b>Voice Trivia</b>');
    expect(concepts).toContain('<b>Voice Karaoke</b>');
    expect(concepts.match(/Coming soon/g)).toHaveLength(2);
    expect(concepts).not.toMatch(/<(?:input|button|a|option)\b|\btabindex=|\bdata-game-choice=/);
    expect(stationGameSelect).not.toMatch(/Trivia|Karaoke/i);
    expect(script).not.toMatch(/['"](?:trivia|karaoke)['"]/i);
    expect(html).toContain('<h2>Manage the live event</h2>');
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
    expect(stationClient).toContain("fragment.has('displayToken')");
    expect(stationClient).toContain("fragment.delete('displayToken')");
    expect(stationClient).toContain("history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)");
    expect(stationClient).not.toContain("fragment.get('displayToken')");
    expect(stationClient).not.toContain("url.searchParams.get('displayToken')");
    expect(stationClient).not.toContain("url.searchParams.set('displayToken'");
    expect(stationDisplay).not.toContain("homeUrl.searchParams.set('displayToken'");
    expect(homeScript).not.toContain("url.searchParams.set('displayToken'");
    expect(fighter).not.toContain("params.get('hostToken')");
    expect(fighter).toContain("pageUrl.searchParams.delete('hostToken')");
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

  it('directs missing and rejected displays to the secure operator flow without a credential form', () => {
    for (const id of ['displaySetupPanel','displaySetupOperator']) expect(home).toContain(`id="${id}"`);
    expect(home).toContain('Only the booth display may launch shared games.');
    expect(home).toMatch(/id="displaySetupOperator" href="\/operator"/);
    expect(home).not.toContain('displayTokenInput');
    expect(home).not.toContain('type="password"');
    expect(home).not.toMatch(/<form id="displaySetupPanel"/);
    expect(homeScript).toContain("showDisplaySetup(displayTokenRejected ? 'invalid' : 'missing')");
    expect(homeScript).toContain('rejectDisplayToken(displayToken)');
    expect(homeScript).toContain('displayToken = null');
    expect(homeScript).toContain('!displayToken && displayTokenWasRejected()');
    expect(homeScript).not.toContain('configureDisplay');
    expect(homeScript).not.toContain('storeDisplayToken');
    expect(homeScript).toContain("current.phase === 'LOCKED'");
    expect(homeScript).not.toContain("lockedCountdown.textContent = current?.phase === 'RESULTS' ? String(current.nextReadyCount) : '10'");
    expect(homeCss).toContain('.display-setup-panel');
  });

  it('installs booth access from the authenticated operator console, signs out, and replaces the same tab', () => {
    expect(html).toContain('id="display-connect-panel"');
    expect(html).toContain('id="connect-booth-display"');
    expect(html).toContain('Connect this tab as booth display');
    expect(html).toContain('current tab into the booth display for this browser session');
    expect(html).toContain('signs you out of the operator console');
    const flow = /async function connectBoothDisplay\(\):Promise<void>\{[\s\S]*?\n}/.exec(script)?.[0] ?? '';
    expect(flow).toContain("'/api/admin/arcade/display/connect'");
    expect(flow).toContain("'Content-Type':'application/json'");
    expect(flow).toContain("body:'{}'");
    expect(flow).toContain("keys.length!==1||keys[0]!=='displayToken'");
    expect(flow).toContain('new TextEncoder().encode(token).byteLength<16');
    expect(flow).toContain('storeDisplayToken(token)');
    expect(flow).toContain("fetch('/auth/logout',{method:'POST',credentials:'include'})");
    expect(flow).toContain("location.replace('/')");
    expect(flow).toContain('rejectDisplayToken(installedToken)');
    expect(flow.indexOf('storeDisplayToken(token)')).toBeLessThan(flow.indexOf("fetch('/auth/logout'"));
    expect(flow.indexOf("fetch('/auth/logout'")).toBeLessThan(flow.indexOf("location.replace('/')"));
    expect(flow).not.toContain('searchParams');
    expect(flow).not.toContain('console.');
  });

  it('returns a launched display home after GET or readiness authorization is rejected', () => {
    expect(stationDisplay).toContain('rejectDisplayToken(displayToken)');
    expect(stationDisplay).toContain('cause instanceof StationRequestError && [401, 403].includes(cause.status)');
    expect(stationDisplay).toContain('if (authorizationRejected) return');
    expect(stationDisplay).toContain('authorizationRejected = true');
    expect(stationDisplay).toContain('unsubscribe()');
    expect(stationDisplay).toContain('clearInterval(polling)');
    expect(stationDisplay).toContain('location.replace(homeUrl.toString())');
    const readiness = /async function acknowledge\([\s\S]*?\n}/.exec(stationDisplay)?.[0] ?? '';
    expect(readiness).toContain('throw new StationRequestError(response.status)');
  });

  it('makes lead capture mode and collected fields explicit while keeping entry cost separate', () => {
    expect(html).toContain('Paused - lead capture off');
    expect(html).toContain('Open - lead capture off');
    expect(html).toContain('Open - lead capture on');
    expect(html).toContain('id="lead-capture-summary"');
    expect(html).toContain('>Entry cost<');
    expect(script).toContain('Browser entry collects first and last name, work email, company, phone number, country or region');
    expect(script).toContain('terms acknowledgement when required, and optional marketing consent');
    expect(script).toContain('Messaging entry uses the sender phone and asks for first and last name, work email, company, and country or region');
    expect(script).toContain('It asks for terms only when required and never asks for marketing consent');
    expect(html).toContain('<summary>Information collected</summary>');
    expect(script).toContain('termsAcknowledgementRequired');
    expect(script).toContain('Messaging entry collects first name only');
    expect(script).toContain('First name is collected for the game display. No lead form is created');
    expect(script).toContain('Pausing freezes the current event flow and stops its timers without removing players or coins');
    expect(script).toContain("output.textContent='Paused'");
    expect(script).toContain('The event is paused and this flow is frozen. Reset the event flow before reopening.');
    expect(script).toContain("state.adminConfig?.arcade.mode!=='off'&&entry.status==='ADMITTED'");
    expect(html).toContain('id="settings-open-blocker"');
    expect(html).toContain('Saving an Open status will ask you to reset that flow');
    expect(script).toContain("error.code==='ACTIVE_STATION_CONFIG_LOCKED'");
    expect(script).toContain("config.arcade.mode==='off'&&selectedMode!=='off'");
    expect(script).toContain('await queueOpenAfterReset(version,settings,selectedMode)');
    expect(script).toContain('await saveOpenAfterReset(openSettings)');
    expect(script).toContain("setNotice('Event flow reset and Open settings saved. The event is now open.'");
    expect(script).toContain('The live event is using these settings. Pause the event before changing them');
    expect(script).toContain('A paused event flow is still preserved. Reset it from Live event before changing these settings');
    expect(script).toContain('Settings were saved, but the console could not reload them.');
    expect(script).toContain("refreshAll(false)");
  });

  it('localizes Portuguese browser registration and protects newer operator state', () => {
    expect(script).toContain("document.documentElement.lang='pt-BR'");
    expect(script).toContain('Tudo pronto');
    expect(script).toContain('state.operatorStation&&(!view||');
    expect(script).toContain("ATTRACT:'Waiting for players'");
  });

  it('keeps the paused host instruction only in the localized player panel', () => {
    expect(script).toContain("renderPlayer();startPlayerUpdates();setNotice('')");
    expect(script).toContain("playerText('The event is not accepting players right now.','O evento não está aceitando jogadores agora.')");
    expect(html).toContain('Check back soon or ask the host when the next game begins.');
    expect(script).toContain("'Volte em breve ou pergunte ao anfitrião quando começa o próximo jogo.'");
    expect(script).not.toContain('Games are paused. Ask the host');
    expect(script).not.toContain('Os jogos estão pausados. Pergunte ao anfitrião');
    expect(css).toContain('.notice:empty{display:none}');
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
    expect(css).toContain('.settings-layout{display:grid;grid-template-columns:repeat(2');
    expect(css).toContain('.choice-card:has(input:checked)');
    expect(script).toContain("document.body.classList.add(operatorView?'operator-page':'player-page')");
    expect(joinScript).toContain("link.className = 'channel'");
    expect(joinScript).not.toContain('available.length === 0');
    expect(joinCss).not.toContain('.channel.primary');
    expect(joinCss).toContain('.channel:focus-visible');
  });
});
