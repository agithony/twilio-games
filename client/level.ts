// client/level.ts
import { LevelScene } from './level-scene';
import { fetchMaps } from './map-world';
import { fetchAssets } from './editor/manifest-client';
import { numberRow, colorRow, heading } from './level-panels';
import { mergeLevel, levelDefaults, DEFAULT_LIGHTING, DEFAULT_EFFECTS,
         type LevelConfig } from '../shared/level';

const LANES_PREVIEW = 3;

const scene = new LevelScene(document.getElementById('app')!);
// Dev-only (localhost): expose the scene for in-browser debugging / headless smoke introspection.
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  (window as unknown as { __levelScene?: unknown }).__levelScene = scene;
}
const sel = document.getElementById('levelSelect') as HTMLSelectElement;
const status = document.getElementById('status')!;
let levels: Record<string, LevelConfig> = {};

const tree = document.getElementById('tree')!;
let assetFiles: string[] = [];
void fetchAssets().then(f => { assetFiles = f; });

// ── Collapse / expand the side panels + all overlays ─────────────────────────────────────────
const topbar = document.getElementById('topbar')!;
const treeTab = document.getElementById('treeTab')!;
const panelTab = document.getElementById('panelTab')!;
// Each edge tab collapses/expands its own panel; the tab arrow flips to hint direction.
treeTab.addEventListener('click', () => {
  const c = tree.classList.toggle('collapsed'); treeTab.textContent = c ? '⟩' : '⟨';
});
panelTab.addEventListener('click', () => {
  const c = panel.classList.toggle('collapsed'); panelTab.textContent = c ? '⟨' : '⟩';
});
// "Hide UI" (or press H) hides EVERYTHING — both panels, the top bar, and the edge tabs — for an
// unobstructed view. Press H again (or the floating Show-UI button) to bring it all back.
let uiHidden = false;
const showUiBtn = document.createElement('button');
showUiBtn.className = 'edge-tab'; showUiBtn.textContent = 'Show UI';
showUiBtn.style.cssText += ';top:8px;left:50%;transform:translateX(-50%);display:none';
document.body.appendChild(showUiBtn);
function setUiHidden(hidden: boolean): void {
  uiHidden = hidden;
  for (const el of [topbar, tree, panel, treeTab, panelTab]) (el as HTMLElement).style.display = hidden ? 'none' : '';
  showUiBtn.style.display = hidden ? 'block' : 'none';
}
document.getElementById('hideUi')!.addEventListener('click', () => setUiHidden(true));
showUiBtn.addEventListener('click', () => setUiHidden(false));
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;   // don't hijack typing
  // 'H' toggles all UI.
  if (e.key === 'h' || e.key === 'H') { setUiHidden(!uiHidden); return; }
  // W/E/R switch the gizmo mode (standard DCC-tool muscle memory) when an object is selected.
  if (e.key === 'w' || e.key === 'W') { scene.setGizmoMode('translate'); renderPanel(); }
  else if (e.key === 'e' || e.key === 'E') { scene.setGizmoMode('rotate'); renderPanel(); }
  else if (e.key === 'r' || e.key === 'R') { scene.setGizmoMode('scale'); renderPanel(); }
});

