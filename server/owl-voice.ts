import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { normalizeForMatching } from '../shared/i18n/translate';
import { isExplicitSpokenName, parseFirstName } from '../shared/spoken-name';
import { speechSafeText } from '../shared/speech-text';
import type { OwlAction, OwlActionEvent, OwlReagent, OwlState } from '../shared/owl-protocol';
import { parseCrMessage } from './conversation-relay';

const MAX_RELAY_FRAME_LENGTH = 16 * 1024;
const MAX_TRANSCRIPT_LENGTH = 800;
const FINAL_DUPLICATE_MS = 300;
const END_SPEECH_TIMEOUT_MS = 12_000;

export interface OwlVoiceEndHandoff {
  type: 'end';
  handoffData: string;
}

export interface OwlVoiceDeps {
  bind(roomCode: string, name: string, callSid: string, locale: SupportedLocale,
    stationManaged: boolean, nameConfirmed: boolean): { playerId: string; resumed: boolean } | null;
  confirmName(roomCode: string, callSid: string, name: string): boolean;
  action(roomCode: string, callSid: string, action: OwlAction, line: string,
    reagents?: readonly [OwlReagent, OwlReagent]): OwlActionEvent | null;
  snapshot(roomCode: string): OwlState | null;
  disconnect(roomCode: string, callSid: string): void;
  leave(roomCode: string, callSid: string, reason?: 'hangup' | 'goodbye'): void;
  say(text: string, isCurrent?: () => boolean): void | Promise<unknown>;
  /** Optional standalone handoff. The host should send this exact Relay frame after the farewell. */
  requestEnd?(handoff: OwlVoiceEndHandoff): void;
}

export type OwlSpeechIntent =
  | { kind: 'action'; action: OwlAction; line: string; reagents?: readonly [OwlReagent, OwlReagent] }
  | { kind: 'help'; line: string }
  | { kind: 'goodbye'; line: string };

const ACTION_LINES: Record<OwlAction, readonly string[]> = {
  call: ['Who could that be?'],
  listen: ['Hello? Yes, I can hear you.'],
  talk: ['Hoo?'],
  hangup: ['Click. Peace and quiet.'],
  newspaper: ['Now, where was I?', 'The Evening Hoot has news.', 'Just one more page.'],
  poke: ['Yes, I am awake.', 'I have noticed your finger.', 'We have established that I am here.'],
  tickle: ['Hah! Careful with the feathers.', 'I am not laughing. You are.', 'All right, that was funny.'],
  eat: ['Acceptable.', 'You may stay.', 'The biscuit changes nothing. Almost.'],
  sip: ['A respectable vintage.', 'That hits the spot.', 'One more sip. For science.'],
  burp: ['Ahem.', 'The acoustics in here are excellent.', 'That was the chair.'],
  portrait: ['I looked very scholarly, did I not?', 'My finest feather day.', 'Please do not tilt the portrait.'],
  lamp: ['A little more atmosphere.'],
  lab: ['Ah. Now we are talking chemistry.'],
  study: ['Back to the study.'],
  mix: ['A fascinating reaction!'],
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
};

const ACTION_LINES_PT: Record<OwlAction, readonly string[]> = {
  call: ['Quem será que está ligando?'],
  listen: ['Alô? Sim, estou ouvindo.'],
  talk: ['Hu?'],
  hangup: ['Clique. Agora, um pouco de silêncio.'],
  newspaper: ['Onde eu estava no jornal?', 'Mais uma página, por favor.'],
  poke: ['Sim, estou acordado.', 'Senti esse cutucão.'],
  tickle: ['Ha! Cuidado com as penas.', 'Não estou rindo. Você está.'],
  eat: ['Esse biscoito é aceitável.', 'Talvez você possa ficar.'],
  sip: ['Um excelente gole.', 'Agora sim.'],
  burp: ['Com licença.', 'Foi a cadeira.'],
  portrait: ['Eu estava muito elegante nesse retrato.', 'Não entorte o quadro.'],
  lamp: ['Um pouco mais de luz.'],
  lab: ['Ah, agora vamos ao laboratório.'],
  study: ['De volta à sala de leitura.'],
  mix: ['Que reação fascinante!'],
  yes: ['Sim.', 'Acho que sim.', 'Se você insiste.'],
  no: ['Não.', 'De jeito nenhum.', 'Pergunte depois do jornal.'],
  laugh: ['Ha, ha, ha!', 'Essa foi boa.'],
  wave: ['Um aceno só para você.', 'Olá outra vez!'],
  ponder: ['Hmm. Deixe-me pensar.', 'Uma pergunta curiosa.'],
  gasp: ['Nossa!', 'Eu não esperava por isso.'],
  dance: ['Eu sei dançar um pouquinho.', 'Um, dois, bate as asas!'],
  snooze: ['Zzz... Só mais cinco minutinhos.', 'Eu estava descansando os olhos.'],
  sing: ['Hu, hu, hu... Que bela canção.', 'Minha obra-prima da meia-noite.'],
  wink: ['Viu essa piscadinha?', 'Um segredo só para você.'],
  shrug: ['O que uma coruja pode fazer?', 'Eu também não sei.'],
  salute: ['Às suas ordens. Por pouco tempo.', 'Saudações da poltrona.'],
  scratch: ['Ah, era aí que coçava.', 'Uma pena fora do lugar.'],
  yawn: ['Perdão pelo bocejo.', 'Foi uma noite longa.'],
  hush: ['Psiu. É segredo.', 'Fale mais baixinho.'],
  cheer: ['Viva!', 'Isso merece uma comemoração.'],
  shiver: ['Brr. Ficou frio aqui?', 'Senti um arrepio nas penas.'],
  bow: ['Uma reverência para você.', 'Obrigado, obrigado.'],
  sneeze: ['Atchim! Com licença.', 'Poeira de pena no escritório.'],
};

