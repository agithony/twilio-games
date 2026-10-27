import * as THREE from 'three';
import QRCode from 'qrcode';
import { DEFAULT_ROOM } from '../../shared/constants';
import type { OwlActionEvent, OwlEvent, OwlState, OwlReagent, OwlRoomMode } from '../../shared/owl-protocol';
import { locale } from '../i18n';
import { createStationDisplay } from '../station-display';
import { rejectDisplayToken, watchVoiceNumber } from '../station-client';
import { OwlCharacter } from './character';
import { OwlConnection, owlWebSocketUrl, type OwlConnectionState } from './owl-net';
import { TalkingOwlWorld } from './world';

type Room = 'study' | 'lab';

function required<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Talking Owl is missing ${selector}`);
  return element;
}

const canvas = required<HTMLCanvasElement>('#scene-canvas');
const speech = required<HTMLElement>('#speech-text');
const sceneName = required<HTMLElement>('#scene-name');
const callPanel = required<HTMLElement>('#call-panel');
const callStatus = required<HTMLElement>('#call-status');
const labPanel = required<HTMLElement>('#lab-panel');
const labResult = document.querySelector<HTMLElement>('#lab-result');
const labInspectButton = required<HTMLButtonElement>('#lab-inspect-button');
const labInspectName = required<HTMLElement>('#lab-inspect-name');
const mixButton = required<HTMLButtonElement>('#mix-button');
const hangupButton = required<HTMLButtonElement>('#hangup-button');
const sayInput = document.querySelector<HTMLInputElement>('#say-input');
const sayButton = document.querySelector<HTMLButtonElement>('#say-button');
const sayForm = document.querySelector<HTMLFormElement>('#say-form');
const recordIndicator = required<HTMLElement>('#record-indicator');
const recordTime = required<HTMLElement>('#record-time');
const toast = required<HTMLElement>('#toast');
const loadingScreen = document.querySelector<HTMLElement>('#loading-screen');
const fullscreenButton = document.querySelector<HTMLButtonElement>('#fullscreen-button');
const liveCallCard = required<HTMLElement>('#live-call-card');
const liveCallTitle = required<HTMLElement>('#live-call-title');
const liveCallDescription = required<HTMLElement>('#live-call-description');
const liveCallEyebrow = required<HTMLElement>('#live-call-eyebrow');
const liveConnection = required<HTMLElement>('#live-connection');
const liveCallDial = required<HTMLElement>('#live-call-dial');
const liveCallNumberLabel = required<HTMLElement>('#live-call-number-label');
const liveCallNumber = required<HTMLAnchorElement>('#live-call-number');
const liveCallNumberFallback = required<HTMLElement>('#live-call-number-fallback');
const liveCallQr = required<HTMLImageElement>('#live-call-qr');
const liveCallQrFallback = required<HTMLElement>('#live-call-qr-fallback');
const liveCallSteps = required<HTMLElement>('#live-call-steps');
const liveCallResult = required<HTMLElement>('#live-call-result');
const liveCallChip = required<HTMLButtonElement>('#live-call-chip');
const liveCallChipText = required<HTMLElement>('#live-call-chip-text');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const params = new URLSearchParams(location.search);
const roomCode = params.get('room') || DEFAULT_ROOM;
const stationLaunchRequested = params.has('station') || params.has('match') || params.has('launchGeneration');
const stationDisplay = createStationDisplay();
const stationManaged = stationLaunchRequested || stationDisplay.active;
const displayMode = params.get('display') === '1' || stationManaged;
const isPortuguese = locale === 'pt-BR';
document.body.dataset.displayMode = String(displayMode);

const liveCopy = isPortuguese ? {
  eyebrow: 'Jogo por telefone ao vivo', connecting: 'Conectando…', connected: 'Ao vivo', reconnecting: 'Reconectando…', closed: 'Sem conexão',
  waitingTitle: 'Ligue para o Talking Owl', waitingDescription: 'Escaneie para ligar. O Owl vai perguntar seu nome.',
  namingTitle: 'Quem está ligando?', namingDescription: 'O Owl está pedindo seu nome pelo telefone.',
  playingTitle: 'A conversa começou', playingDescription: 'Fale, faça perguntas e peça ao Owl para reagir.',
  finishedTitle: 'Até a próxima!', finishedDescription: 'O Owl está pronto para outra visita.',
  stationWaiting: 'Aguardando a ligação da estação.', numberLabel: 'Ou disque', numberLoading: 'Buscando número…',
  numberMissing: 'Número indisponível nesta estação.', qrLoading: 'Buscando número…', qrMissing: 'QR indisponível',
  waitingChip: 'O Owl está esperando', namingChip: 'O Owl está pedindo um nome', listeningChip: 'O Owl está ouvindo',
  askOnPhone: 'Peça ao Owl pelo telefone.', pairingError: 'Esta tela precisa ser vinculada novamente à estação.',
  result: (name: string, count: number) => `${name} fez o Owl reagir ${count} ${count === 1 ? 'vez' : 'vezes'}.`,
} : {
  eyebrow: 'A live phone game', connecting: 'Connecting…', connected: 'Live', reconnecting: 'Reconnecting…', closed: 'Offline',
  waitingTitle: 'Call Talking Owl', waitingDescription: 'Scan to call. Owl will ask your name.',
  namingTitle: 'Who is calling?', namingDescription: 'Owl is asking your name on the phone.',
  playingTitle: 'The conversation is live', playingDescription: 'Talk, ask questions, and invite Owl to react.',
  finishedTitle: 'Until next time!', finishedDescription: 'Owl is ready for another visitor.',
  stationWaiting: 'Waiting for the station call.', numberLabel: 'Or dial', numberLoading: 'Finding the number…',
  numberMissing: 'The call number is unavailable.', qrLoading: 'Finding the number…', qrMissing: 'QR unavailable',
  waitingChip: 'Owl is waiting', namingChip: 'Owl is asking a name', listeningChip: 'Owl is listening',
  askOnPhone: 'Ask Owl over the phone.', pairingError: 'This display needs to be paired with the station again.',
  result: (name: string, count: number) => `${name} made Owl react ${count} ${count === 1 ? 'time' : 'times'}.`,
};

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
} catch {
  if (loadingScreen) {
    loadingScreen.textContent = 'This scene needs WebGL. Try an up-to-date browser with graphics acceleration enabled.';
  }
  throw new Error('WebGL is unavailable');
}

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.setClearColor(0x122b38);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x122b38);
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
camera.position.set(0, 3.45, 8.8);
camera.lookAt(0, 1.65, 0);

const sky = new THREE.HemisphereLight(0xe4f3fa, 0x263843, 2.15);
scene.add(sky);
const key = new THREE.DirectionalLight(0xffe0ae, 2.7);
key.position.set(-3.8, 6.8, 5.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -7;
key.shadow.camera.right = 7;
key.shadow.camera.top = 7;
key.shadow.camera.bottom = -7;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 20;
key.shadow.normalBias = 0.025;
key.shadow.bias = -0.0001;
scene.add(key);
const fill = new THREE.DirectionalLight(0x8dccdc, 1.05);
fill.position.set(5, 3, 5);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xd2f6ec, 1.15);
rim.position.set(1, 5, -4);
scene.add(rim);

const world = new TalkingOwlWorld();
const owl = new OwlCharacter();
scene.add(world.group, owl.group);

let room: Room = 'study';
let paperOpen = false;
let callState: 'idle' | 'ringing' | 'connected' = 'idle';
let remoteCall = false;
let remoteSpeakerphone = false;
let remoteNameConfirmed = false;
let remoteActionQueue: OwlActionEvent[] = [];
let remoteNextActionAt = 0;
let latestOwlState: OwlState | null = null;
let owlConnection: OwlConnection | null = null;
let owlConnectionState: OwlConnectionState = 'connecting';
let liveTransportError = '';
let lastOwlGeneration = -1;
let lastOwlSequence = 0;
let phoneNumber = '';
let phoneQrGeneration = 0;
let stopVoiceNumberUpdates: (() => void) | null = null;
let liveCardOpen = true;
let liveVisualPhase: 'waiting' | 'naming' | 'playing' | 'finished' | null = null;
let hasRenderedFirstFrame = false;
let hasReceivedRoomState = false;
let hasMarkedStationReady = false;
let callReadyAt = 0;
let callReactionEndAt: number | undefined;
let deskReceiverLifted = false;
let pendingPropAction: 'snack' | 'drink' | null = null;
let pendingPropSpeech: { action: 'eat' | 'sip'; line: string } | null = null;
let labRevealTimer: number | undefined;
let speechTimer: number | undefined;
let toastTimer: number | undefined;
let recordingStarted = 0;
let recorder: MediaRecorder | null = null;
let recordingStream: MediaStream | null = null;
let recordingChunks: Blob[] = [];
const chosenReagents: string[] = [];
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const cameraDrift = new THREE.Vector2();
const cameraDriftTarget = new THREE.Vector2();
const clock = new THREE.Clock();
let elapsed = 0;

const lines: Record<string, string[]> = {
  newspaper: [
    'I was at the interesting part.',
    'The paper will not read itself.',
    'Is this urgent? It had better be.',
  ],
  newspaperOpen: [
    'Now, where was I?',
    'The Evening Hoot has news.',
    'Just one more page.',
  ],
  poke: [
    'Yes, I am awake.',
    'I have noticed your finger.',
    'We have established that I am here.',
  ],
  tickle: ['Hah! Careful with the feathers.', 'I am not laughing. You are.', 'All right, that was funny.'],
  snack: ['Acceptable.', 'You may stay.', 'The biscuit changes nothing. Almost.'],
  drink: ['A respectable vintage.', 'That hits the spot.', 'One more sip. For science.'],
  burp: ['Ahem.', 'The acoustics in here are excellent.', 'That was the chair.'],
  yes: ['Yes.', 'I suppose so.', 'If you insist.'],
  no: ['No.', 'Absolutely not.', 'Ask again when I have finished reading.'],
  laugh: ['Heh heh heh.', 'That is absurd. I like it.', 'Ha! Unexpected.'],
  wave: ['A wave, just for you.', 'Hello again, from this very chair.', 'One wing is occupied, you know.'],
  ponder: ['Hmm. Let me think about that.', 'A curious question deserves a curious answer.', 'My very best thinking face.'],
  gasp: ['Good heavens!', 'Well, I did not expect that.', 'That changes everything. Perhaps.'],
  dance: ['I do have a little rhythm.', 'One, two, flap, flap.', 'This dance stays between us.'],
  snooze: ['Zzz... Oh, you are still there.', 'Five more minutes, please.', 'I was only resting my eyes.'],
  sing: ['Hoo hoo hoo... no requests.', 'Ahem. My midnight masterpiece.', 'I know all the old tunes.'],
  wink: ['Did you catch that?', 'A secret just for you.', 'The other eye is off duty.'],
  shrug: ['What can an owl do?', 'Your guess is as good as mine.', 'I have no explanation.'],
  salute: ['At your service. Briefly.', 'Consider that official.', 'Reporting from the armchair.'],
  scratch: ['Ah, there it is.', 'An itchy thought.', 'Hold the line while I think.'],
  yawn: ['Excuse the yawn.', 'It has been a long evening.', 'You are keeping me up.'],
  hush: ['Shhh. A secret.', 'Lower your voice, please.', 'The wallpaper is listening.'],
  cheer: ['Hooray!', 'That deserves a little celebration.', 'Well done, you.'],
  shiver: ['Brr. Did the room get cold?', 'A strange little chill.', 'I felt that in my feathers.'],
  bow: ['A bow, just for you.', 'Thank you. Thank you.', 'I remain gracious.'],
  sneeze: ['Achoo! Excuse me.', 'Ahem. Feather dust in the study.', 'The pepper is at it again.'],
  portrait: ['I looked very scholarly, did I not?', 'My finest feather day.', 'Please do not tilt the portrait.'],
};
const lineCursor = new Map<string, number>();
const callReactions: Record<string, { status: string; duration: number }> = {
  yes: { status: 'Talking Owl nods', duration: 1150 },
  no: { status: 'Talking Owl shakes their head', duration: 1250 },
  laugh: { status: 'Talking Owl laughs', duration: 1850 },
  wave: { status: 'Talking Owl waves a wing', duration: 1700 },
  ponder: { status: 'Talking Owl thinks it over', duration: 2300 },
  gasp: { status: 'Talking Owl is surprised', duration: 1500 },
  dance: { status: 'Talking Owl dances', duration: 2750 },
  snooze: { status: 'Talking Owl dozes off', duration: 2750 },
  sing: { status: 'Talking Owl hoots a tune', duration: 2750 },
  wink: { status: 'Talking Owl winks', duration: 1350 },
  shrug: { status: 'Talking Owl shrugs', duration: 1800 },
  salute: { status: 'Talking Owl salutes', duration: 1550 },
  scratch: { status: 'Talking Owl preens a feather', duration: 1850 },
  yawn: { status: 'Talking Owl yawns', duration: 2250 },
  hush: { status: 'Talking Owl shares a secret', duration: 1650 },
  cheer: { status: 'Talking Owl cheers', duration: 2000 },
  shiver: { status: 'Talking Owl shivers', duration: 1750 },
  bow: { status: 'Talking Owl takes a bow', duration: 1950 },
  sneeze: { status: 'Talking Owl sneezes', duration: 1550 },
};
const callTabs = ['replies', 'reactions', 'gestures', 'faces'] as const;
type CallTab = typeof callTabs[number];
const callPropActions = new Set(['newspaper', 'snack', 'feed', 'drink']);
const ringingInterruptions = new Set(['newspaper', 'poke', 'tickle', 'snack', 'feed', 'drink', 'burp', 'portrait']);

function nextLine(action: string): string {
  const variants = lines[action] ?? ['Hmm.'];
  const index = lineCursor.get(action) ?? 0;
  lineCursor.set(action, index + 1);
  return variants[index % variants.length] ?? variants[0] ?? 'Hmm.';
}

function say(message: string, duration = 4300): void {
  window.clearTimeout(speechTimer);
  speech.textContent = message;
  const bubble = speech.closest<HTMLElement>('.speech-bubble');
  bubble?.classList.remove('is-speaking');
  // Restart the speech animation when the owl has something new to say.
  void bubble?.offsetWidth;
  bubble?.classList.add('is-speaking');
  speechTimer = window.setTimeout(() => bubble?.classList.remove('is-speaking'), duration);
}

function notice(message: string, duration = 2800): void {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, duration);
}

function setCallTab(tab: CallTab): void {
  callPanel.dataset.activeTab = tab;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-call-tab]')) {
    const selected = button.dataset.callTab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-call-panel]')) {
    panel.hidden = panel.dataset.callPanel !== tab;
  }
}

function setCallControlsEnabled(enabled: boolean): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-call-panel] [data-action]')) {
    button.disabled = !enabled;
  }
}

function syncDockAvailability(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('.action-dock__reactions [data-action]')) {
    const action = button.dataset.action ?? '';
    const unavailable = (displayMode && remoteCall)
      || callState === 'ringing' || (callState === 'connected' && callPropActions.has(action));
    button.setAttribute('aria-disabled', String(unavailable));
    button.dataset.defaultTitle ??= button.title;
    button.title = unavailable
      ? remoteCall ? liveCopy.askOnPhone : callState === 'ringing' ? 'Let Talking Owl answer first' : 'Available after the call'
      : button.dataset.defaultTitle;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="lab"]')) {
    button.setAttribute('aria-disabled', String(displayMode && remoteCall));
  }
  renderReagents();
}

function stowReceiverForSpeakerphone(): void {
  if (!remoteCall || remoteSpeakerphone) return;
  owl.trigger('hangup');
  world.trigger('hangup');
  remoteSpeakerphone = true;
  deskReceiverLifted = false;
  callReadyAt = 0;
  callState = 'connected';
  syncDockAvailability();
}

function setRoom(next: Room, options: { remote?: boolean; silent?: boolean } = {}): void {
  if (callState !== 'idle' && !options.remote) endCall();
  if (next === 'lab' && options.remote) stowReceiverForSpeakerphone();
  window.clearTimeout(labRevealTimer);
  document.body.classList.remove('lab-reveal');
  room = next;
  document.body.dataset.scene = next;
  world.setMode(next);
  labPanel.hidden = next !== 'lab';
  labInspectButton.hidden = true;
  sceneName.textContent = next === 'lab' ? 'The lab' : 'The study';
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="lab"]')) {
    button.setAttribute('aria-pressed', String(next === 'lab'));
    button.setAttribute('aria-expanded', String(next === 'lab'));
    button.setAttribute('aria-label', next === 'lab' ? 'Return to Talking Owl’s study' : 'Open Talking Owl’s lab');
    const label = button.querySelector<HTMLElement>('[data-action-label]');
    if (label) label.textContent = next === 'lab' ? 'Study' : 'Lab';
  }
  if (next === 'lab') {
    owl.trigger('surprise');
    paperOpen = false;
    if (!options.silent) say('Ah. Now we are talking chemistry.');
  } else {
    if (!options.silent) say('Back to the study.');
    chosenReagents.length = 0;
    renderReagents();
  }
}

function startCall(interruptedReading = false, source: 'preview' | 'live' = 'preview'): void {
  if (room === 'lab') setRoom('study');
  if (callState !== 'idle') return;
  remoteCall = source === 'live';
  remoteSpeakerphone = false;
  callState = 'ringing';
  deskReceiverLifted = false;
  syncDockAvailability();
  document.body.classList.add('is-calling');
  document.body.classList.toggle('is-live-call', remoteCall);
  callPanel.hidden = remoteCall;
  callStatus.textContent = 'Ringing…';
  callPanel.dataset.revealing = 'false';
  setCallTab('replies');
  setCallControlsEnabled(false);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="call"]')) {
    button.setAttribute('aria-expanded', 'true');
  }
  if (sayInput) sayInput.disabled = true;
  if (sayButton) sayButton.disabled = true;
  world.trigger('call');
  owl.trigger('call');
  paperOpen = false;
  if (!remoteCall) say('Who could that be?', 2100);
  callReadyAt = elapsed + (interruptedReading ? 1.75 : reducedMotion.matches ? 0.7 : 1.35);
  if (remoteCall) renderLiveCallUI();
}

function completeCallPickup(): void {
  if (callState !== 'ringing') return;
  callState = 'connected';
  syncDockAvailability();
  callStatus.textContent = remoteCall
    ? remoteNameConfirmed ? 'Talking Owl is listening' : 'Talking Owl is asking your name'
    : 'Talking Owl picked up';
  if (sayInput) sayInput.disabled = remoteCall;
  if (sayButton) sayButton.disabled = remoteCall;
  setCallControlsEnabled(!remoteCall);
  if (!deskReceiverLifted) {
    world.trigger('answer');
    deskReceiverLifted = true;
  }
  owl.trigger('listen');
  if (!remoteCall) say('Hello? Yes, I can hear you.');
  else renderLiveCallUI();
}

function endCall(): void {
  if (callState === 'idle') return;
  const wasRemote = remoteCall;
  callReadyAt = 0;
  callReactionEndAt = undefined;
  deskReceiverLifted = false;
  callState = 'idle';
  remoteCall = false;
  remoteSpeakerphone = false;
  remoteNameConfirmed = false;
  remoteActionQueue = [];
  syncDockAvailability();
  document.body.classList.remove('is-calling', 'is-live-call');
  callPanel.hidden = true;
  callPanel.dataset.revealing = 'false';
  setCallControlsEnabled(false);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="call"]')) {
    button.setAttribute('aria-expanded', 'false');
  }
  world.trigger('hangup');
  owl.trigger('hangup');
  paperOpen = false;
  if (!wasRemote) say('Click. Peace and quiet.');
  else renderLiveCallUI();
}

function repeatTypedLine(): void {
  if (callState !== 'connected') return;
  const message = sayInput?.value.trim();
  if (!message) { notice('Type something for Talking Owl to repeat.'); return; }
  callPanel.dataset.revealing = 'true';
  owl.trigger('talk');
  callStatus.textContent = 'Talking Owl repeats you';
  say(message.slice(0, 120), Math.min(6400, Math.max(2500, message.length * 70)));
  if (sayInput) sayInput.value = '';
  callReactionEndAt = elapsed + 2.4;
}

function reactToCall(action: string): void {
  const reaction = callReactions[action];
  if (callState !== 'connected' || !reaction) return;
  callPanel.dataset.revealing = 'true';
  owl.trigger(action);
  callStatus.textContent = reaction.status;
  say(nextLine(action), Math.max(3600, reaction.duration + 900));
  callReactionEndAt = elapsed + reaction.duration / 1000;
}

function renderReagents(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-reagent]')) {
    const selected = chosenReagents.includes(button.dataset.reagent ?? '');
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = displayMode && remoteCall;
  }
  mixButton.disabled = chosenReagents.length !== 2 || (displayMode && remoteCall);
}

function chooseReagent(reagent: string): void {
  if (displayMode && remoteCall) { notice(liveCopy.askOnPhone); return; }
  if (room !== 'lab') setRoom('lab');
  const previous = chosenReagents.indexOf(reagent);
  if (previous >= 0) chosenReagents.splice(previous, 1);
  else {
    if (chosenReagents.length === 2) chosenReagents.shift();
    chosenReagents.push(reagent);
  }
  renderReagents();
}

function mix(reagents?: readonly [OwlReagent, OwlReagent], spokenLine?: string): void {
  if (displayMode && remoteCall && !reagents) { notice(liveCopy.askOnPhone); return; }
  if (reagents) {
    if (room !== 'lab') setRoom('lab', { remote: true, silent: true });
    chosenReagents.splice(0, chosenReagents.length, ...reagents);
    renderReagents();
  }
  if (chosenReagents.length !== 2) {
    notice('Choose two ingredients first.');
    return;
  }
  const result = world.mixIngredients(chosenReagents[0]!, chosenReagents[1]!);
  owl.trigger('mix');
  say(spokenLine || result.quip, 5200);
  document.body.style.setProperty('--mix-accent', result.accent);
  if (labResult) {
    labResult.textContent = result.title;
    labResult.hidden = false;
  }
  labInspectName.textContent = result.title;
  document.body.classList.remove('mix-flash');
  void document.body.offsetWidth;
  document.body.classList.add('mix-flash');
  window.setTimeout(() => document.body.classList.remove('mix-flash'), 1300);
  window.clearTimeout(labRevealTimer);
  document.body.classList.remove('lab-reveal');
  void document.body.offsetWidth;
  document.body.classList.add('lab-reveal');
  labRevealTimer = window.setTimeout(() => {
    document.body.classList.remove('lab-reveal');
    if (room === 'lab') {
      labPanel.hidden = true;
      labInspectButton.hidden = false;
    }
  }, 3400);
  chosenReagents.length = 0;
  renderReagents();
}

function startRecording(): void {
  if (!('captureStream' in canvas) || !('MediaRecorder' in window)) {
    notice('Video capture is unavailable in this browser.');
    return;
  }
  const mimeType = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ].find(type => MediaRecorder.isTypeSupported(type));
  try {
    recordingStream = canvas.captureStream(30);
    recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
  } catch {
    recordingStream?.getTracks().forEach(track => track.stop());
    recordingStream = null;
    notice('Could not start a video capture.');
    return;
  }
  recordingChunks = [];
  recorder.addEventListener('dataavailable', event => {
    if (event.data.size) recordingChunks.push(event.data);
  });
  recorder.addEventListener('stop', () => {
    recordIndicator.hidden = true;
    document.body.classList.remove('is-recording');
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="record"]')) {
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', 'Record a clip');
    }
    recordingStream?.getTracks().forEach(track => track.stop());
    recordingStream = null;
    const clip = new Blob(recordingChunks, { type: recorder?.mimeType || 'video/webm' });
    recordingChunks = [];
    if (!clip.size) { notice('The recording was empty.'); return; }
    const url = URL.createObjectURL(clip);
    const link = document.createElement('a');
    link.href = url;
    link.download = `talking-owl-scene-${new Date().toISOString().slice(0, 10)}.${clip.type.includes('mp4') ? 'mp4' : 'webm'}`;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    notice('Your scene clip is ready.');
  }, { once: true });
  recorder.start();
  recordingStarted = performance.now();
  recordIndicator.hidden = false;
  document.body.classList.add('is-recording');
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="record"]')) {
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('aria-label', 'Stop recording and save clip');
  }
  notice('Recording the scene. Select Record again to save it.');
}

function toggleRecording(): void {
  if (recorder?.state === 'recording') { recorder.stop(); return; }
  startRecording();
}

function act(action: string): void {
  if (displayMode && action === 'call') {
    liveCardOpen = !liveCardOpen;
    renderLiveCallUI();
    return;
  }
  if (displayMode && remoteCall && action !== 'record' && action !== 'lamp') {
    notice(liveCopy.askOnPhone);
    return;
  }
  if (callState === 'ringing' && ringingInterruptions.has(action)) {
    notice('Let Talking Owl answer first.');
    return;
  }
  if (callState === 'connected' && callPropActions.has(action)) {
    notice('Finish the call to use that prop.');
    return;
  }
  // A new character action replaces the held treat or mug. Put the table prop
  // back immediately so interruptions never leave a duplicate or empty table.
  if (action !== 'record' && action !== 'lamp') {
    pendingPropAction = null;
    pendingPropSpeech = null;
    world.cancelPropActions();
  }
  const interruptedReading = paperOpen;
  if (action !== 'newspaper' && paperOpen && action !== 'record' && action !== 'lab') {
    paperOpen = false;
    owl.trigger('newspaper');
    world.trigger('newspaper');
  }
  switch (action) {
    case 'newspaper':
      paperOpen = !paperOpen;
      owl.trigger('newspaper');
      world.trigger('newspaper');
      say(nextLine(paperOpen ? 'newspaperOpen' : 'newspaper'));
      break;
    case 'poke':
      owl.trigger('poke');
      say(nextLine('poke'));
      break;
    case 'tickle':
      owl.trigger('tickle');
      say(nextLine('tickle'));
      break;
    case 'snack':
    case 'feed':
      owl.trigger('eat');
      pendingPropAction = 'snack';
      pendingPropSpeech = { action: 'eat', line: nextLine('snack') };
      break;
    case 'drink':
      owl.trigger('sip');
      pendingPropAction = 'drink';
      pendingPropSpeech = { action: 'sip', line: nextLine('drink') };
      break;
    case 'burp':
      owl.trigger('burp');
      world.trigger('burp');
      say(nextLine('burp'));
      break;
    case 'portrait':
      owl.trigger('poke');
      world.trigger('portrait');
      say(nextLine('portrait'));
      break;
    case 'lamp':
      world.trigger('lamp');
      say('A little more atmosphere.');
      break;
    case 'mix':
      mix();
      break;
    case 'call':
      if (callState === 'idle') startCall(interruptedReading); else endCall();
      break;
    case 'lab':
      setRoom(room === 'study' ? 'lab' : 'study');
      break;
    case 'record':
      toggleRecording();
      break;
    case 'yes':
    case 'no':
    case 'laugh':
    case 'wave':
    case 'ponder':
    case 'gasp':
    case 'dance':
    case 'snooze':
    case 'sing':
    case 'wink':
    case 'shrug':
    case 'salute':
    case 'scratch':
    case 'yawn':
    case 'hush':
    case 'cheer':
    case 'shiver':
    case 'bow':
    case 'sneeze':
      reactToCall(action);
      break;
  }
}

function readablePhoneNumber(number: string): string {
  const compact = number.replace(/[\s().-]/g, '');
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(compact);
  return us ? `+1 (${us[1]}) ${us[2]}-${us[3]}` : number;
}

function updateVoiceNumber(number: string): void {
  const next = number.trim();
  if (next === phoneNumber && liveCallQr.src) return;
  phoneNumber = next;
  const generation = ++phoneQrGeneration;
  liveCallQr.hidden = true;
  liveCallQr.removeAttribute('src');
  liveCallNumber.hidden = !next;
  liveCallNumberFallback.hidden = !!next;
  liveCallNumberFallback.textContent = next ? '' : liveCopy.numberMissing;
  liveCallQrFallback.hidden = false;
  liveCallQrFallback.textContent = next ? liveCopy.qrLoading : liveCopy.qrMissing;
  if (!next) return;
  const dial = `tel:${next.replace(/[^\d+*#]/g, '')}`;
  liveCallNumber.href = dial;
  liveCallNumber.textContent = readablePhoneNumber(next);
  void QRCode.toDataURL(dial, {
    width: 420, margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#102e3b', light: '#ffffff' },
  }).then(value => {
    if (generation !== phoneQrGeneration) return;
    liveCallQr.src = value;
    liveCallQr.hidden = false;
    liveCallQrFallback.hidden = true;
  }).catch(() => {
    if (generation !== phoneQrGeneration) return;
    liveCallQrFallback.textContent = liveCopy.qrMissing;
  });
}

function visualLivePhase(): 'waiting' | 'naming' | 'playing' | 'finished' {
  if (latestOwlState?.phase === 'finished') return 'finished';
  if (latestOwlState?.caller?.connected && !latestOwlState.caller.nameConfirmed) return 'naming';
  if (latestOwlState?.phase === 'playing' && latestOwlState.caller) {
    return latestOwlState.caller.nameConfirmed ? 'playing' : 'naming';
  }
  return 'waiting';
}

function renderLiveCallUI(): void {
  if (!displayMode) return;
  const phase = visualLivePhase();
  if (liveVisualPhase !== phase) {
    liveVisualPhase = phase;
    liveCardOpen = stationManaged ? phase === 'naming' || phase === 'finished' : phase !== 'playing';
  }
  const caller = latestOwlState?.caller;
  const name = caller?.nameConfirmed ? caller.name : null;
  liveCallCard.dataset.phase = phase;
  liveCallCard.dataset.connection = owlConnectionState;
  liveCallCard.hidden = !liveCardOpen;
  liveCallChip.hidden = !stationManaged && phase !== 'playing';
  liveConnection.textContent = liveCopy[owlConnectionState];
  liveCallEyebrow.textContent = liveCopy.eyebrow;
  liveCallNumberLabel.textContent = liveCopy.numberLabel;
  liveCallDial.hidden = stationManaged || phase === 'naming' || phase === 'playing' || !!liveTransportError;
  liveCallSteps.hidden = stationManaged || phase !== 'waiting' || !!liveTransportError;
  liveCallResult.hidden = phase !== 'finished' || !latestOwlState?.result;
  if (latestOwlState?.result && phase === 'finished') {
    liveCallResult.textContent = liveCopy.result(latestOwlState.result.name, latestOwlState.result.interactionCount);
  }
  if (liveTransportError) {
    liveCallTitle.textContent = isPortuguese ? 'Ligação indisponível' : 'Call unavailable';
    liveCallDescription.textContent = liveTransportError;
    liveCallCard.hidden = false;
    liveCallChip.hidden = true;
  } else if (phase === 'naming') {
    liveCallTitle.textContent = liveCopy.namingTitle;
    liveCallDescription.textContent = liveCopy.namingDescription;
  } else if (phase === 'playing') {
    liveCallTitle.textContent = liveCopy.playingTitle;
    liveCallDescription.textContent = name
      ? isPortuguese ? `${name} está na linha. ${liveCopy.playingDescription}` : `${name} is on the line. ${liveCopy.playingDescription}`
      : liveCopy.playingDescription;
  } else if (phase === 'finished') {
    liveCallTitle.textContent = liveCopy.finishedTitle;
    liveCallDescription.textContent = stationManaged ? liveCopy.stationWaiting : liveCopy.finishedDescription;
  } else {
    liveCallTitle.textContent = liveCopy.waitingTitle;
    liveCallDescription.textContent = stationManaged ? liveCopy.stationWaiting : liveCopy.waitingDescription;
  }
  liveCallChipText.textContent = name
    ? isPortuguese ? `${name} conversa com o Owl` : `${name} is talking to Owl`
    : phase === 'naming' ? liveCopy.namingChip : phase === 'playing' ? liveCopy.listeningChip : liveCopy.waitingChip;
  const callButton = document.querySelector<HTMLButtonElement>('[data-action="call"]');
  if (callButton) {
    callButton.setAttribute('aria-controls', 'live-call-card');
    callButton.setAttribute('aria-expanded', String(!liveCallCard.hidden));
    callButton.setAttribute('aria-label', liveCallCard.hidden
      ? isPortuguese ? 'Mostrar detalhes da ligação' : 'Show call details'
      : isPortuguese ? 'Ocultar detalhes da ligação' : 'Hide call details');
    callButton.title = callButton.getAttribute('aria-label') ?? '';
  }
  liveCallChip.setAttribute('aria-expanded', String(!liveCallCard.hidden));
  liveCallChip.setAttribute('aria-label', liveCallCard.hidden
    ? isPortuguese ? 'Mostrar detalhes da ligação' : 'Show call details'
    : isPortuguese ? 'Ocultar detalhes da ligação' : 'Hide call details');
}

function ensureRemoteCall(mode: OwlRoomMode = 'study'): void {
  if (remoteCall) return;
  if (mode === 'lab') {
    remoteCall = true;
    remoteSpeakerphone = true;
    callState = 'connected';
    document.body.classList.add('is-calling', 'is-live-call');
    syncDockAvailability();
    if (room !== 'lab') setRoom('lab', { remote: true, silent: true });
    return;
  }
  startCall(paperOpen, 'live');
}

function remoteLine(event: OwlActionEvent, fallback: string): void {
  say(event.line.trim() || fallback, Math.min(6500, Math.max(2700, event.line.length * 76)));
}

function applyRemoteAction(event: OwlActionEvent): void {
  if (!remoteCall && event.action !== 'hangup') ensureRemoteCall(latestOwlState?.roomMode ?? 'study');
  const action = event.action;
  if (action === 'listen') {
    remoteNameConfirmed = true;
    if (!remoteSpeakerphone) owl.trigger('listen');
    callStatus.textContent = 'Talking Owl is listening';
    remoteLine(event, 'Hello! Tell me everything.');
    remoteNextActionAt = elapsed + 0.8;
    return;
  }
  if (action === 'talk') {
    owl.trigger(remoteSpeakerphone ? 'sing' : 'talk');
    callStatus.textContent = 'Talking Owl is talking';
    remoteLine(event, 'Hoo!');
    remoteNextActionAt = elapsed + 1.8;
    callReactionEndAt = elapsed + 2.4;
    return;
  }
  if (action === 'lab' || action === 'study') {
    const next = action === 'lab' ? 'lab' : 'study';
    if (room !== next) setRoom(next, { remote: true, silent: true });
    remoteLine(event, action === 'lab' ? 'To the lab!' : 'Back to the study.');
    remoteNextActionAt = elapsed + 0.85;
    return;
  }
  if (action === 'mix') {
    stowReceiverForSpeakerphone();
    if (event.reagents) mix(event.reagents, event.line);
    remoteNextActionAt = elapsed + 2.5;
    return;
  }
  if (action === 'newspaper') {
    stowReceiverForSpeakerphone();
    paperOpen = !paperOpen;
    owl.trigger('newspaper');
    world.trigger('newspaper');
    remoteLine(event, nextLine(paperOpen ? 'newspaperOpen' : 'newspaper'));
    remoteNextActionAt = elapsed + 1.5;
    return;
  }
  if (action === 'eat' || action === 'sip') {
    stowReceiverForSpeakerphone();
    owl.trigger(action);
    pendingPropAction = action === 'eat' ? 'snack' : 'drink';
    pendingPropSpeech = { action, line: event.line.trim() || nextLine(action === 'eat' ? 'snack' : 'drink') };
    remoteNextActionAt = elapsed + (action === 'eat' ? 2.45 : 2.35);
    return;
  }
  if (action === 'poke' || action === 'tickle') {
    owl.trigger(action);
    remoteLine(event, nextLine(action));
    remoteNextActionAt = elapsed + (action === 'poke' ? 0.85 : 1.5);
    return;
  }
  if (action === 'burp') {
    owl.trigger('burp');
    world.trigger('burp');
    remoteLine(event, nextLine('burp'));
    remoteNextActionAt = elapsed + 1.3;
    return;
  }
  if (action === 'portrait' || action === 'lamp') {
    if (action === 'portrait') owl.trigger('poke');
    world.trigger(action);
    remoteLine(event, nextLine(action));
    remoteNextActionAt = elapsed + 1.1;
    return;
  }
  const reaction = callReactions[action];
  if (reaction) {
    owl.trigger(action);
    callStatus.textContent = reaction.status;
    remoteLine(event, nextLine(action));
    callReactionEndAt = elapsed + reaction.duration / 1000;
    remoteNextActionAt = elapsed + reaction.duration / 1000;
  }
}

function receiveOwlEvents(events: readonly OwlEvent[]): void {
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastOwlSequence) continue;
    lastOwlSequence = event.sequence;
    if (event.type === 'finished') {
      remoteActionQueue = [];
      if (remoteCall) endCall();
      continue;
    }
    if (event.action === 'call') {
      ensureRemoteCall('study');
      remoteLine(event, 'Who could that be?');
      continue;
    }
    if (event.action === 'hangup') {
      remoteActionQueue = [];
      if (remoteCall) endCall();
      remoteLine(event, 'Click. Peace and quiet.');
      continue;
    }
    remoteActionQueue.push(event);
    // A slow display never needs an unbounded queue of already-spoken lines.
    if (remoteActionQueue.length > 24) remoteActionQueue = remoteActionQueue.slice(-24);
  }
}

