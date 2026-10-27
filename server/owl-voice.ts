import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { normalizeForMatching } from '../shared/i18n/translate';
import { isExplicitSpokenName, parseFirstName } from '../shared/spoken-name';
import { speechSafeText } from '../shared/speech-text';
import type { OwlAction, OwlActionEvent, OwlReagent, OwlState } from '../shared/owl-protocol';
import { parseCrMessage } from './conversation-relay';
import type { LlmClient, LlmTurn } from './llm';

const MAX_RELAY_FRAME_LENGTH = 16 * 1024;
const MAX_TRANSCRIPT_LENGTH = 800;
const FINAL_DUPLICATE_MS = 300;
const END_SPEECH_TIMEOUT_MS = 12_000;
const CONVERSATION_TIMEOUT_MS = 5_000;
const MAX_DIALOGUE_HISTORY = 8;

export interface OwlVoiceEndHandoff {
  type: 'end';
  handoffData: string;
}

export interface OwlVoiceDeps {
  llm?: LlmClient;
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
  | { kind: 'goodbye'; line: string }
  | { kind: 'conversation'; text: string };

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
    help: 'Talk to me. Try “wave”, “laugh”, “sing”, “dance”, “read the newspaper”, or “go to the lab”. Ask me anything, or say “repeat after me, hello little owl”. Press 1 for yes, 2 for no, 3 for a laugh, 4 for a wave, 9 for help, or pound to say goodbye.',
    goodbye: 'Hoo hoo. Goodbye for now.',
    missingIngredients: 'Name two ingredients for my potion: berry, mint, or amber.',
    aiRetry: 'My thoughts tangled in my feathers for a moment. Could you ask me again?',
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
    help: 'Fale comigo. Diga acene, ria, cante, dance, leia o jornal, ou vá ao laboratório. Pergunte o que quiser, ou diga repita depois de mim, olá corujinha. Aperte 1 para sim, 2 para não, 3 para rir, 4 para acenar, 9 para ajuda, ou jogo da velha para sair.',
    goodbye: 'Hu hu. Até logo.',
    missingIngredients: 'Escolha dois ingredientes para a poção: frutas vermelhas, hortelã ou âmbar.',
    aiRetry: 'Meus pensamentos se enrolaram nas penas por um instante. Pode perguntar de novo?',
  },
} as const;

/** Full imperative phrases only. A mention of a prop inside a story remains conversation. */
const ACTION_PATTERNS: readonly { action: OwlAction; pattern: RegExp }[] = [
  { action: 'newspaper', pattern: /^(?:newspaper|(?:read|open|close|fold|pick up|put down) (?:the |your )?(?:newspaper|paper))$/ },
  { action: 'poke', pattern: /^(?:poke(?: (?:me|you|him|the owl))?|(?:tap|touch) (?:your |the )?(?:beak|owl|head))$/ },
  { action: 'tickle', pattern: /^(?:tickle(?: (?:me|you|him|yourself|the owl|your feathers))?|i want to tickle (?:you|him|the owl)|feather tickle)$/ },
  { action: 'eat', pattern: /^(?:eat|cookie|biscuit|snack|(?:eat|have|take a bite of) (?:a |the |your )?(?:cookie|biscuit|snack)|feed (?:you|the owl)(?: (?:a |the )?(?:cookie|biscuit))?)$/ },
  { action: 'sip', pattern: /^(?:sip|drink|tea|coffee|mug|(?:sip|drink|have) (?:some |a |the |your )?(?:tea|coffee|water|drink)|take a sip(?: of (?:your |the )?(?:tea|coffee|mug))?)$/ },
  { action: 'burp', pattern: /^(?:burp|belch)(?: for me)?$/ },
  { action: 'portrait', pattern: /^(?:portrait|painting|picture on the wall|(?:look at|show me|touch) (?:the |your )?(?:portrait|painting|picture))$/ },
  { action: 'lamp', pattern: /^(?:lamp|(?:turn (?:on|off)|change) (?:the |your )?(?:lamp|light))$/ },
  { action: 'yes', pattern: /^(?:yes|yeah|yep|say yes|nod|agree|affirmative)$/ },
  { action: 'no', pattern: /^(?:no|nope|nah|say no|shake your head|disagree|negative)$/ },
  { action: 'laugh', pattern: /^(?:(?:laugh|chuckle|giggle)(?: for me)?|make me laugh)$/ },
  { action: 'wave', pattern: /^(?:wave|wave (?:at|to) me|give me a wave|say hello|greet me)$/ },
  { action: 'ponder', pattern: /^(?:ponder|think|think it over|make your thinking face)$/ },
  { action: 'gasp', pattern: /^(?:gasp|act surprised|be surprised|look shocked)$/ },
  { action: 'dance', pattern: /^(?:dance|do a dance|boogie|bust a move)$/ },
  { action: 'snooze', pattern: /^(?:snooze|sleep|take a nap|doze off)$/ },
  { action: 'sing', pattern: /^(?:sing|song|sing (?:a |me a )?song|hoot a tune|sing a tune)$/ },
  { action: 'wink', pattern: /^(?:wink|give me a wink)$/ },
  { action: 'shrug', pattern: /^(?:shrug|look confused)$/ },
  { action: 'salute', pattern: /^(?:salute|stand to attention)$/ },
  { action: 'scratch', pattern: /^(?:scratch|scratch (?:your |the )?(?:head|feathers)|preen|itch)$/ },
  { action: 'yawn', pattern: /^(?:yawn|act tired)$/ },
  { action: 'hush', pattern: /^(?:hush|shush|shh|be quiet|whisper a secret)$/ },
  { action: 'cheer', pattern: /^(?:cheer|hooray|celebrate)$/ },
  { action: 'shiver', pattern: /^(?:shiver|brr|act cold)$/ },
  { action: 'bow', pattern: /^(?:take a bow|bow for me|bow down|bow)$/ },
  { action: 'sneeze', pattern: /^(?:sneeze|achoo)$/ },
];