const VOICE_COPY = {
  'en-US': {
    timeout: 'Our time is up. I enjoyed the chat. Hoo hoo, goodbye.',
    stationStop: 'The game is finished. Thanks for visiting my study.',
    farewell: 'Goodbye. Come back for another hoot.',
    occupied: 'I am already talking to someone in this room. Please try again in a moment.',
    invalidRoom: 'I could not find that room. Please scan the game code and call again.',
    askName: 'Hoo is calling? Tell me your first name.',
    askNameAgain: 'Tell me just your first name, please. Then we can play.',
    askNameRetry: 'I missed that. What is your first name?',
    firstNameBeforeDtmf: 'First, tell me your first name.',
    keypadHelp: 'Press 1 for yes, 2 for no, 3 for a laugh, 4 for a wave, 9 for help, or just talk to me.',
    help: 'Talk to me. Try “wave”, “laugh”, “sing”, “dance”, “read the newspaper”, or “go to the lab”. Ask a yes or no question, or say “repeat after me”. Press 1 for yes, 2 for no, 3 for a laugh, 4 for a wave, 9 for help, or pound to say goodbye.',
    goodbye: 'Hoo hoo. Goodbye for now.',
    noAction: 'All right. I will stay right here.',
    missingIngredients: 'Name two ingredients for my potion: berry, mint, or amber.',
    identity: 'I am Talking Owl. Hoo are you?',
    wellbeing: 'Quite well, thank you. My newspaper was excellent.',
    place: 'Right here in my cozy study, by the old lamp.',
    mystery: 'That is one of the great mysteries of the study.',
  },
  'pt-BR': {
    timeout: 'Nosso tempo acabou. Gostei da conversa. Hu hu, até logo.',
    stationStop: 'O jogo terminou. Obrigado pela visita.',
    farewell: 'Até logo. Volte para conversar comigo.',
    occupied: 'Já estou conversando com outra pessoa nesta sala. Tente de novo em um instante.',
    invalidRoom: 'Não encontrei essa sala. Leia o código do jogo e ligue novamente.',
    askName: 'Hu, quem está ligando? Diga seu primeiro nome.',
    askNameAgain: 'Diga só seu primeiro nome, por favor. Depois podemos brincar.',
    askNameRetry: 'Não entendi. Qual é seu primeiro nome?',
    firstNameBeforeDtmf: 'Primeiro, diga seu nome.',
    keypadHelp: 'Aperte 1 para sim, 2 para não, 3 para uma risada, 4 para um aceno, 9 para ajuda, ou fale comigo.',
    help: 'Fale comigo. Diga acene, ria, cante, dance, leia o jornal, ou vá ao laboratório. Faça uma pergunta de sim ou não, ou diga repita depois de mim. Aperte 1 para sim, 2 para não, 3 para rir, 4 para acenar, 9 para ajuda, ou jogo da velha para sair.',
    goodbye: 'Hu hu. Até logo.',
    noAction: 'Tudo bem. Vou ficar quietinho aqui.',
    missingIngredients: 'Escolha dois ingredientes para a poção: frutas vermelhas, hortelã ou âmbar.',
    identity: 'Eu sou a Coruja Falante. E você?',
    wellbeing: 'Muito bem, obrigado. O jornal estava ótimo.',
    place: 'Aqui na minha sala de leitura, perto do abajur.',
    mystery: 'Esse é um dos grandes mistérios da minha sala.',
  },
} as const;

