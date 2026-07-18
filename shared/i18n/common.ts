import type { LocalizedCatalog } from './translate';

export type CommonMessageKey =
  | 'language.label'
  | 'navigation.home'
  | 'navigation.homeAria'
  | 'music.on'
  | 'music.off'
  | 'music.toggleTitle'
  | 'music.toggleAria'
  | 'connection.connecting'
  | 'connection.connected'
  | 'connection.reconnecting'
  | 'connection.closed'
  | 'attribution.builtBy'
  | 'attribution.visit'
  | 'attribution.slack';

export const COMMON_MESSAGES: LocalizedCatalog<CommonMessageKey> = {
  'en-US': {
    'language.label': 'Language',
    'navigation.home': 'Home',
    'navigation.homeAria': 'Return to Twilio Games home',
    'music.on': 'Music On',
    'music.off': 'Music Off',
    'music.toggleTitle': 'Toggle music on/off',
    'music.toggleAria': 'Toggle music',
    'connection.connecting': 'Connecting',
    'connection.connected': 'Connected',
    'connection.reconnecting': 'Reconnecting',
    'connection.closed': 'Disconnected',
    'attribution.builtBy': 'Built by the Twilio Magician',
    'attribution.visit': 'Visit twil.io/magic',
    'attribution.slack': 'Slack: Anthony Dellavecchia',
  },
  'pt-BR': {
    'language.label': 'Idioma',
    'navigation.home': 'Início',
    'navigation.homeAria': 'Voltar ao início dos Jogos da Twilio',
    'music.on': 'Música ligada',
    'music.off': 'Música desligada',
    'music.toggleTitle': 'Ligar ou desligar a música',
    'music.toggleAria': 'Ligar ou desligar a música',
    'connection.connecting': 'Conectando',
    'connection.connected': 'Conectado',
    'connection.reconnecting': 'Reconectando',
    'connection.closed': 'Desconectado',
    'attribution.builtBy': 'Criado pelo Mago da Twilio',
    'attribution.visit': 'Acesse twil.io/magic',
    'attribution.slack': 'Slack: Anthony Dellavecchia',
  },
};
