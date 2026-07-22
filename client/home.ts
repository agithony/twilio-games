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
  effectivePublicVisitorBaseUrl,
  fetchPublicArcadeConfig,
  fetchPublicStation,
  stationJoinUrl,
  stationLaunchUrl,
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
  joinStepThree: 'Responda MOEDA na tela', selectionEyebrow: 'Seleção automática',
  selectionTitle: 'A próxima arena é escolhida automaticamente.',
  selectionDescription: 'A estação considera a capacidade e a rotação para escolher o próximo jogo.',
  countdownEyebrow: 'Jogadores confirmados', countdownDescription: 'Fique por perto. O jogo está carregando nesta tela.',
  freePlay: 'Jogo livre', chooseGame: 'Escolha um jogo.',
  standaloneEyebrow: 'Jogos de festa controlados por voz · com tecnologia Twilio',
  standaloneTitle: 'Jogue com sua <span>voz.</span>',
  standaloneDescription: 'Escolha um jogo na tela compartilhada. Os jogadores ligam de qualquer telefone e usam a voz como controle.',
  nextGame: 'Próximo jogo', gameComplete: 'Partida concluída',
  playersNext: 'jogadores já estão prontos para a próxima partida',
  displaySetup: 'Configuração da tela necessária', missingDisplayToken: 'Token da tela ausente',
  invalidDisplayToken: 'Falha na autorização da tela',
  lightTheme: 'Tema claro', darkTheme: 'Tema escuro', operator: 'Console do operador', playerMax: 'máx. {count} jogadores',
  playNow: '{count} jogam agora', keepPriority: '{count} mantêm prioridade',
  racerBlurb: 'Uma corrida por uma pista neon controlada por voz.',
  monstersBlurb: 'Comande os golpes em uma batalha tática de criaturas.',
  fighterBlurb: 'Transforme cada golpe gritado em um confronto na arena.',
  freeDescription: 'Escaneie, entre e responda PRONTO quando estiver pronto na tela.',
  freeStep: 'Responda PRONTO na tela',
} : {
  pageTitle: 'Twilio Games', tagline: 'One screen. Your phone. Your voice.',
  connecting: 'Connecting', recruiting: 'Now recruiting', waiting: 'Waiting for first coin',
  ready: 'players ready', timer: 'Next game in {time}', reconnecting: 'Reconnecting', live: 'Station live',
  attractEyebrow: 'Twilio Games', phaseTitle: 'Your voice is the controller.',
  phaseDescription: 'Scan, join, and reply COIN when you are ready at the screen.',
  joinEyebrow: 'Join from your phone', joinTitle: 'Scan to play',
  joinStepOne: 'Choose SMS or WhatsApp', joinStepTwo: 'Complete the quick intro',
  joinStepThree: 'Reply COIN at the screen', selectionEyebrow: 'Automatic selection',
  selectionTitle: 'The next arena is selected automatically.',
  selectionDescription: 'The station uses capacity and rotation to choose the next game.',
  countdownEyebrow: 'Players locked', countdownDescription: 'Stay close. The game is loading on this screen.',
  freePlay: 'Free play', chooseGame: 'Choose a game.',
  standaloneEyebrow: 'Voice-controlled party games · powered by Twilio',
  standaloneTitle: 'Play with your <span>voice.</span>',
  standaloneDescription: 'Choose a game on the shared screen. Players call from any phone and use their voices as controllers.',
  nextGame: 'Next game', gameComplete: 'Game complete',
  playersNext: 'players are already ready for the next game',
  displaySetup: 'Display setup required', missingDisplayToken: 'Missing display token',
  invalidDisplayToken: 'Display authorization failed',
  lightTheme: 'Light theme', darkTheme: 'Dark theme', operator: 'Operator console', playerMax: '{count} player max',
  playNow: '{count} play now', keepPriority: '{count} keep priority',
  racerBlurb: 'A voice-powered sprint through a neon circuit.',
  monstersBlurb: 'Call the moves in a tactical creature battle.',
  fighterBlurb: 'Turn every shouted move into an arena showdown.',
  freeDescription: 'Scan, join, and reply READY when you are at the screen.',
  freeStep: 'Reply READY at the screen',
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

let stationId = new URLSearchParams(location.search).get('station') ?? 'ARCADE-01';
let current: PublicStation | null = null;
let refreshing = false;
let refreshPending = false;
let launched = '';
const displayToken = captureDisplayToken();
let standaloneMode = false;
let joinBaseUrl = location.origin;
let qrRailMode: 'auto' | 'always' | 'hidden' = 'auto';
let configuring = false;
let configurationPending = false;
let freePlay = false;
let enabledGames = new Set(['racer','monsters','fighter']);
let smsAvailable = false;
let whatsappAvailable = false;

function renderGameCards(station: PublicStation): void {
  gameCards.replaceChildren(...station.games.filter(impact => enabledGames.has(impact.id)).map((impact, index) => {
    const definition = PLAYABLE_ARCADE_GAMES.find(game => game.id === impact.id)!;
    const card = document.createElement('article');
    card.className = 'game-card';
    card.dataset.game = impact.id;
    card.innerHTML = `<span>0${index + 1} · ${format(copy.playerMax, { count: definition.humanCapacity })}</span>
      <h2>${gameTitle(locale, impact.id)}</h2>
      <p>${impact.id === 'racer' ? copy.racerBlurb
        : impact.id === 'monsters' ? copy.monstersBlurb : copy.fighterBlurb}</p>
      <div class="capacity"><b>${format(copy.playNow, { count: impact.playNow })}</b><b>${format(copy.keepPriority, { count: impact.overflow })}</b></div>`;
    return card;
  }));
}

function renderStandaloneLauncher(): void {
  const videos: Record<'racer'|'monsters'|'fighter',string> = {
    racer: '/video/vr-demo.mp4', monsters: '/video/vm-demo.mp4', fighter: '/video/vf-demo.mp4',
  };
  standaloneGames.replaceChildren(...PLAYABLE_ARCADE_GAMES.map(game => {
    const link = document.createElement('a');
    const url = new URL(game.route, location.origin);
    url.searchParams.set('display', '1');url.searchParams.set('room', '4821');url.searchParams.set('locale', locale);
    link.href=url.toString();link.className='standalone-game';link.dataset.game=game.id;
    link.innerHTML=`<video src="${videos[game.id]}" loop muted playsinline autoplay></video><span>${gameTitle(locale,game.id)}</span><p>${game.id==='racer'?copy.racerBlurb:game.id==='monsters'?copy.monstersBlurb:copy.fighterBlurb}</p>`;
    return link;
  }));
  standaloneGames.querySelectorAll<HTMLVideoElement>('video').forEach(video=>void video.play().catch(()=>undefined));
}

function show(view: keyof typeof views): void {
  for (const [name, element] of Object.entries(views)) element.toggleAttribute('hidden', name !== view);
}

function render(station: PublicStation): void {
  current = station;
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
    show('standalone');
    renderStandaloneLauncher();
  } else if (station.phase === 'GAME_SELECTION') {
    show('selection');
    selectionTimer.hidden = false;
    document.getElementById('selectionEyebrow')!.textContent = copy.selectionEyebrow;
    document.getElementById('selectionTitle')!.textContent = copy.selectionTitle;
    document.getElementById('selectionDescription')!.textContent = copy.selectionDescription;
    renderGameCards(station);
  } else if (station.phase === 'LOCKED') {
    show('countdown');
    lockedGame.textContent = station.activeGame ? gameTitle(locale, station.activeGame) : copy.nextGame;
  } else if (station.phase === 'RESULTS') {
    show('countdown');
    lockedGame.textContent = copy.gameComplete;
    lockedCountdown.textContent = String(station.nextReadyCount);
    document.getElementById('countdownDescription')!.textContent = copy.playersNext;
  } else if (station.phase === 'LAUNCHING' || station.phase === 'PLAYING') {
    if (!displayToken || !station.launch) {
      show('countdown'); lockedGame.textContent = copy.displaySetup;
      lockedCountdown.textContent = '!'; connection.textContent = copy.missingDisplayToken;
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
  if (!current?.deadline) {
    phaseTimer.textContent = copy.waiting;
    selectionTimer.textContent = '0:30';
    lockedCountdown.textContent = current?.phase === 'RESULTS' ? String(current.nextReadyCount) : '10';
    return;
  }
  const remaining = Math.max(0, Date.parse(current.deadline) - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  const formatted = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  phaseTimer.textContent = copy.timer.replace('{time}', formatted);
  selectionTimer.textContent = formatted;
  lockedCountdown.textContent = String(seconds);
}

async function refresh(): Promise<void> {
  if (refreshing) { refreshPending = true; return; }
  refreshing = true;
  try {
    if (standaloneMode) {
      show('standalone');
      renderStandaloneLauncher();
      return;
    }
    render((await fetchPublicStation(displayToken)).station);
  } catch {
    connection.textContent = copy.reconnecting;
    connection.classList.remove('live');
    if (displayToken) {
      show('countdown');lockedGame.textContent=copy.displaySetup;lockedCountdown.textContent='!';
      connection.textContent=copy.invalidDisplayToken;
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
    freePlay = config.coins.chargePolicy === 'free';
    smsAvailable = config.channels.sms && Boolean(bootstrap.smsNumber);
    whatsappAvailable = config.channels.whatsapp && Boolean(bootstrap.whatsappNumber);
    enabledGames = new Set(Object.entries(config.station.games)
      .filter(([, settings]) => settings.enabled)
      .map(([game]) => game));
    stationId = config.arcade.cabinetId;
    qrRailMode=config.station.qrRail;
    renderEntryPolicyCopy();
    if(standaloneMode){show('standalone');renderStandaloneLauncher();}
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
  document.querySelectorAll<HTMLVideoElement>('video').forEach(video => void video.play().catch(() => undefined));
  await refreshConfiguration();
  subscribeToStation(() => { void refreshConfiguration().then(() => refresh()); });
  setInterval(() => void refresh(), 5_000);
  setInterval(() => void refreshConfiguration(), 30_000);
  setInterval(updateTimers, 250);
  await refresh();
}

void initialize();