let awaitingRoomSnapshot = true;
function receiveOwlState(state: OwlState): void {
  hasReceivedRoomState = true;
  if (state.generation !== lastOwlGeneration) {
    lastOwlGeneration = state.generation;
    lastOwlSequence = 0;
    remoteActionQueue = [];
  }
  if (awaitingRoomSnapshot) {
    awaitingRoomSnapshot = false;
    lastOwlSequence = Math.max(lastOwlSequence, state.lastEvent?.sequence ?? 0);
  }
  latestOwlState = state;
  const callerConnected = state.phase !== 'finished' && !!state.caller?.connected;
  if (callerConnected) {
    remoteNameConfirmed = !!state.caller?.nameConfirmed;
    ensureRemoteCall(state.roomMode);
    if (room !== state.roomMode) setRoom(state.roomMode, { remote: true, silent: true });
    if (callState === 'connected') callStatus.textContent = remoteNameConfirmed
      ? 'Talking Owl is listening' : 'Talking Owl is asking your name';
  } else if (remoteCall) {
    endCall();
  }
  renderLiveCallUI();
  maybeMarkStationReady();
}

function maybeMarkStationReady(): void {
  if (!stationDisplay.active || hasMarkedStationReady || !hasRenderedFirstFrame || !hasReceivedRoomState) return;
  hasMarkedStationReady = true;
  stationDisplay.markEngineReady();
}