function renderTree(): void {
  tree.replaceChildren();
  const mk = (label: string, key: string) => {
    const d = document.createElement('div');
    d.className = 'row' + (scene.selectedKey() === key ? ' sel' : '');
    // Clicking a tree row selects AND flies the camera to that object (frame-on-select). Viewport
    // selection uses plain select() and leaves the camera where it is — per the "only from the
    // left panel" requirement.
    d.textContent = label; d.onclick = () => { scene.selectAndFrame(key); renderTree(); };
    return d;
  };
  tree.append(mk('Level (cars · lighting · effects)', 'level'), mk('Map', 'map'), mk('Track', 'track'));
  // Start/finish gantries — always present (auto-placed at the track ends, but movable/saveable).
  tree.append(mk('Start line', 'startLine'), mk('Finish line', 'finishLine'));
  const cfg = scene.current();
  const h = document.createElement('h4'); h.textContent = `Props (${cfg.props.length})`; tree.append(h);
  for (const p of cfg.props) tree.append(mk(`${p.file.replace('.glb','')} (${p.id})`, p.id));

  const add = document.createElement('button'); add.className = 'btn'; add.textContent = 'Add model';
  add.onclick = () => {
    const file = prompt(`Add which GLB?\nAvailable:\n${assetFiles.join('\n')}`, assetFiles[0] ?? '');
    if (file) { scene.beginEdit(); scene.addProp(file); afterEdit(); }
  };
  // Duplicate/Delete only apply to user props — disable them for Level/Map/Track/gantry selections
  // (so they don't silently no-op).
  const propSelected = !['level', 'map', 'track', 'startLine', 'finishLine'].includes(scene.selectedKey());
  const dup = document.createElement('button'); dup.className = 'btn'; dup.textContent = 'Duplicate';
  dup.disabled = !propSelected; if (!propSelected) dup.style.opacity = '0.4';
  dup.onclick = () => { scene.beginEdit(); if (scene.duplicateSelectedProp()) afterEdit(); };
  const del = document.createElement('button'); del.className = 'btn'; del.textContent = 'Delete';
  del.disabled = !propSelected; if (!propSelected) del.style.opacity = '0.4';
  del.onclick = () => { scene.beginEdit(); scene.removeSelectedProp(); afterEdit(); };
  tree.append(document.createElement('br'), add, dup, del);
}

const panel = document.getElementById('panel')!;

// Slider/color edits fire continuously; snapshot for undo ONCE at the start of an interaction
// (the first pointerdown/keydown on a control) rather than per tick. Re-armed on pointerup/blur so
// the next distinct interaction snapshots again. This keeps each drag = one undo step.
let editArmed = true;
const armUndo = () => { if (editArmed) { scene.beginEdit(); editArmed = false; } };
panel.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).tagName === 'INPUT') armUndo(); });
panel.addEventListener('keydown', (e) => { if ((e.target as HTMLElement).tagName === 'INPUT') armUndo(); });
addEventListener('pointerup', () => { editArmed = true; });
panel.addEventListener('change', () => { editArmed = true; });   // color picker / committed value

/** Append a labelled button that runs `onClick` to `host`. */
function button(host: HTMLElement, label: string, onClick: () => void): void {
  const b = document.createElement('button'); b.className = 'btn'; b.textContent = label;
  b.onclick = onClick; host.append(b);
}

/** Undo / Redo / Reset bar at the top of every panel. Reset reverts to the level as last loaded. */
function renderHistoryBar(host: HTMLElement): void {
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
  const undo = document.createElement('button'); undo.className = 'btn'; undo.textContent = 'Undo';
  undo.disabled = !scene.canUndo(); undo.onclick = () => { scene.undo(); afterEdit(); };
  const redo = document.createElement('button'); redo.className = 'btn'; redo.textContent = 'Redo';
  redo.disabled = !scene.canRedo(); redo.onclick = () => { scene.redo(); afterEdit(); };
  const reset = document.createElement('button'); reset.className = 'btn'; reset.textContent = 'Reset all';
  reset.onclick = () => { if (confirm('Reset this level to its last-loaded state? Unsaved tweaks are lost.')) { scene.resetToLoaded(); afterEdit(); } };
  for (const b of [undo, redo]) if ((b as HTMLButtonElement).disabled) b.style.opacity = '0.4';
  bar.append(undo, redo, reset); host.append(bar);
}

/** Re-render tree + panel after an undo/redo/reset (the scene state changed wholesale). */
function afterEdit(): void { renderTree(); renderPanel(); }

function renderPanel(): void {
  panel.replaceChildren();
  const key = scene.selectedKey();
  // Undo/redo + reset are at the top of every panel (they apply to the whole edit history).
  renderHistoryBar(panel);
  // Context-aware: show ONLY the controls relevant to what's selected.
  //  - 'level' → level-wide Cars / Lighting / Effects
  //  - 'track' → the curve/width controls
  //  - 'map' / a prop → that object's transform (edited via the gizmo) + a hint
  if (key === 'level') { renderCarsSection(panel); renderObstaclesSection(panel); renderLightingSection(panel); renderEffectsSection(panel); }
  else if (key === 'track') renderTrackSection(panel);
  else renderObjectSection(panel, key);
}

