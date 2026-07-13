import type { FighterCommand } from './fighter-world';

const COMMANDS: [FighterCommand, RegExp][] = [
  ['forward', /^(?:move |step |go )?(?:forward|closer|in)$/],
  ['back', /^(?:move |step |go )?(?:back|backward|away)$/],
  ['jump', /^(?:jump|leap|hop)$/],
  ['punch', /^(?:punch|jab|strike|hit)$/],
  ['kick', /^(?:kick|roundhouse)$/],
  ['block', /^(?:block|guard|defend)$/],
];

export function matchFighterCommand(spoken: string): FighterCommand | null {
  const text = spoken.toLowerCase().trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  for (const [command, pattern] of COMMANDS) if (pattern.test(text)) return command;
  return null;
}

export function matchFighterCommands(spoken: string): FighterCommand[] {
  const single = matchFighterCommand(spoken); if (single) return [single];
  const text = spoken.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const counts: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const repeated = text.match(/^(.+?)\s+(one|two|three|four|five|six|[1-6])\s+times?$/);
  if (repeated) {
    const command = matchFighterCommand(repeated[1]!);
    const count = Number(repeated[2]) || counts[repeated[2]!] || 0;
    return command ? Array.from({ length: count }, () => command) : [];
  }
  const commands: FighterCommand[] = [];
  const filler = new Set(['and', 'then', 'move', 'step', 'go']);
  for (const token of text.split(' ')) {
    const command = matchFighterCommand(token);
    if (command) commands.push(command);
    else if (!filler.has(token)) return [];
    if (commands.length === 6) break;
  }
  return commands;
}
