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
  const { portuguese, mode, whatsapp } = input;
  const sms = !portuguese && input.sms;
  const command = portuguese ? 'ENTRAR' : 'JOIN';
  const messaging = sms || whatsapp;
  const englishChannel = sms && whatsapp ? 'SMS or WhatsApp' : sms ? 'SMS' : whatsapp ? 'WhatsApp' : '';
  let intro: string;
  if (portuguese) {
    intro = mode === 'lead_capture'
      ? whatsapp
        ? `Envie ${command} por WhatsApp (recomendado) ou continue no navegador.`
        : 'Continue no navegador para entrar.'
      : whatsapp
        ? `Envie ${command} por WhatsApp.`
        : 'A entrada por mensagem em português está disponível somente pelo WhatsApp.';
  } else if (mode === 'lead_capture') {
    intro = messaging
      ? `Send ${command} by ${englishChannel} (recommended), or continue in your browser.`
      : 'Register in your browser to join.';
  } else {
    intro = `Send ${command} by ${englishChannel}.`;
  }
  return {
    command,
    messaging,
    intro,
    channelDetail: portuguese
      ? `Recomendado · abre ${command} preenchido; basta tocar em Enviar`
      : `Recommended · opens ${command} prefilled; just tap Send`,
    browserDetail: portuguese
      ? 'Alternativa · cadastre-se e entre sem abrir um aplicativo de mensagens'
      : 'Fallback · register and join without opening a messaging app',
  };
}
