// The conversational AI HOST brain: turns a caller's natural-language utterance into a spoken reply
// + game actions, using an LlmClient. Persona = hype race announcer + helpful concierge that KNOWS
// the game state and can ACT on it (pick a car, choose a map, start the race) via function-calling.
//
// Pure-ish: all game access goes through the injected HostContext (a narrow, testable seam), and the
// LLM through LlmClient. game-host has NO direct Room/WS dependency, so it unit-tests with fakes.
import type { LlmClient, LlmTurn, ToolSpec, ToolCall } from './llm';

/** What the host can SEE and DO for one caller. The adapter supplies this from the live room. */
export interface HostContext {
  phase: 'lobby' | 'car_select' | 'map_select' | 'countdown' | 'racing' | 'results' | 'finished';
  cars: string[];                 // selectable car display names (index order)
  maps: string[];                 // selectable track names
  selectedMap: string | null;
  myName: string | null;          // the caller's chosen display name (null until they give one)
  myCar: string | null;           // the caller's currently-picked car name, if any
  myPlace: number | null;         // during/after a race, the caller's place
  racerCount: number;
  // ── results-screen extras (for the post-race recap) ──
  raceStandings?: { name: string; place: number }[];   // this race's finishing order (for a recap)
  allTimeTop?: string[];                                // a few top all-time names (fastest-first)
  allTimeBest?: { name: string; time: number } | null;  // the all-time fastest run (name + seconds)
  // Actions (each returns a short confirmation the caller can be told, or null if it couldn't act):
  setName(name: string): string | null;             // set the caller's display name (shown on screen)
  selectCarByName(name: string): string | null;   // fuzzy-match a car name → pick it
  selectMapByName(name: string): string | null;    // fuzzy-match a map name → pick it
  startRace(): string | null;                       // advance/kick off if allowed
}

