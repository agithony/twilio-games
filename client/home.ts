import QRCode from 'qrcode';
import { PLAYABLE_ARCADE_GAMES } from '../shared/arcade-games';
import { gameTitle } from '../shared/i18n/content';
import { getMusicManager } from './music-manager';
import { injectMusicToggle } from './music-toggle';
import { applyDocumentLocale, injectLanguagePicker, locale } from './i18n';
import { injectMagicHat } from './magic-hat';
import { OPERATOR_ICON, updateThemeToggleIcon } from './icon-controls';
import {
  captureDisplayToken,
  displayTokenWasRejected,
  effectivePublicVisitorBaseUrl,
  fetchPublicArcadeConfig,
  fetchPublicStation,
  rejectDisplayToken,
  stationJoinUrl,
  stationLaunchUrl,
  StationRequestError,
  subscribeToStation,
  type PublicStation,
} from './station-client';

const copy = locale === 'pt-BR' ? {
  pageTitle: 'Twilio Games', tagline: 'Uma tela. Seu telefone. Sua voz.',
  connecting: 'Conectando', recruiting: 'Recrutando agora', waiting: 'Aguardando a primeira moeda',
  ready: 'jogadores prontos', timer: 'Próximo jogo em {time}', reconnecting: 'Reconectando', live: 'Estação ao vivo',
  attractEyebrow: 'Twilio Games', phaseTitle: 'Sua voz é o controle.',
  phaseDescription: 'Escaneie, entre e responda MOEDA quando estiver pronto na tela.',
  joinEyebrow: 'Entre pelo seu telefone', joinTitle: 'Escaneie para jogar',
  joinStepOne: 'Escolha SMS ou WhatsApp', joinStepTwo: 'Conclua a apresentação rápida',
  joinStepThree: 'Responda MOEDA na tela', selectionEyebrow: 'Escolha dos jogadores',
  selectionTitle: 'Escolham o próximo jogo.',
  selectionDescription: 'Jogadores prontos: enviem por mensagem o número mostrado ou o nome do jogo. No navegador, escolham na página do jogador. Se o tempo acabar ou houver empate, a estação decide automaticamente.',
  countdownEyebrow: 'Jogadores confirmados', countdownDescription: 'Fique por perto. O jogo está carregando nesta tela.',
  freePlay: 'Jogo livre', chooseGame: 'Escolha um jogo.',
  standaloneEyebrow: 'Jogos de festa controlados por voz · com tecnologia Twilio',
  standaloneTitle: 'Jogue com sua <span>voz.</span>',
  standaloneDescription: 'Com tecnologia Twilio ConversationRelay. Sua voz é o controle.',
  comingSoon: 'Em breve',
  triviaTitle: 'Quiz por Voz', karaokeTitle: 'Karaokê por Voz',
  triviaPreview: 'Perguntas rápidas, respostas em voz alta e rodadas para todos.',
  karaokePreview: 'Escolha a música, pegue o microfone e cante pelo telefone.',
  nextGame: 'Próximo jogo', gameComplete: 'Partida concluída',
  playersNext: 'jogadores já estão prontos para a próxima partida',
  displaySetup: 'Conexão segura necessária', missingDisplayToken: 'Tela não conectada',
  invalidDisplayToken: 'Acesso da tela rejeitado', connectDisplay: 'Conecte pelo console do operador',
  missingDisplayExplanation: 'Somente a tela do estande pode iniciar jogos compartilhados. Um operador autenticado deve conectar este navegador para impedir que visitantes controlem os jogos.',
  invalidDisplayExplanation: 'O acesso desta tela foi rejeitado. Para proteger os jogos contra o controle de visitantes, um operador autenticado deve reconectar este navegador.',
  openOperator: 'Abrir console do operador',
  lightTheme: 'Tema claro', darkTheme: 'Tema escuro', operator: 'Console do operador', playerMax: 'máx. {count} jogadores',
  playNow: 'Jogando nesta rodada: {count}', keepPriority: 'Aguardando o próximo jogo: {count}',
  racerBlurb: 'Uma corrida por uma pista neon controlada por voz.',
  monstersBlurb: 'Comande os golpes em uma batalha tática de criaturas.',
  fighterBlurb: 'Transforme cada golpe gritado em um confronto na arena.',
  freeDescription: 'Escaneie, entre e responda PRONTO quando estiver pronto na tela.',
  freeStep: 'Responda PRONTO na tela',
  vote: 'voto', votes: 'votos', leader: 'Na liderança', tiedLeader: 'Líder empatado', textCommand: 'Envie',
} : {
  pageTitle: 'Twilio Games', tagline: 'One screen. Your phone. Your voice.',
  connecting: 'Connecting', recruiting: 'Now recruiting', waiting: 'Waiting for first coin',
  ready: 'players ready', timer: 'Next game in {time}', reconnecting: 'Reconnecting', live: 'Station live',
  attractEyebrow: 'Twilio Games', phaseTitle: 'Your voice is the controller.',
  phaseDescription: 'Scan, join, and reply COIN when you are ready at the screen.',
  joinEyebrow: 'Join from your phone', joinTitle: 'Scan to play',
  joinStepOne: 'Choose SMS or WhatsApp', joinStepTwo: 'Complete the quick intro',
  joinStepThree: 'Reply COIN at the screen', selectionEyebrow: 'Player choice',
  selectionTitle: 'Choose the next game.',
  selectionDescription: 'Ready players: text the number shown or game name. In a browser, choose on your player page. If time runs out or votes tie, the station chooses automatically.',
  countdownEyebrow: 'Players locked', countdownDescription: 'Stay close. The game is loading on this screen.',
  freePlay: 'Free play', chooseGame: 'Choose a game.',
  standaloneEyebrow: 'Voice-controlled party games · powered by Twilio',
  standaloneTitle: 'Play with your <span>voice.</span>',
  standaloneDescription: 'Powered by Twilio Conversation Relay. Your voice is the controller.',
  comingSoon: 'Coming soon',
  triviaTitle: 'Voice Trivia', karaokeTitle: 'Voice Karaoke',
  triviaPreview: 'Quick questions, spoken answers, and rounds built for everyone.',
  karaokePreview: 'Pick a song, take the mic, and sing through your phone.',
  nextGame: 'Next game', gameComplete: 'Game complete',
  playersNext: 'players are already ready for the next game',
  displaySetup: 'Secure connection required', missingDisplayToken: 'Display not connected',
  invalidDisplayToken: 'Display access rejected', connectDisplay: 'Connect through the operator console',
  missingDisplayExplanation: 'Only the booth display may launch shared games. A signed-in operator must connect this browser to prevent visitors from controlling the games.',
  invalidDisplayExplanation: 'This display access was rejected. To protect games from visitor control, a signed-in operator must reconnect this browser.',
  openOperator: 'Open operator console',
  lightTheme: 'Light theme', darkTheme: 'Dark theme', operator: 'Operator console', playerMax: '{count} player max',
  playNow: 'Playing this round: {count}', keepPriority: 'Waiting for next game: {count}',
  racerBlurb: 'A voice powered race dodging obstacles.',
  monstersBlurb: 'Call the moves in a tactical creature battle.',
  fighterBlurb: 'Turn every shouted move into an arena showdown.',
  freeDescription: 'Scan, join, and reply READY when you are at the screen.',
  freeStep: 'Reply READY at the screen',
  vote: 'vote', votes: 'votes', leader: 'Leading', tiedLeader: 'Tied lead', textCommand: 'Text',
};