/** Narrow command phrases are tested before general questions and the playful echo fallback. */
const ACTION_PATTERNS: readonly { action: OwlAction; pattern: RegExp }[] = [
  { action: 'newspaper', pattern: /\b(?:newspaper|read (?:the |your )?paper|open (?:the |your )?paper|close (?:the |your )?paper)\b/ },
  { action: 'poke', pattern: /\b(?:poke|tap (?:your |the )?(?:beak|owl|head)|touch (?:your |the )?(?:beak|owl|head))\b/ },
  { action: 'tickle', pattern: /\b(?:tickle|feather tickle)\b/ },
  { action: 'eat', pattern: /\b(?:eat|snack|biscuit|cookie|feed (?:you|the owl))\b/ },
  { action: 'sip', pattern: /\b(?:sip|drink|tea|coffee|mug)\b/ },
  { action: 'burp', pattern: /\b(?:burp|belch)\b/ },
  { action: 'portrait', pattern: /\b(?:portrait|painting|picture on the wall)\b/ },
  { action: 'lamp', pattern: /\b(?:lamp|turn (?:on|off) the light|change the light)\b/ },
  { action: 'yes', pattern: /^(?:yes|yeah|yep|say yes|nod|agree|affirmative)[.! ]*$/ },
  { action: 'no', pattern: /^(?:no|nope|nah|say no|shake your head|disagree|negative)[.! ]*$/ },
  { action: 'laugh', pattern: /\b(?:laugh|chuckle|giggle|tell (?:me )?a joke|funny)\b/ },
  { action: 'wave', pattern: /\b(?:wave|say hello|greet me)\b/ },
  { action: 'ponder', pattern: /\b(?:ponder|think (?:about|it over)|thinking face)\b/ },
  { action: 'gasp', pattern: /\b(?:gasp|act surprised|be surprised|look shocked)\b/ },
  { action: 'dance', pattern: /\b(?:dance|boogie|bust a move)\b/ },
  { action: 'snooze', pattern: /\b(?:snooze|sleep|take a nap|doze off)\b/ },
  { action: 'sing', pattern: /\b(?:sing|song|hoot a tune|sing a tune)\b/ },
  { action: 'wink', pattern: /\b(?:wink|give me a wink)\b/ },
  { action: 'shrug', pattern: /\b(?:shrug|look confused)\b/ },
  { action: 'salute', pattern: /\b(?:salute|stand to attention)\b/ },
  { action: 'scratch', pattern: /\b(?:scratch|preen|itch)\b/ },
  { action: 'yawn', pattern: /\b(?:yawn|act tired)\b/ },
  { action: 'hush', pattern: /\b(?:hush|shush|shh|be quiet|whisper a secret)\b/ },
  { action: 'cheer', pattern: /\b(?:cheer|hooray|celebrate)\b/ },
  { action: 'shiver', pattern: /\b(?:shiver|brr|act cold)\b/ },
  { action: 'bow', pattern: /\b(?:take a bow|bow for me|bow down|bow)\b/ },
  { action: 'sneeze', pattern: /\b(?:sneeze|achoo)\b/ },
];