/** Track inspector: in-panel curve/width buttons driving the live CurveEditor (gizmo moves/rotates
 *  the whole track; these bend the curve + tune lane/shoulder width). */
function renderTrackSection(host: HTMLElement): void {
  heading(host, 'Track');
  const note = document.createElement('p');
  note.style.cssText = 'font-size:12px;opacity:.7;margin:4px 0';
  note.innerHTML = scene.isAddArmed()
    ? '<b>Click empty ground</b> in the viewport to drop a new control point.'
    : '<b>Drag the green/red dots</b> in the viewport to bend the track (red = start/finish). Buttons below add/remove points, lock an axis, and tune corners & width.';
  host.append(note);

  // Each curve tweak snapshots first (beginEdit) so it's individually undoable.
  const curveEdit = (fn: (c: NonNullable<ReturnType<typeof scene.getCurve>>) => void) => () => {
    const c = scene.getCurve(); if (!c) return; scene.beginEdit(); fn(c); afterEdit();
  };

  // Point editing (drag in the viewport + these helpers).
  heading(host, 'Points');
  button(host, scene.isAddArmed() ? 'Click in viewport to place…' : 'Add point',
    () => { scene.armAddPoint(!scene.isAddArmed()); afterEdit(); });
  button(host, 'Delete selected', () => {
    if (!scene.deleteSelectedPoint()) { status.textContent = 'Click a non-endpoint dot first, then Delete'; setTimeout(() => (status.textContent = ''), 2500); }
    afterEdit();
  });
  // Drag axis lock: constrain a viewport handle-drag to one ground axis.
  const lock = scene.axisLockMode();
  button(host, (lock === 'none' ? '● ' : '') + 'Free move', () => { scene.setAxisLock('none'); afterEdit(); });
  button(host, (lock === 'x' ? '● ' : '') + 'Lock Z (move X)', () => { scene.setAxisLock('x'); afterEdit(); });
  button(host, (lock === 'z' ? '● ' : '') + 'Lock X (move Z)', () => { scene.setAxisLock('z'); afterEdit(); });

  // Per-point HEIGHT (Y) — raise/lower the SELECTED point so the track follows the map's hills.
  // (Y isn't drag-edited; ground-drag handles X/Z, these buttons handle the point's elevation.)
  heading(host, 'Selected point height (Y)');
  const curve = scene.getCurve();
  const hasSel = !!curve && curve.selectedIndex >= 0;
  const hInfo = document.createElement('div');
  hInfo.style.cssText = 'font-size:12px;opacity:.7;margin:2px 0 4px';
  hInfo.textContent = hasSel
    ? `selected point Y: ${Math.round(curve!.selectedHeight())}u`
    : 'Click a dot in the viewport to select it, then raise/lower it.';
  host.append(hInfo);
  const raise = (dy: number) => () => {
    scene.beginEdit();
    if (!scene.getCurve()?.raiseSelected(dy)) { status.textContent = 'Select a point first'; setTimeout(() => (status.textContent = ''), 2000); }
    afterEdit();
  };
  button(host, '▲ Up (big)', raise(20));
  button(host, '△ Up (fine)', raise(2));
  button(host, '▽ Down (fine)', raise(-2));
  button(host, '▼ Down (big)', raise(-20));

  // Extend / trim the two ends along the track direction.
  heading(host, 'Ends');
  button(host, '⟸ Extend start', () => { scene.extendTrackEnd('start', 80); afterEdit(); });
  button(host, 'Trim start ⟹', () => { scene.extendTrackEnd('start', -80); afterEdit(); });
  button(host, 'Extend end ⟹', () => { scene.extendTrackEnd('end', 80); afterEdit(); });
  button(host, '⟸ Trim end', () => { scene.extendTrackEnd('end', -80); afterEdit(); });

  // Shape + width.
  heading(host, 'Shape & width');
  button(host, 'Straighten', curveEdit(c => c.reset()));
  button(host, 'Sharper corners', curveEdit(c => c.setSmoothing(c.cornerSmoothing - 0.1)));
  button(host, 'Smoother corners', curveEdit(c => c.setSmoothing(c.cornerSmoothing + 0.1)));
  button(host, 'Wider sides', curveEdit(c => c.setShoulder(c.shoulder + 20)));
  button(host, 'Narrower sides', curveEdit(c => c.setShoulder(c.shoulder - 20)));
  button(host, 'Lanes wider', curveEdit(c => c.setLaneScale(c.laneScale * 1.2)));
  button(host, 'Lanes narrower', curveEdit(c => c.setLaneScale(c.laneScale / 1.2)));
}