function connectLiveRoom(): void {
  if (!displayMode) return;
  if (stationLaunchRequested && !stationDisplay.displayToken) {
    owlConnectionState = 'closed';
    liveTransportError = liveCopy.pairingError;
    renderLiveCallUI();
    return;
  }
  try {
    owlConnection = new OwlConnection(owlWebSocketUrl(location), roomCode,
      stationManaged ? stationDisplay.displayToken : null, locale);
    owlConnection.onState(receiveOwlState);
    owlConnection.onEvents(receiveOwlEvents);
    owlConnection.onConnection(next => {
      owlConnectionState = next;
      if (next === 'connected') {
        awaitingRoomSnapshot = true;
        liveTransportError = '';
      }
      renderLiveCallUI();
    });
    owlConnection.onError((code, message) => {
      if (code === 'bad_display_auth') {
        if (stationManaged) rejectDisplayToken(stationDisplay.displayToken);
        owlConnection?.close();
        owlConnectionState = 'closed';
        liveTransportError = stationManaged ? liveCopy.pairingError : message;
      } else liveTransportError = message;
      renderLiveCallUI();
    });
  } catch (error) {
    owlConnectionState = 'closed';
    liveTransportError = error instanceof Error ? error.message : String(error);
    renderLiveCallUI();
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
  button.addEventListener('click', () => act(button.dataset.action ?? ''));
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-reagent]')) {
  button.addEventListener('click', () => chooseReagent(button.dataset.reagent ?? ''));
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-call-tab]')) {
  const tab = button.dataset.callTab as CallTab;
  if (!callTabs.includes(tab)) continue;
  button.addEventListener('click', () => setCallTab(tab));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = callTabs.indexOf(tab);
    const next = (event.key === 'Home' ? callTabs[0]
      : event.key === 'End' ? callTabs[callTabs.length - 1]
        : callTabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + callTabs.length) % callTabs.length]) ?? 'replies';
    setCallTab(next);
    document.querySelector<HTMLButtonElement>(`[data-call-tab="${next}"]`)?.focus();
  });
}
mixButton.addEventListener('click', () => mix());
labInspectButton.addEventListener('click', () => {
  labInspectButton.hidden = true;
  labPanel.hidden = false;
  labPanel.querySelector<HTMLButtonElement>('[data-reagent]')?.focus();
});
hangupButton.addEventListener('click', endCall);
liveCallChip.addEventListener('click', () => {
  liveCardOpen = !liveCardOpen;
  renderLiveCallUI();
});
if (sayForm) sayForm.addEventListener('submit', event => {
  event.preventDefault();
  repeatTypedLine();
});
else sayButton?.addEventListener('click', repeatTypedLine);
document.querySelector<HTMLButtonElement>('#call-close-button')?.addEventListener('click', endCall);
document.querySelector<HTMLButtonElement>('#lab-close-button')?.addEventListener('click', () => {
  if (displayMode && remoteCall) { notice(liveCopy.askOnPhone); return; }
  setRoom('study');
});

