// client/level.ts
import { LevelScene } from './level-scene';
import { fetchMaps } from './map-world';
import { mergeLevel, levelDefaults, type LevelConfig } from '../shared/level';

const scene = new LevelScene(document.getElementById('app')!);
const sel = document.getElementById('levelSelect') as HTMLSelectElement;
const status = document.getElementById('status')!;
let levels: Record<string, LevelConfig> = {};

async function refresh(selectKey?: string): Promise<void> {
  const raw = await fetchMaps();
  levels = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, mergeLevel(v)]));
  sel.replaceChildren();
  for (const key of Object.keys(levels)) {
    const o = document.createElement('option'); o.value = key; o.textContent = key; sel.appendChild(o);
  }
  const key = selectKey ?? Object.keys(levels)[0];
  if (key) { sel.value = key; await scene.loadLevel(structuredClone(levels[key]!)); }
}

sel.addEventListener('change', () => { void scene.loadLevel(structuredClone(levels[sel.value]!)); });

document.getElementById('newLevel')!.addEventListener('click', async () => {
  const map = prompt('New level key (e.g. canyon):')?.trim();
  if (!map) return;
  const file = prompt('World GLB filename in assets/maps (e.g. canyon.glb):', `${map}.glb`)?.trim();
  if (!file) return;
  if (levels[map] && !confirm(`Overwrite existing level "${map}"?`)) return;
  levels[map] = levelDefaults(map, file);
  await scene.loadLevel(structuredClone(levels[map]!));
  const o = document.createElement('option'); o.value = map; o.textContent = map; sel.appendChild(o); sel.value = map;
});

document.getElementById('saveLevel')!.addEventListener('click', async () => {
  const cfg = scene.current();
  try {
    const res = await fetch('/api/maps', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    status.textContent = res.ok ? `Saved "${cfg.map}" ✓` : 'Save failed';
  } catch { status.textContent = 'Server unreachable'; }
  setTimeout(() => (status.textContent = ''), 2500);
});

void refresh();
