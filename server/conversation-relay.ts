import type { Intent, GameEvent } from '../shared/types';
import { intentsFromTranscript } from './voice-intent';
import { greetingLines, lineForEvent, isChattyEvent, raceOverLine } from './voice-lines';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { RACER_MESSAGES } from '../shared/i18n/racer';
import { createTranslator } from '../shared/i18n/translate';

export type CrMessage =
  | { type:'setup'; callSid:string; from?:string; customParameters: Record<string,string> }
  | { type:'prompt'; voicePrompt:string; last:boolean }
  | { type:'dtmf'; digit:string }
  | { type:'interrupt'; utteranceUntilInterrupt:string; durationUntilInterruptMs:number }
  | { type:'error'; description:string }
  | { type:'unknown' };

export function parseCrMessage(raw: string): CrMessage {
  let o: any;
  try { o = JSON.parse(raw); } catch { return { type:'unknown' }; }
  if (!o || typeof o.type !== 'string') return { type:'unknown' };
  switch (o.type) {
    case 'setup':
      return { type:'setup', callSid: String(o.callSid ?? ''),
        ...(typeof o.from === 'string' ? { from: o.from } : {}),
        customParameters: (o.customParameters && typeof o.customParameters === 'object')
          ? o.customParameters : {} };
    case 'prompt':
      if (typeof o.voicePrompt !== 'string') return { type:'unknown' };
      return { type:'prompt', voicePrompt: o.voicePrompt, last: o.last === true };
    case 'dtmf':
      return { type:'dtmf', digit: String(o.digit ?? '') };
    case 'interrupt':
      // Sent when the caller's speech (barge-in) cuts the TTS. utteranceUntilInterrupt = the part of
      // our reply that actually played; durationUntilInterruptMs = how long it played.
      return { type:'interrupt',
        utteranceUntilInterrupt: String(o.utteranceUntilInterrupt ?? ''),
        durationUntilInterruptMs: Number(o.durationUntilInterruptMs ?? 0) || 0 };
    case 'error':
      return { type:'error', description: String(o.description ?? '') };
    default:
      return { type:'unknown' };
  }
}

export type RoomLike = {
  addPlayer(name: string, color?: string, preferredIndex?: number): { playerId: string; lane: number } | { error: string };
  expectHumanPlayers?(count:number,stationManaged?:boolean):void;
  applyIntent(id: string, intent: Intent): boolean|void;
  removePlayer(id: string): void;
  readonly playerCount?:number;
};

const DTMF_TO_INTENT: Record<string, Intent> = {
  '1': 'MOVE_LEFT', '2': 'BOOST', '3': 'MOVE_RIGHT', '4': 'BRAKE', '5': 'USE_POWER',
};

/** Min gap between mid-race "arcade" voice lines to a caller, so they stay fun (not spammy) and don't
 *  talk over the caller's spoken commands. 2s → snappy, reactive, still not a constant stream. */
const CHATTY_GAP_MS = 2000;
const SETUP_PHASE_GUARD_MS=1_500;

/** Everything the adapter needs from its host to TALK BACK to the caller + hook game events. All
 *  optional so existing callers/tests that only drive intents keep working unchanged. */
