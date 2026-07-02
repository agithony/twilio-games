// The Voice Monsters conversational HOST brain — the battler's analog of game-host.ts. Turns a
// caller's natural-language utterance into a spoken reply + battle actions (pick a monster; FIGHT a
// move / GUARD / ITEM / TAUNT; advance/rematch) via an LlmClient, and answers questions about the
// game, the type chart, and the Twilio stack. Persona: a hype-but-knowledgeable battle commentator +
// concierge that KNOWS the live state (phase, monsters, HP, whose turn, potions) and can ACT on it.
//
// Pure-ish: all game access goes through the injected BattleHostContext; the LLM through LlmClient.
// No direct BattleRoom/WS dependency, so it unit-tests with fakes.
import type { LlmClient, LlmTurn, ToolSpec, ToolCall } from './llm';

/** What the host can SEE and DO for one caller in a battle. The adapter supplies this live. */
export interface BattleHostContext {
  phase: 'lobby' | 'monster_select' | 'battle' | 'results';
  monsters: string[];               // selectable monster display names (roster order)
  myName: string | null;            // caller's display name (null until they give one)
  myMonster: string | null;         // caller's chosen monster name, if any
  foeMonster: string | null;        // the opponent's monster name, once battling
  myHp: number | null; myMaxHp: number | null;
  foeHp: number | null; foeMaxHp: number | null;
  myPotions: number;                // Potions the caller has left (for the ITEM action)
  whoseTurn: 'me' | 'foe' | null;   // whose action the battle is waiting on
  moves: string[];                  // the caller's 4 move names (during battle)
  winnerName: string | null;        // set at results
  // Actions (return a short spoken confirmation, or null if they couldn't act):
  setName(name: string): string | null;
  selectMonster(name: string): string | null;   // fuzzy-match a monster name → pick it
  chooseAction(action: string): string | null;   // 'fight:<move>' | 'guard' | 'item' | 'taunt'
  advance(): string | null;                       // start battle / rematch / next phase
}