const format = (template: string, values: Readonly<Record<string, string | number>>): string => (
  Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), template)
);

const views = {
  standalone: document.getElementById('standaloneView')!,
  recruiting: document.getElementById('recruitingView')!,
  selection: document.getElementById('selectionView')!,
  countdown: document.getElementById('countdownView')!,
};
const readyCount = document.getElementById('readyCount')!;
const phaseTimer = document.getElementById('phaseTimer')!;
const readyRoster = document.getElementById('readyRoster')!;
const connection = document.getElementById('connectionState')!;
const selectionTimer = document.getElementById('selectionTimer')!;
const lockedCountdown = document.getElementById('lockedCountdown')!;
const lockedGame = document.getElementById('lockedGame')!;
const gameCards = document.getElementById('gameCards')!;
const phaseEyebrow = document.getElementById('phaseEyebrow')!;
const standaloneGames = document.getElementById('standaloneGames')!;
const selectionVideos = {
  racer: '/video/vr-demo.mp4', monsters: '/video/vm-demo.mp4', fighter: '/video/vf-demo.mp4',
} as const;
const gameCommands = { racer: 1, monsters: 2, fighter: 3 } as const;

interface PreviewConnection {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
  addEventListener?(type: 'change', listener: () => void): void;
}

const reducedMotionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const previewConnection = (navigator as Navigator & { connection?: PreviewConnection }).connection;
let activeView: HTMLElement = views.recruiting;

