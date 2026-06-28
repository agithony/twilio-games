// Map editor: overlay our 3-lane race strip onto a straight section of a track GLB.
// Two manipulable objects — the RACE STRIP (cyan, where cars drive) and the TRACK MODEL —
// each movable/rotatable/scalable via a gizmo. Save writes a map config (both transforms +
// carScale) to localStorage (and logs JSON to copy). URL: /maptest.html?map=silver_lake
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TRACK_W, TRACK_LEN } from '../shared/constants';

const mapName = new URLSearchParams(location.search).get('map') ?? 'silver_lake';
const statsEl = document.getElementById('stats')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x223047);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 200000);
const orbit = new OrbitControls(camera, renderer.domElement);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x303040, 1.3));
const sun = new THREE.DirectionalLight(0xffffff, 2.0); sun.position.set(500, 1500, 500); scene.add(sun);

// --- The race strip: a 3-lane × TRACK_LEN road slab + forward arrow (cars drive +Z). ---
// Built at GAME scale (TRACK_W wide, a chunk of TRACK_LEN long); the user scales the whole
// group to fit the map's road. We render it semi-transparent so the map shows through.
const raceStrip = new THREE.Group();
const slab = new THREE.Mesh(
  new THREE.BoxGeometry(TRACK_W, 0.5, TRACK_LEN),
  new THREE.MeshBasicMaterial({ color: 0x36d1dc, transparent: true, opacity: 0.4 }),
);
slab.position.y = 0.25;
raceStrip.add(slab);
// lane dividers so orientation/width is legible
for (let i = 1; i < 3; i++) {
  const x = TRACK_W / 2 - (TRACK_W / 3) * i;
  const line = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, TRACK_LEN),
    new THREE.MeshBasicMaterial({ color: 0xffffff }));
  line.position.set(x, 0.3, 0); raceStrip.add(line);
}
const arrow = new THREE.Mesh(new THREE.ConeGeometry(2, 6, 8),
  new THREE.MeshBasicMaterial({ color: 0xff3b3b }));
arrow.rotation.x = Math.PI / 2; arrow.position.set(0, 1, TRACK_LEN / 2 + 4); // points +Z = forward
raceStrip.add(arrow);
scene.add(raceStrip);

let trackModel: THREE.Object3D | null = null;

// --- Gizmo + selection between the two targets. ---
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setMode('translate');
scene.add(gizmo);
gizmo.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !(e as unknown as { value: boolean }).value;
});
let target: 'strip' | 'track' = 'strip';
function selectTarget(t: 'strip' | 'track') {
  target = t;
  const obj = t === 'strip' ? raceStrip : trackModel;
  if (obj) gizmo.attach(obj);
  render();
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
loader.setDRACOLoader(draco);

loader.load(`/assets/maps/${mapName}.glb`, (gltf) => {
  trackModel = gltf.scene;
  scene.add(trackModel);
  const box = new THREE.Box3().setFromObject(trackModel);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);

  // Restore a saved config if present, else seed sensible defaults.
  const saved = loadConfig();
  if (saved) applyConfig(saved);
  else {
    // Seed the race strip near the map center, scaled so it's ~visible on a road.
    const guess = Math.max(size.x, size.z) * 0.02 / TRACK_W;
    raceStrip.scale.setScalar(guess);
    raceStrip.position.set(center.x, box.min.y + 1, center.z);
  }

  // Frame top-down so the circuit reads like a map.
  orbit.target.copy(center);
  const span = Math.max(size.x, size.z);
  camera.position.set(center.x, center.y + span * 1.0, center.z + 0.01);
  camera.up.set(0, 0, -1);
  orbit.update();
  selectTarget('strip');
  render();
}, (p) => { statsEl.textContent = `loading… ${(p.loaded / 1048576).toFixed(1)} MB`; },
  (err) => { statsEl.textContent = `failed to load ${mapName}`; console.error(err); });

// --- Config persistence (the map definition: both transforms + derived carScale). ---
interface MapConfig {
  map: string;
  strip: { pos: number[]; rotDeg: number[]; scale: number };
  track: { pos: number[]; rotDeg: number[]; scale: number };
}
const KEY = `voiceRacer.map.${mapName}`;
function currentConfig(): MapConfig {
  const r2d = (r: THREE.Euler) => [r.x, r.y, r.z].map((v) => Math.round((v * 180) / Math.PI));
  return {
    map: mapName,
    strip: { pos: raceStrip.position.toArray().map(round), rotDeg: r2d(raceStrip.rotation), scale: round(raceStrip.scale.x) },
    track: trackModel
      ? { pos: trackModel.position.toArray().map(round), rotDeg: r2d(trackModel.rotation), scale: round(trackModel.scale.x) }
      : { pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1 },
  };
}
function applyConfig(c: MapConfig): void {
  const d2r = (d: number) => (d * Math.PI) / 180;
  raceStrip.position.fromArray(c.strip.pos);
  raceStrip.rotation.set(d2r(c.strip.rotDeg[0]!), d2r(c.strip.rotDeg[1]!), d2r(c.strip.rotDeg[2]!));
  raceStrip.scale.setScalar(c.strip.scale);
  if (trackModel) {
    trackModel.position.fromArray(c.track.pos);
    trackModel.rotation.set(d2r(c.track.rotDeg[0]!), d2r(c.track.rotDeg[1]!), d2r(c.track.rotDeg[2]!));
    trackModel.scale.setScalar(c.track.scale);
  }
}
function loadConfig(): MapConfig | null {
  try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) as MapConfig : null; } catch { return null; }
}
const round = (n: number) => Math.round(n * 1000) / 1000;

