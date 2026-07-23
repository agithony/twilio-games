import { fetchPublicArcadeConfig } from '../station-client';
import { locale } from '../i18n';
import { updateThemeToggleIcon } from '../icon-controls';
import { buildJoinGuidance } from './guidance';

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

function channelLink(label: string, detail: string, href: string,kind:'sms'|'whatsapp'|'browser'): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = `channel channel--${kind}`;
  link.href = href;
  link.innerHTML = `<div><strong>${label}</strong><span>${detail}</span></div><b aria-hidden="true">-></b>`;
  return link;
}

function availableNumber(value: string | undefined): string {
  const number = value?.trim().replace(/^whatsapp:/i, '') ?? '';
  return /^\+[1-9][0-9]{7,14}$/.test(number) ? number : '';
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
    const mode = arcade.arcade.mode;
    if (mode === 'off') {
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
    const smsNumber = availableNumber(bootstrap.smsNumber);
    const whatsappNumber = availableNumber(bootstrap.whatsappNumber);
    const sms = arcade.channels.sms && Boolean(smsNumber);
    const whatsapp = arcade.channels.whatsapp && Boolean(whatsappNumber);
    if (mode === 'coin_only' && !sms && !whatsapp) {
      throw new Error(portuguese
        ? 'Nenhuma forma de entrada está disponível. Peça ajuda à equipe.'
        : 'No way to join is available. Ask the booth operator for help.');
    }
    const guidance = buildJoinGuidance({
      portuguese, mode, sms, whatsapp,
      termsRequired: arcade.registration.termsAcknowledgementRequired,
      freePlay,
    });
    const command = guidance.command;
    document.getElementById('intro')!.textContent = guidance.intro;
    stationBadge.textContent = portuguese ? 'Twilio Games · Português' : 'Twilio Games · English';
    const browserRegistrationUrl = `/player?cabinet=${encodeURIComponent(station)}&locale=${encodeURIComponent(locale)}`;
    const available: HTMLElement[] = [];
    if (sms) {
      available.push(channelLink(
        portuguese ? 'Entrar com SMS' : 'Join with SMS',
        guidance.channelDetail,
        `sms:${smsNumber}?body=${encodeURIComponent(command)}`,'sms',
      ));
    }
    if (whatsapp) {
      const digits = whatsappNumber.replace(/\D/g, '');
      available.push(channelLink(
        portuguese ? 'Entrar com WhatsApp' : 'Join with WhatsApp',
        guidance.channelDetail,
        `https://wa.me/${digits}?text=${encodeURIComponent(command)}`,'whatsapp',
      ));
    }
    if (mode === 'lead_capture') {
      available.push(channelLink(
        portuguese ? 'Continuar no navegador' : 'Continue in browser',
        guidance.browserDetail,
        browserRegistrationUrl,'browser',
      ));
    }
    if (!available.length) {
      throw new Error(portuguese
        ? 'Nenhuma forma de entrada está disponível. Peça ajuda à equipe.'
        : 'No way to join is available. Ask the booth operator for help.');
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