/** Tools the model may call to drive the battle by voice. */
export const BATTLE_HOST_TOOLS: ToolSpec[] = [
  { name: 'set_name', description: "Set the caller's name once they say it (e.g. 'I'm Ada' → set_name('Ada')). Shows on the big screen.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: "the caller's name" } }, required: ['name'] } },
  { name: 'select_monster', description: "Pick the caller's monster by name (or a fuzzy match like 'the electric one'). Only valid during monster selection.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'monster name to pick' } }, required: ['name'] } },
  { name: 'choose_action', description: "Take the caller's turn action during a battle. `action` is 'guard', 'item' (use a Potion), 'taunt', or 'fight:<move name>' to attack with one of their moves (e.g. 'fight:Thunder Jolt'). Only valid during battle, on the caller's turn.",
    parameters: { type: 'object', properties: { action: { type: 'string', description: "'guard' | 'item' | 'taunt' | 'fight:<move name>'" } }, required: ['action'] } },
  { name: 'advance', description: 'Move the game forward when the caller is ready: start the battle from monster select, or rematch from the results screen.',
    parameters: { type: 'object', properties: {} } },
];

/** Build the system prompt: persona + LIVE battle state + rules. Regenerated each turn so the model
 *  always sees the current phase/HP/turn (cheap + keeps it grounded, exactly like the racer host). */
export function buildBattleSystemPrompt(ctx: BattleHostContext): string {
  const lines: string[] = [
    'You are the AI host + live commentator of "Voice Monsters", a phone-controlled, turn-based creature battler by Twilio, played on a big shared screen. Players call in and control everything BY VOICE.',
    'Personality: an excitable, knowledgeable battle commentator who is also a helpful concierge. Keep replies to ONE or TWO short spoken sentences — a live phone call, punchy and fun, never robotic or rambling. Talk enough to guide + hype, but do not monologue.',
    'Everything is BY VOICE — the caller never types. You collect their name, then their monster, by talking, then commentate the fight and take their turn actions when they call them.',
    '',
    'HOW TO PLAY (explain when asked, and prime players at the start): battles are TURN-BASED. On your turn choose one of four actions — say "FIGHT" then a move name (or a number 1-4) to attack; "GUARD" to brace (halves the next hit + heals a little); "ITEM" to use a Potion (heals a third of your health, two per battle); "TAUNT" to rattle the foe so its next attack is likelier to miss. Whoever picks their action FIRST that turn goes first.',
    'MOVES have a power rating (pips) and an accuracy — stronger moves can MISS, weaker moves are reliable, so it is a risk/reward call. Attacks can land a rare CRITICAL HIT for big bonus damage.',
    '',
    // ── Type-chart knowledge so it can answer matchup questions intelligently ──
    'TYPE MATCHUPS (so you can answer "what beats what"): the 9 types are normal, fire, water, grass, electric, rock, ground, flying, psychic. Key rules: fire beats grass + flying; water beats fire, rock, ground; grass beats water, rock, ground; electric beats water + flying (but does nothing extra to ground); rock beats fire + flying + psychic; ground beats fire, electric, rock; flying beats grass; psychic beats normal + flying but is resisted by rock. A super-effective hit does DOUBLE damage; a resisted one does HALF. Encourage players to attack with a type their foe is weak to.',
    '',
    'YOU CAN ANSWER QUESTIONS. If the caller asks about the game, controls, type matchups, what is on their screen, Twilio, or how this is built, answer helpfully in a sentence or two, then steer back to the battle.',
    'ABOUT THE TECH ("how does this work / how is this built"): built on Twilio Conversation Relay. The call streams live to a server over a WebSocket; Twilio transcribes the caller\'s speech and speaks your replies with text-to-speech; Conversation Relay handles real-time, interruptible voice — the caller can talk over you any time. The battle logic + this AI host run on the server. Keep tech answers short + in-character, not a lecture.',
    '',
    `CURRENT STATE: phase=${ctx.phase}; caller name=${ctx.myName ?? 'NOT SET YET'}${ctx.myMonster ? `; their monster=${ctx.myMonster}` : ''}${ctx.foeMonster ? `; opponent=${ctx.foeMonster}` : ''}.`,
    'The big screen SHOWS the same phase you are in. Refer to what is on their screen; do not talk about a step they are not on yet.',
  ];

  if (!ctx.myName) {
    lines.push("The caller has NOT given their name yet. FIRST job: ask their name. The moment they say it, CALL set_name AND in the SAME reply greet them by name and tell them what's next — do NOT just say 'nice to meet you' and stop. Immediately move them into picking a monster (see the phase note).");
  }
  if (ctx.phase === 'lobby') {
    lines.push("SCREEN: the LOBBY (players call in; the shared screen shows who's in). Once you have their name: greet them, say others can still call in OR they can jump right in, and that you'll take them to pick their monster — then CALL advance to go to MONSTER SELECT. NEVER end a turn on a bare 'nice to meet you'; always say the next step.");
  }
  if (ctx.phase === 'monster_select') {
    lines.push(`SCREEN: MONSTER SELECT — a grid of creatures is on the display RIGHT NOW. Tell the caller to PICK their monster (say a name or a number). The ONLY monsters are, in order: ${numberedList(ctx.monsters)}. These names are EXACT — only ever say one from THIS list, never invent one; if unsure, say its number.`);
    if (ctx.myMonster) lines.push(`The caller picked ${ctx.myMonster} (their square is highlighted on screen). If they're happy, tell them to say "battle" / "start" and CALL advance; to change, CALL select_monster again.`);
    else lines.push('The caller has NOT picked yet. Prompt them to choose — suggest one with a fun one-liner about its type — and CALL select_monster when they name one. Do NOT advance until they have a monster.');
  }
  if (ctx.phase === 'battle') {
    const hp = (h: number | null, m: number | null) => (h !== null && m !== null ? `${h}/${m}` : '?');
    lines.push(`A BATTLE is LIVE. ${ctx.myMonster ?? 'Your monster'} (HP ${hp(ctx.myHp, ctx.myMaxHp)}) vs ${ctx.foeMonster ?? 'the rival'} (HP ${hp(ctx.foeHp, ctx.foeMaxHp)}).`);
    if (ctx.moves.length) lines.push(`The caller's moves are: ${numberedList(ctx.moves)}. When they pick one, CALL choose_action to attack. In your SPOKEN reply, say the move's plain English name only (e.g. "Thunder Jolt!") — NEVER say the tool format, a colon, an underscore, or any code-like token out loud.`);
    if (ctx.whoseTurn === 'me') lines.push(`It is the CALLER'S turn — help them choose. If they name a move, GUARD, ITEM, or TAUNT, CALL choose_action. Give a quick tactical nudge (e.g. suggest a super-effective move, or GUARD/ITEM when low on HP) but keep it to one short sentence.`);
    else if (ctx.whoseTurn === 'foe') lines.push('It is the RIVAL\'S turn — briefly commentate what is happening; do not take an action for the caller.');
    else lines.push('Mid-resolution — commentate the action briefly and excitedly (one short line).');
    lines.push(`The caller has ${ctx.myPotions} Potion${ctx.myPotions === 1 ? '' : 's'} left.`);
  }
  if (ctx.phase === 'results') {
    const iWon = ctx.myMonster && ctx.winnerName && ctx.myName && ctx.winnerName.includes(ctx.myName);
    if (iWon) lines.push('The caller just WON! React with MAXIMUM hype like a title-fight announcer (in words, no emojis). Celebrate them by name, then invite a rematch (CALL advance if they say yes).');
    else lines.push(`The battle is over${ctx.winnerName ? ` — ${ctx.winnerName} won` : ''}. Give an upbeat, encouraging reaction and invite a rematch (CALL advance if they say yes).`);
  }

  lines.push('',
    'RULES: Never invent monster or move names — use ONLY the exact lists above. SPOKEN OUTPUT IS READ ALOUD: say only natural English — NEVER speak ids, slugs, underscores, colons, the word "underscore", or any code/variable/tool token (say "Thunder Jolt", never "sparkmouse_jolt" or "fight colon"). Do NOT advance past the current step unless it is done AND the caller is ready. Never mention being an AI language model. Stay in character. No emojis.');
  return lines.join('\n');
}

/** Render choices as a spoken-friendly numbered list, anchoring the model to exact names + numbers. */
function numberedList(items: string[]): string {
  return items.map((n, i) => `${i + 1}) ${n}`).join(', ');
}

/** Run one conversational turn: LLM sees the utterance + state + tools, we execute its tool calls
 *  against the context, and return what to SAY (its words, or a tool confirmation if it said nothing).
 *  Returns null when the LLM is disabled/empty so the caller falls back to scripted commentary. */
export async function battleHostTurn(
  llm: LlmClient, ctx: BattleHostContext, history: LlmTurn[],
): Promise<string | null> {
  if (!llm.enabled) return null;
  const reply = await llm.respond(buildBattleSystemPrompt(ctx), history, BATTLE_HOST_TOOLS);
  const confirmations = reply.toolCalls.map(tc => runBattleTool(ctx, tc)).filter((s): s is string => !!s);
  const said = reply.say.trim();
  // Anti-repetition: if the model spoke, trust ITS words alone (it usually acknowledges its own
  // action). Only fall back to the tool confirmation on a bare tool call. Never concatenate both.
  if (said) return said;
  if (confirmations.length) return confirmations.join(' ');
  return null;
}

/** Execute one tool call against the battle, returning a short confirmation to speak (or null). */
function runBattleTool(ctx: BattleHostContext, tc: ToolCall): string | null {
  const argName = typeof tc.args.name === 'string' ? tc.args.name : '';
  const argAction = typeof tc.args.action === 'string' ? tc.args.action : '';
  switch (tc.name) {
    case 'set_name':        return argName ? ctx.setName(argName) : null;
    case 'select_monster':  return ctx.phase === 'monster_select' && argName ? ctx.selectMonster(argName) : null;
    case 'choose_action':   return ctx.phase === 'battle' && argAction ? ctx.chooseAction(argAction) : null;
    case 'advance':         return ctx.advance();
    default:                return null;
  }
}
