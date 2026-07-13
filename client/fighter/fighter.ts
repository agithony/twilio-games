import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { FighterActor } from './fighter-actor';
import { FIGHTERS, FIGHTER_ASSET_VERSION, loadAnimationSources } from './fighter-assets';
import { FighterConnection } from './fighter-net';
import { isInteractiveShortcutTarget, resolveNumericSelection } from './fighter-client-utils';
import { getSoundEffectsManager } from '../sound-effects';
import { getMusicManager } from '../music-manager';
import { injectMusicToggle } from '../music-toggle';
import { isCountdownSoundCue } from '../../shared/countdown';
import { DEFAULT_ROOM } from '../../shared/constants';
import { FIGHTER_RUN_BACKWARD_DURATION, FIGHTER_RUN_FORWARD_DURATION,
  type FighterCommand, type FighterEvent, type FighterId, type FighterWorld } from '../../shared/fighter-world';
import type { FighterMapEntry, FighterRosterEntry } from '../../shared/fighter-roster';
import type { FighterState } from '../../shared/fighter-protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const arena = $('arena'), overlay = $('overlay'), loading = $('loading');
const loadingLabel = $('loading-label'), loadingFill = $('loading-fill'), loadingPercent = $('loading-percent');
const voiceCommand = $('voice-command'), voiceFeed = document.querySelector('.voice-feed')!;
const p1Health = $('p1-health'), p2Health = $('p2-health');
const p1Meter = p1Health.parentElement!, p2Meter = p2Health.parentElement!;
const result = $('result'), resultTitle = $('result-title'), rematch = $('rematch');
const fightCall = $('fight-call'), errorBox = $('error');
const connectionStatus = $('connection-status');
const p1FighterName = $('p1-fighter-name'), p2FighterName = $('p2-fighter-name');
const p1PlayerName = $('p1-player-name'), p2PlayerName = $('p2-player-name');
const commandButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-command]')];
injectMusicToggle('music-toggle-container');

const params = new URLSearchParams(location.search);
const roomCode = params.get('room') || DEFAULT_ROOM;
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const connection = new FighterConnection(`${wsProtocol}//${location.host}/fighter`);
connection.setDisplayAuth(roomCode, params.get('displayToken') ?? params.get('hostToken'));

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12;
arena.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x05060a); scene.fog = new THREE.FogExp2(0x08090e, 0.06);
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.05, 5000);
camera.position.set(0, 2.15, 10.5); camera.lookAt(0, 1.05, 0);
const theme = buildArena();

let loadedActors = new Map<string, FighterActor>();
let actors: Record<FighterId, FighterActor> | null = null;
let actorKey = '';
let state: FighterState | null = null;
let playerId: string | null = null;
let roster: FighterRosterEntry[] = [];
let maps: FighterMapEntry[] = [];
let phoneNumber = 'Call the number on screen';
let movement: Partial<Record<FighterId, { from: number; to: number; elapsed: number; jump: boolean; duration: number }>> = {};
const actionDurations: Record<FighterId, number> = { p1: FIGHTER_RUN_FORWARD_DURATION, p2: FIGHTER_RUN_FORWARD_DURATION };
let lastTime = performance.now();
let lastOverlayKey = '';
let lastPhase = '';
let loadedMapId = '';
let mapReadyId = '';
let readySentFor = '';
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let mapModel: THREE.Object3D | null = null;
let mapBackdrop: THREE.WebGLRenderTarget | null = null;
let mapLoadAttempt = 0;
let customMapStatic = false;
let mapPlane = { origin: [0, 0, 0] as [number, number, number], rotationY: 0 };
const displayX: Record<FighterId, number> = { p1: -2.5, p2: 2.5 };
const displayHeight: Record<FighterId, number> = { p1: 0, p2: 0 };
let cameraBase = { pos: [0, 2.15, 10.5] as [number, number, number], lookAt: [0, 1.25, 0] as [number, number, number], fov: 36 };
const cameraAxis = new THREE.Vector3(), cameraTarget = new THREE.Vector3(), cameraView = new THREE.Vector3(), cameraDesired = new THREE.Vector3();
let flowMessage = '';
let animationSources: Awaited<ReturnType<typeof loadAnimationSources>> | null = null;
const actorLoads = new Map<string, Promise<FighterActor>>();
let preparedFightKey = '';
let fightStartedKey = '';
let bufferedEvents: FighterEvent[] = [];
let initializationAttempt = 0;
let numericBuffer = '';
let numericTimer: ReturnType<typeof setTimeout> | null = null;
let focusBeforeError: HTMLElement | null = null;
let isHost = false;
let resultRevealAt = 0;
let resultTimer: ReturnType<typeof setTimeout> | null = null;
let introSegment = '';
let countdownSoundPlayed = false;