const ACTION_PATTERNS_PT: readonly { action: OwlAction; pattern: RegExp }[] = [
  { action: 'newspaper', pattern: /\b(?:jornal|leia|ler o jornal|abra o jornal|feche o jornal)\b/ },
  { action: 'poke', pattern: /\b(?:cutuque|cutucar|toque na coruja|encoste na coruja)\b/ },
  { action: 'tickle', pattern: /\b(?:cocegas|faca cocegas)\b/ },
  { action: 'eat', pattern: /\b(?:biscoito|bolacha|lanche|comer|coma|alimente)\b/ },
  { action: 'sip', pattern: /\b(?:beba|beber|gole|cha|cafe|caneca)\b/ },
  { action: 'burp', pattern: /\b(?:arroto|arrote|arrotar)\b/ },
  { action: 'portrait', pattern: /\b(?:retrato|quadro|pintura)\b/ },
  { action: 'lamp', pattern: /\b(?:abajur|lampada|acenda a luz|apague a luz)\b/ },
  { action: 'yes', pattern: /^(?:sim|diga sim|concorde|balance a cabeca)[.! ]*$/ },
  { action: 'no', pattern: /^(?:nao|diga nao|discorde|negativo)[.! ]*$/ },
  { action: 'laugh', pattern: /\b(?:ria|rir|risada|gargalhe|gargalhada|conte uma piada)\b/ },
  { action: 'wave', pattern: /\b(?:acene|acenar|aceno|diga oi|de oi)\b/ },
  { action: 'ponder', pattern: /\b(?:pense|pensar|reflita|reflitir)\b/ },
  { action: 'gasp', pattern: /\b(?:surpreso|surpresa|assustado|espanto|surpreenda)\b/ },
  { action: 'dance', pattern: /\b(?:dance|dancar|danca)\b/ },
  { action: 'snooze', pattern: /\b(?:durma|dormir|soneca|cochile)\b/ },
  { action: 'sing', pattern: /\b(?:cante|cantar|cancao|musica)\b/ },
  { action: 'wink', pattern: /\b(?:pisque|piscar|piscadinha)\b/ },
  { action: 'shrug', pattern: /\b(?:encolha os ombros|de de ombros|nao sei)\b/ },
  { action: 'salute', pattern: /\b(?:continencia|saudacao|saude militar)\b/ },
  { action: 'scratch', pattern: /\b(?:coce|cocar|arrume as penas|limpe as penas)\b/ },
  { action: 'yawn', pattern: /\b(?:boceje|bocejar|bocejo)\b/ },
  { action: 'hush', pattern: /\b(?:psiu|silencio|segredo|fale baixo)\b/ },
  { action: 'cheer', pattern: /\b(?:comemore|comemorar|viva|torca)\b/ },
  { action: 'shiver', pattern: /\b(?:trema|tremer|arrepie|frio|brr)\b/ },
  { action: 'bow', pattern: /\b(?:reverencia|faca uma reverencia|curve-se)\b/ },
  { action: 'sneeze', pattern: /\b(?:espirre|espirrar|atchim)\b/ },
];

const DTMF_ACTIONS: Readonly<Record<string, OwlAction>> = {
  '1': 'yes', '2': 'no', '3': 'laugh', '4': 'wave', '5': 'ponder',
  '6': 'gasp', '7': 'dance', '8': 'sing', '0': 'burp',
};

/** One Twilio ConversationRelay socket. The room remains authoritative across socket replacement. */
export class OwlVoiceSession {
  private code: string | null = null;
  private playerId: string | null = null;
  private callSid: string | null = null;
  private commandLocale: SupportedLocale = DEFAULT_LOCALE;
  private authoritativeName: string | null = null;
  private stationManaged = false;
  private awaitingName = false;
  private active = true;
  private turnEpoch = 0;
  private terminalAnnouncedGeneration: number | null = null;
  private lastFinal: { text: string; atMs: number } | null = null;
  private readonly lineCursors = new Map<OwlAction, number>();
  private readonly pendingSpeech = new Set<Promise<unknown>>();

  constructor(private readonly deps: OwlVoiceDeps) {}

  get boundRoomCode(): string | null { return this.code; }
  get boundPlayerId(): string | null { return this.playerId; }
  get locale(): SupportedLocale { return this.commandLocale; }

  setAuthoritativeName(name: string | null): void {
    this.authoritativeName = name?.trim().slice(0, 40) || null;
  }

  setStationManaged(active: boolean): void { this.stationManaged = active; }

  handleMessage(raw: string): void {
    if (!this.active || typeof raw !== 'string' || raw.length > MAX_RELAY_FRAME_LENGTH) return;
    const message = parseCrMessage(raw);
    if (message.type === 'setup') {
      this.handleSetup(message.callSid, message.customParameters);
      return;
    }
    if (!this.code || !this.callSid || message.type === 'unknown' || message.type === 'error') return;
    if (message.type === 'interrupt') {
      this.turnEpoch++;
      this.lastFinal = null;
      return;
    }
    if (message.type === 'prompt' && !message.last) {
      this.turnEpoch++;
      return;
    }
    if (message.type === 'dtmf') {
      this.turnEpoch++;
      this.handleDtmf(message.digit);
      return;
    }
    if (message.type === 'prompt') {
      this.turnEpoch++;
      this.handleFinalPrompt(message.voicePrompt);
    }
  }

