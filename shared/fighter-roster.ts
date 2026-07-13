export interface FighterRosterEntry { id: string; name: string; title: string; color: string; file: string; embeddedIdle?: boolean; preview: string; }
export interface FighterMapEntry {
  id: string; name: string; blurb: string; color: string;
  preview?: string;
  file?: string;
  pos?: [number, number, number];
  rotDeg?: [number, number, number];
  scale?: number;
  bounds: [number, number];
  floorY?: number;
  fightPlane?: { origin: [number, number, number]; rotationY: number };
  camera?: { pos: [number, number, number]; lookAt: [number, number, number]; fov?: number };
}

export const FIGHTER_ROSTER: FighterRosterEntry[] = [
  { id: 'nyx', name: 'Nyx', title: 'The Nightblade', color: '#ef223a', file: 'nyx.fbx', preview: '/assets/fighters/previews/characters/nyx.png?v=4' },
  { id: 'wraith', name: 'Wraith', title: 'The Voidborn', color: '#2dd4bf', file: 'wraith.fbx', preview: '/assets/fighters/previews/characters/wraith.png?v=4' },
  { id: 'remy-riot', name: 'Remy Riot', title: 'The Street Spark', color: '#ff6b6b', file: 'remy-riot.fbx', embeddedIdle: true, preview: '/assets/fighters/previews/characters/remy-riot.png?v=4' },
  { id: 'cinder-capone', name: 'Cinder Capone', title: 'The Smoke Syndicate', color: '#f0a35e', file: 'cinder-capone.fbx', embeddedIdle: true, preview: '/assets/fighters/previews/characters/cinder-capone.png?v=4' },
  { id: 'rune-warden', name: 'Rune Warden', title: 'The Arcane Elder', color: '#7bed9f', file: 'rune-warden.fbx', embeddedIdle: true, preview: '/assets/fighters/previews/characters/rune-warden.png?v=4' },
  { id: 'shroom-boom', name: 'Shroom Boom', title: 'The Spore Striker', color: '#eccc68', file: 'shroom-boom.fbx', embeddedIdle: true, preview: '/assets/fighters/previews/characters/shroom-boom.png?v=4' },
  { id: 'gran-slam', name: 'Gran Slam', title: 'The Senior Smackdown', color: '#70a1ff', file: 'gran-slam.fbx', embeddedIdle: true, preview: '/assets/fighters/previews/characters/gran-slam.png?v=4' },
  { id: 'bass-nova', name: 'Bass Nova', title: 'The Rhythm Rebel', color: '#ff7fcb', file: 'bass-nova.fbx', embeddedIdle: true, preview: '/assets/fighters/previews/characters/bass-nova.png?v=4' },
  { id: 'velvet-thunder', name: 'Velvet Thunder', title: 'The King of the Ring', color: '#c56cf0', file: 'velvet-thunder.fbx', embeddedIdle: true, preview: '/assets/fighters/previews/characters/velvet-thunder.png?v=4' },
  { id: 'iron-oni', name: 'Iron Oni', title: 'The Crimson Shogun', color: '#ff3838', file: 'iron-oni.fbx', embeddedIdle: true, preview: '/assets/fighters/previews/characters/iron-oni.png?v=4' },
  { id: 'bulkhead', name: 'Bulkhead', title: 'The Masked Mountain', color: '#a4b0be', file: 'bulkhead.fbx', embeddedIdle: true, preview: '/assets/fighters/previews/characters/bulkhead.png?v=4' },
  { id: 'sir-knockout', name: 'Sir Knockout', title: 'The Last Knight Standing', color: '#ffa502', file: 'sir-knockout.fbx', embeddedIdle: true, preview: '/assets/fighters/previews/characters/sir-knockout.png?v=4' },
];

export const FIGHTER_MAPS: FighterMapEntry[] = [
  { id: 'foundry', name: 'Neon Foundry', blurb: 'A red-hot industrial fight pit.', color: '#ef223a', bounds: [-9, 9] },
  { id: 'void', name: 'Void Circuit', blurb: 'A cold arena at the edge of space.', color: '#2dd4bf', bounds: [-11, 11] },
];