/** The tools the model may call to drive the game by voice. */
export const HOST_TOOLS: ToolSpec[] = [
  { name: 'set_name', description: "Set the caller's racer name once they tell you it. Call this as soon as they give a name (e.g. 'I'm Ada' → set_name('Ada')). The name shows on the big screen.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: "the caller's name" } }, required: ['name'] } },
  { name: 'select_car', description: "Pick a car for the caller by its name (or a fuzzy match like 'the fast one' → choose a sporty car). Only valid during car selection.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'car name to pick' } }, required: ['name'] } },
  { name: 'select_map', description: 'VOTE for the race track by name on the caller\'s behalf. Only valid during track selection. The winning track is decided by votes across all players.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'track name to vote for' } }, required: ['name'] } },
  { name: 'start_race', description: 'Start the race / advance the menu forward when the caller says they are ready.',
    parameters: { type: 'object', properties: {} } },
];

/** Build the system prompt: persona + LIVE game state + rules. Regenerated each turn so the model
 *  always sees the current phase/choices (cheap, and keeps it grounded). */
export function buildSystemPrompt(ctx: HostContext): string {
  const lines: string[] = [
    'You are the AI host + live commentator of "Voice Racer", a phone-controlled arcade racing game by Twilio, played on a big shared screen. Players call in and control everything BY VOICE.',
    'Personality: upbeat, clear, and measured — not over-the-top. You are a helpful race host, not a shouting announcer. Keep replies to ONE or TWO short spoken sentences for a live phone call.',
    'Everything is done BY VOICE — the caller never types or texts. You collect their setup by talking: their name, then their car, then their track vote. Use the tools to record each.',
    '',
    'HOW TO PLAY (tell players when they ask, and remind them at the start): during the race they SHOUT commands — "left"/"right" to change lane, "boost" (or "go") to speed up (keep saying it to build speed), "brake" to slow down. "NITRO" is the special move: a NITRO DASH that makes them INVULNERABLE for a couple seconds so they SMASH THROUGH barriers unharmed instead of crashing. It is DIFFERENT from boost — boost just goes faster; NITRO busts through a wall you cannot dodge. One dash charge; grab a glowing orb on the track to refill. NITRO is the move players most often forget — remind them to say "nitro" and that it smashes through barriers.',
    '',
    // ── Knowledge base so the host can actually HAVE a conversation / answer questions ──
    'YOU CAN ANSWER QUESTIONS — and you are SMART and context-aware. If the caller asks about the game, the controls, strategy ("how do I win?", "what does nitro do?"), what screen they are on, who is winning, Twilio, or how this app is built, answer helpfully and specifically in a sentence or two, then steer back to racing. Use the LIVE STATE below so your answers fit exactly what is on their screen right now. Never give a generic non-answer.',
    'BARGE-IN: the caller can interrupt you at ANY time — that is a feature (Conversation Relay). If they cut you off with a new question or command, drop what you were saying and respond to the NEW thing. Never scold them for interrupting.',
    'ABOUT THE TECH (for "how does this work / how is this built"): built on Twilio Conversation Relay. The voice call streams live to a server over a WebSocket; Twilio transcribes the caller\'s speech in real time (Deepgram) and speaks your replies with text-to-speech (ElevenLabs). Conversation Relay handles low-latency, INTERRUPTIBLE voice — the caller can talk over you any time and you hear them mid-sentence — plus DTMF keypad input. The game logic + this AI host run on a Node server; a big shared screen shows the race. Keep tech answers short + in-character (a hype host who happens to know the stack), not a lecture.',
    '',
    `CURRENT STATE: phase=${ctx.phase}; players in room=${ctx.racerCount}; caller name=${ctx.myName ?? 'NOT SET YET'}${ctx.myCar ? `; their car=${ctx.myCar}` : ''}.`,
    'The big screen is SHOWING the same phase you are in right now. Refer to what is on their screen; do NOT talk about a step they are not on yet.',
  ];
  // Onboarding sequence: proactively drive name → car → map → start, ONE step at a time. Always get
  // the NAME first (any phase) if it's still unset.
  if (!ctx.myName) {
    lines.push("The caller has NOT given their name yet. Your FIRST job: ask their name, and the moment they say it, CALL set_name. In the SAME reply, greet them BY NAME, tell them to look at the controls on the screen, and briefly explain: say left/right to steer, boost to speed up, brake to slow down, and nitro to break through a wall. Then tell them to say start when ready to pick a car — do NOT just say 'nice to meet you' and stop.");
  }
  if (ctx.phase === 'lobby') {
    lines.push("SCREEN: the LOBBY (players call in to join; the shared screen shows who's in). Once you have their name: greet them, say they can wait a moment for other players to call in OR jump right in, and that you'll take them to pick their car — then CALL start_race to advance to CAR selection. NEVER end a turn on a bare 'nice to meet you'; always tell them the next step. Nothing is picked yet, so don't mention specific cars/tracks.");
  }
  if (ctx.phase === 'car_select') {
    lines.push(`SCREEN: CAR SELECT — a grid of cars is on the display right now. The ONLY cars that exist are, in order: ${numberedList(ctx.cars)}. These names are EXACT — only ever say a car from THIS list, never invent or rename one, and if unsure read the number. Callers can pick by number ("car 2") or name.`);
    if (ctx.myCar) {
      lines.push(`The caller has picked the ${ctx.myCar}. If they are happy, CALL start_race to advance to the TRACK vote. If they want to change it, CALL select_car again.`);
    } else {
      lines.push('The caller has NOT picked a car yet. Ask which car they want (a fun one-line suggestion is great); when they name one or a number, CALL select_car. DO NOT talk about tracks/maps and DO NOT call start_race until they actually have a car — do not skip ahead.');
    }
  }
  if (ctx.phase === 'map_select') {
    lines.push(`SCREEN: TRACK VOTE — the tracks are on the display. This is a VOTE (each player votes; most votes wins, ties broken randomly). The ONLY tracks that exist are, in order: ${numberedList(ctx.maps)}.`);
    lines.push('CRITICAL — TRACK NAMES: say each track name EXACTLY as written above, word-for-word — do NOT translate it, spell it out, add flavor words, or invent a fancier name. If a name looks odd or you are unsure how to say it, refer to it by its NUMBER instead ("track two"). Never speak a track name that is not verbatim in the list. Prefer numbers — it is a shared screen and numbers are unambiguous.');
    lines.push(`${ctx.selectedMap ? `Currently leading: ${ctx.selectedMap}. ` : ''}Ask which track they want (you can say "say a track name or number") and CALL select_map to cast THEIR vote; tell them it is a vote. Only CALL start_race once they say they are ready to race.`);
  }
  if (ctx.phase === 'racing' || ctx.phase === 'countdown') {
    lines.push('A race is LIVE — the caller should be DRIVING (shouting left/right/boost/brake/nitro), and the scripted announcer handles the play-by-play. Do NOT narrate unprompted. But if they ASK you something mid-race ("what place am I?", "how do I use nitro?"), answer in a SNAPPY few words so it does not bury their next command. Otherwise stay quiet.');
  }
  if (ctx.phase === 'results' || ctx.phase === 'finished') {
    if (ctx.myPlace === 1) lines.push('The caller won the race. Congratulate them warmly, but keep it calm and concise.');
    else lines.push(`The race is over — the caller finished ${ctx.myPlace ? `in place ${ctx.myPlace}` : 'the race'}. Encourage them to try again, without sounding disappointed or overly dramatic.`);
    // A proactive RECAP + leaderboard OVERVIEW — this is the results screen, don't just wait silently.
    if (ctx.raceStandings && ctx.raceStandings.length > 1) {
      const order = ctx.raceStandings.slice(0, 3).map(s => `${s.place}) ${s.name}`).join(', ');
      lines.push(`RECAP: give a quick 1-2 sentence recap of how the race played out — the podium was: ${order}. Mention the winner + any close/notable finish. Do NOT list every position robotically; summarize like a broadcaster.`);
    }
    if (ctx.allTimeBest) {
      lines.push(`CURRENT TRACK LEADERBOARD (${ctx.selectedMap ?? 'this track'}): the record is ${ctx.allTimeBest.name} at ${ctx.allTimeBest.time.toFixed(1)} seconds${ctx.allTimeTop && ctx.allTimeTop.length > 1 ? ` (top names: ${ctx.allTimeTop.slice(0, 3).join(', ')})` : ''}. Use ONLY this track-specific leaderboard data when discussing high scores. A one-line overview, NOT a full readout.`);
    }
    lines.push('Then invite them to race again (say "rematch" or "go again").');
  }
  lines.push('',
    'RULES: Never invent car or track names — use ONLY the exact lists above. Do NOT advance the flow past the current step unless that step is done AND the caller is ready. Never mention that you are an AI language model. Stay in character as the race host. Do not use emojis (this is spoken aloud).');
  return lines.join('\n');
}

/** Render choices as a spoken-friendly numbered list ("1) Batmobile, 2) McLaren Senna, ..."). Anchors
 *  the model to EXACT names + their numbers so it never invents or mis-orders a car/track. */
function numberedList(items: string[]): string {
  return items.map((n, i) => `${i + 1}) ${n}`).join(', ');
}

/** Run one conversational turn: give the LLM the utterance + state + tools, execute any tool calls
 *  it requests against the HostContext, and return what to SAY back (reply + action confirmations).
 *  Returns null when the LLM is disabled/empty so the caller falls back to scripted lines. */
export async function hostTurn(
  llm: LlmClient, ctx: HostContext, history: LlmTurn[],
): Promise<string | null> {
  if (!llm.enabled) return null;
  const reply = await llm.respond(buildSystemPrompt(ctx), history, HOST_TOOLS);
  // Execute the tool calls (side effects: pick car/map, set name, start) — we still run them for
  // their game effect even if we don't speak their confirmation.
  const confirmations = reply.toolCalls.map(tc => runTool(ctx, tc)).filter((s): s is string => !!s);
  const said = reply.say.trim();
  // ANTI-REPETITION: the model usually acknowledges its own action in words ("Great pick, the
  // McLaren!"). Appending the tool confirmation too ("...the McLaren!") said the car/map name TWICE.
  // So: if the model spoke, trust ITS words alone. Only fall back to the confirmation when the model
  // said nothing (a bare tool call). Never concatenate both.
  if (said) return said;
  if (confirmations.length) return confirmations.join(' ');
  return null;
}

/** Execute one tool call against the game, returning a short confirmation to speak (or null). */
function runTool(ctx: HostContext, tc: ToolCall): string | null {
  const argName = typeof tc.args.name === 'string' ? tc.args.name : '';
  switch (tc.name) {
    case 'set_name':   return argName ? ctx.setName(argName) : null;
    case 'select_car': return ctx.phase === 'car_select' ? ctx.selectCarByName(argName) : null;
    case 'select_map': return ctx.phase === 'map_select' ? ctx.selectMapByName(argName) : null;
    case 'start_race': return ctx.startRace();
    default:           return null;
  }
}

/** Spoken number words → value, for "car eleven" / "number three" voice picks (ASR often gives words,
 *  not digits). Covers 1–20 which comfortably spans the roster + map list. */
const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

/** ORDINAL words → value ("the second one" = index 2). Checked BEFORE cardinals so "second" wins
 *  over the trailing filler "one" in phrases like "the second one" (which used to match "one"→1). */
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12,
};

/** Parse a 1-based selection NUMBER out of a spoken phrase ("car 11", "number three", "the 3rd one",
 *  "eleven", "the second one"), or null if none. Priority: digits → ordinal words → cardinal words.
 *  Ordinals beat cardinals so "the second one" is 2, not 1 (the trailing "one"). */
export function parseSelectionNumber(spoken: string): number | null {
  const q = spoken.toLowerCase();
  const digit = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);   // "car 11", "3", "3rd"
  if (digit) return parseInt(digit[1]!, 10);
  for (const [word, n] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(q)) return n;
  }
  for (const [word, n] of Object.entries(NUM_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(q)) return n;
  }
  return null;
}

