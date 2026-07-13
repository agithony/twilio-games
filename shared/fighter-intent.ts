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