let stationId = new URLSearchParams(location.search).get('station') ?? 'ARCADE-01';
let current: PublicStation | null = null;
let refreshing = false;
let refreshPending = false;
let launched = '';
let displayToken = captureDisplayToken();
let displayTokenRejected = !displayToken && displayTokenWasRejected();
let standaloneMode = false;
let joinBaseUrl = location.origin;
let qrRailMode: 'auto' | 'always' | 'hidden' = 'auto';
let configuring = false;
let configurationPending = false;
let freePlay = false;
let enabledGames = new Set(['racer','monsters','fighter']);
let smsAvailable = false;
let whatsappAvailable = false;
let selectionLineup = '';

function renderGameCards(station: PublicStation): void {
  const available = station.games.filter(impact => enabledGames.has(impact.id));
  const lineup = available.map(impact => impact.id).join(',');
  if (lineup !== selectionLineup) {
    selectionLineup = lineup;
    gameCards.replaceChildren(...available.map(impact => buildGameCard(impact)));
  }
  const highestChoices = Math.max(0, ...available.map(impact => impact.choices));
  const leaders = highestChoices > 0 ? available.filter(impact => impact.choices === highestChoices) : [];
  for (const impact of available) {
    const card = gameCards.querySelector<HTMLElement>(`[data-game="${impact.id}"]`)!;
    const leading = leaders.includes(impact);
    card.classList.toggle('game-card-leading', leading);
    card.setAttribute('aria-label', `${gameCommands[impact.id]}, ${gameTitle(locale, impact.id)}, ${impact.choices} ${impact.choices === 1 ? copy.vote : copy.votes}`);
    card.querySelector<HTMLElement>('[data-role="vote-count"]')!.textContent = `${impact.choices} ${impact.choices === 1 ? copy.vote : copy.votes}`;
    const leader = card.querySelector<HTMLElement>('[data-role="leader"]')!;
    leader.hidden = !leading;
    leader.textContent = leaders.length > 1 ? copy.tiedLeader : copy.leader;
    card.querySelector<HTMLElement>('[data-role="play-now"]')!.textContent = format(copy.playNow, { count: impact.playNow });
    card.querySelector<HTMLElement>('[data-role="overflow"]')!.textContent = format(copy.keepPriority, { count: impact.overflow });
  }
}