  onStateChanged(): void {
    if (!this.active || !this.code || !this.callSid) return;
    const state = this.deps.snapshot(this.code);
    if (!state || state.phase !== 'finished' || this.terminalAnnouncedGeneration === state.generation) return;
    this.terminalAnnouncedGeneration = state.generation;
    this.awaitingName = false;
    const copy = VOICE_COPY[this.commandLocale];
    const line = state.result?.reason === 'timeout'
      ? copy.timeout : state.result?.reason === 'station_stop'
        ? copy.stationStop : copy.farewell;
    this.speak(line);
  }

  async whenSpeechSettled(): Promise<void> {
    while (this.pendingSpeech.size) await Promise.allSettled([...this.pendingSpeech]);
  }

  /** The Relay transport closed; allow the same CallSid to reconnect during grace. */
  handleClose(): void {
    if (!this.active) return;
    this.active = false;
    this.turnEpoch++;
    if (this.code && this.callSid) this.deps.disconnect(this.code, this.callSid);
  }

  /** An old socket was superseded by a new Relay socket for this same CallSid. */
  handleReplaced(): void {
    this.active = false;
    this.turnEpoch++;
  }

  /** Twilio's call-status callback confirms the phone call itself ended. */
  handleCallEnded(): void {
    this.active = false;
    this.turnEpoch++;
    if (this.code && this.callSid) this.deps.leave(this.code, this.callSid, 'hangup');
  }

  private handleSetup(callSid: string, parameters: Record<string, string>): void {
    if (this.code) return;
    this.commandLocale = resolveLocale(parameters['commandLocale'] ?? parameters['locale'], DEFAULT_LOCALE);
    const rawCode: unknown = parameters['roomCode'];
    if (!callSid.trim() || typeof rawCode !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(rawCode.trim())) {
      this.speak(VOICE_COPY[this.commandLocale].invalidRoom);
      if (this.deps.requestEnd) void this.finishAfterSpokenEnd('owl-bad-room');
      return;
    }
    const code = rawCode.trim().toUpperCase();
    const name = this.authoritativeName ?? 'Visitor';
    const joined = this.deps.bind(code, name, callSid.trim(), this.commandLocale,
      this.stationManaged, Boolean(this.authoritativeName));
    if (!joined) {
      this.speak(VOICE_COPY[this.commandLocale].occupied);
      if (this.deps.requestEnd) void this.finishAfterSpokenEnd('owl-occupied');
      return;
    }
    this.code = code;
    this.playerId = joined.playerId;
    this.callSid = callSid.trim();
    const state = this.deps.snapshot(code);
    if (!state) return;
    if (state.phase === 'finished') {
      this.terminalAnnouncedGeneration = null;
      this.onStateChanged();
      return;
    }
    this.awaitingName = !state.caller?.nameConfirmed;
    const copy = VOICE_COPY[this.commandLocale];
    if (this.awaitingName) {
      this.speak(joined.resumed
        ? this.commandLocale === 'pt-BR'
          ? 'Bem-vindo de volta à Coruja Falante. Qual é seu primeiro nome?'
          : 'Welcome back to Talking Owl. What is your first name?'
        : copy.askName);
      return;
    }
    const named = state.caller?.name ?? this.authoritativeName ?? 'friend';
    this.speak(joined.resumed
      ? this.commandLocale === 'pt-BR'
        ? `Bem-vindo de volta, ${named}. Faça uma pergunta ou diga o que devo fazer.`
        : `Welcome back, ${named}. You can ask me a question or tell me what to do.`
      : this.commandLocale === 'pt-BR'
        ? `Olá, ${named}. Faça uma pergunta ou peça para eu acenar, rir, cantar, dançar ou visitar o laboratório.`
        : `Hello, ${named}. Ask me a question, or tell me to wave, laugh, sing, dance, or visit the lab.`);
  }

