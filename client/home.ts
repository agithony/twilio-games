// Home / lobby page logic: render the game lineup, wire the join form, theme toggle.
// URL building + input sanitation live in the pure (tested) home-nav module.
import { buildPlayUrl } from './home-nav';

interface GameCard { id: string; title: string; blurb: string; status: 'active' | 'soon'; }

// Adding a future game is a one-line edit here.
const GAMES: GameCard[] = [
  { id: 'racer', title: 'Voice Racer', status: 'active',
    blurb: 'Lane-dodging multiplayer race. Shout your moves; dodge barriers, grab boosts.' },
  { id: 'fighter', title: '2D Voice Fighter', status: 'soon',
    blurb: 'Call your attacks out loud in a side-view brawler. Coming soon.' },
  { id: 'battler', title: 'Monster Battler', status: 'soon',
    blurb: 'Turn-based, Pokémon-style battles driven entirely by voice. Coming soon.' },
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
    host.appendChild(card);
  }
}

function go(mode: 'screen' | 'device'): void {
  const name = (document.getElementById('name') as HTMLInputElement).value;
  const roomCode = (document.getElementById('room') as HTMLInputElement).value;
  location.href = buildPlayUrl({ mode, roomCode, name });
}

function wireForm(): void {
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