/** Map / prop inspector: the object is transformed with the gizmo; show a hint + (for props) the
 *  delete/duplicate affordances are already in the tree. */
function renderObjectSection(host: HTMLElement, key: string): void {
  const isLine = key === 'startLine' || key === 'finishLine';
  heading(host, key === 'map' ? 'Map' : key === 'startLine' ? 'Start line'
    : key === 'finishLine' ? 'Finish line' : `Prop ${key}`);

  // Gizmo mode toggle (also W/E/R keys) — drag in the viewport OR use the numeric fields below.
  const tools = document.createElement('div');
  tools.style.cssText = 'display:flex;gap:6px;margin:6px 0';
  const mode = scene.gizmoModeNow();
  const modeBtn = (label: string, m: 'translate' | 'rotate' | 'scale') => {
    const b = document.createElement('button'); b.className = 'btn';
    b.textContent = label; if (mode === m) b.style.outline = '2px solid #36d1dc';
    b.onclick = () => { scene.setGizmoMode(m); renderPanel(); };
    tools.append(b);
  };
  modeBtn('Move (W)', 'translate'); modeBtn('Rotate (E)', 'rotate'); modeBtn('Scale (R)', 'scale');
  host.append(tools);

  const t = scene.selectedTransform();
  if (!t) {   // object still loading (async GLB) — show a hint, panel re-renders on change
    const p = document.createElement('p'); p.style.cssText = 'font-size:12px;opacity:.7';
    p.textContent = 'Loading model…'; host.append(p); return;
  }

  // Numeric Position / Rotation / Scale — the authoritative, precise way to place anything.
  heading(host, 'Position');
  const POS = 6000;   // generous range (maps are huge)
  numberRow(host, 'X', t.pos[0], -POS, POS, 0.5, (v) => scene.setSelectedPos(0, v));
  numberRow(host, 'Y', t.pos[1], -POS, POS, 0.5, (v) => scene.setSelectedPos(1, v));
  numberRow(host, 'Z', t.pos[2], -POS, POS, 0.5, (v) => scene.setSelectedPos(2, v));
  heading(host, 'Rotation (°)');
  numberRow(host, 'X', t.rotDeg[0], -180, 180, 1, (v) => scene.setSelectedRotDeg(0, v));
  numberRow(host, 'Y', t.rotDeg[1], -180, 180, 1, (v) => scene.setSelectedRotDeg(1, v));
  numberRow(host, 'Z', t.rotDeg[2], -180, 180, 1, (v) => scene.setSelectedRotDeg(2, v));
  heading(host, 'Scale');
  numberRow(host, 'Uniform', t.scale, 0.05, 500, 0.05, (v) => scene.setSelectedScale(v));

  const note = document.createElement('p');
  note.style.cssText = 'font-size:12px;opacity:.7;margin:8px 0 0';
  if (isLine) {
    note.textContent = 'Gantries auto-place at the track ends. Editing here pins this one to your transform (it stops following the track) and saves with the level.';
    host.append(note);
    button(host, 'Reset to auto-place', () => { scene.resetSelectedGantry(); renderPanel(); });
  } else if (key !== 'map') {
    note.textContent = 'Use the tree buttons above to Duplicate or Delete this prop.';
    host.append(note);
  }
}

/** Cars section (level-wide). Overrides keyed by car INDEX string ("0","1",…) — same key the game
 *  uses — NOT a GLB filename. Labels read "Car 1…" (1-based) while the key stays the 0-based index. */
