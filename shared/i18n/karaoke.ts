import type { LocalizedCatalog } from './translate';

const EN_MESSAGES = {
  'voice.roomUnavailable': 'This Voice Karaoke room is unavailable. Please wait for the next song.',
  'voice.callerPlaceholder': 'Singer',
  'voice.welcome': 'Welcome to Voice Karaoke!',
  'voice.askName': 'First, what is your first name?',
  'voice.invalidName': 'Please say only your first name. For example, Ada.',
  'voice.welcomeName': 'Welcome to Voice Karaoke, {name}.',
  'voice.returned': 'You are back.',
  'voice.returnedName': 'You are back, {name}.',
  'voice.gameplay': 'Choose a song by number or title, say Start, then watch the display and sing each word when it reaches the target.',
  'voice.catalog': 'Available songs: {songs}. Say a song number or title.',
  'voice.noSongs': 'There are no songs available in your language right now.',
  'voice.unknownSong': 'I did not recognize that song. Say a song number or title from the display.',
  'voice.songSelected': '{title} selected.',
  'voice.startRequired': 'Your song is {title}.',
  'voice.startConsent': 'When scoring is enabled, your live voice is sent to a third-party speech recognition service for scoring. Say Start to consent and begin.',
  'voice.chooseFirst': 'Choose a song before saying start.',
  'voice.notReady': 'The room is not ready to start yet.',
  'voice.preparing': 'Preparing your backing track. Keep watching the display.',
  'voice.loadingTimeout': 'The backing track did not become ready. Please check the display audio, then say Start to try again.',
  'voice.result': '{name}, your score is {score}, with a best combo of {combo}.',
  'voice.stationRequeue': 'Your results are on the display. Thanks for singing! To play again, check your messages for game coin instructions.',
  'voice.singAgain': 'Your results are on the display. To sing again, say Choose another song.',
} as const;

export type KaraokeMessageKey = keyof typeof EN_MESSAGES;

const PT_MESSAGES: Record<KaraokeMessageKey, string> = {
  'voice.roomUnavailable': 'Esta sala do Karaokê por Voz não está disponível. Aguarde a próxima música.',
  'voice.callerPlaceholder': 'Cantor',
  'voice.welcome': 'Boas-vindas ao Karaokê por Voz!',
  'voice.askName': 'Primeiro, qual é o seu primeiro nome?',
  'voice.invalidName': 'Diga apenas seu primeiro nome. Por exemplo, Ana.',
  'voice.welcomeName': 'Boas-vindas ao Karaokê por Voz, {name}.',
  'voice.returned': 'Você voltou.',
  'voice.returnedName': 'Você voltou, {name}.',
  'voice.gameplay': 'Escolha uma música pelo número ou título, diga Começar, depois olhe para a tela e cante cada palavra quando ela chegar ao alvo.',
  'voice.catalog': 'Músicas disponíveis: {songs}. Diga o número ou o título de uma música.',
  'voice.noSongs': 'Não há músicas disponíveis no seu idioma agora.',
  'voice.unknownSong': 'Não reconheci essa música. Diga um número ou título exibido na tela.',
  'voice.songSelected': '{title} selecionada.',
  'voice.startRequired': 'Sua música é {title}.',
  'voice.startConsent': 'Quando a pontuação estiver ativada, sua voz ao vivo será enviada a um serviço terceirizado de reconhecimento de fala para pontuação. Diga Começar para consentir e iniciar.',
  'voice.chooseFirst': 'Escolha uma música antes de dizer começar.',
  'voice.notReady': 'A sala ainda não está pronta para começar.',
  'voice.preparing': 'Preparando sua faixa de apoio. Continue olhando para a tela.',
  'voice.loadingTimeout': 'A faixa de apoio não ficou pronta. Verifique o áudio da tela e diga Começar para tentar novamente.',
  'voice.result': '{name}, sua pontuação é {score}, com melhor combo de {combo}.',
  'voice.stationRequeue': 'Seus resultados estão na tela. Agradecemos por cantar! Para jogar novamente, veja nas suas mensagens as instruções de moedas do jogo.',
  'voice.singAgain': 'Seus resultados estão na tela. Para cantar novamente, diga Escolher outra música.',
};

export const KARAOKE_MESSAGES: LocalizedCatalog<KaraokeMessageKey> = {
  'en-US': EN_MESSAGES,
  'pt-BR': PT_MESSAGES,
};
