// Garage — the single model viewer + configurator (/garage). Lists EVERY model role in the manifest
// (each car slot, barrier, boost, each prop), shows one at a time, and lets you:
//   - swap which GLB fills a role, set scale / rotation / offset (saved to the manifest),
//   - give it a friendly display name,
//   - preview baked animation clips: pick a clip, play/pause, SCRUB the timeline, change SPEED,
//   - toggle "use in game" (the per-model animate flag) and a turntable.
// Keeps ALL clips (the game loader strips them) so you can audit a model before enabling it.
// Replaces the old play.html?garage=1 AND the Models Library (role/transform editing lives here now).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { stripDisplayBases } from '../asset-loader';
import { applyModelTransform } from '../model-transform';
import { fetchManifest, saveManifest, fetchAssets } from '../editor/manifest-client';
import { isWheelNode, CAR_TARGET, BARRIER_TARGET, BOOST_TARGET } from '../../shared/asset-fit';
import type { Manifest, AssetRef } from '../../shared/asset-manifest';

type Mode = 'static' | 'wheels' | 'clip';
type Role = 'car' | 'barrier' | 'boost' | 'prop';

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
// An Entry points at WHERE a role lives in the manifest, so edits write straight back.
interface Entry { role: Role; label: string; target: number; get(): AssetRef | null; set(r: AssetRef | null): void; }
let manifest: Manifest = { cars: [], barrier: null, boostPad: null, props: [] };
let entries: Entry[] = [];
let allGlbs: string[] = [];
let idx = 0;
let current: { group: THREE.Group; model: THREE.Object3D; wheels: THREE.Object3D[];
               mixer: THREE.AnimationMixer | null; clips: THREE.AnimationClip[]; action: THREE.AnimationAction | null;
               } | null = null;
let mode: Mode = 'static';
let turntable = true;
let paused = false;
let speed = 1;
let lastFrame = performance.now();

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const modelSel = $<HTMLSelectElement>('model'), clipSel = $<HTMLSelectElement>('clip');
const fileSel = $<HTMLSelectElement>('file'), roleSel = $<HTMLSelectElement>('role');
const nameInput = $<HTMLInputElement>('name'), scaleInput = $<HTMLInputElement>('scale');
const useAnim = $<HTMLInputElement>('useanim'), statusEl = $('status');
const turntableBtn = $('turntable'), modeBtns = [...document.querySelectorAll('#mode button')] as HTMLButtonElement[];
const rIn = ['rx', 'ry', 'rz'].map((id) => $<HTMLInputElement>(id));
const oIn = ['ox', 'oy', 'oz'].map((id) => $<HTMLInputElement>(id));
const scrubBar = $('scrub'), timeRange = $<HTMLInputElement>('time'), timeVal = $('timeval');
const speedRange = $<HTMLInputElement>('speed'), speedVal = $('speedval'), playPauseBtn = $('playpause');

function refreshModeButtons() {
  for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === mode);
  scrubBar.classList.toggle('show', mode === 'clip' && !!current?.clips.length);
}

/** Build the editable role list from the manifest (each car slot, barrier, boost, each prop). */
function buildEntries(m: Manifest): Entry[] {
  const out: Entry[] = [];
  m.cars.forEach((_, i) => out.push({ role: 'car', label: `Car ${i + 1}`, target: CAR_TARGET,
    get: () => m.cars[i] ?? null, set: (r) => { if (r) m.cars[i] = r; } }));
  out.push({ role: 'barrier', label: 'Barrier', target: BARRIER_TARGET,
    get: () => m.barrier, set: (r) => { m.barrier = r; } });
  out.push({ role: 'boost', label: 'Boost pad', target: BOOST_TARGET,
    get: () => m.boostPad, set: (r) => { m.boostPad = r; } });
  m.props.forEach((_, i) => out.push({ role: 'prop', label: `Prop ${i + 1}`, target: CAR_TARGET,
    get: () => m.props[i] ?? null, set: (r) => { if (r) m.props[i] = r; } }));
  return out;
}

const refOf = (i: number): AssetRef | null => entries[i]?.get() ?? null;
const prettyEntry = (e: Entry) => { const r = e.get(); const nm = r?.name?.trim()
  || r?.file.replace(/\.glb$/i, '').replace(/_/g, ' ') || '(empty)'; return `${e.label}: ${nm}`; };