export interface AdapterDeps {
  findOrCreateRoom: (code: string) => RoomLike | null;
  /** Rebind a reconnecting Conversation Relay transport to its existing Racer player. */
  resumePlayer?: (callSid: string, roomCode: string) => { playerId: string; lane: number; resumed?: boolean; name?:string } | null;
  /** Speak a line to the caller (host wires this to a Relay `{type:'text'}` WS send). */
  say?: (text: string, isCurrent?: () => boolean) => void;
  /** Register/unregister this adapter to receive its room's game events (greeting/countdown/result). */
  register?: (roomCode: string, adapter: ConversationRelayAdapter) => void;
  unregister?: (adapter: ConversationRelayAdapter) => void;
  /** Drop the caller's player slot AND reap the room if now empty (a phone caller never hits the WS
   *  close/leave reap paths, so this avoids a voice-only room leaking). Falls back to plain
   *  removePlayer when absent (keeps existing tests/callers working). */
  leaveRoom?: (roomCode: string, playerId: string) => void;
  /** Run a conversational AI turn for this caller: given their utterance, return what the host should
   *  SAY back (having also executed any game actions), or null to fall back to scripted behavior.
   *  Wired to the LLM game-host. Absent → no conversational AI (scripted-only, current behavior).
   *  `phase` lets the caller decide command-vs-chat routing. */
  converse?: (roomCode: string, playerId: string, utterance: string, locale: SupportedLocale,
    isCurrent: () => boolean) => Promise<string | { text: string; phase: string } | null>;
  /** The room's current phase, so the adapter routes: race → fast commands; else → conversation. */
  phaseOf?: (roomCode: string) => string;
  hasPlayerName?: (roomCode: string, playerId: string) => boolean;
  onSetupChanged?: (roomCode:string,beforePhase:string) => void;
  handleSetupUtterance?: (roomCode:string,playerId:string,utterance:string,locale:SupportedLocale) => string|null;
  setupTurnFor?: (roomCode:string,playerId:string,phase:string) => 'active'|'waiting';
  /** Accepted semantic commands only; raw transcripts are deliberately never exposed to analytics. */
  onIntent?: (intent: Intent) => void;
}

export class ConversationRelayAdapter {
  private room: RoomLike | null = null;
  private playerId: string | null = null;
  private roomCode: string | null = null;
  // The intents already fired for the CURRENT utterance (reset on last:true). We compare each new
  // partial's intents against this by longest-common-prefix and fire only the new tail — robust to
  // ASR revising a word mid-utterance (see the prompt handler).
  private firedIntents: Intent[] = [];
  // Turn epoch for barge-in: bumped on every new final utterance AND on every interrupt. An in-flight
  // conversational reply captures the epoch it was requested under; if the epoch has since moved
  // (caller interrupted or spoke again), the stale reply is DROPPED instead of spoken over them.
  private turnEpoch = 0;
  private commandLocale: SupportedLocale = DEFAULT_LOCALE;
  private authoritativeName: string | null = null;
  private stationManaged=false;
  private stationParticipantIndex = 0;
  private stationParticipantCount = 1;
  private active=true;
  private callSid='';
  private setupPromptPhase:string|null=null;
  private lastFinalCommand:{text:string;at:number;source:'setup'|'race'}|null=null;
  private setupPhaseEnteredAt=0;
  constructor(private deps: AdapterDeps) {}

  setAuthoritativeName(name: string | null): void {
    this.authoritativeName = name?.trim().slice(0, 50) || null;
  }
  setStationManaged(active:boolean):void{this.stationManaged=active;}
  setStationAssignment(index: number, count: number): void {
    this.stationParticipantIndex = index === 1 ? 1 : 0;
    this.stationParticipantCount = count >= 2 ? 2 : 1;
  }

  /** The caller's bound player id (null until setup binds them) — for event targeting. */
  get boundPlayerId(): string | null { return this.playerId; }
  /** The caller's room code (null until bound) — so the registry can route events. */
  get boundRoomCode(): string | null { return this.roomCode; }
  /** Language selected by Conversation Relay setup; defaults to English for legacy callers. */
  get locale(): SupportedLocale { return this.commandLocale; }