connection.onRoster((fighters, mapEntries) => { roster = fighters; maps = mapEntries; renderFlow(); });
connection.onJoined(id => { playerId = id; renderFlow(); });
connection.onEvents(handleEvents);
connection.onError((_code, message) => { flowMessage = message; lastOverlayKey = ''; renderFlow(); });
connection.onHostIdentity(host => { isHost = host; lastOverlayKey = ''; renderFlow(); });
connection.onConnectionState(status => {
  connectionStatus.dataset.state = status;
  connectionStatus.textContent = status === 'connected' ? 'Connected' : status === 'reconnecting' ? 'Reconnecting...' : status === 'closed' ? 'Disconnected' : 'Connecting...';
});
connection.onState(next => {
  const previousPhase = state?.phase;
  const phaseChanged = next.phase !== previousPhase;
  const choiceChanged = next.selectedMap !== state?.selectedMap
    || next.players.map(player => player.fighterId ?? '').join('|') !== state?.players.map(player => player.fighterId ?? '').join('|');
  const selectionChanged = choiceChanged
    || next.players.map(player => `${player.playerId}:${player.fighterId ?? ''}`).join('|') !== state?.players.map(player => `${player.playerId}:${player.fighterId ?? ''}`).join('|');
  if (state && choiceChanged && (next.phase === 'fighter_select' || next.phase === 'map_select')) getSoundEffectsManager().playSelect();
  if (phaseChanged || selectionChanged) {
    flowMessage = ''; numericBuffer = ''; if (numericTimer) { clearTimeout(numericTimer); numericTimer = null; }
  }
  if (phaseChanged) {
    if (next.phase === 'loading') { preparedFightKey = ''; fightStartedKey = ''; bufferedEvents = []; }
    if (next.phase === 'loading' || next.phase === 'intro') countdownSoundPlayed = false;
    if (next.phase !== 'results' && resultTimer) { clearTimeout(resultTimer); resultTimer = null; resultRevealAt = 0; }
    if (['lobby', 'fighter_select', 'map_select', 'loading'].includes(next.phase)) getMusicManager().switchContext('lobby');
  }
  state = next;
  if (next.phase === 'countdown') {
    const count = Math.ceil(next.countdown ?? 0);
    if (isCountdownSoundCue(count) && !countdownSoundPlayed) { countdownSoundPlayed = true; getSoundEffectsManager().playCountdown(); }
  }
  if (phaseChanged && next.phase === 'map_select') { readySentFor = ''; if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; } }
  document.body.dataset.phase = next.phase;
  if (next.world) {
    p1Health.style.width = `${next.world.p1.health}%`; p2Health.style.width = `${next.world.p2.health}%`;
    p1Meter.setAttribute('aria-valuenow', String(next.world.p1.health)); p2Meter.setAttribute('aria-valuenow', String(next.world.p2.health));
    syncAuthoritativePositions(next.world);
  }
  updateNames(next);
  if (next.selectedMap && ['loading', 'intro', 'countdown', 'fight', 'victory', 'results'].includes(next.phase)) applyMapTheme(next.selectedMap);
  if ((next.phase === 'loading' || next.phase === 'intro' || next.phase === 'countdown') && (phaseChanged || !actors)) prepareFight(next);
  if (phaseChanged && next.phase === 'intro') beginIntro(next);
  if (previousPhase === 'intro' && next.phase === 'countdown') endIntro(next);
  if (next.phase === 'loading') maybeSignalReady();
  if (phaseChanged && next.phase === 'fight') beginFight(next);
  if (next.phase === 'results' && next.result) showResult(next.result.winner);
  else if (next.phase !== 'results') { result.hidden = true; setFightControlsEnabled(next.phase === 'fight'); }
  renderFlow();
});
connection.spectate(roomCode);
void fetch('/api/config').then(r => r.json()).then(config => { if (config.phoneNumber) phoneNumber = config.phoneNumber; renderFlow(); }).catch(() => {});

function setLoading(progress: number, label: string): void {
  const value = Math.round(progress * 100); loadingLabel.textContent = label;
  loadingFill.style.width = `${value}%`; loadingPercent.textContent = `${value}%`;
  loadingFill.parentElement?.setAttribute('aria-valuenow', String(value));
}

async function initialize(): Promise<void> {
  const attempt = ++initializationAttempt;
  loading.classList.remove('done'); loading.setAttribute('aria-busy', 'true'); hideAssetError();
  setLoading(.05, 'Opening lobby');
  setTimeout(() => {
    if (attempt !== initializationAttempt) return;
    loading.classList.add('done'); loading.setAttribute('aria-busy', 'false'); renderFlow();
  }, 250);
  try {
    animationSources = await loadAnimationSources((loaded, total, label) => setLoading(loaded / total, `Preparing ${label}`));
    if (attempt !== initializationAttempt) return;
    setLoading(1, 'Ready');
    if (state?.phase === 'loading' || state?.phase === 'intro' || state?.phase === 'countdown' || state?.phase === 'fight') prepareFight(state);
    maybeSignalReady(); renderFlow();
  } catch (error) {
    if (attempt !== initializationAttempt) return;
    loading.classList.add('done'); loading.setAttribute('aria-busy', 'false');
    showAssetError('Unable to load animations', error, [
      { label: 'Retry', action: () => void initialize() },
      { label: 'Cancel', secondary: true, action: () => { hideAssetError(); connection.back(); } },
    ]);
  }
}