fullscreenButton?.addEventListener('click', async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  if (!fullscreenButton) return;
  fullscreenButton.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen');
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (displayMode && remoteCall) {
    if (liveCardOpen) { liveCardOpen = false; renderLiveCallUI(); }
    return;
  }
  if (callState !== 'idle') endCall();
  else if (room === 'lab') setRoom('study');
});

function updatePointer(event: PointerEvent): void {
  const bounds = canvas.getBoundingClientRect();
  pointer.set(
    ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
  );
  owl.setLook(pointer.x, pointer.y);
  cameraDriftTarget.set(pointer.x * 0.17, pointer.y * 0.08);
}

function pickAction(): string | null {
  raycaster.setFromCamera(pointer, camera);
  for (const hit of raycaster.intersectObjects([owl.group, world.group], true)) {
    // Three.js can return intersections from a hidden room or a lowered prop.
    let visible: THREE.Object3D | null = hit.object;
    while (visible?.visible) visible = visible.parent;
    if (visible) continue;
    let item: THREE.Object3D | null = hit.object;
    while (item) {
      if (typeof item.userData.action === 'string') return item.userData.action;
      if (item === owl.group) return 'poke';
      item = item.parent;
    }
  }
  return null;
}

canvas.addEventListener('pointermove', event => {
  updatePointer(event);
  canvas.style.cursor = !(displayMode && remoteCall) && pickAction() ? 'pointer' : 'default';
});
canvas.addEventListener('pointerleave', () => {
  owl.setLook(0, 0);
  cameraDriftTarget.set(0, 0);
  canvas.style.cursor = 'default';
});
canvas.addEventListener('pointerdown', event => {
  updatePointer(event);
  const action = pickAction();
  if (action) act(action);
});

