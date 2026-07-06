// Home / lobby page logic: render the game lineup, wire the join form, theme toggle.
// URL building + input sanitation live in the pure (tested) home-nav module.
import { buildPlayUrl } from './home-nav';
import { getMusicManager } from './music-manager';
import { injectMusicToggle } from './music-toggle';

interface GameCard { id: string; title: string; blurb: string; status: 'active' | 'soon';
  /** The page an ACTIVE card launches (shared-screen mode). Racer → play.html; battler → monsters.html. */
  page?: string; }

// Adding a future game is a one-line edit here.
const GAMES: GameCard[] = [
  { id: 'racer', title: 'Voice Racer', status: 'active', page: 'play.html',
    blurb: 'Lane-dodging multiplayer race. Shout your moves; dodge barriers, grab boosts.' },
  { id: 'battler', title: 'Voice Monsters', status: 'active', page: 'monsters.html',
    blurb: 'Command your creature out loud in turn-based duels. Call your attacks and out-strategize your rival.' },
  { id: 'fighter', title: '2D Voice Fighter', status: 'soon',
    blurb: 'Call your attacks out loud in a side-view brawler. Coming soon.' },
  { id: 'karaoke', title: 'Voice Karaoke Rhythm', status: 'soon',
    blurb: 'Karaoke meets Guitar Hero — sing into the call and nail the timing of each word for points. Coming soon.' },
];

function renderGames(): void {
  const host = document.getElementById('games')!;
  host.innerHTML = '';
  for (const g of GAMES) {
    const card = document.createElement('div');
    card.className = `game ${g.status === 'active' ? 'active' : 'soon'}`;
    const badge = g.status === 'active' ? 'Playable' : 'Coming soon';
    // textContent for user-facing dynamic strings; structure built safely.
    const tag = document.createElement('span'); tag.className = 'badge'; tag.textContent = badge;
    const h = document.createElement('h3'); h.textContent = g.title;
    const p = document.createElement('p'); p.textContent = g.blurb;
    card.append(tag, h, p);
    // An ACTIVE card launches that game's SHARED SCREEN for the entered room code (the primary way to
    // start a session). Racer → play.html, battler → monsters.html.
    if (g.status === 'active' && g.page) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => launchScreen(g.page!));
    }
    host.appendChild(card);
  }
}

/** Open a game's shared-screen display for the current room code. */
function launchScreen(page: string): void {
  const roomInput = document.getElementById('room') as HTMLInputElement | null;
  const room = (roomInput?.value ?? '').replace(/\D/g, '').slice(0, 4) || '4821';
  location.href = `${page}?display=1&room=${room}`;
}

function go(mode: 'screen' | 'device'): void {
  const name = (document.getElementById('name') as HTMLInputElement).value;
  const roomCode = (document.getElementById('room') as HTMLInputElement).value;
  location.href = buildPlayUrl({ mode, roomCode, name });
}

function wireForm(): void {
  // Enable autoplay on first user interaction
  const enableAutoplay = () => {
    getMusicManager().switchContext('lobby');
    document.removeEventListener('click', enableAutoplay);
    document.removeEventListener('keydown', enableAutoplay);
  };
  document.addEventListener('click', enableAutoplay);
  document.addEventListener('keydown', enableAutoplay);

  document.getElementById('screenBtn')!.addEventListener('click', () => go('screen'));
  document.getElementById('deviceBtn')!.addEventListener('click', () => go('device'));
  // Enter in the room field opens the shared screen (the primary path); Enter in the name field
  // plays on this device (you typed a name → you're a device player).
  document.getElementById('room')!.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') go('screen');
  });
  document.getElementById('name')!.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') go('device');
  });
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
wireForm();
wireTheme();

// Add music toggle button
injectMusicToggle('header-controls');
