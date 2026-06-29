// Garage — the single unified model viewer (/garage). Lists EVERY model in the manifest (cars,
// barrier, boost, props), shows one at a time at its real role size, and lets you:
//   - pick the model (dropdown),
//   - pick which baked animation CLIP to preview (models can have several),
//   - choose a MODE: static pose / wheel-spin / play the selected clip,
//   - toggle a turntable spin,
//   - set a friendly DISPLAY NAME (saved to the manifest).
// Unlike the game loader this keeps ALL animations, so you can audit how each model behaves before
// deciding its in-game `animate` flag. Replaces the old play.html?garage=1 + the Models Library
// preview overlap.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { stripDisplayBases } from '../asset-loader';
import { fetchManifest, saveManifest } from '../editor/manifest-client';
import { autoFitScale, isWheelNode, CAR_TARGET, BARRIER_TARGET, BOOST_TARGET } from '../../shared/asset-fit';
import type { Manifest, AssetRef } from '../../shared/asset-manifest';

type Mode = 'static' | 'wheels' | 'clip';

// ── Scene ───────────────────────────────────────────────────────────────────────────────────────
const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 2000);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

const sun = new THREE.DirectionalLight(0xfff4e2, 2.2); sun.position.set(8, 12, -6); sun.castShadow = true;
scene.add(sun, new THREE.HemisphereLight(0xbfd4ff, 0x202840, 0.9));
// A simple ground disc so the model has a surface + shadow.
const ground = new THREE.Mesh(new THREE.CircleGeometry(20, 48),
  new THREE.MeshStandardMaterial({ color: 0x222a3e, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
const loader = new GLTFLoader(); loader.setDRACOLoader(draco);

// ── State ───────────────────────────────────────────────────────────────────────────────────────
interface Entry { ref: AssetRef; role: string; target: number; }
let manifest: Manifest = { cars: [], barrier: null, boostPad: null, props: [] };
let entries: Entry[] = [];
let current: { group: THREE.Group; wheels: THREE.Object3D[]; mixer: THREE.AnimationMixer | null;
               clips: THREE.AnimationClip[]; action: THREE.AnimationAction | null } | null = null;
let mode: Mode = 'static';
let turntable = true;
let lastFrame = performance.now();

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const modelSel = $<HTMLSelectElement>('model');
const clipSel = $<HTMLSelectElement>('clip');
const nameInput = $<HTMLInputElement>('name');
const statusEl = $('status');
const turntableBtn = $('turntable');
const modeBtns = [...document.querySelectorAll('#mode button')] as HTMLButtonElement[];

function refreshModeButtons() { for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === mode); }

/** Flatten the manifest into a viewable list of {ref, role, target}. */
function buildEntries(m: Manifest): Entry[] {
  const out: Entry[] = [];
  m.cars.forEach((r) => out.push({ ref: r, role: 'car', target: CAR_TARGET }));
  if (m.barrier) out.push({ ref: m.barrier, role: 'barrier', target: BARRIER_TARGET });
  if (m.boostPad) out.push({ ref: m.boostPad, role: 'boost', target: BOOST_TARGET });
  m.props.forEach((r) => out.push({ ref: r, role: 'prop', target: CAR_TARGET }));
  return out;
}

const pretty = (e: Entry) => e.ref.name?.trim() || e.ref.file.replace(/\.glb$/i, '').replace(/_/g, ' ');

function populateModelDropdown() {
  modelSel.replaceChildren();
  entries.forEach((e, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = `${pretty(e)}  ·  ${e.role}`;
    modelSel.appendChild(o);
  });
}

// ── Load + show one model (keeping ALL its clips) ─────────────────────────────────────────────────
async function show(index: number): Promise<void> {
  const e = entries[index]; if (!e) return;
  if (current) { scene.remove(current.group); current = null; }
  nameInput.value = e.ref.name ?? '';
  statusEl.textContent = 'loading…';

  const gltf = await new Promise<any>((res) => loader.load(`/assets/${e.ref.file}`, res, undefined, () => res(null)));
  if (!gltf) { statusEl.textContent = 'load failed'; return; }
  const model: THREE.Group = gltf.scene;
  stripDisplayBases(model);   // drop showroom floors/backdrops, exactly like the game

  // Auto-fit to the role target + ground it (same math as AssetLoader/game).
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(); box.getSize(size);
  const fit = autoFitScale([size.x, size.y, size.z], e.target) * (e.ref.scale ?? 1);
  model.scale.setScalar(fit);
  const box2 = new THREE.Box3().setFromObject(model);
  const c = new THREE.Vector3(); box2.getCenter(c);
  model.position.x += -c.x; model.position.z += -c.z; model.position.y += -box2.min.y;
  model.traverse((o) => { (o as THREE.Mesh).castShadow = true; });

  // Collect ONLY real wheels (tight match so body parts don't spin). isWheelNode is loose
  // (matches "rim" inside "trim"); require the name to be wheel-ish AND look like a wheel word.
  const wheels: THREE.Object3D[] = [];
  model.traverse((o) => { if (o.name && isStrictWheel(o.name)) wheels.push(o); });

  const group = new THREE.Group(); group.add(model); scene.add(group);
  const clips: THREE.AnimationClip[] = gltf.animations ?? [];
  const mixer = clips.length ? new THREE.AnimationMixer(model) : null;
  current = { group, wheels, mixer, clips, action: null };

  // Clip dropdown
  clipSel.replaceChildren();
  if (clips.length === 0) {
    const o = document.createElement('option'); o.textContent = '(no baked clips)'; o.value = '-1';
    clipSel.appendChild(o); clipSel.disabled = true;
  } else {
    clips.forEach((cl, i) => { const o = document.createElement('option'); o.value = String(i);
      o.textContent = cl.name || `clip ${i + 1}`; clipSel.appendChild(o); });
    clipSel.disabled = false;
  }

  // Frame the camera on the model's size.
  frameCamera(fit, e.target);
  applyMode();   // honor the current mode for the new model
  statusEl.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${wheels.length} wheels`;
}

/** A stricter wheel test than isWheelNode: the token must be a whole word, so "trim"/"perimeter"
 *  don't false-match "rim". Catches "wheel", "tire", "tyre", "rim" as standalone words. */
function isStrictWheel(name: string): boolean {
  return isWheelNode(name) && /(^|[^a-z])(wheel|tire|tyre|rim)([^a-z]|$)/i.test(name);
}

function frameCamera(fit: number, target: number): void {
  const r = Math.max(target * fit, 2);
  camera.position.set(r * 0.9, r * 0.7, -r * 1.4);
  orbit.target.set(0, r * 0.3, 0);
  orbit.update();
}

function applyMode(): void {
  if (!current) return;
  // Stop any clip; reset wheel rotations to a clean baseline so switching modes is predictable.
  current.action?.stop(); current.action = null;
  if (mode === 'clip' && current.mixer && current.clips.length) {
    const idx = Math.max(0, parseInt(clipSel.value, 10) || 0);
    const clip = current.clips[idx] ?? current.clips[0]!;
    current.action = current.mixer.clipAction(clip); current.action.reset().play();
  }
}

// ── Render loop ───────────────────────────────────────────────────────────────────────────────────
function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.1); lastFrame = now;
  if (current) {
    if (turntable) current.group.rotation.y += dt * 0.5;
    if (mode === 'clip' && current.mixer) current.mixer.update(dt);
    else if (mode === 'wheels') for (const w of current.wheels) w.rotation.x += dt * 6;
  }
  orbit.update();
  renderer.render(scene, camera);
}

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────────
modelSel.addEventListener('change', () => void show(parseInt(modelSel.value, 10)));
clipSel.addEventListener('change', () => { if (mode === 'clip') applyMode(); });
for (const b of modeBtns) b.addEventListener('click', () => {
  mode = (b.dataset.mode as Mode) ?? 'static'; refreshModeButtons(); applyMode();
});
turntableBtn.addEventListener('click', () => {
  turntable = !turntable; turntableBtn.textContent = `Turntable: ${turntable ? 'on' : 'off'}`;
});
nameInput.addEventListener('change', () => {
  const e = entries[parseInt(modelSel.value, 10)]; if (!e) return;
  const v = nameInput.value.trim();
  if (v) e.ref.name = v; else delete e.ref.name;   // blank clears it
});
$('save').addEventListener('click', async () => {
  statusEl.textContent = 'saving…';
  try { manifest = await saveManifest(manifest); statusEl.textContent = 'saved names'; }
  catch { statusEl.textContent = 'save failed'; }
  setTimeout(() => (statusEl.textContent = ''), 2500);
});

async function boot(): Promise<void> {
  manifest = await fetchManifest();
  entries = buildEntries(manifest);
  if (entries.length === 0) { statusEl.textContent = 'no models in manifest'; return; }
  populateModelDropdown();
  mode = 'static'; refreshModeButtons();
  await show(0);
  frame();
}
void boot();
