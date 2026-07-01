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
  myCar: string | null;           // the caller's currently-picked car name, if any
  myPlace: number | null;         // during/after a race, the caller's place
  racerCount: number;
  // Actions (each returns a short confirmation the caller can be told, or null if it couldn't act):
  selectCarByName(name: string): string | null;   // fuzzy-match a car name → pick it
  selectMapByName(name: string): string | null;    // fuzzy-match a map name → pick it
  startRace(): string | null;                       // advance/kick off if allowed
}

/** The tools the model may call to drive the game by voice. */
export const HOST_TOOLS: ToolSpec[] = [
  { name: 'select_car', description: "Pick a car for the caller by its name (or a fuzzy match like 'the fast one' → choose a sporty car). Only valid during car selection.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'car name to pick' } }, required: ['name'] } },
  { name: 'select_map', description: 'Choose the race track by name. Only valid during track selection.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'track name to pick' } }, required: ['name'] } },
  { name: 'start_race', description: 'Start the race / advance the menu forward when the caller says they are ready.',
    parameters: { type: 'object', properties: {} } },
];

/** Build the system prompt: persona + LIVE game state + rules. Regenerated each turn so the model
 *  always sees the current phase/choices (cheap, and keeps it grounded). */
export function buildSystemPrompt(ctx: HostContext): string {
  const lines: string[] = [
    'You are the AI host of "Voice Racer", a phone-controlled arcade racing game by Twilio, played on a big shared screen.',
    'Personality: a HYPE, upbeat race announcer who is also a helpful concierge. Keep replies to ONE or TWO short spoken sentences — this is a live phone call, be punchy and fun, never robotic.',
    'You can answer questions about how to play and act on the caller\'s requests using the provided tools.',
    'How to play: players call in and SHOUT commands during the race — "left", "right", "boost", "brake". Before the race they pick a car, then a track.',
    '',
    `CURRENT STATE: phase=${ctx.phase}; racers in room=${ctx.racerCount}.`,
  ];
  if (ctx.phase === 'car_select') lines.push(`Cars available: ${ctx.cars.join(', ')}. The caller ${ctx.myCar ? `has picked the ${ctx.myCar}` : 'has not picked yet'}. If they ask you to pick (e.g. "give me a fast car"), CALL select_car.`);
  if (ctx.phase === 'map_select') lines.push(`Tracks available: ${ctx.maps.join(', ')}. Selected: ${ctx.selectedMap ?? 'none'}. If they choose one, CALL select_map. If they're ready to race, CALL start_race.`);
  if (ctx.phase === 'lobby') lines.push('The game is in the lobby. If the caller is ready, CALL start_race to move to car selection.');
  if (ctx.phase === 'racing' || ctx.phase === 'countdown') lines.push('A race is LIVE — do NOT chat much; the caller should be driving. Keep any reply to a few words.');
  if (ctx.phase === 'results' || ctx.phase === 'finished') lines.push(`The race is over. The caller finished ${ctx.myPlace ? `in place ${ctx.myPlace}` : 'the race'}. Congratulate/console them and mention they can play again.`);
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
  const confirmations = reply.toolCalls.map(tc => runTool(ctx, tc)).filter((s): s is string => !!s);
  // Prefer the model's own words; append action confirmations. If it ONLY called a tool with no
  // words, speak the confirmation(s). If nothing at all, null → caller falls back.
  const parts = [reply.say, ...confirmations].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/** Execute one tool call against the game, returning a short confirmation to speak (or null). */
function runTool(ctx: HostContext, tc: ToolCall): string | null {
  const argName = typeof tc.args.name === 'string' ? tc.args.name : '';
  switch (tc.name) {
    case 'select_car': return ctx.phase === 'car_select' ? ctx.selectCarByName(argName) : null;
    case 'select_map': return ctx.phase === 'map_select' ? ctx.selectMapByName(argName) : null;
    case 'start_race': return ctx.startRace();
    default:           return null;
  }
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