const ACTION_PATTERNS_PT: readonly { action: OwlAction; pattern: RegExp }[] = [
  { action: 'newspaper', pattern: /^(?:jornal|leia|ler o jornal|abra o jornal|feche o jornal|dobre o jornal)$/ },
  { action: 'poke', pattern: /^(?:cutuque|cutucar|toque na coruja|encoste na coruja)$/ },
  { action: 'tickle', pattern: /^(?:cocegas|faca cocegas|faca cocegas (?:em mim|na coruja))$/ },
  { action: 'eat', pattern: /^(?:biscoito|bolacha|lanche|comer|coma|coma (?:um |o )?(?:biscoito|bolacha)|alimente(?: a coruja)?)$/ },
  { action: 'sip', pattern: /^(?:beba|beber|gole|cha|cafe|caneca|(?:beba|tome) (?:um |o |seu )?(?:gole|cha|cafe))$/ },
  { action: 'burp', pattern: /^(?:arroto|arrote|arrotar)$/ },
  { action: 'portrait', pattern: /^(?:retrato|quadro|pintura|olhe (?:o|para o) (?:retrato|quadro))$/ },
  { action: 'lamp', pattern: /^(?:abajur|lampada|acenda a luz|apague a luz)$/ },
  { action: 'yes', pattern: /^(?:sim|diga sim|concorde|balance a cabeca)$/ },
  { action: 'no', pattern: /^(?:nao|diga nao|discorde|negativo)$/ },
  { action: 'laugh', pattern: /^(?:ria|rir|risada|gargalhe|gargalhada)$/ },
  { action: 'wave', pattern: /^(?:acene|acenar|aceno|diga oi|de oi)$/ },
  { action: 'ponder', pattern: /^(?:pense|pensar|reflita|reflitir)$/ },
  { action: 'gasp', pattern: /^(?:surpreso|surpresa|assustado|espanto|surpreenda)$/ },
  { action: 'dance', pattern: /^(?:dance|dancar|danca)$/ },
  { action: 'snooze', pattern: /^(?:durma|dormir|soneca|cochile)$/ },
  { action: 'sing', pattern: /^(?:cante|cantar|cancao|musica|cante uma musica)$/ },
  { action: 'wink', pattern: /^(?:pisque|piscar|piscadinha)$/ },
  { action: 'shrug', pattern: /^(?:encolha os ombros|de de ombros)$/ },
  { action: 'salute', pattern: /^(?:continencia|saudacao|saude militar)$/ },
  { action: 'scratch', pattern: /^(?:coce|cocar|arrume as penas|limpe as penas)$/ },
  { action: 'yawn', pattern: /^(?:boceje|bocejar|bocejo)$/ },
  { action: 'hush', pattern: /^(?:psiu|silencio|fale baixo)$/ },
  { action: 'cheer', pattern: /^(?:comemore|comemorar|viva|torca)$/ },
  { action: 'shiver', pattern: /^(?:trema|tremer|arrepie|frio|brr)$/ },
  { action: 'bow', pattern: /^(?:reverencia|faca uma reverencia|curve-se)$/ },
  { action: 'sneeze', pattern: /^(?:espirre|espirrar|atchim)$/ },
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
  private dialogueHistory: LlmTurn[] = [];
  private awaitingConversationalAnswer = false;
  private pendingConversation: AbortController | null = null;
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
      this.invalidateTurn();
      this.lastFinal = null;
      return;
    }
    if (message.type === 'prompt' && !message.last) {
      this.invalidateTurn();
      return;
    }
    if (message.type === 'dtmf') {
      this.invalidateTurn();
      this.awaitingConversationalAnswer = false;
      this.handleDtmf(message.digit);
      return;
    }
    if (message.type === 'prompt') {
      this.handleFinalPrompt(message.voicePrompt);
    }
  }

  onStateChanged(): void {
    if (!this.active || !this.code || !this.callSid) return;
    const state = this.deps.snapshot(this.code);
    if (!state || state.phase !== 'finished' || this.terminalAnnouncedGeneration === state.generation) return;
    this.invalidateTurn();
    this.terminalAnnouncedGeneration = state.generation;
    this.awaitingName = false;
    this.awaitingConversationalAnswer = false;
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
    this.invalidateTurn();
    if (this.code && this.callSid) this.deps.disconnect(this.code, this.callSid);
  }

  /** An old socket was superseded by a new Relay socket for this same CallSid. */
  handleReplaced(): void {
    this.active = false;
    this.invalidateTurn();
  }

  /** Twilio's call-status callback confirms the phone call itself ended. */
  handleCallEnded(): void {
    this.active = false;
    this.invalidateTurn();
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
    this.invalidateTurn();
    const answeringOwlQuestion = this.awaitingConversationalAnswer
      && isBareYesNo(normalized, this.commandLocale);
    this.awaitingConversationalAnswer = false;
    const state = this.deps.snapshot(this.code);
    if (!state) return;
    if (state.phase === 'finished') { this.onStateChanged(); return; }
    if (this.awaitingName) {
      const possibleCommand = interpretOwlSpeech(spoken, 0, this.commandLocale);
      const explicit = isExplicitSpokenName(spoken, this.commandLocale);
      const bareName = !/\s/u.test(spoken.trim())
        && possibleCommand.kind === 'conversation';
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
    this.executeIntent(answeringOwlQuestion
      ? { kind: 'conversation', text: spoken }
      : interpretOwlSpeech(spoken, state.interactionCount, this.commandLocale), spoken);
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

  private executeIntent(intent: OwlSpeechIntent, spoken?: string): void {
    if (!this.code || !this.callSid) return;
    if (intent.kind === 'conversation') { void this.converse(intent.text); return; }
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
    if (spoken) this.rememberTurn(spoken, event.line);
  }

  private invalidateTurn(): void {
    this.turnEpoch++;
    this.pendingConversation?.abort();
    this.pendingConversation = null;
  }

  /** Model replies are plain dialogue: only the room may turn one into an animated talk event. */
  private async converse(spoken: string): Promise<void> {
    const code = this.code, callSid = this.callSid, playerId = this.playerId;
    if (!code || !callSid || !playerId) return;
    const initial = this.deps.snapshot(code);
    if (!initial || initial.phase !== 'playing' || !initial.caller?.nameConfirmed) return;
    const epoch = this.turnEpoch, generation = initial.generation;
    const controller = new AbortController();
    this.pendingConversation = controller;
    const current = () => this.active && this.turnEpoch === epoch
      && this.pendingConversation === controller && this.code === code
      && this.callSid === callSid && this.playerId === playerId
      && (() => {
        const state = this.deps.snapshot(code);
        return state?.generation === generation && state.phase === 'playing'
          && state.caller?.playerId === playerId && state.caller.connected;
      })();
    const history: LlmTurn[] = [...this.dialogueHistory.slice(-MAX_DIALOGUE_HISTORY),
      { role: 'user', content: spoken }];
    let answer = '';
    if (this.deps.llm?.enabled) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const timeout = new Promise<null>(resolve => {
          timer = setTimeout(() => { controller.abort(); resolve(null); }, CONVERSATION_TIMEOUT_MS);
          timer.unref?.();
        });
        const reply = await Promise.race([
          this.deps.llm.respond(owlSystemPrompt(initial, this.commandLocale), history, [],
            { signal: controller.signal, timeoutMs: CONVERSATION_TIMEOUT_MS }),
          timeout,
        ]);
        answer = reply?.say ?? '';
      } catch {
        answer = '';
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (!current()) return;
    const cleaned = shortSpokenReply(answer, this.commandLocale);
    const echoed = normalizedEcho(cleaned, spoken, this.commandLocale);
    const line = cleaned && !echoed ? cleaned : VOICE_COPY[this.commandLocale].aiRetry;
    const event = this.deps.action(code, callSid, 'talk', line);
    if (!event || !current()) return;
    this.awaitingConversationalAnswer = Boolean(cleaned && !echoed && /\?\s*$/.test(event.line));
    this.rememberTurn(spoken, event.line);
    this.speak(event.line, current);
  }

  private rememberTurn(user: string, assistant: string): void {
    this.dialogueHistory.push({ role: 'user', content: user }, { role: 'assistant', content: assistant });
    if (this.dialogueHistory.length > MAX_DIALOGUE_HISTORY) {
      this.dialogueHistory = this.dialogueHistory.slice(-MAX_DIALOGUE_HISTORY);
    }
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

  private speak(raw: string, extraGuard?: () => boolean): void {
    if (!this.active) return;
    const line = speechSafeText(raw, 250, this.commandLocale);
    if (!line) return;
    const epoch = this.turnEpoch;
    let result: void | Promise<unknown>;
    try { result = this.deps.say(line, () => this.active && this.turnEpoch === epoch
      && (!extraGuard || extraGuard())); }
    catch { return; }
    const settled = Promise.resolve(result).catch(() => {});
    this.pendingSpeech.add(settled);
    void settled.finally(() => this.pendingSpeech.delete(settled));
  }
}

/** Only explicit game commands bypass conversation. */
export function interpretOwlSpeech(spoken: string, _turnNumber = 0,
  locale: SupportedLocale = DEFAULT_LOCALE): OwlSpeechIntent {
  const safe = speechSafeText(spoken, 180, locale);
  const normalized = normalizeForMatching(safe, locale);
  const pt = locale === 'pt-BR';
  const copy = VOICE_COPY[locale];
  const actionLines = pt ? ACTION_LINES_PT : ACTION_LINES;
  const patterns = pt ? ACTION_PATTERNS_PT : ACTION_PATTERNS;
  if (!normalized) return { kind: 'help', line: copy.help };
  if (pt
    ? /^(?:ajuda|o que (?:voce|eu) (?:pode|posso) fazer|lista de comandos|como jogar|como eu jogo)$/.test(normalized)
    : /^(?:help|what can (?:you|i) do|list (?:the )?commands|how (?:do i|to) play)$/.test(normalized)) {
    return { kind: 'help', line: copy.help };
  }
  if (pt
    ? /^(?:por favor )?(?:repita(?: depois de mim)?|repete|diga exatamente|fale exatamente)$/.test(normalized)
    : /^(?:please )?(?:repeat after me|repeat|say this|say exactly)$/.test(normalized)) {
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
  const command = commandBody(normalized, locale);
  if (pt
    ? /^(?:misture|misturar|combine|combinar|faca (?:uma )?pocao)(?:\b|$)/.test(command)
      || command === 'pocao'
    : /^(?:mix|combine|brew|make (?:a |me a )?potion)(?:\b|$)/.test(command)
      || command === 'potion') {
    const reagents = orderedReagents(command, locale);
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
    ? /^(?:(?:va|vamos|ir|entre|visite|abra)\s+(?:(?:ao?|para o|no)\s+)?(?:lab|laboratorio)|lab|laboratorio)$/.test(command)
    : /^(?:(?:go to|open|visit|enter|show me)\s+(?:the\s+)?(?:lab|laboratory)|lab|laboratory)$/.test(command)) {
    return { kind: 'action', action: 'lab', line: actionLines.lab[0]! };
  }
  if (pt
    ? /^(?:(?:volte|voltar|vamos|va|ir)\s+(?:para|ao?|a)\s+(?:a |o )?(?:sala de leitura|escritorio|estudo)|escritorio|sala de leitura|estudo)$/.test(command)
    : /^(?:(?:go back to|return to|back to|go to|show me)\s+(?:the\s+)?study|study)$/.test(command)) {
    return { kind: 'action', action: 'study', line: actionLines.study[0]! };
  }
  if (pt ? /^(?:oi|ola|bom dia|boa tarde|boa noite)[.! ]*$/.test(normalized)
    : /^(?:hi|hello|hey|good morning|good evening)[.! ]*$/.test(normalized)) {
    return { kind: 'action', action: 'wave', line: actionLines.wave[0]! };
  }
  if (pt ? /^(?:obrigad[oa]|valeu)[.! ]*$/.test(normalized)
    : /^(?:thank you|thanks)[.! ]*$/.test(normalized)) {
    return { kind: 'action', action: 'bow', line: actionLines.bow[0]! };
  }
  for (const { action, pattern } of patterns) {
    if (pattern.test(command)) return { kind: 'action', action, line: actionLines[action][0]! };
  }
  return { kind: 'conversation', text: safe };
}

function commandBody(normalized: string, locale: SupportedLocale): string {
  const withoutPrefix = locale === 'pt-BR'
    ? normalized.replace(/^(?:(?:por favor|coruja|voce pode|voce poderia|pode|poderia|quero que voce|eu quero que voce|vamos)\s+)+/, '')
    : normalized.replace(/^(?:(?:please|hey owl|owl|can you|could you|would you|will you|i want you to|lets)\s+)+/, '');
  return withoutPrefix.replace(/\s+(?:please|por favor)$/, '').trim();
}

function isBareYesNo(normalized: string, locale: SupportedLocale): boolean {
  return locale === 'pt-BR'
    ? /^(?:sim|nao)$/.test(normalized)
    : /^(?:yes|yeah|yep|no|nope|nah)$/.test(normalized);
}

function normalizedEcho(answer: string, spoken: string, locale: SupportedLocale): boolean {
  const heard = normalizeForMatching(spoken, locale);
  return Boolean(heard) && normalizeForMatching(answer, locale) === heard;
}

function shortSpokenReply(answer: string, locale: SupportedLocale): string {
  const safe = speechSafeText(answer, 600, locale);
  if (safe.length <= 155) return safe;
  const firstSentence = safe.match(/^.+?[.!?](?=\s|$)/)?.[0];
  if (firstSentence && firstSentence.length <= 155) return firstSentence;
  const clipped = speechSafeText(safe, 154, locale);
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}

function owlSystemPrompt(state: OwlState, locale: SupportedLocale): string {
  const name = state.caller?.name ?? (locale === 'pt-BR' ? 'visitante' : 'friend');
  const lastAction = state.lastEvent?.type === 'action' ? state.lastEvent.action : 'none';
  return locale === 'pt-BR'
    ? `Você é Talking Owl, uma coruja de desenho animado fofa, esperta e um pouco travessa. `
      + `Converse naturalmente em português do Brasil com ${JSON.stringify(name)} pelo telefone. `
      + `Você está na sala ${JSON.stringify(state.roomCode)}, no cenário ${state.roomMode}. `
      + `Sua última ação visível foi ${lastAction}. Responda à fala mais recente, incluindo perguntas e comentários. `
      + `Seja útil e preciso; se não souber, diga isso com gentileza. Use uma ou duas frases curtas, até 35 palavras. `
      + `Não repita a fala da pessoa, não invente ações e não use markdown, emoji ou instruções de bastidores.`
    : `You are Talking Owl, a cute, clever, slightly mischievous cartoon owl. `
      + `Talk naturally by phone with ${JSON.stringify(name)}. `
      + `You are in room ${JSON.stringify(state.roomCode)}, currently in the ${state.roomMode}. `
      + `Your last visible action was ${lastAction}. Reply to the latest utterance, including questions and comments. `
      + `Be helpful and accurate; if unsure, say so gently. Use one or two short spoken sentences, at most 35 words. `
      + `Do not repeat the caller's words, invent actions, or use markdown, emoji, or backstage instructions.`;
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