// --- Keyboard: target + gizmo mode + save. ---
addEventListener('keydown', (e) => {
  if (e.key === '1') selectTarget('strip');
  else if (e.key === '2') selectTarget('track');
  else if (e.key === 'w' || e.key === 'g') gizmo.setMode('translate');
  else if (e.key === 'e') gizmo.setMode('rotate');
  else if (e.key === 'r') gizmo.setMode('scale');
  else if (e.key === 'u') setUniform(!uniformScale);
  else if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
});

function setUniform(on: boolean): void {
  uniformScale = on;
  const cb = document.getElementById('uniform') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  applyUniformHandles();
  render();
}
document.getElementById('uniform')?.addEventListener('change', (e) =>
  setUniform((e.target as HTMLInputElement).checked));
// Uniform scaling (default ON): when scaling, keep all 3 axes equal so the strip/track can't
// be stretched out of proportion. Enforced by clamping in objectChange (below) — dragging any
// scale handle scales all axes evenly.
// NOTE: we intentionally do NOT hide the per-axis scale handles here. In three.js 0.164 the
// center uniform ("E"/XYZ) handle is only visible when showX && showY && showZ are ALL true
// (TransformControls.js line ~1440), so setting them false to "leave only the uniform handle"
// actually hid the ENTIRE scale gizmo, making it impossible to scale. The objectChange clamp
// already guarantees uniform scaling regardless of which handle is dragged.
let uniformScale = true;
function applyUniformHandles(): void {
  gizmo.showX = true;
  gizmo.showY = true;
  gizmo.showZ = true;
}
const origSetMode = gizmo.setMode.bind(gizmo);
gizmo.setMode = ((m: 'translate' | 'rotate' | 'scale') => { origSetMode(m); applyUniformHandles(); render(); }) as typeof gizmo.setMode;

gizmo.addEventListener('objectChange', () => {
  if (uniformScale && gizmo.getMode() === 'scale' && gizmo.object) {
    // Force all axes to the largest component so any drag scales evenly.
    const o = gizmo.object;
    const s = Math.max(o.scale.x, o.scale.y, o.scale.z);
    o.scale.setScalar(s);
  }
  render();
});

function save(): void {
  const c = currentConfig();
  localStorage.setItem(KEY, JSON.stringify(c));
  console.log('MAP CONFIG (copy this):\n' + JSON.stringify(c, null, 2));
  flash('Saved ✓ (config logged to console)');
}
document.getElementById('save')?.addEventListener('click', save);
document.getElementById('sel-strip')?.addEventListener('click', () => selectTarget('strip'));
document.getElementById('sel-track')?.addEventListener('click', () => selectTarget('track'));
document.getElementById('m-move')?.addEventListener('click', () => gizmo.setMode('translate'));
document.getElementById('m-rot')?.addEventListener('click', () => gizmo.setMode('rotate'));
document.getElementById('m-scale')?.addEventListener('click', () => gizmo.setMode('scale'));

let flashT = 0;
function flash(msg: string): void { statsEl.dataset.flash = msg; flashT = performance.now() + 1800; render(); }

function render(): void {
  const c = currentConfig();
  statsEl.replaceChildren();
  const b = document.createElement('b'); b.textContent = mapName;
  const sel = document.createElement('div');
  sel.textContent = `editing: ${target === 'strip' ? 'RACE STRIP (cyan)' : 'TRACK MODEL'} · gizmo: ${gizmo.getMode()}`;
  sel.style.color = '#36d1dc';
  const info = document.createElement('div');
  info.textContent = `strip scale ${c.strip.scale} rotY ${c.strip.rotDeg[1]}° · track scale ${c.track.scale} rotY ${c.track.rotDeg[1]}°`;
  statsEl.append(b, sel, info);
  if (statsEl.dataset.flash && performance.now() < flashT) {
    const f = document.createElement('div'); f.textContent = statsEl.dataset.flash; f.style.color = '#36e08a';
    statsEl.append(f);
  }
}

function loop(): void { requestAnimationFrame(loop); orbit.update(); renderer.render(scene, camera); }
loop();
