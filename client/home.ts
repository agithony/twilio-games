// Home / lobby page logic: render the game lineup, theme toggle, music.
import { getMusicManager } from './music-manager';
import { injectMusicToggle } from './music-toggle';
import { getSoundEffectsManager } from './sound-effects';
import { injectMagicHat } from './magic-hat';

interface GameCard { id: string; title: string; blurb: string; status: 'active' | 'soon';
  /** The page an ACTIVE card launches (shared-screen mode). Racer → play.html; battler → monsters.html. */
  page?: string; }

// Adding a future game is a one-line edit here.
const GAMES: GameCard[] = [
  { id: 'racer', title: 'Voice Racer', status: 'active', page: 'play.html',
    blurb: 'Lane-dodging multiplayer race. Shout your moves; dodge barriers, grab boosts.' },
  { id: 'battler', title: 'Voice Monsters', status: 'active', page: 'monsters.html',
    blurb: 'Command your creature out loud in turn-based duels. Call your attacks and out-strategize your rival.' },
  { id: 'fighter', title: 'Voice Fighter', status: 'active', page: 'fighter.html',
    blurb: 'Call your attacks out loud in a cinematic side-view brawler.' },
  { id: 'karaoke', title: 'Voice Karaoke', status: 'soon',
    blurb: 'Karaoke meets Guitar Hero — sing into the call and nail the timing of each word for points. Coming soon.' },
];

let selectedGame: GameCard | null = null;

function renderGames(): void {
  const host = document.getElementById('games')!;
  host.innerHTML = '';
  for (const g of GAMES) {
    const card = document.createElement('div');
    card.className = `game ${g.status === 'active' ? 'active' : 'soon'}`;
    card.dataset.gameId = g.id;
    const badge = g.status === 'active' ? 'Playable' : 'Coming soon';
    const tag = document.createElement('span'); tag.className = 'badge'; tag.textContent = badge;
    const h = document.createElement('h3'); h.textContent = g.title;
    const p = document.createElement('p'); p.textContent = g.blurb;
    card.append(tag, h, p);
    if (g.status === 'active' && g.page) {
      card.style.cursor = 'pointer';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Select ${g.title}`);
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
  btn.textContent = `Play ${game.title}`;

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
  location.href = `${selectedGame.page}?display=1&room=4821`;
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
    btn.textContent = t === 'dark' ? 'Light theme' : 'Dark theme';
  };
  apply(document.documentElement.getAttribute('data-theme') || 'dark');
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    apply(cur === 'dark' ? 'light' : 'dark');
  });
}

renderGames();
wirePlayBtn();
wireAutoplay();
wireTheme();

// Add music toggle button
injectMusicToggle('header-controls');
injectMagicHat();
