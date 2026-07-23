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
  channelDetail: string;
  browserDetail: string;
}

export function buildJoinGuidance(input: JoinGuidanceInput): JoinGuidance {
  const { portuguese, mode, sms, whatsapp } = input;
  const command = portuguese ? 'ENTRAR' : 'JOIN';
  const messaging = sms || whatsapp;
  const channel = sms && whatsapp ? 'SMS ou WhatsApp' : sms ? 'SMS' : whatsapp ? 'WhatsApp' : '';
  const englishChannel = sms && whatsapp ? 'SMS or WhatsApp' : sms ? 'SMS' : whatsapp ? 'WhatsApp' : '';
  let intro: string;
  if (mode === 'lead_capture') {
    intro = messaging
      ? portuguese
        ? `Cadastre-se no navegador ou envie ${command} por ${channel}.`
        : `Register in your browser or send ${command} by ${englishChannel}.`
      : portuguese
        ? 'Cadastre-se no navegador para entrar.'
        : 'Register in your browser to join.';
  } else {
    intro = portuguese
      ? `Envie ${command} por ${channel}.`
      : `Send ${command} by ${englishChannel}.`;
  }
  return {
    command,
    messaging,
    intro,
    channelDetail: portuguese
      ? `Abre ${command} preenchido; basta tocar em Enviar`
      : `Opens ${command} prefilled; just tap Send`,
    browserDetail: portuguese
      ? 'Cadastre-se e entre na fila sem abrir um aplicativo de mensagens'
      : 'Register and join without opening a messaging app',
  };
}