function renderFlow(): void {
  if (!state || !loading.classList.contains('done')) return;
  const previousScroll = overlay.scrollTop;
  const focusKey = focusedControlKey();
  const phaseBeforeRender = lastPhase;
  const countdownKey = state.countdown === null ? null : Math.ceil(state.countdown) > 3 ? 'ready' : Math.ceil(state.countdown);
  const introKey = state.intro === null ? null : introStage(state.intro);
  const key = JSON.stringify([state.phase, state.players, state.selectedMap, introKey, countdownKey, playerId, isHost, roster, maps, phoneNumber, flowMessage]);
  if (key === lastOverlayKey || state.phase === 'fight' || state.phase === 'victory' || state.phase === 'results') {
    if (state.phase === 'fight' || state.phase === 'victory' || state.phase === 'results') overlay.replaceChildren();
    return;
  }
  lastOverlayKey = key;
  lastPhase = state.phase;
  if (state.phase === 'lobby') {
    overlay.innerHTML = `<section class="flow-panel lobby-panel"><div class="lobby-head"><span class="flow-kicker">Twilio Games · Room ${escapeHtml(roomCode)}</span><h1>Voice Fighter</h1><p>Call in, choose a champion, and command every move with your voice.</p></div><div class="lobby-layout"><div class="qr-card"><img src="/brand/join-qr.png?v=2" alt="Scan to call and join Voice Fighter"><strong>Scan to join</strong><span>${escapeHtml(phoneNumber)}</span></div><div class="lobby-center"><h2>Get started</h2><ol class="join-steps"><li><b>1</b><span>Scan the QR code with your phone</span></li><li><b>2</b><span>Call the number and tell the host your name</span></li><li><b>3</b><span>Pick a fighter and arena, then say “fight”</span></li></ol><div class="player-list"><h2>${state.players.length ? 'Challengers' : 'Fight lobby'}</h2>${state.players.length ? state.players.map(playerChip).join('') : '<p>Waiting for the first challenger...</p>'}</div></div><aside class="how-to"><h2>How to fight</h2><p>Reduce your rival’s health to zero. Attacks need range and have recovery time.</p><div class="instruction-grid"><span><b>Forward</b> close distance</span><span><b>Back</b> create space</span><span><b>Jump</b> evade and cross over</span><span><b>Punch</b> quick attack</span><span><b>Kick</b> heavy attack</span><span><b>Block</b> reduce damage</span></div><p class="voice-tip">Say commands clearly over the call. The screen and phone host react together.</p></aside></div><div class="flow-actions lobby-actions"><button id="local-join">${playerId ? 'Playing here' : 'Press P to play here'}</button><button id="flow-next" ${state.players.length && isHost ? '' : 'disabled'}>Choose fighters</button></div>${isHost ? '' : '<p class="flow-hint">Viewing only — the host display controls setup.</p>'}</section>`;
  } else if (state.phase === 'fighter_select') {
    const allPicked = state.players.length > 0 && state.players.every(player => player.fighterId);
    overlay.innerHTML = selectScreen('Choose your fighter', 'Say a fighter name or choose a card.', roster.map((fighter, index) => {
      const owner = state!.players.find(player => player.fighterId === fighter.id);
      return { id: fighter.id, name: fighter.name, detail: owner ? `Selected by ${owner.name}` : fighter.title, color: fighter.color, number: index + 1, selected: !!owner, taken: !!owner };
    }), 'fighter', allPicked && isHost);
  } else if (state.phase === 'map_select') {
    overlay.innerHTML = selectScreen('Choose the arena', 'Pick the battleground for this fight.', maps.map((map, index) => ({ id: map.id, name: map.name, detail: map.blurb, color: map.color, number: index + 1, selected: state!.selectedMap === map.id, taken: false })), 'map', !!state.selectedMap && isHost);
  } else if (state.phase === 'loading') {
    overlay.innerHTML = `<section class="countdown-screen loading-arena"><span>Preparing stage</span><strong>LOADING</strong><small>${escapeHtml(maps.find(map => map.id === state!.selectedMap)?.name ?? '')}</small></section>`;
  } else if (state.phase === 'intro') {
    overlay.innerHTML = introHtml(state);
  } else if (state.phase === 'countdown') {
    const count = Math.ceil(state.countdown ?? 0);
    overlay.innerHTML = `<section class="countdown-screen"><span>${count > 3 ? 'Loading arena' : 'Match begins in'}</span><strong>${count > 3 ? 'READY' : count}</strong><small>${state.selectedMap ? escapeHtml(maps.find(map => map.id === state!.selectedMap)?.name ?? '') : ''}</small></section>`;
  }
  if (flowMessage && state.phase !== 'countdown') overlay.insertAdjacentHTML('beforeend', `<div class="flow-error" role="alert">${escapeHtml(flowMessage)}</div>`);
  wireFlowButtons();
  requestAnimationFrame(() => {
    overlay.scrollTop = previousScroll;
    const replacement = focusKey ? overlay.querySelector<HTMLElement>(focusKey) : null;
    if (replacement) replacement.focus();
    else if (phaseBeforeRender && phaseBeforeRender !== state?.phase) overlay.querySelector<HTMLElement>('h1, [tabindex="-1"]')?.focus();
  });
}

function selectScreen(title: string, description: string, cards: { id: string; name: string; detail: string; color: string; number: number; selected: boolean; taken: boolean }[], kind: string, ready: boolean): string {
  return `<section class="flow-panel selection-panel"><span class="flow-kicker">Voice Fighter</span><h1 tabindex="-1">${title}</h1><p>${description}</p><div class="select-grid ${kind}-grid">${cards.map(card => { const preview = kind === 'fighter' ? roster.find(entry => entry.id === card.id)?.preview : maps.find(map => map.id === card.id)?.preview; return `<button class="select-card ${card.selected ? 'selected' : ''} ${card.taken ? 'taken' : ''}" data-${kind}="${card.id}" aria-pressed="${card.selected}" aria-label="${String(card.number).padStart(2, '0')}, ${escapeHtml(card.name)}, ${escapeHtml(card.detail)}" style="--card-color:${card.color}" ${card.taken && kind === 'fighter' ? 'disabled' : ''}><div class="card-preview" aria-hidden="true" ${preview ? `style="background-image:url('${preview}')"` : ''}></div><span class="number">${String(card.number).padStart(2, '0')}</span><strong>${escapeHtml(card.name)}</strong><span>${escapeHtml(card.detail)}</span></button>`; }).join('')}</div><div class="flow-actions"><button id="flow-back" class="secondary">Back</button><button id="flow-next" ${ready ? '' : 'disabled'}>${kind === 'map' ? 'Start fight' : 'Choose arena'}</button></div><div class="flow-hint">Type a card number · Enter to continue</div></section>`;
}

function focusedControlKey(): string | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !overlay.contains(active)) return null;
  if (active.id) return `#${CSS.escape(active.id)}`;
  if (active.dataset.fighter) return `[data-fighter="${CSS.escape(active.dataset.fighter)}"]`;
  if (active.dataset.map) return `[data-map="${CSS.escape(active.dataset.map)}"]`;
  return null;
}

interface ErrorAction { label: string; secondary?: boolean; action: () => void }
function showAssetError(title: string, error: unknown, actions: ErrorAction[]): void {
  if (errorBox.hidden) focusBeforeError = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  errorBox.replaceChildren();
  const heading = document.createElement('strong'); heading.textContent = title;
  const detail = document.createElement('p'); detail.textContent = error instanceof Error ? error.message : String(error);
  const controls = document.createElement('div'); controls.className = 'error-actions';
  for (const item of actions) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = item.label;
    if (item.secondary) button.className = 'secondary'; button.addEventListener('click', item.action); controls.appendChild(button);
  }
  errorBox.append(heading, detail, controls); errorBox.hidden = false;
  requestAnimationFrame(() => controls.querySelector('button')?.focus());
}
function hideAssetError(): void {
  if (errorBox.hidden) return;
  errorBox.hidden = true; errorBox.replaceChildren();
  const target = focusBeforeError?.isConnected ? focusBeforeError : overlay.querySelector<HTMLElement>('button:not(:disabled), h1');
  focusBeforeError = null; requestAnimationFrame(() => target?.focus());
}

function wireFlowButtons(): void {
  $('flow-next')?.addEventListener('click', () => { flowMessage = ''; connection.advance(); });
  $('flow-back')?.addEventListener('click', () => { if (isHost) connection.back(); });
  $('local-join')?.addEventListener('click', toggleLocalPlayer);
  for (const button of overlay.querySelectorAll<HTMLElement>('[data-fighter]')) button.addEventListener('click', () => { if (!isHost && !playerId) return; flowMessage = ''; connection.selectFighter(button.dataset.fighter!); });
  for (const button of overlay.querySelectorAll<HTMLElement>('[data-map]')) button.addEventListener('click', () => { if (!isHost) return; flowMessage = ''; connection.selectMap(button.dataset.map!); });
}