function renderCarsSection(host: HTMLElement): void {
  heading(host, 'Cars');
  const lvl = scene.getLevel();
  numberRow(host, 'All cars size', lvl.cars.masterScale, 0.1, 10, 0.05, (v) => {
    lvl.cars.masterScale = v; scene.applyCars();
  });
  const toggle = document.createElement('label');
  const cb = document.createElement('input'); cb.type = 'checkbox';
  cb.checked = scene.carPreviewEnabled();
  cb.onchange = () => scene.setCarPreview(cb.checked);
  toggle.append(cb, document.createTextNode(' Show sample cars')); host.append(toggle);
  for (let i = 0; i < LANES_PREVIEW; i++) {
    numberRow(host, `Car ${i + 1} tweak`, lvl.cars.overrides[String(i)] ?? 1, 0.2, 5, 0.05, (v) => {
      lvl.cars.overrides[String(i)] = v; scene.applyCars();
    });
  }
}

/** Obstacles section (level-wide): per-level SIZE multipliers for the barrier + boost models, so
 *  each map can size obstacles to its track. The manifest sets the global base size; these scale it.
 *  OPT-IN: a level gains its own `obstacles` only when you change a value (1 = unchanged). */
function renderObstaclesSection(host: HTMLElement): void {
  heading(host, 'Obstacles & boosts');
  const lvl = scene.getLevel();
  const ensure = (): NonNullable<LevelConfig['obstacles']> => (lvl.obstacles ??= {});
  const toggle = document.createElement('label');
  const cb = document.createElement('input'); cb.type = 'checkbox';
  cb.checked = scene.obstaclePreviewEnabled();
  cb.onchange = () => scene.setObstaclePreview(cb.checked);
  toggle.append(cb, document.createTextNode(' Show sample obstacle + boost')); host.append(toggle);
  numberRow(host, 'Barrier size', lvl.obstacles?.barrierScale ?? 1, 0.1, 20, 0.05, (v) => {
    ensure().barrierScale = v; scene.applyObstacles();
  });
  numberRow(host, 'Boost size', lvl.obstacles?.boostScale ?? 1, 0.1, 20, 0.05, (v) => {
    ensure().boostScale = v; scene.applyObstacles();
  });
  const note = document.createElement('p');
  note.style.cssText = 'font-size:12px;opacity:.7;margin:4px 0';
  note.textContent = 'Multiplies the global model size (set in the Models library). 1 = unchanged.';
  host.append(note);
}

/** Lighting section (level-wide; replaces zone cycling in-game). OPT-IN: initial VALUES read from a
 *  local default (no persist on render); a level gains its own `lighting` only on an actual edit. */
function renderLightingSection(host: HTMLElement): void {
  const lvl = scene.getLevel();
  const lgt = lvl.lighting ?? DEFAULT_LIGHTING;
  const ensureLgt = (): NonNullable<LevelConfig['lighting']> =>
    (lvl.lighting ??= structuredClone(DEFAULT_LIGHTING));
  heading(host, 'Lighting (replaces zones)');
  numberRow(host, 'Sun intensity', lgt.sunIntensity, 0, 6, 0.05, v => { ensureLgt().sunIntensity = v; scene.applyLighting(); });
  numberRow(host, 'Sun X', lgt.sunPos[0]!, -500, 500, 5, v => { ensureLgt().sunPos[0] = v; scene.applyLighting(); });
  numberRow(host, 'Sun Y', lgt.sunPos[1]!, 0, 1000, 5, v => { ensureLgt().sunPos[1] = v; scene.applyLighting(); });
  numberRow(host, 'Sun Z', lgt.sunPos[2]!, -500, 500, 5, v => { ensureLgt().sunPos[2] = v; scene.applyLighting(); });
  colorRow(host, 'Sun color', lgt.sunColor, h => { ensureLgt().sunColor = h; scene.applyLighting(); });
  numberRow(host, 'Ambient', lgt.ambientIntensity, 0, 3, 0.05, v => { ensureLgt().ambientIntensity = v; scene.applyLighting(); });
  colorRow(host, 'Sky color', lgt.skyColor, h => { ensureLgt().skyColor = h; scene.applyLighting(); });
  colorRow(host, 'Ground color', lgt.groundColor, h => { ensureLgt().groundColor = h; scene.applyLighting(); });
  numberRow(host, 'Exposure', lgt.exposure, 0.2, 3, 0.05, v => { ensureLgt().exposure = v; scene.applyLighting(); });
}

