export interface JoinGuidanceInput {
  portuguese: boolean;
  mode: 'coin_only' | 'lead_capture';
  sms: boolean;
  whatsapp: boolean;
  termsRequired: boolean;
  freePlay: boolean;
}

export interface JoinGuidance {
  command: 'JOIN' | 'ENTRAR';
  messaging: boolean;
  intro: string;
  commandHelp: string;
  channelDetail: string;
  browserDetail: string;
}

export function buildJoinGuidance(input: JoinGuidanceInput): JoinGuidance {
  const { portuguese, mode, sms, whatsapp, termsRequired, freePlay } = input;
  const command = portuguese ? 'ENTRAR' : 'JOIN';
  const messaging = sms || whatsapp;
  const channel = sms && whatsapp ? 'SMS ou WhatsApp' : sms ? 'SMS' : whatsapp ? 'WhatsApp' : '';
  const englishChannel = sms && whatsapp ? 'SMS or WhatsApp' : sms ? 'SMS' : whatsapp ? 'WhatsApp' : '';
  const readyCommand = portuguese ? freePlay ? 'PRONTO' : 'MOEDA' : freePlay ? 'READY' : 'COIN';
  let intro: string;
  if (mode === 'lead_capture') {
    intro = messaging
      ? portuguese
        ? `Cadastre-se no navegador ou envie ${command} por ${channel}. Cada resposta da mensagem diz exatamente o que responder.`
        : `Register in your browser or send ${command} by ${englishChannel}. Every messaging reply tells you exactly what to answer.`
      : portuguese
        ? 'Cadastre-se no navegador para entrar. Nenhum aplicativo de mensagens é necessário.'
        : 'Register in your browser to join. No messaging app is needed.';
  } else if (termsRequired) {
    intro = portuguese
      ? `Envie ${command} por ${channel}. As respostas orientam você, incluindo SIM para os termos e ${readyCommand} na tela.`
      : `Send ${command} by ${englishChannel}. Replies guide you, including YES for terms and ${readyCommand} at the screen.`;
  } else {
    intro = portuguese
      ? `Envie ${command} por ${channel}. Depois, responda ${readyCommand} quando solicitado na tela.`
      : `Send ${command} by ${englishChannel}. Then reply ${readyCommand} when prompted at the screen.`;
  }
  return {
    command,
    messaging,
    intro,
    commandHelp: portuguese
      ? `Os botões de mensagem abrem ${command} preenchido. Basta tocar em Enviar. Cada resposta seguinte diz exatamente o que responder.`
      : `Messaging buttons open ${command} prefilled. Just tap Send. Every subsequent reply tells you exactly what to answer.`,
    channelDetail: portuguese
      ? `Abre ${command} preenchido; basta tocar em Enviar`
      : `Opens ${command} prefilled; just tap Send`,
    browserDetail: portuguese
      ? 'Cadastre-se e entre na fila sem abrir um aplicativo de mensagens'
      : 'Register and join without opening a messaging app',
  };
}