function introStage(remaining: number): 'p1' | 'versus' | 'p2' | 'faceoff' {
  if (remaining > 6.3) return 'p1';
  if (remaining > 4.5) return 'versus';
  if (remaining > 1.7) return 'p2';
  return 'faceoff';
}

function introHtml(current: FighterState): string {
  const stage = introStage(current.intro ?? 0);
  const p1 = current.players.find(player => player.side === 'p1'), p2 = current.players.find(player => player.side === 'p2');
  const p1Fighter = roster.find(fighter => fighter.id === p1?.fighterId)?.name ?? 'Fighter One';
  const p2Fighter = roster.find(fighter => fighter.id === p2?.fighterId)?.name ?? 'Fighter Two';
  if (stage === 'versus') return `<section class="intro-screen versus-beat"><span>Tonight's matchup</span><strong>VS</strong></section>`;
  if (stage === 'faceoff') return `<section class="intro-screen faceoff-beat"><div><small>${escapeHtml(p1?.name ?? 'Player One')}</small><b>${escapeHtml(p1Fighter)}</b></div><strong>VS</strong><div><small>${escapeHtml(p2?.name ?? 'Rival')}</small><b>${escapeHtml(p2Fighter)}</b></div></section>`;
  const player = stage === 'p1' ? p1 : p2, fighter = stage === 'p1' ? p1Fighter : p2Fighter;
  return `<section class="intro-screen fighter-beat ${stage}"><span>${stage === 'p1' ? 'Player One' : 'The Challenger'}</span><strong>${escapeHtml(fighter)}</strong><small>${escapeHtml(player?.name ?? 'Rival')}</small></section>`;
}

function beginIntro(current: FighterState): void {
  getMusicManager().switchContext('fighter');
  introSegment = '';
  updateIntroPresentation(current, true);
}

function updateIntroPresentation(current: FighterState, force = false): void {
  if (!actors || current.phase !== 'intro') return;
  const segment = introStage(current.intro ?? 0), changed = force || segment !== introSegment;
  if (changed) {
    introSegment = segment;
    if (segment === 'p1') playIntroAttack(actors.p1);
    else if (segment === 'p2') playIntroAttack(actors.p2);
    else if (segment === 'faceoff') { actors.p1.playRandom('idle', { loop: true }); actors.p2.playRandom('idle', { loop: true }); }
  }
  if (segment === 'p1' || segment === 'p2') {
    const featured = segment === 'p1' ? actors.p1 : actors.p2, hidden = segment === 'p1' ? actors.p2 : actors.p1;
    featured.root.visible = true; hidden.root.visible = false;
    featured.root.position.set(0, 0, 0); featured.root.rotation.y = 0;
    camera.position.set(segment === 'p1' ? .35 : -.35, 1.2, 4.2); camera.lookAt(0, 1.1, 0);
  } else if (segment === 'versus') {
    actors.p1.root.visible = false; actors.p2.root.visible = false;
  } else {
    actors.p1.root.visible = true; actors.p2.root.visible = true;
    actors.p1.root.position.set(-1.15, 0, 0); actors.p1.root.rotation.y = Math.PI / 2;
    actors.p2.root.position.set(1.15, 0, 0); actors.p2.root.rotation.y = -Math.PI / 2;
    camera.position.set(0, 1.35, 6); camera.lookAt(0, 1.1, 0);
  }
}

function playIntroAttack(actor: FighterActor): void {
  const command = Math.random() < .5 ? 'punch' : 'kick';
  actor.playRandom(command, { speed: .85 });
  if (command === 'punch') getSoundEffectsManager().playFighterPunch();
  else getSoundEffectsManager().playFighterKick();
}

function endIntro(current: FighterState): void {
  if (!actors) return;
  introSegment = ''; actors.p1.root.visible = true; actors.p2.root.visible = true;
  actors.p1.playRandom('idle', { loop: true }); actors.p2.playRandom('idle', { loop: true });
  if (current.world) syncAuthoritativePositions(current.world, true);
  camera.position.set(...cameraBase.pos); updateCameraProjection(); camera.lookAt(...cameraBase.lookAt);
}

function prepareFight(next: FighterState): void {
  const p1 = next.players.find(player => player.side === 'p1'); const p2 = next.players.find(player => player.side === 'p2');
  if (!p1?.fighterId || !p2?.fighterId) return;
  const key = `${p1.fighterId}:${p2.fighterId}`;
  if (!loadedActors.has(p1.fighterId) || !loadedActors.has(p2.fighterId)) { void ensureFightActors(p1.fighterId, p2.fighterId, key); return; }
  if (key !== actorKey) {
    for (const actor of loadedActors.values()) scene.remove(actor.root);
    const left = loadedActors.get(p1.fighterId), right = loadedActors.get(p2.fighterId); if (!left || !right) return;
    actors = { p1: left, p2: right }; actorKey = key;
    scene.add(left.root, right.root);
    trimActorCache(new Set([p1.fighterId, p2.fighterId]));
  }
  if (!actors) return;
  const setupKey = `${key}:${next.selectedMap ?? ''}`;
  if (preparedFightKey !== setupKey) {
    preparedFightKey = setupKey; movement = {};
    actors.p1.playRandom('idle', { loop: true }); actors.p2.playRandom('idle', { loop: true });
    if (next.world) syncAuthoritativePositions(next.world, true);
  }
  replayBufferedEvents();
  if (next.phase === 'fight') startFightPresentation(setupKey);
}

