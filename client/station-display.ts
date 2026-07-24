import QRCode from 'qrcode';
import { locale } from './i18n';
import { createCoinInsertionPresenter } from './coin-insertion';
import {
  captureDisplayToken,
  fetchPublicStation,
  fetchPublicArcadeConfig,
  idempotencyKey,
  rejectDisplayToken,
  StationRequestError,
  stationJoinUrl,
  subscribeToStation,
  type PublicStation,
} from './station-client';
import './station-display.css';

export interface StationDisplay {
  readonly active: boolean;
  readonly displayToken: string | null;
  markEngineReady(): void;
  markEngineResultsReady(): void;
}

export function createStationDisplay(): StationDisplay {
  const params = new URLSearchParams(location.search);
  const stationId = params.get('station');
  const matchId = params.get('match');
  const generation = Number(params.get('launchGeneration'));
  const displayToken = captureDisplayToken();
  const joinBaseUrl = params.get('joinBaseUrl') ?? location.origin;
  if (!stationId || !matchId || !displayToken || !Number.isSafeInteger(generation) || generation < 1) {
    return { active: false, displayToken, markEngineReady: () => undefined, markEngineResultsReady: () => undefined };
  }

  const rail = buildRail();
  const coinInsertion = createCoinInsertionPresenter();
  const resultsFallback = buildResultsFallback();
  document.body.append(resultsFallback);
  rail.root.hidden = true;
  document.body.appendChild(rail.root);
  const homeUrl = new URL('/', location.origin);
  homeUrl.searchParams.set('locale', locale);
  homeUrl.searchParams.set('joinBaseUrl', joinBaseUrl);
  for (const home of document.querySelectorAll<HTMLAnchorElement>('.game-home, #result a[href="/"]')) {
    home.href = homeUrl.toString();
  }
  void QRCode.toCanvas(rail.qr, stationJoinUrl(stationId, locale, joinBaseUrl), {
    width: 420, margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#000D25', light: '#FFFFFF' },
  });
  let railMode: 'auto' | 'always' | 'hidden' = 'auto';
  let configRefreshing = false;
  let configRefreshPending = false;
  const refreshRailConfig = async () => {
    if (configRefreshing) { configRefreshPending = true; return; }
    configRefreshing = true;
    try {
      const config = await fetchPublicArcadeConfig();
      railMode = config.station.qrRail;
      setRailVisible(railMode !== 'hidden');
      rail.instructions.innerHTML = config.coins.chargePolicy === 'free'
        ? locale === 'pt-BR'
          ? 'Comece pelo telefone e responda <b>PRONTO</b> quando estiver na tela.'
          : 'Start on your phone, then reply <b>READY</b> when you are at the screen.'
        : locale === 'pt-BR'
          ? 'Comece pelo telefone e responda <b>MOEDA</b> quando estiver na tela.'
          : 'Start on your phone, then reply <b>COIN</b> when you are at the screen.';
    } catch {
      // Keep the last known rail policy until the next event or poll.
    } finally {
      configRefreshing = false;
      if (configRefreshPending) { configRefreshPending = false; void refreshRailConfig(); }
    }
  };
  void refreshRailConfig();

  let engineReady = false;
  let engineResultsReady = false;
  let resultsFallbackTimer:ReturnType<typeof setTimeout>|null=null;
  let acknowledged = false;
  let latest: { station: PublicStation; etag: string } | null = null;
  let refreshing = false;
  let refreshPending = false;
  let authorizationRejected = false;
  let unsubscribe: () => void = () => undefined;
  let polling: ReturnType<typeof setInterval> | null = null;
  let configPolling: ReturnType<typeof setInterval> | null = null;

  const refresh = async () => {
    if (authorizationRejected) return;
    if (refreshing) { refreshPending = true; return; }
    refreshing = true;
    try {
      latest = await fetchPublicStation(displayToken);
      setRailVisible(railMode !== 'hidden');
      const launch = latest.station.launch;
      const sameLaunch = launch?.matchId === matchId && launch.generation === generation;
      rail.count.textContent = String(latest.station.nextReadyCount);
      rail.status.textContent = latest.station.phase === 'RESULTS'
        ? locale === 'pt-BR' ? 'Resultados na tela · operador continua' : 'Results on screen · operator continues'
        : latest.station.phase === 'PLAYING'
        ? locale === 'pt-BR' ? 'Partida ao vivo · próxima fila aberta' : 'Match live · next pool open'
        : latest.station.phase === 'LAUNCHING'
          ? locale === 'pt-BR' ? 'Preparando o jogo' : 'Preparing game engine'
          : locale === 'pt-BR' ? 'Aguardando a estação' : 'Waiting for station';
      if (engineReady && sameLaunch && latest.station.phase === 'LAUNCHING' && !acknowledged) {
        await acknowledge(latest.etag, matchId, generation, displayToken);
        acknowledged = true;
      } else if (!sameLaunch || !['LAUNCHING', 'PLAYING', 'RESULTS'].includes(latest.station.phase)) {
        location.replace(homeUrl.toString());
      }
      if(latest.station.phase==='RESULTS'&&!engineResultsReady){
        if(resultsFallbackTimer===null)resultsFallbackTimer=setTimeout(()=>{
          resultsFallbackTimer=null;if(!engineResultsReady&&latest?.station.phase==='RESULTS')renderResultsFallback(resultsFallback,latest.station.results,latest.station.resultSource);
        },1000);
      }else if(latest.station.phase!=='RESULTS'||engineResultsReady){
        if(resultsFallbackTimer!==null)clearTimeout(resultsFallbackTimer);resultsFallbackTimer=null;resultsFallback.hidden=true;
      }
    } catch (cause) {
      if (cause instanceof StationRequestError && [401, 403].includes(cause.status)) {
        authorizationRejected = true;
        rejectDisplayToken(displayToken);
        unsubscribe();
        if (polling !== null) clearInterval(polling);
        if (configPolling !== null) clearInterval(configPolling);
        location.replace(homeUrl.toString());
        return;
      }
      rail.status.textContent = locale === 'pt-BR' ? 'Reconectando' : 'Reconnecting to station';
    } finally {
      refreshing = false;
      if (refreshPending && !authorizationRejected) { refreshPending = false; void refresh(); }
    }
  };
  unsubscribe = subscribeToStation(() => {
    void refresh();
    void refreshRailConfig();
  },event=>coinInsertion.show(event));
  polling = setInterval(() => void refresh(), 5_000);
  configPolling = setInterval(() => void refreshRailConfig(), 30_000);
  addEventListener('pagehide', () => {
    unsubscribe();
    if (polling !== null) clearInterval(polling);
    if (configPolling !== null) clearInterval(configPolling);
  }, { once: true });
  void refresh();

  return {
    active: true,
    displayToken,
    markEngineReady: () => {
      engineReady = true;
      void refresh();
    },
    markEngineResultsReady:()=>{
      engineResultsReady=true;if(resultsFallbackTimer!==null)clearTimeout(resultsFallbackTimer);resultsFallbackTimer=null;resultsFallback.hidden=true;
    },
  };

  function setRailVisible(visible: boolean): void {
    const changed=rail.root.hidden!==!visible
      ||document.body.classList.contains('station-mode')!==visible;
    rail.root.hidden = !visible;
    document.body.classList.toggle('station-mode', visible);
    if(changed)dispatchEvent(new Event('resize'));
  }
}

