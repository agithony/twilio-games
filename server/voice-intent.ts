import type { Intent } from '../shared/types';

// Each intent maps to the words/phrases that trigger it. Order within the scan
// is by last-occurrence in the transcript so self-corrections ("left no right")
// take the latest command.
const WORD_TO_INTENT: { word: string; intent: Intent }[] = [
  { word: 'left', intent: 'MOVE_LEFT' },
  { word: 'right', intent: 'MOVE_RIGHT' },
  { word: 'boost', intent: 'BOOST' },
  { word: 'go', intent: 'BOOST' },           // "go" = accelerate
  { word: 'brake', intent: 'BRAKE' },
  { word: 'slow', intent: 'BRAKE' },          // "slow down"
  { word: 'stop', intent: 'BRAKE' },
  { word: 'power', intent: 'USE_POWER' },     // "use power" / "power"
];

export function mapTranscriptToIntent(transcript: string): Intent | null {
  const norm = transcript.toLowerCase().replace(/[^a-z\s]/g, ' ');
  const tokens = norm.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  // scan from the end so the latest spoken command wins
  for (let i = tokens.length - 1; i >= 0; i--) {
    const hit = WORD_TO_INTENT.find(w => w.word === tokens[i]);
    if (hit) return hit.intent;
  }
  return null;
}

/**
 * Extract the ordered list of command intents from a transcript, one entry per
 * matching token. e.g. "left right boost" → [MOVE_LEFT, MOVE_RIGHT, BOOST].
 * Used to handle Conversation Relay's ACCUMULATING partial transcripts: we look
 * at how many commands a growing partial contains and only act on newly-added ones.
 */
export function intentsFromTranscript(transcript: string): Intent[] {
  const norm = transcript.toLowerCase().replace(/[^a-z\s]/g, ' ');
  const tokens = norm.split(/\s+/).filter(Boolean);
  const out: Intent[] = [];
  for (const tok of tokens) {
    const hit = WORD_TO_INTENT.find(w => w.word === tok);
    if (hit) out.push(hit.intent);
  }
  return out;
}