  private handleFinalPrompt(raw: string): void {
    if (!this.code || !this.callSid || typeof raw !== 'string') return;
    const spoken = speechSafeText(raw.slice(0, MAX_TRANSCRIPT_LENGTH), 180, this.commandLocale);
    if (!spoken) return;
    const normalized = normalizeForMatching(spoken, this.commandLocale);
    const now = Date.now();
    if (this.lastFinal?.text === normalized && now - this.lastFinal.atMs < FINAL_DUPLICATE_MS) return;
    this.lastFinal = { text: normalized, atMs: now };
    const state = this.deps.snapshot(this.code);
    if (!state) return;
    if (state.phase === 'finished') { this.onStateChanged(); return; }
    if (this.awaitingName) {
      const possibleCommand = interpretOwlSpeech(spoken, 0, this.commandLocale);
      const explicit = isExplicitSpokenName(spoken, this.commandLocale);
      const bareName = !/\s/u.test(spoken.trim())
        && possibleCommand.kind === 'action' && possibleCommand.action === 'talk';
      const name = explicit || bareName
        ? parseFirstName(spoken, this.commandLocale) : null;
      if (!name) {
        this.speak(VOICE_COPY[this.commandLocale].askNameAgain);
        return;
      }
      if (!this.deps.confirmName(this.code, this.callSid, name)) {
        this.speak(VOICE_COPY[this.commandLocale].askNameRetry);
        return;
      }
      this.awaitingName = false;
      this.speak(this.commandLocale === 'pt-BR'
        ? `Prazer em conhecer você, ${name}. Faça uma pergunta ou peça para eu acenar, rir, cantar, dançar ou misturar uma poção.`
        : `Nice to meet you, ${name}. Ask me a question, or tell me to wave, laugh, sing, dance, or mix a potion.`);
      return;
    }
    this.executeIntent(interpretOwlSpeech(spoken, state.interactionCount, this.commandLocale));
  }

  private handleDtmf(digit: string): void {
    if (!this.code || !this.callSid) return;
    const state = this.deps.snapshot(this.code);
    if (!state || state.phase === 'finished') return;
    if (this.awaitingName) {
      this.speak(VOICE_COPY[this.commandLocale].firstNameBeforeDtmf);
      return;
    }
    if (digit === '9') {
      this.speak(VOICE_COPY[this.commandLocale].help);
      return;
    }
    if (digit === '#') {
      this.executeIntent({ kind: 'goodbye', line: VOICE_COPY[this.commandLocale].goodbye });
      return;
    }
    const action = DTMF_ACTIONS[digit];
    if (!action) {
      this.speak(VOICE_COPY[this.commandLocale].keypadHelp);
      return;
    }
    this.executeIntent({ kind: 'action', action, line: this.nextLine(action) });
  }

  private executeIntent(intent: OwlSpeechIntent): void {
    if (!this.code || !this.callSid) return;
    if (intent.kind === 'help') { this.speak(intent.line); return; }
    if (intent.kind === 'goodbye') {
      const state = this.deps.snapshot(this.code);
      if (state) this.terminalAnnouncedGeneration = state.generation;
      this.speak(intent.line);
      this.deps.leave(this.code, this.callSid, 'goodbye');
      if (this.deps.requestEnd && !this.stationManaged) {
        void this.finishAfterSpokenEnd('owl-goodbye');
      }
      return;
    }
    const state = this.deps.snapshot(this.code);
    if (intent.action === 'mix' && state?.roomMode !== 'lab') {
      const enteringLab = this.deps.action(this.code, this.callSid, 'lab', this.nextLine('lab'));
      if (enteringLab) this.speak(enteringLab.line);
    }
    const line = intent.action === 'talk' || intent.action === 'mix'
      ? intent.line : this.nextLine(intent.action);
    const event = this.deps.action(this.code, this.callSid, intent.action, line, intent.reagents);
    if (!event) {
      this.onStateChanged();
      return;
    }
    this.speak(event.line);
  }

  private async finishAfterSpokenEnd(reasonCode: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([this.whenSpeechSettled(), new Promise<void>(resolve => {
      timer = setTimeout(resolve, END_SPEECH_TIMEOUT_MS);
      timer.unref?.();
    })]);
    if (timer) clearTimeout(timer);
    if (!this.active || !this.deps.requestEnd) return;
    this.deps.requestEnd({ type: 'end', handoffData: JSON.stringify({ reasonCode }) });
  }

  private nextLine(action: OwlAction): string {
    const variants = (this.commandLocale === 'pt-BR' ? ACTION_LINES_PT : ACTION_LINES)[action];
    const index = this.lineCursors.get(action) ?? 0;
    this.lineCursors.set(action, index + 1);
    return variants[index % variants.length] ?? variants[0] ?? 'Hoo.';
  }

  private speak(raw: string): void {
    if (!this.active) return;
    const line = speechSafeText(raw, 250, this.commandLocale);
    if (!line) return;
    const epoch = this.turnEpoch;
    let result: void | Promise<unknown>;
    try { result = this.deps.say(line, () => this.active && this.turnEpoch === epoch); }
    catch { return; }
    const settled = Promise.resolve(result).catch(() => {});
    this.pendingSpeech.add(settled);
    void settled.finally(() => this.pendingSpeech.delete(settled));
  }
}

