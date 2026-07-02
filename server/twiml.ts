function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** An SMS reply: one outbound message back to the sender. */
export function twimlMessage(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${esc(text)}</Message></Response>`;
}

/** An empty response: acknowledge the webhook without sending any SMS (e.g. duplicate retry). */
export function twimlEmpty(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>`;
}

export function twimlGatherRoomCode(opts: { actionUrl: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="4" timeout="8" action="${esc(opts.actionUrl)}" method="POST">
    <Say>Welcome to Voice Racer. Enter your four digit room code.</Say>
  </Gather>
  <Say>No code received. Goodbye.</Say>
</Response>`;
}

export function twimlConnectRelay(opts: {
  wsUrl: string; sessionEndedUrl: string; roomCode: string;
  // TTS voice for talk-back (greeting/countdown/result). ElevenLabs is Conversation Relay's premium
  // provider; `voice` is an ElevenLabs voiceId. Both optional → Relay uses its default voice.
  ttsProvider?: string; voice?: string;
  // Spoken the instant the call connects (before the game WS binds) — a quick intro.
  welcomeGreeting?: string;
  // Which game this call joins ('racer' | 'monsters'), passed to the WS so it routes correctly.
  game?: string;
  // ASR biasing hints — the game's key spoken words (commands / move names) for better recognition.
  hints?: string;
}): string {
  // Only emit tts attrs when a voice is configured (an empty voice="" would be invalid).
  const ttsAttrs = opts.voice
    ? ` ttsProvider="${esc(opts.ttsProvider ?? 'ElevenLabs')}" voice="${esc(opts.voice)}"`
    : '';
  const greeting = esc(opts.welcomeGreeting ?? '');
  const hints = esc(opts.hints ?? 'left, right, boost, go, brake, slow, stop, nitro, power');
  const gameParam = opts.game ? `\n      <Parameter name="game" value="${esc(opts.game)}" />` : '';
  // Interruption (barge-in) is a headline Conversation Relay feature and central to this app:
  //  - interruptible="speech": the caller's SPEECH cuts the TTS immediately (say "left" over the host).
  //  - reportInputDuringAgentSpeech="speech": we RECEIVE the caller's words while TTS plays (default
  //    is "none" as of May 2025, which would hide mid-speech commands entirely).
  //  - interruptSensitivity="medium" + ignoreBackchannel="true": a shared party screen is noisy; don't
  //    let background chatter / "yeah, okay" mutters falsely kill the host, but a real command does.
  // We handle the resulting {type:"interrupt"} message on the WS (stop speaking, trim LLM history).
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${esc(opts.sessionEndedUrl)}">
    <ConversationRelay url="${esc(opts.wsUrl)}"${ttsAttrs} transcriptionProvider="Deepgram" speechModel="flux" partialPrompts="true" transcriptionLanguage="en-US" interruptible="speech" reportInputDuringAgentSpeech="speech" interruptSensitivity="medium" ignoreBackchannel="true" dtmfDetection="true" hints="${hints}" speechTimeout="600" eotThreshold="0.6" welcomeGreeting="${greeting}">
      <Parameter name="roomCode" value="${esc(opts.roomCode)}" />${gameParam}
    </ConversationRelay>
  </Connect>
</Response>`;
}
