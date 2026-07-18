// Home / lobby page logic: render the game lineup, theme toggle, music.
import { getMusicManager } from './music-manager';
import { injectMusicToggle } from './music-toggle';
import { getSoundEffectsManager } from './sound-effects';
import { injectMagicHat } from './magic-hat';
import { injectLanguagePicker, locale } from './i18n';
import { HOME_MESSAGES, type HomeMessageKey } from '../shared/i18n/home';
import { createTranslator } from '../shared/i18n/translate';
import { gameTitle, type GameId } from '../shared/i18n/content';

const text = createTranslator(locale, HOME_MESSAGES);

interface GameCard { id: GameId; blurbKey: HomeMessageKey; status: 'active' | 'soon';
  /** The page an ACTIVE card launches (shared-screen mode). Racer → play.html; battler → monsters.html. */
  page?: string; }

// Adding a future game is a one-line edit here.
const GAMES: GameCard[] = [
  { id: 'racer', status: 'active', page: 'play.html',
    blurbKey: 'games.racer.blurb' },
  { id: 'monsters', status: 'active', page: 'monsters.html',
    blurbKey: 'games.monsters.blurb' },
  { id: 'fighter', status: 'active', page: 'fighter.html',
    blurbKey: 'games.fighter.blurb' },
  { id: 'trivia', status: 'soon',
    blurbKey: 'games.trivia.blurb' },
  { id: 'karaoke', status: 'soon',
    blurbKey: 'games.karaoke.blurb' },
];

let selectedGame: GameCard | null = null;

function renderGames(): void {
  const host = document.getElementById('games')!;
  host.innerHTML = '';
  for (const g of GAMES) {
    const title = gameTitle(locale, g.id);
    const card = document.createElement('div');
    card.className = `game ${g.status === 'active' ? 'active' : 'soon'}`;
    card.dataset.gameId = g.id;
    const badge = g.status === 'active' ? text('games.playable') : text('games.soon');
    const tag = document.createElement('span'); tag.className = 'badge'; tag.textContent = badge;
    const h = document.createElement('h3'); h.textContent = title;
    const p = document.createElement('p'); p.textContent = text(g.blurbKey);
    card.append(tag, h, p);
    if (g.status === 'active' && g.page) {
      card.style.cursor = 'pointer';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', text('games.select', { game: title }));
      card.addEventListener('click', () => selectGame(g));
      card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectGame(g); }
      });
    }
    host.appendChild(card);
  }
}

function selectGame(game: GameCard): void {
  selectedGame = game;
  getSoundEffectsManager().playSelect();

  // Update card highlight
  document.querySelectorAll('.game.selected').forEach(el => el.classList.remove('selected'));
  const card = document.querySelector(`.game[data-game-id="${game.id}"]`);
  card?.classList.add('selected');

  // Update Play button
  const btn = document.getElementById('playBtn') as HTMLButtonElement;
  btn.disabled = false;
  btn.textContent = text('games.play', { game: gameTitle(locale, game.id) });

  // Swap background video
  const videos = document.querySelectorAll<HTMLVideoElement>('#videoBg video');
  videos.forEach(v => {
    if (v.dataset.game === game.id) {
      v.classList.add('active');
      v.play().catch(() => {});
    } else {
      v.classList.remove('active');
      v.pause();
    }
  });
}

function launchSelected(): void {
  if (!selectedGame?.page) return;
  location.href = `${selectedGame.page}?display=1&room=4821&locale=${encodeURIComponent(locale)}`;
}

function wirePlayBtn(): void {
  document.getElementById('playBtn')!.addEventListener('click', launchSelected);
}

function wireAutoplay(): void {
  const enableAutoplay = () => {
    getMusicManager().switchContext('lobby');
    document.removeEventListener('click', enableAutoplay);
    document.removeEventListener('keydown', enableAutoplay);
  };
  document.addEventListener('click', enableAutoplay);
  document.addEventListener('keydown', enableAutoplay);
}

function wireTheme(): void {
  const btn = document.getElementById('themeToggle')!;
  const apply = (t: string) => {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('twilio-theme', t);
    btn.textContent = t === 'dark' ? text('theme.light') : text('theme.dark');
  };
  apply(document.documentElement.getAttribute('data-theme') || 'dark');
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    apply(cur === 'dark' ? 'light' : 'dark');
  });
}

function localizeStaticPage(): void {
  document.title = text('page.title');
  document.getElementById('brandName')!.textContent = text('page.title');
  document.getElementById('heroEyebrow')!.textContent = text('hero.eyebrow');
  document.getElementById('heroTitle')!.innerHTML = text('hero.title');
  document.getElementById('heroDescription')!.innerHTML = text('hero.description');
  document.getElementById('gamesHeading')!.textContent = text('games.heading');
  document.getElementById('playBtn')!.textContent = text('games.selectPrompt');
  const theme = document.getElementById('themeToggle')!;
  theme.title = text('theme.toggle');
  theme.setAttribute('aria-label', text('theme.toggle'));
  document.getElementById('homeFooter')!.textContent = text('footer');
}

localizeStaticPage();
renderGames();
wirePlayBtn();
wireAutoplay();
wireTheme();

// Add music toggle button
injectMusicToggle('header-controls');
injectLanguagePicker('header-controls');
injectMagicHat();
