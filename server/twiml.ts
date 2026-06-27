function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
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
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${esc(opts.sessionEndedUrl)}">
    <ConversationRelay url="${esc(opts.wsUrl)}" transcriptionProvider="Deepgram" speechModel="flux" partialPrompts="true" transcriptionLanguage="en-US" interruptible="none" dtmfDetection="true" hints="left, right, boost, brake, use power" speechTimeout="600" eotThreshold="0.5" welcomeGreeting="">
      <Parameter name="roomCode" value="${esc(opts.roomCode)}" />
    </ConversationRelay>
  </Connect>
</Response>`;
}