async function ensureFightActors(p1Id: string, p2Id: string, expectedKey: string): Promise<void> {
  if (!animationSources) return;
  const load = (id: string) => {
    const existing = loadedActors.get(id); if (existing) return Promise.resolve(existing);
    let pending = actorLoads.get(id);
    if (!pending) {
      const spec = FIGHTERS.find(fighter => fighter.id === id); if (!spec) return Promise.reject(new Error(`Unknown fighter ${id}`));
      pending = FighterActor.load(spec, animationSources!); actorLoads.set(id, pending);
      void pending.then(actor => { loadedActors.set(id, actor); trimActorCache(new Set([p1Id, p2Id])); })
        .finally(() => actorLoads.delete(id)).catch(() => {});
    }
    return pending;
  };
  try {
    const results = await Promise.allSettled([load(p1Id), load(p2Id)]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const current = `${state?.players.find(player => player.side === 'p1')?.fighterId}:${state?.players.find(player => player.side === 'p2')?.fighterId}`;
    if (state && current === expectedKey && (state.phase === 'loading' || state.phase === 'intro' || state.phase === 'countdown' || state.phase === 'fight')) {
      prepareFight(state); if (state.phase === 'intro') beginIntro(state); maybeSignalReady();
    }
  } catch (error) {
    showAssetError('Fighter failed to load', error, [
      { label: 'Retry', action: () => { hideAssetError(); void ensureFightActors(p1Id, p2Id, expectedKey); } },
      { label: 'Use fallback', action: () => installFallbackActors(p1Id, p2Id, expectedKey) },
      { label: 'Cancel', secondary: true, action: () => { hideAssetError(); connection.back(); } },
    ]);
  }
}

function installFallbackActors(p1Id: string, p2Id: string, expectedKey: string): void {
  for (const id of [p1Id, p2Id]) {
    if (loadedActors.has(id)) continue;
    const color = roster.find(fighter => fighter.id === id)?.color ?? '#ef223a';
    loadedActors.set(id, FighterActor.fallback(color));
  }
  hideAssetError();
  const p1 = state?.players.find(player => player.side === 'p1')?.fighterId;
  const p2 = state?.players.find(player => player.side === 'p2')?.fighterId;
  if (state && `${p1}:${p2}` === expectedKey) { prepareFight(state); maybeSignalReady(); }
}

function beginFight(next: FighterState): void {
  prepareFight(next);
  if (!actors) return;
  startFightPresentation(`${actorKey}:${next.selectedMap ?? ''}`);
}

function startFightPresentation(key: string): void {
  if (fightStartedKey === key) return;
  fightStartedKey = key; hideAssetError(); result.hidden = true; setFightControlsEnabled(true);
  fightCall.classList.remove('show'); void fightCall.offsetWidth; fightCall.classList.add('show'); announce('Fight!');
}

function handleEvents(events: FighterEvent[]): void {
  if (!actors) { bufferedEvents.push(...events); if (bufferedEvents.length > 200) bufferedEvents.splice(0, bufferedEvents.length - 200); return; }
  applyEvents(events);
}
function replayBufferedEvents(): void {
  if (!actors || !bufferedEvents.length) return;
  const pending = bufferedEvents; bufferedEvents = []; applyEvents(pending);
}
function applyEvents(events: FighterEvent[]): void {
  if (!actors) return;
  const mySide = state?.players.find(player => player.playerId === playerId)?.side;
  for (const event of events) {
    if (event.type === 'action') {
      const pool = event.command === 'forward' ? 'walk' : event.command === 'back' ? 'walk-back' : event.command;
      const actionDuration = actors[event.fighter].playRandom(pool, { speed: 1 });
      if (event.command === 'punch') getSoundEffectsManager().playFighterPunch();
      else if (event.command === 'kick') getSoundEffectsManager().playFighterKick();
      if (event.command === 'forward' || event.command === 'back') {
        actionDurations[event.fighter] = actionDuration || (event.command === 'forward' ? FIGHTER_RUN_FORWARD_DURATION : FIGHTER_RUN_BACKWARD_DURATION);
      }
      const player = state?.players.find(candidate => candidate.side === event.fighter);
      if (player && !player.isAi) { announce(`${player.name}: ${event.command}`); flashButton(event.command); }
    } else if (event.type === 'move') movement[event.fighter] = { from: event.from, to: event.to, elapsed: 0, jump: event.jump === true, duration: event.jump ? .82 : actionDurations[event.fighter] };
    else if (event.type === 'hit') { if (!event.blocked) actors[event.defender].playRandom('reaction', { speed: 1.15 }); showImpact(event.blocked ? 'Blocked' : `-${event.damage}`, event.defender); }
    else if (event.type === 'miss' && event.attacker === mySide) announce('Missed - move closer');
    else if (event.type === 'ko') {
      actors[event.loser].playRandom('fall', { hold: true, lockFloor: true });
      getMusicManager().switchContext('fighter-victory');
      const celebrationSeconds = actors[event.winner].playRandom('celebration');
      resultRevealAt = performance.now() + Math.min(12000, Math.max(6000, celebrationSeconds * 1000 + 1500));
    }
  }
}

function trimActorCache(keep: Set<string>): void {
  for (const [id, actor] of loadedActors) {
    if (loadedActors.size <= 4) break;
    if (keep.has(id) || actor === actors?.p1 || actor === actors?.p2) continue;
    loadedActors.delete(id); actor.dispose();
  }
}

function syncAuthoritativePositions(world: FighterWorld, immediate = false): void {
  if (!actors) return;
  for (const id of ['p1', 'p2'] as const) {
    if (immediate || !movement[id]) displayX[id] = world[id].x;
    if (immediate) displayHeight[id] = 0;
  }
  applyActorTransforms();
}
function updateMovement(delta: number): void {
  if (!actors) return;
  for (const id of ['p1', 'p2'] as const) {
    const tween = movement[id]; if (!tween) continue; tween.elapsed += delta;
    const duration = tween.duration;
    const t = Math.min(1, tween.elapsed / duration); displayX[id] = THREE.MathUtils.lerp(tween.from, tween.to, t);
    displayHeight[id] = tween.jump ? Math.sin(Math.PI * t) * 2.5 : 0;
    if (t === 1) { displayHeight[id] = 0; delete movement[id]; }
  }
  applyActorTransforms();
}

function applyActorTransforms(): void {
  if (!actors) return;
  const angle = THREE.MathUtils.degToRad(mapPlane.rotationY), axisX = Math.cos(angle), axisZ = -Math.sin(angle);
  for (const id of ['p1', 'p2'] as const) {
    const actor = actors[id], localX = displayX[id];
    actor.root.position.set(mapPlane.origin[0] + axisX * localX, mapPlane.origin[1] + displayHeight[id], mapPlane.origin[2] + axisZ * localX);
    const other = id === 'p1' ? 'p2' : 'p1';
    const toward = Math.sign(displayX[other] - localX) || (id === 'p1' ? 1 : -1);
    actor.root.rotation.y = angle + (toward > 0 ? Math.PI / 2 : -Math.PI / 2);
  }
}

function updateNames(next: FighterState): void {
  for (const [side, fighterEl, playerEl] of [['p1', p1FighterName, p1PlayerName], ['p2', p2FighterName, p2PlayerName]] as const) {
    const player = next.players.find(row => row.side === side); const fighter = roster.find(row => row.id === player?.fighterId);
    fighterEl.textContent = fighter?.name ?? side.toUpperCase(); playerEl.textContent = player?.isAi ? 'CPU Rival' : player?.name ?? 'Waiting';
  }
}
function playerChip(player: FighterState['players'][number]): string { return `<div class="player-chip"><strong>${escapeHtml(player.name)}</strong><span>${player.isAi ? 'CPU' : 'Connected'}</span></div>`; }
function toggleLocalPlayer(): void { if (playerId) { connection.leave(roomCode); playerId = null; } else connection.join(roomCode, 'Keyboard Fighter'); renderFlow(); }
function announce(text: string): void { voiceCommand.textContent = text.replace('-', ' '); voiceFeed.classList.remove('heard'); void (voiceFeed as HTMLElement).offsetWidth; voiceFeed.classList.add('heard'); }
function flashButton(command: FighterCommand): void { const button = commandButtons.find(item => item.dataset.command === command); button?.classList.add('active'); setTimeout(() => button?.classList.remove('active'), 220); }
function showImpact(text: string, defender: FighterId): void { document.body.classList.remove('shake'); void document.body.offsetWidth; document.body.classList.add('shake'); const element = document.createElement('div'); element.className = 'impact'; element.style.left = defender === 'p1' ? '39%' : '61%'; element.textContent = text; document.body.appendChild(element); setTimeout(() => element.remove(), 600); }
function showResult(winner: FighterId): void {
  if (resultTimer) clearTimeout(resultTimer);
  const delay = Math.max(0, resultRevealAt - performance.now());
  if (delay > 0) {
    result.hidden = true;
    resultTimer = setTimeout(() => { resultTimer = null; showResult(winner); }, delay);
    return;
  }
  const player = state?.players.find(row => row.side === winner); const fighter = roster.find(row => row.id === player?.fighterId);
  resultTitle.textContent = `${fighter?.name ?? winner} wins`; result.hidden = false; setFightControlsEnabled(false);
  if (!result.contains(document.activeElement)) requestAnimationFrame(() => rematch.focus());
}
function setFightControlsEnabled(enabled: boolean): void { for (const button of commandButtons) button.disabled = !enabled; }
function applyMapTheme(mapId: string): void {
  // Fight state arrives at 20 Hz. Reapplying the saved camera on every snapshot fights the smooth
  // tracking camera and produces a visible judder; map setup is a one-time phase transition.
  if (loadedMapId === mapId) { maybeSignalReady(); return; }
  const config = maps.find(map => map.id === mapId); if (!config) return;
  const attempt = ++mapLoadAttempt;
  loadedMapId = mapId;
  mapReadyId = '';
  hideAssetError();
  disposeCurrentMap();
  theme.ring.material.color.set(config.color); theme.red.color.set(config.color);
  theme.foundry.visible = mapId === 'foundry'; theme.voidStage.visible = mapId === 'void';
  theme.floor.material.color.set(mapId === 'void' ? 0x080d1c : 0x21171a);
  scene.background = new THREE.Color(mapId === 'void' ? 0x02040d : 0x0d080b);
  scene.fog = new THREE.FogExp2(mapId === 'void' ? 0x040817 : 0x16090c, .035);
  mapPlane = config.fightPlane ?? { origin: [0, config.floorY ?? 0, 0], rotationY: 0 };
  applyActorTransforms();
  if (config.camera) {
    cameraBase = { pos: config.camera.pos, lookAt: config.camera.lookAt, fov: config.camera.fov ?? 36 };
    camera.position.set(...cameraBase.pos); updateCameraProjection();
  } else {
    cameraBase = { pos: [0, 2.15, 10.5], lookAt: [0, 1.25, 0], fov: 36 };
    camera.position.set(...cameraBase.pos); updateCameraProjection();
  }
  camera.lookAt(...cameraBase.lookAt);
  customMapStatic = false;
  renderer.shadowMap.enabled = true;
  theme.procedural.visible = !config.file;
  if (!config.file) { mapReadyId = mapId; maybeSignalReady(); return; }
  const draco = new DRACOLoader(); draco.setDecoderPath('/draco/');
  const loader = new GLTFLoader(); loader.setDRACOLoader(draco);
  const fallbackTimer = setTimeout(() => {
    if (loadedMapId === mapId && attempt === mapLoadAttempt && mapReadyId !== mapId) { draco.dispose(); useProceduralFallback(mapId); }
  }, 12000);
  loader.load(`/assets/fighters/maps/${encodeURIComponent(config.file)}?v=${FIGHTER_ASSET_VERSION}`, gltf => {
    clearTimeout(fallbackTimer);
    draco.dispose();
    if (loadedMapId !== mapId || attempt !== mapLoadAttempt) { disposeObjectResources(gltf.scene); return; }
    mapModel = gltf.scene;
    mapModel.position.set(...(config.pos ?? [0, 0, 0]));
    const rotation = config.rotDeg ?? [0, 0, 0]; mapModel.rotation.set(...rotation.map(value => THREE.MathUtils.degToRad(value)) as [number, number, number]);
    mapModel.scale.setScalar(config.scale ?? 1);
    // Environment geometry is static and often contains millions of triangles. It can receive fighter
    // shadows, but must not render into the shadow map itself every frame.
    mapModel.traverse(object => { if ((object as THREE.Mesh).isMesh) { (object as THREE.Mesh).receiveShadow = true; (object as THREE.Mesh).castShadow = false; } });
    scene.add(mapModel);
    try { captureMapBackdrop(); }
    catch (error) { console.warn('Unable to cache arena backdrop; using live rendering.', error); customMapStatic = false; renderer.shadowMap.enabled = true; }
    mapReadyId = mapId;
    hideAssetError();
    maybeSignalReady();
  }, undefined, error => {
    clearTimeout(fallbackTimer);
    draco.dispose();
    if (loadedMapId !== mapId || attempt !== mapLoadAttempt) return;
    console.warn(`Arena ${mapId} failed to load; using the procedural stage.`, error);
    useProceduralFallback(mapId);
  });
}

function useProceduralFallback(mapId: string): void {
  mapLoadAttempt++; disposeCurrentMap(); hideAssetError();
  theme.procedural.visible = true; renderer.shadowMap.enabled = true; customMapStatic = false;
  mapPlane = { origin: [0, 0, 0], rotationY: 0 };
  cameraBase = { pos: [0, 2.15, 10.5], lookAt: [0, 1.25, 0], fov: 36 };
  applyActorTransforms(); camera.position.set(...cameraBase.pos); updateCameraProjection(); camera.lookAt(...cameraBase.lookAt);
  scene.background = new THREE.Color(0x05060a); scene.fog = new THREE.FogExp2(0x08090e, .06);
  mapReadyId = mapId; maybeSignalReady();
}

function disposeCurrentMap(): void {
  if (mapBackdrop) { if (scene.background === mapBackdrop.texture) scene.background = new THREE.Color(0x05060a); mapBackdrop.dispose(); mapBackdrop = null; }
  if (mapModel) { disposeObjectResources(mapModel); mapModel.removeFromParent(); mapModel = null; }
}

function disposeObjectResources(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh; mesh.geometry?.dispose();
    const values = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of values) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}