function populateModelDropdown() {
  modelSel.replaceChildren();
  entries.forEach((e, i) => { const o = document.createElement('option'); o.value = String(i);
    o.textContent = prettyEntry(e); modelSel.appendChild(o); });
  modelSel.value = String(idx);
}
function populateFileDropdown(sel: string | undefined) {
  fileSel.replaceChildren();
  for (const f of allGlbs) { const o = document.createElement('option'); o.value = f;
    o.textContent = f; if (f === sel) o.selected = true; fileSel.appendChild(o); }
}
function populateRoleDropdown(role: Role) {
  roleSel.replaceChildren();
  // Role is fixed by which slot you're editing (the manifest shape), so this is informational —
  // you change which GLB fills a role here, not re-categorize a slot.
  const o = document.createElement('option'); o.textContent = role; o.value = role; o.selected = true;
  roleSel.appendChild(o); roleSel.disabled = true;
}

// ── Load + show ──────────────────────────────────────────────────────────────────────────────────
async function show(i: number): Promise<void> {
  idx = i;
  const e = entries[i]; if (!e) return;
  const ref = e.get();
  if (current) { scene.remove(current.group); current = null; }
  // Fill the panel from the ref.
  nameInput.value = ref?.name ?? '';
  scaleInput.value = String(ref?.scale ?? 1);
  const rot = ref?.rotation ?? [0, 0, 0], off = ref?.offset ?? [0, 0, 0];
  rIn.forEach((el, k) => (el.value = String(rot[k] ?? 0)));
  oIn.forEach((el, k) => (el.value = String(off[k] ?? 0)));
  useAnim.checked = ref?.animate === true;
  populateFileDropdown(ref?.file); populateRoleDropdown(e.role);

  if (!ref) { statusEl.textContent = '(no model assigned)'; clipSel.replaceChildren(); refreshModeButtons(); return; }
  statusEl.textContent = 'loading…';
  const gltf = await new Promise<any>((res) => loader.load(`/assets/${ref.file}`, res, undefined, () => res(null)));
  if (!gltf) { statusEl.textContent = 'load failed'; return; }
  const model: THREE.Group = gltf.scene;
  stripDisplayBases(model);
  const group = new THREE.Group(); group.add(model); scene.add(group);

  const wheels: THREE.Object3D[] = [];
  model.traverse((o) => { if (o.name && isStrictWheel(o.name)) wheels.push(o); });
  const clips: THREE.AnimationClip[] = gltf.animations ?? [];
  const mixer = clips.length ? new THREE.AnimationMixer(model) : null;
  current = { group, model, wheels, mixer, clips, action: null };

  applyTransform();   // scale/rotation/offset + auto-fit + grounding
  // Clip dropdown
  clipSel.replaceChildren();
  if (clips.length === 0) { const o = document.createElement('option'); o.textContent = '(no baked clips)';
    o.value = '-1'; clipSel.appendChild(o); clipSel.disabled = true; }
  else { clips.forEach((cl, k) => { const o = document.createElement('option'); o.value = String(k);
    o.textContent = `${cl.name || 'clip ' + (k + 1)} · ${cl.duration.toFixed(1)}s`; clipSel.appendChild(o); });
    clipSel.disabled = false; }

  frameCamera();
  applyMode();
  statusEl.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${wheels.length} wheels`;
}

/** Re-apply scale/rotation/offset from the panel onto the model. Uses the SAME shared placement
 *  helper as the game loader (rotate → fit → ground/center) so the garage is true WYSIWYG. */
function applyTransform(): void {
  if (!current) return;
  const e = entries[idx]; const ref = e?.get(); if (!ref) return;
  applyModelTransform(current.model, ref, e!.target);
}

function isStrictWheel(name: string): boolean {
  return isWheelNode(name) && /(^|[^a-z])(wheel|tire|tyre|rim)([^a-z]|$)/i.test(name);
}
function frameCamera(): void {
  if (!current) return;
  // Frame on the model's ACTUAL rendered size (post auto-fit + scale), not target×fit (fit is the
  // tiny scale FACTOR, which made huge raw models frame from ~origin and look like a speck).
  const box = new THREE.Box3().setFromObject(current.model); const size = new THREE.Vector3();
  box.getSize(size); const center = new THREE.Vector3(); box.getCenter(center);
  const r = Math.max(size.x, size.y, size.z, 1);
  camera.position.set(center.x + r * 0.9, center.y + r * 0.7, center.z - r * 1.4);
  orbit.target.copy(center); orbit.update();
  // Size the ground disc to the model so it reads as a stage, not a giant plain (radius ~1.6× the
  // footprint, min 3). Lift it to the model's base.
  const groundR = Math.max(Math.max(size.x, size.z) * 0.9, 3);
  ground.scale.setScalar(groundR / 20);   // base geometry radius is 20
  ground.position.y = box.min.y - 0.01;
}

function applyMode(): void {
  if (!current) return;
  current.action?.stop(); current.action = null;
  if (mode === 'clip' && current.mixer && current.clips.length) {
    const k = Math.max(0, parseInt(clipSel.value, 10) || 0);
    const clip = current.clips[k] ?? current.clips[0]!;
    current.action = current.mixer.clipAction(clip); current.action.reset().play();
    paused = false; playPauseBtn.textContent = 'Pause';
    timeRange.max = String(clip.duration || 1);
  }
  refreshModeButtons();
}

// ── Render loop ───────────────────────────────────────────────────────────────────────────────────
function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now(); const dt = Math.min((now - lastFrame) / 1000, 0.1); lastFrame = now;
  if (current) {
    if (turntable) current.group.rotation.y += dt * 0.5;
    if (mode === 'clip' && current.mixer && current.action) {
      if (!paused) current.mixer.update(dt * speed);
      // reflect playhead on the scrub bar
      const d = current.action.getClip().duration || 1;
      const t = current.action.time % d;
      timeRange.value = String(t); timeVal.textContent = `${t.toFixed(1)} / ${d.toFixed(1)}s`;
    } else if (mode === 'wheels') for (const w of current.wheels) w.rotation.x += dt * 6;
  }
  orbit.update(); renderer.render(scene, camera);
}

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────────
modelSel.addEventListener('change', () => void show(parseInt(modelSel.value, 10)));
clipSel.addEventListener('change', () => { if (mode === 'clip') applyMode(); });
for (const b of modeBtns) b.addEventListener('click', () => { mode = (b.dataset.mode as Mode) ?? 'static'; applyMode(); });
turntableBtn.addEventListener('click', () => { turntable = !turntable; turntableBtn.textContent = `Turntable: ${turntable ? 'on' : 'off'}`; });

// scrub controls
playPauseBtn.addEventListener('click', () => { paused = !paused; playPauseBtn.textContent = paused ? 'Play' : 'Pause'; });
speedRange.addEventListener('input', () => { speed = parseFloat(speedRange.value); speedVal.textContent = `${speed}×`; });
timeRange.addEventListener('input', () => {
  if (!current?.action) return;
  paused = true; playPauseBtn.textContent = 'Play';
  const t = parseFloat(timeRange.value);
  current.action.time = t; current.mixer!.update(0);   // jump the playhead + apply the pose
});

// panel edits → write back to the AssetRef + re-apply
const writeRef = (mutate: (r: AssetRef) => void) => { const r = refOf(idx); if (!r) return; mutate(r); };
nameInput.addEventListener('change', () => { writeRef((r) => { const v = nameInput.value.trim(); if (v) r.name = v; else delete r.name; }); populateModelDropdown(); });
scaleInput.addEventListener('input', () => { writeRef((r) => { r.scale = parseFloat(scaleInput.value) || 1; }); applyTransform(); });
for (const el of [...rIn, ...oIn]) el.addEventListener('input', () => {
  writeRef((r) => {
    r.rotation = [parseFloat(rIn[0]!.value) || 0, parseFloat(rIn[1]!.value) || 0, parseFloat(rIn[2]!.value) || 0];
    r.offset = [parseFloat(oIn[0]!.value) || 0, parseFloat(oIn[1]!.value) || 0, parseFloat(oIn[2]!.value) || 0];
  });
  applyTransform();
});
useAnim.addEventListener('change', () => writeRef((r) => { if (useAnim.checked) r.animate = true; else delete r.animate; }));
fileSel.addEventListener('change', () => { writeRef((r) => { r.file = fileSel.value; }); populateModelDropdown(); void show(idx); });

$('save').addEventListener('click', async () => {
  statusEl.textContent = 'saving…';
  try { manifest = await saveManifest(manifest); entries = buildEntries(manifest); statusEl.textContent = 'saved'; }
  catch { statusEl.textContent = 'save failed'; }
  setTimeout(() => (statusEl.textContent = ''), 2500);
});

if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  (window as unknown as { __garage?: unknown }).__garage = { get current() { return current; }, get mode() { return mode; }, scene };
}

async function boot(): Promise<void> {
  [manifest, allGlbs] = await Promise.all([fetchManifest(), fetchAssets()]);
  entries = buildEntries(manifest);
  if (entries.length === 0) { statusEl.textContent = 'no models in manifest'; return; }
  speedVal.textContent = '1×';
  populateModelDropdown();
  mode = 'static'; refreshModeButtons();
  await show(0);
  frame();
}
void boot();