function buildResultsFallback():HTMLElement{
  const root=document.createElement('section');root.className='station-results-fallback';root.hidden=true;root.setAttribute('aria-live','polite');return root;
}

function renderResultsFallback(root:HTMLElement,results:PublicStation['results'],source:PublicStation['resultSource']):void{
  root.replaceChildren();
  const eyebrow=document.createElement('p');eyebrow.className='station-results-eyebrow';eyebrow.textContent=locale==='pt-BR'?'RESULTADOS FINAIS':'FINAL RESULTS';
  const title=document.createElement('h1');title.textContent=locale==='pt-BR'?'Placar':'Scoreboard';root.append(eyebrow,title);
  if(!results.length){
    const unavailable=document.createElement('div');unavailable.className='station-results-unavailable';
    unavailable.textContent=source==='RECOVERY'
      ?(locale==='pt-BR'?'Partida interrompida. As moedas foram devolvidas.':'Match interrupted. Player coins were returned.')
      :(locale==='pt-BR'?'Partida encerrada. Os detalhes não ficaram disponíveis após a recuperação.':'Match complete. Detailed results were unavailable after recovery.');
    root.append(unavailable);
  }
  for(const result of results){
    const row=document.createElement('div');row.className=`station-result-row${result.won?' winner':''}`;
    const rank=document.createElement('strong');rank.textContent=result.rank===null?'—':`#${result.rank}`;
    const name=document.createElement('span');name.textContent=result.displayName;
    const time=document.createElement('time');time.textContent=result.durationSeconds!==null&&result.durationSeconds>0
      ?`${result.durationSeconds.toFixed(2)}s`
      :result.completed?(locale==='pt-BR'?'Concluído':'Complete'):'DNF';
    row.append(rank,name,time);root.append(row);
  }
  const hold=document.createElement('p');hold.className='station-results-hold';hold.textContent=locale==='pt-BR'?'O operador continuará quando todos terminarem.':'Results will stay here until the operator continues.';root.append(hold);root.hidden=false;
}

async function acknowledge(
  etag: string,
  matchId: string,
  launchGeneration: number,
  displayToken: string,
): Promise<void> {
  const response = await fetch('/api/arcade/station/display/ready', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': etag,
      'Idempotency-Key': idempotencyKey('display-ready'),
      'X-Arcade-Display-Token': displayToken,
    },
    body: JSON.stringify({ matchId, launchGeneration }),
  });
  if (!response.ok) {
    throw new StationRequestError(response.status);
  }
}

function buildRail(): {
  root: HTMLElement;
  qr: HTMLCanvasElement;
  count: HTMLElement;
  status: HTMLElement;
  instructions: HTMLElement;
} {
  const portuguese = locale === 'pt-BR';
  const root = document.createElement('aside');
  root.className = 'station-rail';
  root.setAttribute('aria-label', 'Join the next Twilio Games match');
  root.innerHTML = `
    <div class="station-rail-brand"><img src="/brand/Twilio_Logo_Bug_White.svg" alt=""><strong>Twilio Games</strong></div>
    <div class="station-rail-copy"><span>${portuguese ? 'Próximo jogo' : 'Next game'}</span><h2>${portuguese ? 'Escaneie para entrar' : 'Scan to join'}</h2><p>${portuguese ? 'Comece pelo telefone e responda <b>MOEDA</b> quando estiver na tela.' : 'Start on your phone, then reply <b>COIN</b> when you are at the screen.'}</p></div>
    <div class="station-rail-qr"><canvas aria-label="Join Twilio Games QR code"></canvas></div>
    <div class="station-rail-count"><strong>0</strong><span>${portuguese ? 'prontos para o próximo' : 'ready next'}</span></div>
    <div class="station-rail-status" role="status">${portuguese ? 'Conectando' : 'Connecting to station'}</div>`;
  return {
    root,
    qr: root.querySelector('canvas')!,
    count: root.querySelector('.station-rail-count strong')!,
    status: root.querySelector('.station-rail-status')!,
    instructions: root.querySelector('.station-rail-copy p')!,
  };
}