function maybeSignalReady(): void {
  if (!isHost || state?.phase !== 'loading' || !state.selectedMap || mapReadyId !== state.selectedMap) return;
  const selected = state.players.filter(player => player.side === 'p1' || player.side === 'p2').map(player => player.fighterId);
  if (selected.length < 2 || selected.some(id => !id || !loadedActors.has(id))) return;
  if (readySentFor === state.selectedMap || readyTimer) return;
  const mapId = state.selectedMap;
  // Let the loading overlay paint and let any first-frame shader compilation block THIS timer. The
  // authoritative countdown begins only after the browser has actually become responsive.
  readyTimer = setTimeout(() => {
    readyTimer = null;
    if (state?.phase !== 'loading' || state.selectedMap !== mapId) return;
    readySentFor = mapId; connection.ready();
  }, 350);
}

/** Custom stages never move, so flatten millions of environment triangles into the authored camera
 * shot once. The live renderer then draws only the two animated fighters over this texture. */
function captureMapBackdrop(): void {
  if (!mapModel) return;
  const drawingSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  const scale = Math.min(1, 1920 / drawingSize.x, 1080 / drawingSize.y);
  mapBackdrop?.dispose();
  const backdropScale = scale;
  mapBackdrop = new THREE.WebGLRenderTarget(Math.max(1, Math.round(drawingSize.x * backdropScale)), Math.max(1, Math.round(drawingSize.y * backdropScale)), {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
  });
  const actorVisibility = actors ? [actors.p1.root.visible, actors.p2.root.visible] : null;
  const priorFog = scene.fog;
  if (actors) { actors.p1.root.visible = false; actors.p2.root.visible = false; }
  mapModel.visible = true;
  scene.fog = null;
  scene.background = new THREE.Color(0x101522);
  renderer.setRenderTarget(mapBackdrop); renderer.render(scene, camera); renderer.setRenderTarget(null);
  const capturedModel = mapModel; capturedModel.visible = false; capturedModel.removeFromParent(); disposeObjectResources(capturedModel); mapModel = null;
  if (actors && actorVisibility) { actors.p1.root.visible = actorVisibility[0]!; actors.p2.root.visible = actorVisibility[1]!; }
  scene.background = mapBackdrop.texture;
  scene.fog = priorFog;
  customMapStatic = true;
  // The flattened backdrop cannot receive live shadows, so skip the animated shadow pass entirely.
  renderer.shadowMap.enabled = false;
}
function updateCameraProjection(): void {
  const referenceAspect = 16 / 9;
  const authored = THREE.MathUtils.degToRad(cameraBase.fov);
  camera.fov = camera.aspect < referenceAspect
    ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(authored / 2) * referenceAspect / camera.aspect))
    : cameraBase.fov;
  camera.updateProjectionMatrix();
}
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!); }