function buildGameCard(impact: PublicStation['games'][number]): HTMLElement {
  const definition = PLAYABLE_ARCADE_GAMES.find(game => game.id === impact.id)!;
  const title = gameTitle(locale, impact.id);
  const card = document.createElement('article');
  card.className = 'game-card';
  card.dataset.game = impact.id;
  card.innerHTML = `<div class="game-card-media"><span class="game-media-fallback" role="img" aria-label="${gameCommands[impact.id]}, ${title}"><strong>${gameCommands[impact.id]}</strong><b>${title}</b></span><video data-src="${selectionVideos[impact.id]}" preload="none" loop muted playsinline aria-hidden="true"></video>
      <span class="game-command"><small>${copy.textCommand}</small><strong>${gameCommands[impact.id]}</strong></span></div>
    <div class="game-card-body"><div class="game-card-meta"><span data-role="vote-count"></span><b data-role="leader" hidden></b></div>
      <h2>${title}</h2>
      <span class="game-capacity">${format(copy.playerMax, { count: definition.humanCapacity })}</span>
      <div class="capacity"><b data-role="play-now"></b><b data-role="overflow"></b></div></div>`;
  const video = card.querySelector<HTMLVideoElement>('video')!;
  video.addEventListener('error', () => card.classList.add('game-card-video-unavailable'), { once: true });
  return card;
}

function renderStandaloneLauncher(): void {
  if (standaloneGames.childElementCount > 0) return;
  standaloneGames.append(...PLAYABLE_ARCADE_GAMES.map(game => {
    const link = document.createElement('a');
    const url = new URL(game.route, location.origin);
    url.searchParams.set('display', '1');url.searchParams.set('room', '4821');url.searchParams.set('locale', locale);
    link.href=url.toString();link.className='standalone-game';link.dataset.game=game.id;
    link.innerHTML=`<video data-src="${selectionVideos[game.id]}" preload="none" loop muted playsinline aria-hidden="true"></video><span>${gameTitle(locale,game.id)}</span><p>${game.id==='racer'?copy.racerBlurb:game.id==='monsters'?copy.monstersBlurb:copy.fighterBlurb}</p>`;
    return link;
  }));
}

function previewPlaybackAllowed(): boolean {
  return document.visibilityState !== 'hidden'
    && !reducedMotionPreference.matches
    && !previewConnection?.saveData
    && !['slow-2g', '2g'].includes(previewConnection?.effectiveType ?? '');
}

function syncPreviewPlayback(): void {
  const playbackAllowed = previewPlaybackAllowed();
  document.querySelectorAll<HTMLVideoElement>('.station-view video').forEach(video => {
    if (!playbackAllowed || !activeView.contains(video)) {
      video.pause();
      return;
    }
    const source=video.dataset.src;
    if(source&&!video.getAttribute('src'))video.src=source;
    if (video.paused) void video.play().catch(() => undefined);
  });
}

function show(view: keyof typeof views): void {
  for (const [name, element] of Object.entries(views)) element.toggleAttribute('hidden', name !== view);
  activeView = views[view];
  syncPreviewPlayback();
}

function render(station: PublicStation): void {
  current = station;
  clearDisplaySetup();
  connection.textContent = copy.live;
  connection.classList.add('live');
  readyCount.textContent = String(station.currentReadyCount);
  document.getElementById('readyLabel')!.textContent = copy.ready;
  readyRoster.replaceChildren(...station.roster.slice(0, 8).map(player => {
    const chip = document.createElement('span');
    chip.textContent = `${player.position}. ${player.displayName}`;
    return chip;
  }));
  phaseEyebrow.textContent = station.phase === 'ATTRACT' ? copy.attractEyebrow : copy.recruiting;
  const persistentJoin=document.getElementById('persistentJoin')!;
  persistentJoin.hidden=standaloneMode||qrRailMode==='hidden'||station.phase==='ATTRACT'||station.phase==='RECRUITING';

  if (standaloneMode) {
    renderStandaloneLauncher();
    show('standalone');
  } else if (station.phase === 'GAME_SELECTION') {
    selectionTimer.hidden = false;
    document.getElementById('selectionEyebrow')!.textContent = copy.selectionEyebrow;
    document.getElementById('selectionTitle')!.textContent = copy.selectionTitle;
    document.getElementById('selectionDescription')!.textContent = copy.selectionDescription;
    renderGameCards(station);
    show('selection');
  } else if (station.phase === 'LOCKED') {
    show('countdown');
    document.getElementById('countdownEyebrow')!.textContent = copy.countdownEyebrow;
    document.getElementById('countdownDescription')!.textContent = copy.countdownDescription;
    lockedGame.textContent = station.activeGame ? gameTitle(locale, station.activeGame) : copy.nextGame;
  } else if (station.phase === 'RESULTS') {
    show('countdown');
    lockedGame.textContent = copy.gameComplete;
    lockedCountdown.textContent = String(station.nextReadyCount);
    document.getElementById('countdownDescription')!.textContent = copy.playersNext;
  } else if (station.phase === 'LAUNCHING' || station.phase === 'PLAYING') {
    if (!displayToken || displayTokenRejected || !station.launch) {
      showDisplaySetup(displayTokenRejected ? 'invalid' : 'missing');
      return;
    }
    const target = stationLaunchUrl(station, stationId, locale, joinBaseUrl);
    if (target && target !== launched) { launched = target; location.replace(target); }
  } else {
    show('recruiting');
  }
  updateTimers();
}

