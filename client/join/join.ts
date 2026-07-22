import { fetchPublicArcadeConfig } from '../station-client';
import { locale } from '../i18n';
import { updateThemeToggleIcon } from '../icon-controls';

interface BootstrapConfig {
  smsNumber?: string;
  whatsappNumber?: string;
}

const params = new URLSearchParams(location.search);
const requestedStation = params.get('station');
const actions = document.getElementById('channelActions')!;
const error = document.getElementById('error')!;
const stationBadge = document.getElementById('stationBadge')!;
const portuguese = locale === 'pt-BR';

function localizePage(): void {
  document.documentElement.lang = locale;
  if (!portuguese) return;
  document.title = 'Entrar no Twilio Games';
  document.getElementById('join-page-eyebrow')!.textContent = 'Configuração do telefone';
  document.getElementById('join-page-title')!.textContent = 'Escolha como entrar.';
  document.getElementById('intro')!.textContent = 'Escolha como entrar. As opções disponíveis aparecerão abaixo.';
  document.getElementById('join-privacy')!.textContent = 'Suas informações são usadas apenas para criar e operar seu perfil de jogo. Nunca envie dados de pagamento ou senhas.';
  document.getElementById('terms-title')!.textContent = 'Termos de participação';
  document.getElementById('terms-copy')!.textContent = 'Ao continuar, você concorda em participar desta experiência e permite que o Twilio Games use as informações fornecidas para operar sua sessão. O acompanhamento de marketing exige consentimento separado.';
}

function channelLink(label: string, detail: string, href: string, primary = false): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = `channel${primary ? ' primary' : ''}`;
  link.href = href;
  link.innerHTML = `<div><strong>${label}</strong><span>${detail}</span></div><b aria-hidden="true">-></b>`;
  return link;
}

async function initialize(): Promise<void> {
  localizePage();
  wireTheme();
  try {
    const [arcade, bootstrapResponse] = await Promise.all([
      fetchPublicArcadeConfig(),
      fetch('/api/config', { cache: 'no-store' }),
    ]);
    const bootstrap = await bootstrapResponse.json() as BootstrapConfig;
    const station = requestedStation ?? arcade.arcade.cabinetId;
    if (arcade.arcade.mode === 'off') {
      throw new Error(portuguese
        ? 'O Twilio Games não está aceitando jogadores agora. Pergunte à equipe quando a próxima sessão começa.'
        : 'Twilio Games is not accepting players right now. Ask booth staff when the next session starts.');
    }
    if (requestedStation !== null && requestedStation !== arcade.arcade.cabinetId) {
      throw new Error(portuguese
        ? 'Este link não está mais ativo. Escaneie novamente o QR na tela.'
        : 'This station link is no longer active. Scan the QR on the game screen again.');
    }
    const freePlay = arcade.coins.chargePolicy === 'free';
    document.getElementById('intro')!.textContent = arcade.arcade.mode === 'coin_only'
      ? arcade.registration.termsAcknowledgementRequired
        ? portuguese
          ? `Escolha SMS ou WhatsApp e envie o comando preenchido. Você deve responder SIM para aceitar os termos antes de responder ${freePlay ? 'PRONTO' : 'MOEDA'} na tela.`
          : `Choose SMS or WhatsApp and send the prefilled command. You must reply YES to acknowledge the terms before replying ${freePlay ? 'READY' : 'COIN'} at the screen.`
        : portuguese
          ? `Escolha SMS ou WhatsApp, envie o comando preenchido e responda ${freePlay ? 'PRONTO' : 'MOEDA'} quando estiver na tela.`
          : `Choose SMS or WhatsApp, send the prefilled command, then reply ${freePlay ? 'READY' : 'COIN'} at the screen.`
      : freePlay
        ? portuguese
          ? 'Escolha uma mensagem ou o navegador. Por mensagem, responda PRONTO quando estiver na tela; no navegador, entre diretamente na fila.'
          : 'Choose messaging or browser registration. By message, reply READY at the screen; in the browser, join the ready pool directly.'
        : portuguese
          ? 'Escolha SMS, WhatsApp ou cadastro pelo navegador para criar seu perfil de jogo.'
          : 'Choose SMS, WhatsApp, or browser registration to create your game profile.';
    const command = `JOIN ${station} LANG ${locale}`;
    stationBadge.textContent = portuguese ? 'Twilio Games · Português' : 'Twilio Games · English';
    const browserRegistrationUrl = `/player?cabinet=${encodeURIComponent(station)}&locale=${encodeURIComponent(locale)}`;
    const available: HTMLElement[] = [];
    if (arcade.channels.sms && bootstrap.smsNumber) {
      available.push(channelLink(
        portuguese ? 'Entrar com SMS' : 'Join with SMS',
        portuguese ? 'Abre suas mensagens com o comando pronto' : 'Opens your text messages with the command ready',
        `sms:${bootstrap.smsNumber}?body=${encodeURIComponent(command)}`, available.length === 0,
      ));
    }
    if (arcade.channels.whatsapp && bootstrap.whatsappNumber) {
      const digits = bootstrap.whatsappNumber.replace(/\D/g, '');
      available.push(channelLink(
        portuguese ? 'Entrar com WhatsApp' : 'Join with WhatsApp',
        portuguese ? 'Abre uma conversa com o assistente do jogo' : 'Opens a chat with the game assistant',
        `https://wa.me/${digits}?text=${encodeURIComponent(command)}`,
        available.length === 0,
      ));
    }
    if (arcade.arcade.mode === 'lead_capture') {
      available.push(channelLink(
        portuguese ? 'Continuar no navegador' : 'Continue in browser',
        portuguese ? 'Cadastre-se e entre na fila sem abrir um aplicativo de mensagens' : 'Register and join without opening a messaging app',
        browserRegistrationUrl,
        available.length === 0,
      ));
    }
    if (!available.length) {
      throw new Error(portuguese
        ? 'Nenhum canal de mensagens está configurado. Peça à equipe para ativar o SMS ou WhatsApp.'
        : 'No messaging channel is configured. Ask the booth operator to enable SMS or WhatsApp before joining.');
    }
    actions.replaceChildren(...available);
  } catch (cause) {
    error.hidden = false;
    error.textContent = cause instanceof Error ? cause.message : 'Unable to load Twilio Games.';
    stationBadge.textContent = portuguese ? 'Entrada indisponível' : 'Joining unavailable';
  }
}

function wireTheme(): void {
  const button = document.getElementById('themeToggle')!;
  const render = () => {
    const theme=document.documentElement.dataset.theme??'dark';
    updateThemeToggleIcon(button,theme,portuguese?'Tema claro':'Light theme',portuguese?'Tema escuro':'Dark theme');
  };
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; localStorage.setItem('twilio-theme', next); render();
  });
  render();
}

void initialize();