/** Match a spoken phrase to a choice index. Tries a NUMBER first ("car 11" → index 10), then falls
 *  back to fuzzy NAME matching. Returns the index or -1. Shared by HostContext impls + tests. */
export function matchChoice(spoken: string, choices: string[]): number {
  const num = parseSelectionNumber(spoken);
  if (num !== null && num >= 1 && num <= choices.length) return num - 1;   // 1-based → index
  return fuzzyMatch(spoken, choices);
}

/** Is this utterance a QUESTION rather than a selection? ("which is fastest?", "what do you..."). */
function isQuestion(spoken: string): boolean {
  const q = spoken.toLowerCase().trim();
  return q.endsWith('?') || /^(which|what|who|how|why|when|where|can |could |should |do |does |is |are |tell me|explain)/.test(q);
}

/** A DETERMINISTIC selection: return the chosen index when the caller CLEARLY picked one (an in-range
 *  number, or a strong name match) and did NOT ask a question — else null so the LLM handles it. Used
 *  as a pre-LLM fast-path in menus so "two" / "the second one" reliably picks even if the model would
 *  have chatted instead (and so selection works with the LLM disabled). Questions fall through. */
export function clearSelectionIndex(spoken: string, choices: string[]): number | null {
  if (isQuestion(spoken)) return null;
  const num = parseSelectionNumber(spoken);
  if (num !== null) return (num >= 1 && num <= choices.length) ? num - 1 : null;
  const i = fuzzyMatch(spoken, choices);
  return i >= 0 ? i : null;
}

/** Fuzzy-match a spoken name against a list of choices (case-insensitive substring / word overlap).
 *  Returns the matched index or -1. Exposed so HostContext impls + tests share one matcher. */
export function fuzzyMatch(spoken: string, choices: string[]): number {
  const q = spoken.toLowerCase().trim();
  if (!q) return -1;
  // exact / substring first
  let idx = choices.findIndex(c => c.toLowerCase() === q);
  if (idx >= 0) return idx;
  idx = choices.findIndex(c => c.toLowerCase().includes(q) || q.includes(c.toLowerCase()));
  if (idx >= 0) return idx;
  // word-overlap: any shared significant word
  const qWords = new Set(q.split(/\s+/).filter(w => w.length > 2));
  idx = choices.findIndex(c => c.toLowerCase().split(/\s+/).some(w => qWords.has(w)));
  return idx;
}