function updateTimers(): void {
  if (!current) return;
  const seconds = current.deadline ? Math.ceil(Math.max(0, Date.parse(current.deadline) - Date.now()) / 1000) : null;
  const formatted = seconds === null ? '--:--' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  if (current.phase === 'RECRUITING' || current.phase === 'ATTRACT') {
    phaseTimer.textContent = seconds === null ? copy.waiting : copy.timer.replace('{time}', formatted);
  } else if (current.phase === 'GAME_SELECTION') {
    selectionTimer.textContent = formatted;
  } else if (current.phase === 'LOCKED') {
    lockedCountdown.textContent = seconds === null ? '--' : String(seconds);
  } else if (current.phase === 'RESULTS') {
    lockedCountdown.textContent = String(current.nextReadyCount);
  }
}

function clearDisplaySetup(): void {
  views.countdown.classList.remove('display-setup-view');
  document.getElementById('displaySetupPanel')!.hidden = true;
  lockedCountdown.hidden = false;
  document.getElementById('countdownDescription')!.hidden = false;
}

function showDisplaySetup(reason: 'missing' | 'invalid'): void {
  show('countdown');
  views.countdown.classList.add('display-setup-view');
  lockedCountdown.hidden = true;
  document.getElementById('countdownDescription')!.hidden = true;
  const panel = document.getElementById('displaySetupPanel')!;
  panel.hidden = false;
  document.getElementById('displaySetupEyebrow')!.textContent = copy.displaySetup;
  document.getElementById('displaySetupTitle')!.textContent = copy.connectDisplay;
  document.getElementById('displaySetupExplanation')!.textContent = reason === 'missing'
    ? copy.missingDisplayExplanation : copy.invalidDisplayExplanation;
  document.getElementById('displaySetupOperator')!.textContent = copy.openOperator;
  connection.textContent = reason === 'missing' ? copy.missingDisplayToken : copy.invalidDisplayToken;
}

async function refresh(): Promise<void> {
  if (refreshing) { refreshPending = true; return; }
  refreshing = true;
  try {
    if (standaloneMode) {
      renderStandaloneLauncher();
      show('standalone');
      return;
    }
    const result = await fetchPublicStation(displayToken);
    if (displayToken) displayTokenRejected = false;
    render(result.station);
  } catch (cause) {
    connection.textContent = copy.reconnecting;
    connection.classList.remove('live');
    if (displayToken && cause instanceof StationRequestError && [401, 403].includes(cause.status)) {
      rejectDisplayToken(displayToken);
      displayToken = null;
      displayTokenRejected = true;
      try {
        render((await fetchPublicStation()).station);
      } catch {
        connection.textContent = copy.reconnecting;
      }
    }
  } finally {
    refreshing = false;
    if (refreshPending) { refreshPending = false; void refresh(); }
  }
}