  /** Called by the voice registry when THIS caller's room emits a game event. Speaks the caller-
   *  relevant lines. Key moments (countdown/go/finish) always speak; mid-race "arcade" lines
   *  (hit-streak/fell-to-last/took-lead) are THROTTLED — at most one every CHATTY_GAP ms — so spoken
   *  audio never buries the caller's own left/right/boost. Safe no-op if no `say` sink. */
  private lineSeq = 0;
  private lastChattyAt = -1e9;
  private recapDone = false;   // one proactive results recap per race (reset on a new countdown/go)
  private pendingSpeech = new Set<Promise<void>>();
  private lateRacingPromptUntil = 0;
  private lateRacingPromptActive = false;
  private myFinishPlace: number | null = null;
  private lastMenuPrompt: { kind: 'enter_car_select' | 'enter_map_select'; at: number } | null = null;
  onGameEvent(ev: GameEvent): void {
    const now = Date.now();
    if ('spokenReplyPlayerId' in ev && ev.spokenReplyPlayerId === this.playerId) return;
    if (ev.kind === 'go' || ev.kind === 'countdown') {
      this.recapDone = false;
      this.myFinishPlace = null;
      this.lateRacingPromptUntil = 0;
      this.lateRacingPromptActive = false;
    }
    if (ev.kind === 'enter_car_select' || ev.kind === 'enter_map_select') {
      this.turnEpoch++;
      this.setupPhaseEnteredAt=now;
      if (this.lastMenuPrompt?.kind === ev.kind && now - this.lastMenuPrompt.at < 1000) return;
      this.lastMenuPrompt = { kind: ev.kind, at: now };
      const phase=ev.kind==='enter_car_select'?'car_select':'map_select';
      if(this.stationManaged&&this.roomCode&&this.playerId
        &&this.deps.setupTurnFor?.(this.roomCode,this.playerId,phase)==='waiting'){
        this.deps.say?.(createTranslator(this.commandLocale,RACER_MESSAGES)('voice.waitingForPlayers'));
        return;
      }
    }
    if(this.stationManaged&&this.roomCode&&this.playerId
      &&((ev.kind==='car_picked'&&ev.playerId!==this.playerId)||
        (ev.kind==='map_picked'&&ev.playerId!==undefined&&ev.playerId!==this.playerId))){
      const phase=ev.kind==='car_picked'?'car_select':'map_select';
      if(this.deps.setupTurnFor?.(this.roomCode,this.playerId,phase)==='active'){
        this.deps.say?.(createTranslator(this.commandLocale,RACER_MESSAGES)(
          phase==='car_select'?'voice.helpCar':'voice.helpMap',
        ));
        return;
      }
    }
    if (isChattyEvent(ev.kind)) {
      if (now - this.lastChattyAt < CHATTY_GAP_MS) return;   // too soon → stay quiet
      const line = lineForEvent(ev, this.playerId, this.lineSeq, this.commandLocale);
      if (line) { this.lastChattyAt = now; this.lineSeq++; this.deps.say?.(line); }
      return;
    }
    if (ev.kind === 'finish' && this.playerId && ev.playerId === this.playerId) {
      this.myFinishPlace = ev.place;
      if (this.stationManaged) return;
    }
    // The final recap waits for race_over so the room is on the results screen and hostContext has the
    // actual standings. A finish event can fire earlier while other racers are still driving.
    if (ev.kind === 'race_over' && this.playerId && !this.recapDone) {
      this.requestResultRecap();
      return;
    }
    const line = lineForEvent(ev, this.playerId, this.lineSeq, this.commandLocale);
    if (line) {
      this.lineSeq++;
      const expectedPhase = ev.kind === 'enter_car_select' ? 'car_select'
        : ev.kind === 'enter_map_select' ? 'map_select' : null;
      this.deps.say?.(line, expectedPhase ? this.phaseGuard(expectedPhase) : undefined);
    }
  }

  async whenSpeechSettled(): Promise<void> {
    await Promise.allSettled([...this.pendingSpeech]);
  }

  private speakResultRecap(text: string): void {
    for (const sentence of text.split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(Boolean)) {
      this.deps.say?.(sentence);
    }
  }

  private requestResultRecap(): void {
    if (!this.playerId || !this.roomCode || this.recapDone) return;
    this.recapDone = true;
    this.lateRacingPromptUntil = Date.now() + 10_000;
    const fallback = () => this.stationManaged
      ? createTranslator(this.commandLocale, RACER_MESSAGES)('voice.waitOperator')
      : raceOverLine(this.myFinishPlace, this.commandLocale);
    if (!this.deps.converse) { this.speakResultRecap(fallback()); return; }
    const epoch = ++this.turnEpoch;
    const prompt = createTranslator(this.commandLocale, RACER_MESSAGES)('voice.raceOverPrompt');
    let speech!: Promise<void>;
    const isCurrent = () => epoch === this.turnEpoch && this.active;
    speech = this.deps.converse(this.roomCode, this.playerId, prompt, this.commandLocale, isCurrent)
      .then(reply => { if (epoch === this.turnEpoch) this.speakResultRecap((typeof reply==='string'?reply:reply?.text) || fallback()); })
      .catch(() => { if (epoch === this.turnEpoch) this.speakResultRecap(fallback()); })
      .finally(() => this.pendingSpeech.delete(speech));
    this.pendingSpeech.add(speech);
  }

