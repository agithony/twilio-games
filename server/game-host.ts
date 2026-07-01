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
    'You are the AI host of "Voice Racer", a phone-controlled arcade racing game by Twilio, played on a big shared screen.',
    'Personality: a HYPE, upbeat race announcer who is also a helpful concierge. Keep replies to ONE or TWO short spoken sentences — this is a live phone call, be punchy and fun, never robotic.',
    'Everything is done BY VOICE on this call — the caller never texts. You COLLECT their setup by talking: their name, then their car, then their track vote. Use the tools to record each.',
    'How to play: during the race the caller SHOUTS commands — "left", "right", "boost", "brake".',
    '',
    `CURRENT STATE: phase=${ctx.phase}; racers in room=${ctx.racerCount}; caller name=${ctx.myName ?? 'NOT SET YET'}.`,
  ];
  // Onboarding sequence: proactively drive name → car → map → start, asking the NEXT question after
  // each answer. Always get the NAME first (any phase) if it's still unset.
  if (!ctx.myName) {
    lines.push("The caller has NOT given their name yet. Your FIRST job: ask their name, and the moment they say it, CALL set_name with it, then move on to the car.");
  }
  if (ctx.phase === 'lobby') lines.push('Lobby phase. Once you have their name, tell them the race is about to set up and CALL start_race to move to car selection.');
  if (ctx.phase === 'car_select') lines.push(`Car selection. Cars available: ${ctx.cars.join(', ')}. The caller ${ctx.myCar ? `has picked the ${ctx.myCar}` : 'has NOT picked a car'}. Proactively ask which car they want (offer a fun suggestion); when they answer, CALL select_car. Once they have a car, move them to the track vote by CALLing start_race.`);
  if (ctx.phase === 'map_select') lines.push(`Track selection — this is a VOTE (multiple players may each vote; most votes wins, ties broken randomly). Tracks available: ${ctx.maps.join(', ')}. Ask which track they want and CALL select_map to cast THEIR vote. Tell them it's a vote. When they're ready, CALL start_race.`);
  if (ctx.phase === 'racing' || ctx.phase === 'countdown') lines.push('A race is LIVE — do NOT chat; the caller should be driving. Stay silent or a few words max.');
  if (ctx.phase === 'results' || ctx.phase === 'finished') {
    if (ctx.myPlace === 1) lines.push('The caller just WON — FIRST PLACE! React with MAXIMUM hype and energy, like a race announcer calling a photo finish. Be loud and thrilled (in words — no emojis). Celebrate them by name if you know it. Then invite them to race again.');
    else lines.push(`The race is over — the caller finished ${ctx.myPlace ? `in place ${ctx.myPlace}` : 'the race'}. Give an upbeat, encouraging reaction (still energetic!) and invite them to race again.`);
  }
  lines.push('', 'Never mention that you are an AI language model. Stay in character as the race host. Do not use emojis (this is spoken aloud).');
  return lines.join('\n');
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

/** Parse a 1-based selection NUMBER out of a spoken phrase ("car 11", "number three", "the 3rd one",
 *  "eleven"), or null if none. Digit forms + number words both handled. */
export function parseSelectionNumber(spoken: string): number | null {
  const q = spoken.toLowerCase();
  const digit = q.match(/\b(\d{1,2})\b/);   // "car 11", "3"
  if (digit) return parseInt(digit[1]!, 10);
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