function wireTheme(): void {
  const storageKey = 'twilio-home-theme';
  const button = document.getElementById('themeToggle')!;
  const apply = (theme: string) => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(storageKey, theme);
    updateThemeToggleIcon(button,theme,copy.lightTheme,copy.darkTheme);
  };
  apply(document.documentElement.dataset.theme ?? 'light');
  button.addEventListener('click', () => apply(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

function localizeStaticPage(): void {
  applyDocumentLocale();
  document.title = copy.pageTitle;
  document.getElementById('brandTagline')!.textContent = copy.tagline;
  connection.textContent = copy.connecting;
  document.getElementById('phaseTitle')!.textContent = copy.phaseTitle;
  document.getElementById('phaseDescription')!.innerHTML = locale === 'pt-BR'
    ? 'Escaneie, entre e responda <b>MOEDA</b> quando estiver pronto na tela.'
    : 'Scan, join, and reply <b>COIN</b> when you are ready at the screen.';
  document.getElementById('joinEyebrow')!.textContent = copy.joinEyebrow;
  document.getElementById('joinTitle')!.textContent = copy.joinTitle;
  document.getElementById('joinStepOne')!.textContent = copy.joinStepOne;
  document.getElementById('joinStepTwo')!.textContent = copy.joinStepTwo;
  document.getElementById('joinStepThree')!.innerHTML = locale === 'pt-BR'
    ? 'Responda <b>MOEDA</b> na tela' : 'Reply <b>COIN</b> at the screen';
  document.getElementById('selectionEyebrow')!.textContent = copy.selectionEyebrow;
  document.getElementById('selectionTitle')!.textContent = copy.selectionTitle;
  document.getElementById('selectionDescription')!.textContent = copy.selectionDescription;
  document.getElementById('countdownEyebrow')!.textContent = copy.countdownEyebrow;
  document.getElementById('countdownDescription')!.textContent = copy.countdownDescription;
  document.getElementById('standaloneEyebrow')!.textContent=copy.standaloneEyebrow;
  document.getElementById('standaloneTitle')!.innerHTML=copy.standaloneTitle;
  document.getElementById('standaloneDescription')!.textContent=copy.standaloneDescription;
  document.getElementById('futureGamesLabel')!.textContent=copy.comingSoon;
  document.getElementById('voiceTriviaTitle')!.textContent=copy.triviaTitle;
  document.getElementById('voiceKaraokeTitle')!.textContent=copy.karaokeTitle;
  document.getElementById('voiceTriviaDescription')!.textContent=copy.triviaPreview;
  document.getElementById('voiceKaraokeDescription')!.textContent=copy.karaokePreview;
  document.getElementById('persistentJoinLabel')!.textContent=locale==='pt-BR'?'Proxima rodada':'Next round';
  document.getElementById('persistentJoinTitle')!.textContent=locale==='pt-BR'?'Escaneie para entrar':'Scan to join';
  const operator=document.getElementById('operatorLink')!;operator.innerHTML=OPERATOR_ICON;operator.title=copy.operator;operator.setAttribute('aria-label',copy.operator);
}

function renderEntryPolicyCopy(): void {
  const messaging = smsAvailable || whatsappAvailable;
  const command = freePlay ? locale === 'pt-BR' ? 'PRONTO' : 'READY' : locale === 'pt-BR' ? 'MOEDA' : 'COIN';
  const channelStep = smsAvailable && whatsappAvailable
    ? copy.joinStepOne
    : smsAvailable
      ? locale === 'pt-BR' ? 'Abra o SMS preenchido' : 'Open the prefilled SMS'
      : whatsappAvailable
        ? locale === 'pt-BR' ? 'Abra a conversa no WhatsApp' : 'Open the WhatsApp chat'
        : locale === 'pt-BR' ? 'Escaneie o QR' : 'Scan the QR';
  document.getElementById('joinStepOne')!.textContent = channelStep;
  document.getElementById('joinStepTwo')!.textContent = messaging
    ? copy.joinStepTwo
    : locale === 'pt-BR' ? 'Siga as instrucoes no telefone' : 'Follow the instructions on your phone';
  document.getElementById('phaseDescription')!.innerHTML = messaging
    ? locale === 'pt-BR'
      ? `Escaneie, entre e responda <b>${command}</b> quando estiver pronto na tela.`
      : `Scan, join, and reply <b>${command}</b> when you are ready at the screen.`
    : locale === 'pt-BR'
      ? 'Escaneie o QR e siga as instrucoes no telefone.'
      : 'Scan the QR and follow the instructions on your phone.';
  document.getElementById('joinStepThree')!.innerHTML = messaging
    ? locale === 'pt-BR' ? `Responda <b>${command}</b> na tela` : `Reply <b>${command}</b> at the screen`
    : locale === 'pt-BR' ? 'Fique pronto perto da tela' : 'Get ready near the shared screen';
  document.getElementById('joinTitle')!.textContent = copy.joinTitle;
  (document.getElementById('joinQr') as HTMLCanvasElement).hidden = false;
}

async function refreshConfiguration(): Promise<void> {
  if (configuring) { configurationPending = true; return; }
  configuring = true;
  try {
    const bootstrapRequest: Promise<{
      publicBaseUrl?: string; smsNumber?: string; whatsappNumber?: string;
    }> = fetch('/api/config', { cache: 'no-store' })
      .then(async response => response.ok ? await response.json() : {})
      .catch(() => ({}));
    const [config, bootstrap] = await Promise.all([
      fetchPublicArcadeConfig(),
      bootstrapRequest,
    ]);
    joinBaseUrl = effectivePublicVisitorBaseUrl(bootstrap.publicBaseUrl);
    standaloneMode = config.arcade.mode === 'off';
    document.body.classList.toggle('standalone-mode',standaloneMode);
    freePlay = config.coins.chargePolicy === 'free';
    smsAvailable = config.channels.sms && Boolean(bootstrap.smsNumber);
    whatsappAvailable = config.channels.whatsapp && Boolean(bootstrap.whatsappNumber);
    enabledGames = new Set(Object.entries(config.station.games)
      .filter(([, settings]) => settings.enabled)
      .map(([game]) => game));
    stationId = config.arcade.cabinetId;
    qrRailMode=config.station.qrRail;
    renderEntryPolicyCopy();
    if(standaloneMode){renderStandaloneLauncher();show('standalone');}
    else if(current)render(current);
    if (!standaloneMode) {
      await QRCode.toCanvas(
        document.getElementById('joinQr') as HTMLCanvasElement,
        stationJoinUrl(stationId, locale, joinBaseUrl),
        { width: 520, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000D25', light: '#FFFFFF' } },
      );
      await QRCode.toCanvas(
        document.getElementById('persistentJoinQr') as HTMLCanvasElement,
        stationJoinUrl(stationId, locale, joinBaseUrl),
        { width: 220, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000D25', light: '#FFFFFF' } },
      );
    }
  } catch {
    connection.textContent = copy.reconnecting;
  } finally {
    configuring = false;
    if (configurationPending) { configurationPending = false; void refreshConfiguration(); }
  }
}

async function initialize(): Promise<void> {
  localizeStaticPage();
  wireTheme();
  injectMusicToggle('header-controls');
  injectLanguagePicker('header-controls');
  injectMagicHat();
  document.addEventListener('click', () => getMusicManager().switchContext('lobby'), { once: true });
  reducedMotionPreference.addEventListener('change', syncPreviewPlayback);
  previewConnection?.addEventListener?.('change', syncPreviewPlayback);
  document.addEventListener('visibilitychange',syncPreviewPlayback);
  await refreshConfiguration();
  subscribeToStation(() => { void refreshConfiguration().then(() => refresh()); });
  setInterval(() => void refresh(), 5_000);
  setInterval(() => void refreshConfiguration(), 30_000);
  setInterval(updateTimers, 250);
  await refresh();
}

void initialize();