/** Effects section (level-wide). Same OPT-IN rule as Lighting. Editor previews fog; full bloom/
 *  sky/glow is verified by launching the game. */
function renderEffectsSection(host: HTMLElement): void {
  const lvl = scene.getLevel();
  const fx = lvl.effects ?? DEFAULT_EFFECTS;
  const ensureFx = (): NonNullable<LevelConfig['effects']> =>
    (lvl.effects ??= structuredClone(DEFAULT_EFFECTS));
  heading(host, 'Effects');
  numberRow(host, 'Bloom strength', fx.bloom.strength, 0, 3, 0.05, v => { ensureFx().bloom.strength = v; scene.applyEffects(); });
  numberRow(host, 'Bloom radius', fx.bloom.radius, 0, 2, 0.05, v => { ensureFx().bloom.radius = v; scene.applyEffects(); });
  numberRow(host, 'Bloom threshold', fx.bloom.threshold, 0, 1, 0.01, v => { ensureFx().bloom.threshold = v; scene.applyEffects(); });
  numberRow(host, 'Fog density', fx.fog.density, 0, 0.02, 0.0005, v => { ensureFx().fog.density = v; scene.applyEffects(); });
  colorRow(host, 'Fog color', fx.fog.color, h => { ensureFx().fog.color = h; scene.applyEffects(); });
  numberRow(host, 'Track glow', fx.trackEmissive, 0, 4, 0.05, v => { ensureFx().trackEmissive = v; scene.applyEffects(); });
  numberRow(host, 'Pulse speed', fx.pulse.speed, 0, 6, 0.1, v => { ensureFx().pulse.speed = v; scene.applyEffects(); });
  numberRow(host, 'Pulse amount', fx.pulse.amount, 0, 1, 0.02, v => { ensureFx().pulse.amount = v; scene.applyEffects(); });
  colorRow(host, 'Sky top', fx.skyTop, h => { ensureFx().skyTop = h; scene.applyEffects(); });
  colorRow(host, 'Sky bottom', fx.skyBottom, h => { ensureFx().skyBottom = h; scene.applyEffects(); });
}

// Re-render the tree/panel when the scene changes (gizmo drag, programmatic edits) — but DON'T
// rebuild the panel while the user is typing in one of its own inputs, or we'd steal focus and
// interrupt the edit. The live 3D + the typed value are already in sync; the panel re-syncs on blur.
scene.onChange(() => {
  renderTree();
  const editing = panel.contains(document.activeElement) &&
    (document.activeElement as HTMLElement)?.tagName === 'INPUT';
  if (!editing) renderPanel();
});

async function refresh(selectKey?: string): Promise<void> {
  const raw = await fetchMaps();
  levels = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, mergeLevel(v)]));
  sel.replaceChildren();
  for (const key of Object.keys(levels)) {
    const o = document.createElement('option'); o.value = key; o.textContent = key; sel.appendChild(o);
  }
  const key = selectKey ?? Object.keys(levels)[0];
  if (key) { sel.value = key; await scene.loadLevel(structuredClone(levels[key]!)); }
  renderTree();
}

sel.addEventListener('change', async () => {
  await scene.loadLevel(structuredClone(levels[sel.value]!)); renderTree();
});

document.getElementById('newLevel')!.addEventListener('click', async () => {
  const map = prompt('New level key (e.g. canyon):')?.trim();
  if (!map) return;
  const file = prompt('World GLB filename in assets/maps (e.g. canyon.glb):', `${map}.glb`)?.trim();
  if (!file) return;
  if (levels[map] && !confirm(`Overwrite existing level "${map}"?`)) return;
  levels[map] = levelDefaults(map, file);
  await scene.loadLevel(structuredClone(levels[map]!));
  const o = document.createElement('option'); o.value = map; o.textContent = map; sel.appendChild(o); sel.value = map;
  renderTree();
});

document.getElementById('saveLevel')!.addEventListener('click', async () => {
  const cfg = scene.current();
  try {
    const res = await fetch('/api/maps', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    status.textContent = res.ok ? `Saved "${cfg.map}"` : 'Save failed';
  } catch { status.textContent = 'Server unreachable'; }
  setTimeout(() => (status.textContent = ''), 2500);
});

void refresh();