/** A bounded deterministic interpreter. Unmatched speech is echoed, like the toy that inspired it. */
export function interpretOwlSpeech(spoken: string, turnNumber = 0,
  locale: SupportedLocale = DEFAULT_LOCALE): OwlSpeechIntent {
  const safe = speechSafeText(spoken, 180, locale);
  const normalized = normalizeForMatching(safe, locale);
  const pt = locale === 'pt-BR';
  const copy = VOICE_COPY[locale];
  const actionLines = pt ? ACTION_LINES_PT : ACTION_LINES;
  const patterns = pt ? ACTION_PATTERNS_PT : ACTION_PATTERNS;
  if (!normalized) return { kind: 'help', line: copy.help };
  if (pt
    ? /\b(?:ajuda|o que (?:voce|eu) (?:pode|posso) fazer|lista de comandos|como jogar|como eu jogo)\b/.test(normalized)
    : /\b(?:help|what can (?:you|i) do|list (?:the )?commands|how (?:do i|to) play)\b/.test(normalized)) {
    return { kind: 'help', line: copy.help };
  }
  const repeat = pt
    ? safe.match(/^(?:por favor\s+)?(?:repita(?: depois de mim)?|repete|diga exatamente|fale exatamente)\s*[:,-]?\s*(.+)$/iu)
    : safe.match(/^(?:please\s+)?(?:repeat after me|repeat|say this|say exactly)\s*[:,-]?\s*(.+)$/i);
  if (repeat?.[1]?.trim()) {
    return { kind: 'action', action: 'talk', line: speechSafeText(repeat[1], 120, locale) };
  }
  const rejectsGoodbye = pt
    ? /\b(?:nao|nunca)\s+(?:desligue|desligar|encerre|encerrar|diga tchau)\b/.test(normalized)
    : /\b(?:do not|dont|don't|never|not)\s+(?:hang up|end the call|say goodbye)\b/.test(normalized);
  if (!rejectsGoodbye && (pt
    ? /^(?:por favor )?(?:tchau|adeus|ate logo|desligue|desligar|encerre (?:a )?(?:ligacao|chamada)|termine (?:a )?chamada|diga tchau)[.! ]*$/.test(normalized)
    : /^(?:please )?(?:goodbye|bye bye|bye|hang up|end (?:the |this )?call|see you later|say goodbye)[.! ]*$/.test(normalized))) {
    return { kind: 'goodbye', line: copy.goodbye };
  }
  if (pt
    ? /\b(?:mistur\w*|pocao|ingredientes|combine)\b/.test(normalized)
    : /\b(?:mix|potion|ingredients|combine)\b/.test(normalized)) {
    const reagents = orderedReagents(normalized, locale);
    if (reagents.length >= 2) {
      const picked = [reagents[0]!, reagents[1]!] as const;
      const labels = pt ? { berry: 'frutas vermelhas', mint: 'hortelã', amber: 'âmbar' } : {
        berry: 'berry', mint: 'mint', amber: 'amber',
      };
      return { kind: 'action', action: 'mix', reagents: picked,
        line: pt
          ? `Vamos misturar ${labels[picked[0]]} e ${labels[picked[1]]}. Veja esse brilho!`
          : `Let's mix ${labels[picked[0]]} and ${labels[picked[1]]}. Look at that glow!` };
    }
    return { kind: 'action', action: 'talk', line: copy.missingIngredients };
  }
  if (pt
    ? /\b(?:va|vamos|ir|entre|visite|abra)\s+(?:ao?|para o|no)?\s*(?:lab|laboratorio)\b/.test(normalized)
      || normalized === 'lab' || normalized === 'laboratorio'
    : /\b(?:go to|open|visit|enter|show me)\s+(?:the\s+)?(?:lab|laboratory)\b/.test(normalized)
      || normalized === 'lab' || normalized === 'laboratory') {
    return { kind: 'action', action: 'lab', line: actionLines.lab[0]! };
  }
  if (pt
    ? /\b(?:volte|voltar|vamos|va|ir)\s+(?:para|ao?|a)\s+(?:a |o )?(?:sala de leitura|escritorio|estudo)\b/.test(normalized)
      || ['escritorio', 'sala de leitura', 'estudo'].includes(normalized)
    : /\b(?:go back to|return to|back to|go to|show me)\s+(?:the\s+)?study\b/.test(normalized)
      || normalized === 'study') {
    return { kind: 'action', action: 'study', line: actionLines.study[0]! };
  }
  if (pt
    ? /\b(?:qual (?:e )?(?:o )?seu nome|quem (?:e )?voce|como voce se chama)\b/.test(normalized)
    : /\b(?:(?:what|whats|who) (?:is|are)? ?(?:your|you) name|what should i call you|who are you)\b/.test(normalized)) {
    return { kind: 'action', action: 'talk', line: copy.identity };
  }
  if (pt ? /\b(?:como (?:voce )?esta|tudo bem)\b/.test(normalized)
    : /\bhow are you\b/.test(normalized)) {
    return { kind: 'action', action: 'talk', line: copy.wellbeing };
  }
  if (pt ? /\b(?:onde voce esta|onde fica sua sala)\b/.test(normalized)
    : /\b(?:where are you|where do you live)\b/.test(normalized)) {
    return { kind: 'action', action: 'talk', line: copy.place };
  }
  if (pt ? /^(?:oi|ola|bom dia|boa tarde|boa noite)[.! ]*$/.test(normalized)
    : /^(?:hi|hello|hey|good morning|good evening)[.! ]*$/.test(normalized)) {
    return { kind: 'action', action: 'wave', line: actionLines.wave[0]! };
  }
  if (pt ? /^(?:obrigad[oa]|valeu)[.! ]*$/.test(normalized)
    : /^(?:thank you|thanks)[.! ]*$/.test(normalized)) {
    return { kind: 'action', action: 'bow', line: actionLines.bow[0]! };
  }
  const negatedAction = pt
    ? /\b(?:nao|nunca|pare de)\b/.test(normalized)
    : /\b(?:do not|dont|don't|never|stop)\b/.test(normalized);
  if (negatedAction && patterns.some(({ pattern }) => pattern.test(normalized))
    && !['nao', 'nao sei'].includes(normalized)) {
    return { kind: 'action', action: 'talk', line: copy.noAction };
  }
  const isCommandQuestion = pt
    ? /^(?:voce (?:pode|consegue|poderia)|pode|consegue|poderia)\b/.test(normalized)
    : /^(?:can|could|would|will) you\b/.test(normalized);
  const isOrdinaryQuestion = pt
    ? /^(?:voce|sera|devo|e|tem|esta|qual|quem|como|onde|quando|por que|porque|o que)\b/.test(normalized)
    : /^(?:do|does|did|is|are|am|have|has|was|were|what|who|why|where|when|how)\b/.test(normalized);
  if (isOrdinaryQuestion && !isCommandQuestion) return answerQuestion(normalized, turnNumber, locale);
  for (const { action, pattern } of patterns) {
    if (pattern.test(normalized)) return { kind: 'action', action, line: actionLines[action][0]! };
  }
  if (/\?$/.test(safe) || isCommandQuestion) return answerQuestion(normalized, turnNumber, locale);
  return { kind: 'action', action: 'talk', line: safe.slice(0, 120) };
}

function answerQuestion(normalized: string, turnNumber: number, locale: SupportedLocale): OwlSpeechIntent {
  const pt = locale === 'pt-BR';
  if (pt ? /^(?:qual|quem|como|onde|quando|por que|porque|o que)\b/.test(normalized)
    : /^(?:what|who|why|where|when|how)\b/.test(normalized)) {
    return { kind: 'action', action: 'talk', line: VOICE_COPY[locale].mystery };
  }
  const options: readonly OwlAction[] = ['yes', 'no', 'ponder'];
  const hash = [...normalized].reduce((value, char) => ((value * 31) + char.charCodeAt(0)) >>> 0, turnNumber >>> 0);
  const action = options[hash % options.length]!;
  return { kind: 'action', action,
    line: (pt ? ACTION_LINES_PT : ACTION_LINES)[action][0]! };
}

function orderedReagents(normalized: string, locale: SupportedLocale): OwlReagent[] {
  const found: { reagent: OwlReagent; at: number }[] = [];
  const patterns = locale === 'pt-BR' ? [
    ['berry', /\b(?:frutas? (?:vermelhas?|silvestres?)|morango|amora|berry)\b/g],
    ['mint', /\b(?:hortela|menta|mint)\b/g],
    ['amber', /\b(?:ambar|amarelo|dourado|ouro|amber)\b/g],
  ] as const : [
    ['berry', /\b(?:berry|berries|blueberry|strawberry)\b/g],
    ['mint', /\b(?:mint|peppermint)\b/g],
    ['amber', /\b(?:amber|golden|gold)\b/g],
  ] as const;
  for (const [reagent, expression] of patterns) {
    const match = expression.exec(normalized);
    if (match?.index !== undefined) found.push({ reagent, at: match.index });
  }
  return found.sort((a, b) => a.at - b.at).map(item => item.reagent);
}