  ignoreLateRacingPrompt(final: boolean): void {
    this.lateRacingPromptActive = !final;
    if (final) this.firedIntents = [];
  }

  acceptsLateRacingPrompt(): boolean {
    return Date.now() <= this.lateRacingPromptUntil;
  }

  hasActiveLateRacingPrompt(): boolean {
    return this.lateRacingPromptActive;
  }

  handleMessage(raw: string): void {
    const msg = parseCrMessage(raw);
    switch (msg.type) {
      case 'setup': {
        const code = msg.customParameters['roomCode'];
        this.commandLocale = resolveLocale(msg.customParameters['commandLocale'] ?? msg.customParameters['locale'], DEFAULT_LOCALE);
        console.log(`[CR] setup callSid=${msg.callSid} roomCode=${code ?? '(none)'} commandLocale=${this.commandLocale}`);
        if (!code) { console.log('[CR] no roomCode → unbound'); return; }
        const room = this.deps.findOrCreateRoom(code);
        if (!room) { console.log(`[CR] room ${code} not found → unbound`); return; }
        const beforeJoinPhase=this.deps.phaseOf?.(code)??'lobby';
        this.callSid=msg.callSid;
        if(this.stationManaged)room.expectHumanPlayers?.(this.stationParticipantCount,true);
        else if(this.authoritativeName)room.expectHumanPlayers?.(1,false);
        else if((room.playerCount??0)>=1)room.expectHumanPlayers?.(2,false);
        const resumed=this.deps.resumePlayer?.(msg.callSid,code)??null;
        const res = resumed??room.addPlayer(this.authoritativeName ?? playerName(msg.from, this.commandLocale), undefined,
          this.stationManaged ? this.stationParticipantIndex : undefined);
        if ('error' in res) {
          console.log(`[CR] addPlayer rejected: ${res.error} → unbound (caller cannot drive)`);
          this.deps.say?.(createTranslator(this.commandLocale, RACER_MESSAGES)('voice.roomFull'));
          return;
        }
        if(!this.authoritativeName&&resumed?.name&&!/^(Racer|Piloto)(\s|$)/.test(resumed.name))this.authoritativeName=resumed.name.slice(0,50);
        this.room = room; this.playerId = res.playerId; this.roomCode = code;
        console.log(`[CR] bound caller to player ${res.playerId} lane ${res.lane} in room ${code}`);
        // Register for this room's game events + greet the caller. Send each greeting SENTENCE as its
        // own utterance so Relay TTS pauses naturally between them (one long string read run-on).
        this.deps.register?.(code, this);
        this.deps.onSetupChanged?.(code,beforeJoinPhase);
        if(this.authoritativeName)this.speakNamedArrival(resumed?.resumed===true);
        else if(resumed?.resumed===true){const text=createTranslator(this.commandLocale,RACER_MESSAGES);this.deps.say?.(text('voice.returned'));if((this.deps.phaseOf?.(code)??'lobby')==='lobby')this.deps.say?.(text('voice.helpLobby'));else this.speakPhaseGuidance();}
        else for(const line of greetingLines(this.commandLocale))this.deps.say?.(line);
        break;
      }
      case 'prompt': {
        const requestEpoch = ++this.turnEpoch;
        const phaseAtFrame=this.roomCode?this.deps.phaseOf?.(this.roomCode)??null:null;
        if(!msg.last&&phaseAtFrame&&['lobby','car_select','map_select'].includes(phaseAtFrame)
          &&this.setupPromptPhase===null)this.setupPromptPhase=phaseAtFrame;
        const originatingSetupPhase=msg.last?this.setupPromptPhase:null;
        if(msg.last)this.setupPromptPhase=null;
        if(msg.last&&originatingSetupPhase&&phaseAtFrame!==originatingSetupPhase){
          this.firedIntents=[];
          this.speakPhaseFallback(phaseAtFrame);
          break;
        }
        if(msg.last&&this.stationManaged&&this.roomCode&&['results','finished'].includes(this.deps.phaseOf?.(this.roomCode)??'')){
          this.firedIntents=[];
          if(!this.recapDone)this.requestResultRecap();
          else this.deps.say?.(createTranslator(this.commandLocale,RACER_MESSAGES)('voice.waitOperator'));
          break;
        }
        if (msg.last && isHelpRequest(msg.voicePrompt, this.commandLocale)) {
          this.firedIntents = [];
          const phase = this.roomCode ? this.deps.phaseOf?.(this.roomCode) : null;
          const waiting=this.stationManaged&&this.roomCode&&this.playerId&&phase
            &&['car_select','map_select'].includes(phase)
            &&this.deps.setupTurnFor?.(this.roomCode,this.playerId,phase)==='waiting';
          const key = waiting?'voice.waitingForPlayers'
            :phase === 'car_select' ? 'voice.helpCar'
            : phase === 'map_select' ? 'voice.helpMap'
              : phase === 'results' || phase === 'finished' ? 'voice.helpResults'
                : phase === 'racing' || phase === 'countdown' ? 'voice.help'
                  : this.authoritativeName ? 'voice.helpLobbyNamed' : 'voice.helpLobby';
          this.deps.say?.(createTranslator(this.commandLocale, RACER_MESSAGES)(key), phase ? this.phaseGuard(phase) : undefined);
          break;
        }
        const setupPhase=this.roomCode?this.deps.phaseOf?.(this.roomCode):null;
        if(msg.last&&this.roomCode&&this.playerId&&setupPhase&&['lobby','car_select','map_select'].includes(setupPhase)){
          this.firedIntents=[];
          const now=Date.now();
          if(now-this.setupPhaseEnteredAt<SETUP_PHASE_GUARD_MS){
            this.speakPhaseFallback(setupPhase);
            break;
          }
          const reply=this.deps.handleSetupUtterance?.(this.roomCode,this.playerId,msg.voicePrompt,this.commandLocale)??null;
          const currentPhase=this.deps.phaseOf?.(this.roomCode)??setupPhase;
          this.lastFinalCommand={text:msg.voicePrompt.trim().toLocaleLowerCase(this.commandLocale),at:now,source:'setup'};
          if(currentPhase!==setupPhase)this.setupPhaseEnteredAt=now;
          if(reply)this.deps.say?.(reply,this.phaseGuard(currentPhase));
          else this.speakPhaseFallback(currentPhase);
          break;
        }
        // ROUTE by phase: during a live RACE, keep the fast local command path (no LLM latency in the
        // hot loop). In menus/results, route the FINAL utterance to the conversational AI host so the
        // caller can talk naturally ("which car is fastest?", "pick me a fast one", "start the race").
        const racing = this.deps.phaseOf && this.roomCode
          ? (this.deps.phaseOf(this.roomCode) === 'racing' || this.deps.phaseOf(this.roomCode) === 'countdown')
          : true;   // no phaseOf → behave as before (command path)

        if (racing || !this.deps.converse) {
          // Interim hypotheses are revisable. Mutate authoritative race state only from the final
          // transcript so a correction such as left -> right cannot execute both commands.
          if (!msg.last) break;
          const normalizedFinal=msg.voicePrompt.trim().toLocaleLowerCase(this.commandLocale);
          const now=Date.now();
          const commandPhase=this.roomCode?this.deps.phaseOf?.(this.roomCode)??'unknown':'unbound';
          const duplicateWindow=this.lastFinalCommand?.source==='setup'?SETUP_PHASE_GUARD_MS:400;
          if(this.lastFinalCommand?.text===normalizedFinal&&now-this.lastFinalCommand.at<duplicateWindow){
            console.log(`[CR] command call=${this.callSid.slice(0,8)||'unknown'} player=${this.playerId??'unbound'} phase=${commandPhase} duplicate-final=true`);
            break;
          }
          this.lastFinalCommand={text:normalizedFinal,at:now,source:'race'};
          const intents = intentsFromTranscript(msg.voicePrompt, this.commandLocale);
          if (!intents.length) {
            const phase = this.roomCode ? this.deps.phaseOf?.(this.roomCode) ?? null : null;
            if (this.deps.converse && this.roomCode && this.playerId) {
              this.requestConversation(msg.voicePrompt.trim(), requestEpoch, phase);
            } else this.speakPhaseFallback(phase);
            break;
          }
          const accepted:Intent[]=[];
          if (this.room && this.playerId) for (const intent of intents) {
            if(this.room.applyIntent(this.playerId,intent)!==false){accepted.push(intent);this.deps.onIntent?.(intent);}
          }
          console.log(`[CR] command call=${this.callSid.slice(0,8)||'unknown'} player=${this.playerId??'unbound'} phase=${this.roomCode?this.deps.phaseOf?.(this.roomCode)??'unknown':'unbound'} requested=[${intents.join(',')}] accepted=[${accepted.join(',')}]`);
          this.firedIntents = [];
        } else if (msg.last && this.roomCode && this.playerId) {
          // Conversational path — only on the FINAL transcript (partials would spam the LLM). Fire and
          // forget; the reply is spoken via deps.say when it resolves — UNLESS the caller has spoken
          // again or barged in since (epoch moved), in which case the stale reply is dropped.
          const text = msg.voicePrompt.trim();
          if (text) this.requestConversation(text, requestEpoch, this.deps.phaseOf?.(this.roomCode) ?? null);
        }
        break;
      }
      case 'dtmf': {
        console.log(`[CR] dtmf digit=${msg.digit}${this.playerId ? '' : ' (NOT BOUND)'}`);
        if (!this.room || !this.playerId) return;
        const phase = this.roomCode ? this.deps.phaseOf?.(this.roomCode) : null;
        if (phase === 'racing' || phase === 'countdown' || !this.deps.phaseOf) {
          const intent = DTMF_TO_INTENT[msg.digit];
          if (intent) {
            const accepted=this.room.applyIntent(this.playerId,intent)!==false;
            if(accepted)this.deps.onIntent?.(intent);
            console.log(`[CR] command call=${this.callSid.slice(0,8)||'unknown'} player=${this.playerId} phase=${phase??'unknown'} dtmf=${msg.digit} accepted=${accepted}`);
          }
        } else if (/^\d+$/.test(msg.digit)) {
          this.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: msg.digit, last: true }));
        }
        break;
      }
      case 'interrupt': {
        // Barge-in: the caller talked over the host. Conversation Relay already stopped the TTS on its
        // side; we bump the epoch so any in-flight conversational reply is dropped (not spoken late),
        // and clear the current utterance's fired-intents so their next words are read fresh.
        console.log(`[CR] interrupt after ${msg.durationUntilInterruptMs}ms; played="${msg.utteranceUntilInterrupt}"`);
        this.turnEpoch++;
        this.firedIntents = [];
        this.setupPromptPhase=null;
        if(this.stationManaged&&this.roomCode&&['results','finished'].includes(this.deps.phaseOf?.(this.roomCode)??'')){
          this.recapDone=false;this.requestResultRecap();
        }
        break;
      }
      case 'error':
        console.log(`[CR] error: ${msg.description}`);
        return;
      case 'unknown':
        return;
    }
  }

  private speakNamedArrival(resumed:boolean):void{
    if(!this.authoritativeName||!this.roomCode)return;
    const text=createTranslator(this.commandLocale,RACER_MESSAGES);
    this.deps.say?.(text(resumed?'voice.returnedNamed':'voice.welcomeNamed',{name:this.authoritativeName}));
    if(!resumed){this.deps.say?.(text('voice.greeting.1'));this.deps.say?.(text('voice.controlsIntro'));}
    this.speakPhaseGuidance();
  }

  private speakPhaseGuidance():void{
    if(!this.roomCode)return;
    const text=createTranslator(this.commandLocale,RACER_MESSAGES);
    const phase=this.deps.phaseOf?.(this.roomCode)??'lobby';
    if(this.stationManaged&&['results','finished'].includes(phase)){this.requestResultRecap();return;}
    const waiting=this.stationManaged&&this.playerId&&['car_select','map_select'].includes(phase)
      &&this.deps.setupTurnFor?.(this.roomCode,this.playerId,phase)==='waiting';
    const key=waiting?'voice.waitingForPlayers'
      :phase==='car_select'?'voice.helpCar'
      :phase==='map_select'?'voice.helpMap'
      :phase==='racing'||phase==='countdown'?'voice.help'
      :phase==='results'||phase==='finished'?(this.stationManaged?'voice.waitOperator':'voice.helpResults')
      :'voice.helpLobbyNamed';
    this.deps.say?.(text(key), this.phaseGuard(phase));
  }

  handleClose(preservePlayer = false): void {
    this.active=false;this.turnEpoch++;
    this.deps.unregister?.(this);
    // Prefer leaveRoom (drops the slot AND reaps an empty room); fall back to plain removePlayer.
    if (this.playerId && !preservePlayer) {
      if (this.roomCode && this.deps.leaveRoom) this.deps.leaveRoom(this.roomCode, this.playerId);
      else this.room?.removePlayer(this.playerId);
    }
    this.room = null; this.playerId = null; this.roomCode = null;
  }

  private phaseGuard(expectedPhase:string):()=>boolean{
    return()=>this.active&&Boolean(this.roomCode)&&this.deps.phaseOf?.(this.roomCode!)===expectedPhase;
  }

  private requestConversation(text: string, epoch: number, requestPhase: string | null): void {
    if (!text || !this.deps.converse || !this.roomCode || !this.playerId) return;
    const roomCode = this.roomCode, playerId = this.playerId;
    const isCurrent = () => epoch === this.turnEpoch && this.active;
    void this.deps.converse(roomCode, playerId, text, this.commandLocale, isCurrent)
      .then(result => {
        if (!isCurrent()) return;
        if (!result) { this.speakPhaseFallback(requestPhase); return; }
        const reply=typeof result==='string'?result:result.text;
        const expectedPhase=typeof result==='string'?requestPhase:result.phase;
        if (expectedPhase && this.deps.phaseOf?.(roomCode) !== expectedPhase) return;
        this.deps.say?.(reply, expectedPhase ? this.phaseGuard(expectedPhase) : undefined);
      })
      .catch(() => { if (isCurrent()) this.speakPhaseFallback(requestPhase); });
  }

  private speakPhaseFallback(phase: string | null): void {
    const text = createTranslator(this.commandLocale, RACER_MESSAGES);
    const waiting=this.stationManaged&&this.roomCode&&this.playerId&&phase
      &&['car_select','map_select'].includes(phase)
      &&this.deps.setupTurnFor?.(this.roomCode,this.playerId,phase)==='waiting';
    const key = waiting?'voice.waitingForPlayers'
      :phase === 'car_select' ? 'voice.helpCar'
      : phase === 'map_select' ? 'voice.helpMap'
        : phase === 'results' || phase === 'finished' ? 'voice.helpResults'
          : phase === 'racing' || phase === 'countdown' ? 'voice.help'
            : this.authoritativeName || (this.roomCode && this.playerId
              && this.deps.hasPlayerName?.(this.roomCode, this.playerId)) ? 'voice.helpLobbyNamed' : 'voice.helpLobby';
    this.deps.say?.(text(key), phase ? this.phaseGuard(phase) : undefined);
  }
}

function playerName(from: string | undefined, locale: SupportedLocale): string {
  const racer = createTranslator(locale, RACER_MESSAGES)('voice.playerName');
  if (from && from.length >= 4) return `${racer} ${from.slice(-4)}`;
  return racer;
}

function isHelpRequest(spoken: string, locale: SupportedLocale): boolean {
  const text = spoken.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase(locale);
  return locale === 'pt-BR'
    ? /\b(ajuda|instrucoes|comandos|como jogar|o que posso dizer)\b/.test(text)
    : /\b(help|instructions|commands|how do i play|what can i say)\b/.test(text);
}