function resize(): void {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  camera.aspect = width / height;
  camera.fov = camera.aspect < 0.7 ? 42 : 36;
  camera.position.z = camera.aspect < 0.7 ? 9.35 : 8.8;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);
resize();
world.setMode('study');
renderReagents();
syncDockAvailability();
if (displayMode) {
  liveCallCard.hidden = false;
  liveCallNumberFallback.textContent = liveCopy.numberLoading;
  liveCallQrFallback.textContent = liveCopy.qrLoading;
  if (isPortuguese) {
    for (const [index, label] of ['Ligue para o Owl', 'Diga seu nome', 'Converse e brinque'].entries()) {
      const step = liveCallSteps.querySelectorAll<HTMLElement>('span')[index];
      if (step?.lastChild) step.lastChild.textContent = ` ${label}`;
    }
  }
  if (!stationManaged) stopVoiceNumberUpdates = watchVoiceNumber(locale, updateVoiceNumber);
  connectLiveRoom();
  renderLiveCallUI();
}

addEventListener('pagehide', () => {
  phoneQrGeneration += 1;
  stopVoiceNumberUpdates?.();
  owlConnection?.close();
}, { once: true });

let firstFrame = true;
function frame(): void {
  requestAnimationFrame(frame);
  // Advance animation in bounded steps after slow frames or screenshots so UI
  // states cannot outrun the character's paper and receiver choreography.
  const frameDelta = Math.min(clock.getDelta(), 3);
  const stepCount = Math.max(1, Math.ceil(frameDelta / 0.05));
  const stepDelta = frameDelta / stepCount;
  for (let step = 0; step < stepCount; step++) {
    elapsed += stepDelta;
    owl.update(stepDelta, elapsed);
    if (pendingPropAction) {
      const characterAction = pendingPropAction === 'snack' ? 'eat' : 'sip';
      if (owl.getActionAge(characterAction) !== null) {
        world.trigger(pendingPropAction);
        pendingPropAction = null;
      }
    }
    if (pendingPropSpeech) {
      const age = owl.getActionAge(pendingPropSpeech.action);
      // Let the response land on the actual bite or sip, including when a
      // newspaper has to fold away before the owl can reach for the prop.
      const responseBeat = pendingPropSpeech.action === 'eat' ? 1.23 : 1.48;
      if (age !== null && age >= responseBeat) {
        say(pendingPropSpeech.line);
        pendingPropSpeech = null;
      }
    }
    world.update(stepDelta, elapsed, owl.getActionAge('eat'), owl.getActionAge('sip'));
  }
  if (callState === 'ringing' && !deskReceiverLifted && owl.isPhonePickupStarted()) {
    world.trigger('answer');
    deskReceiverLifted = true;
  }
  if (callState === 'ringing' && elapsed >= callReadyAt && owl.isCallPickupReady()) {
    completeCallPickup();
  }
  if (remoteCall && callState === 'connected' && remoteActionQueue.length > 0 && elapsed >= remoteNextActionAt) {
    const event = remoteActionQueue.shift();
    if (event) applyRemoteAction(event);
  }
  if (callState === 'connected' && callReactionEndAt !== undefined && elapsed >= callReactionEndAt) {
    callReactionEndAt = undefined;
    if (!remoteCall || !remoteSpeakerphone) owl.trigger('listen');
    callStatus.textContent = 'Talking Owl is listening';
    callPanel.dataset.revealing = 'false';
  }
  if (!reducedMotion.matches) {
    cameraDrift.x = THREE.MathUtils.damp(cameraDrift.x, cameraDriftTarget.x, 2.6, frameDelta);
    cameraDrift.y = THREE.MathUtils.damp(cameraDrift.y, cameraDriftTarget.y, 2.6, frameDelta);
    camera.position.x = cameraDrift.x;
    camera.position.y = 3.45 + cameraDrift.y;
    camera.lookAt(cameraDrift.x * 0.12, 1.65, 0);
  }
  if (recorder?.state === 'recording') {
    const seconds = Math.floor((performance.now() - recordingStarted) / 1000);
    recordTime.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    hasRenderedFirstFrame = true;
    maybeMarkStationReady();
    if (loadingScreen) loadingScreen.hidden = true;
  }
}

frame();