function buildArena(): { ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; floor: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>; red: THREE.SpotLight; procedural: THREE.Group; foundry: THREE.Group; voidStage: THREE.Group } {
  const procedural = new THREE.Group(); scene.add(procedural);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(13, 8), new THREE.MeshStandardMaterial({ color: 0x171922, roughness: .72, metalness: .16 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const ring = new THREE.Mesh(new THREE.RingGeometry(10.2, 10.3, 8), new THREE.MeshBasicMaterial({ color: 0xef223a, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = .006; procedural.add(floor, ring);
  const grid = new THREE.GridHelper(25, 50, 0x3a1721, 0x141721); grid.position.y = .012; procedural.add(grid);
  const geometry = new THREE.BoxGeometry(.24, 4.8, .24), material = new THREE.MeshStandardMaterial({ color: 0x161923, metalness: .7, roughness: .35 });
  for (let i = -6; i <= 6; i++) { const pillar = new THREE.Mesh(geometry, material); pillar.position.set(i * 1.25, 2.3, -3.5 - Math.abs(i) * .08); pillar.rotation.z = i * .02; procedural.add(pillar); }
  const foundry = new THREE.Group(), voidStage = new THREE.Group(); procedural.add(foundry, voidStage); voidStage.visible = false;
  const steel = new THREE.MeshStandardMaterial({ color: 0x252a31, metalness: .9, roughness: .28 });
  const furnace = new THREE.MeshStandardMaterial({ color: 0x3a1014, emissive: 0xef223a, emissiveIntensity: 3.2, metalness: .4, roughness: .35 });
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(.55, .72, 3.5, 12), steel); tower.position.set(side * (5.5 + i * 1.35), 1.75, -2.5); foundry.add(tower);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(.34, .34, 2.1, 12), furnace); core.position.copy(tower.position); foundry.add(core);
  }
  for (let i = -4; i <= 4; i++) { const beam = new THREE.Mesh(new THREE.BoxGeometry(.16, .16, 8), steel); beam.position.set(i * 2.1, 4.3, -1.5); beam.rotation.z = i * .025; foundry.add(beam); }
  for (const z of [-1.6, 0, 1.6]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(18, .025, .08), furnace); strip.position.set(0, .035, z); foundry.add(strip);
  }
  const reactor = new THREE.Mesh(new THREE.TorusGeometry(2.2, .2, 12, 64), furnace); reactor.position.set(0, 2.5, -4.2); foundry.add(reactor);
  const reactorCore = new THREE.Mesh(new THREE.CircleGeometry(1.55, 48), new THREE.MeshBasicMaterial({ color: 0xff6b35, transparent: true, opacity: .75, side: THREE.DoubleSide })); reactorCore.position.set(0, 2.5, -4.18); foundry.add(reactorCore);
  const foundryLight = new THREE.PointLight(0xff3b1f, 55, 18, 1.7); foundryLight.position.set(0, 3.2, -1); foundry.add(foundryLight);
  const voidMetal = new THREE.MeshStandardMaterial({ color: 0x10172b, emissive: 0x163a55, emissiveIntensity: 1.2, metalness: .85, roughness: .22 });
  const holo = new THREE.MeshBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: .7, side: THREE.DoubleSide });
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
    const monolith = new THREE.Mesh(new THREE.BoxGeometry(.6, 3.5 + i * .4, .8), voidMetal); monolith.position.set(side * (4.6 + i * 1.55), 1.8 + i * .2, -2.8); monolith.rotation.z = side * .08; voidStage.add(monolith);
  }
  for (const radius of [4.2, 6.2, 8.2]) { const halo = new THREE.Mesh(new THREE.TorusGeometry(radius, .025, 6, 96), holo); halo.rotation.x = Math.PI / 2; halo.position.y = .03; voidStage.add(halo); }
  const starGeometry = new THREE.BufferGeometry(), starPositions = new Float32Array(900);
  for (let i = 0; i < starPositions.length; i += 3) { starPositions[i] = (Math.random() - .5) * 35; starPositions[i + 1] = Math.random() * 14 + 2; starPositions[i + 2] = -4 - Math.random() * 12; }
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  voidStage.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0xbcecff, size: .055, transparent: true, opacity: .85 })));
  const key = new THREE.DirectionalLight(0xfff1e6, 4.4); key.position.set(-1, 7, 5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -6; key.shadow.camera.right = 6; key.shadow.camera.top = 5; key.shadow.camera.bottom = -1;
  const red = new THREE.SpotLight(0xef223a, 70, 14, .62, .8); red.position.set(-5, 5, 1); red.target.position.set(-1, 0, 0);
  const cyan = new THREE.SpotLight(0x2dd4bf, 55, 14, .62, .8); cyan.position.set(5, 4, -1); cyan.target.position.set(1, 0, 0);
  scene.add(key, red, red.target, cyan, cyan.target, new THREE.HemisphereLight(0x9db7d4, 0x11080d, 1.5)); return { ring, floor, red, procedural, foundry, voidStage };
}

for (const button of commandButtons) button.addEventListener('click', () => connection.command(button.dataset.command as FighterCommand));
const keyCommands: Record<string, FighterCommand> = { a: 'back', d: 'forward', w: 'jump', ' ': 'jump', j: 'punch', k: 'kick', l: 'block' };
addEventListener('keydown', event => {
  if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || isInteractiveShortcutTarget(event.target)) return;
  const key = event.key.toLowerCase(), command = keyCommands[key]; let handled = false;
  if (state?.phase === 'fight' && command) { connection.command(command); handled = true; }
  else if (key === 'p') { toggleLocalPlayer(); handled = true; }
  else if (key === 'enter' && isHost) { connection.advance(); handled = true; }
  else if (key === 'backspace' && isHost) { connection.back(); handled = true; }
  else if (/^\d$/.test(key) && (state?.phase === 'fighter_select' || state?.phase === 'map_select')) { handleNumericSelection(key); handled = true; }
  if (handled) event.preventDefault();
});
function handleNumericSelection(key: string): void {
  const entries = state?.phase === 'fighter_select' ? roster : maps;
  const next = resolveNumericSelection(numericBuffer, key, entries.length); numericBuffer = next.buffer;
  if (numericTimer) clearTimeout(numericTimer);
  const select = (number: number) => {
    const id = entries[number - 1]?.id; if (!id) return;
    if (state?.phase === 'fighter_select' && (isHost || playerId)) connection.selectFighter(id);
    else if (state?.phase === 'map_select' && isHost) connection.selectMap(id);
  };
  if (next.selection) select(next.selection);
  else if (next.waiting) numericTimer = setTimeout(() => {
    const value = Number(numericBuffer); numericBuffer = ''; numericTimer = null;
    if (value >= 1 && value <= entries.length) select(value);
  }, 450);
}
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; updateCameraProjection(); renderer.setSize(innerWidth, innerHeight);
  if (mapModel && customMapStatic) captureMapBackdrop();
});
rematch.addEventListener('click', () => connection.advance());
for (const link of document.querySelectorAll<HTMLAnchorElement>('.game-home, #result a[href="/"]')) {
  link.addEventListener('click', event => {
    event.preventDefault(); connection.leaveAndClose(roomCode); setTimeout(() => { location.href = '/'; }, 60);
  });
}

function render(now: number): void {
  requestAnimationFrame(render); const delta = Math.min((now - lastTime) / 1000, .05); lastTime = now;
  updateMovement(delta); if (actors) {
    actors.p1.update(delta); actors.p2.update(delta);
    if (state?.phase === 'intro') { updateIntroPresentation(state); renderer.render(scene, camera); return; }
    if (customMapStatic) { renderer.render(scene, camera); return; }
    const midpoint = (displayX.p1 + displayX.p2) / 2, separation = Math.abs(displayX.p1 - displayX.p2);
    const angle = THREE.MathUtils.degToRad(mapPlane.rotationY); cameraAxis.set(Math.cos(angle), 0, -Math.sin(angle));
    cameraTarget.set(...cameraBase.lookAt).addScaledVector(cameraAxis, midpoint);
    cameraView.set(cameraBase.pos[0] - cameraBase.lookAt[0], cameraBase.pos[1] - cameraBase.lookAt[1], cameraBase.pos[2] - cameraBase.lookAt[2]);
    const baseDistance = cameraView.length(), targetDistance = Math.max(baseDistance, Math.min(baseDistance + 9, baseDistance - 2 + separation * .72));
    cameraDesired.copy(cameraTarget).add(cameraView.normalize().multiplyScalar(targetDistance));
    camera.position.lerp(cameraDesired, Math.min(1, delta * 3)); camera.lookAt(cameraTarget);
  }
  renderer.render(scene, camera);
}
void initialize(); requestAnimationFrame(render);
