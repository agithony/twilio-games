import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import {
  autoFitScale,
  CAR_TARGET,
  BARRIER_TARGET,
  BOOST_TARGET,
} from '../../shared/asset-fit';
import { stripDisplayBases } from '../asset-loader';
import { fetchManifest, saveManifest, fetchAssets } from './manifest-client';
import { TRACK_W, TRACK_LEN, LANES, laneX } from '../../shared/constants';
import type { Manifest, AssetRef } from '../../shared/asset-manifest';

const deg = (d: number) => (d * Math.PI) / 180;

/** Which manifest slot a placed group maps back to. */
type Binding =
  | { kind: 'car'; index: number }
  | { kind: 'barrier' }
  | { kind: 'boostPad' };

/** A model placed in the editor scene, linked to its AssetRef in the working manifest. */
interface Placement {
  /** Outer group positioned in the lane; the gizmo attaches here. */
  group: THREE.Group;
  /** The loaded model (or primitive fallback) inside `group`. */
  model: THREE.Object3D;
  binding: Binding;
  /** Resolved target longest-dimension for this role (for auto-fit). */
  target: number;
  /** Auto-fit factor measured on the loaded model (1 for primitives). */
  fit: number;
  /** Lane base position (world) so offset is applied relative to it. */
  base: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Scene boot (mirrors client/renderer.ts: same lights + track material/size).
// ---------------------------------------------------------------------------
const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(13, 15, -30);
camera.lookAt(0, 1.5, 26);

const sun = new THREE.DirectionalLight(0xfff6e6, 1.2);
sun.position.set(40, 80, -20);
sun.castShadow = true;
scene.add(sun);
scene.add(new THREE.AmbientLight(0x5566aa, 0.6));

const track = new THREE.Mesh(
  new THREE.PlaneGeometry(TRACK_W, TRACK_LEN * 3),
  new THREE.MeshStandardMaterial({ color: 0x1a2238 }),
);
track.rotation.x = -Math.PI / 2;
track.position.z = TRACK_LEN;
scene.add(track);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1, 20);
orbit.update();

const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setMode('translate');
scene.add(gizmo);
// Disable orbiting while dragging the gizmo so the two don't fight.
gizmo.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !(e as unknown as { value: boolean }).value;
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// State: the working manifest copy + the placed models bound to it.
// ---------------------------------------------------------------------------
let working: Manifest = { cars: [], barrier: null, boostPad: null, props: [] };
let availableGlbs: string[] = [];
const placements: Placement[] = [];
let selected: Placement | null = null;
/** True only after boot() has successfully loaded + populated the scene. Gates Save. */
let loaded = false;

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
loader.setDRACOLoader(draco);

/**
 * Load a GLB and normalize it exactly like AssetLoader: auto-fit to the role
 * target, center on x/z, sit on y=0. Returns the model plus the measured fit
 * factor (so the inspector's scale field is a multiplier on top of auto-fit,
 * matching the runtime loader). Resolves to null on any error.
 */
function loadModel(file: string, target: number): Promise<{ model: THREE.Object3D; fit: number } | null> {
  return new Promise((resolve) => {
    loader.load(
      `/assets/${file}`,
      (gltf) => {
        try {
          const g = gltf.scene;
          stripDisplayBases(g);   // drop showroom bases/floors/backdrops (match game loader)
          const box = new THREE.Box3().setFromObject(g);
          const size = new THREE.Vector3();
          box.getSize(size);
          const fit = autoFitScale([size.x, size.y, size.z], target);
          g.scale.setScalar(fit);
          const box2 = new THREE.Box3().setFromObject(g);
          const c = new THREE.Vector3();
          box2.getCenter(c);
          g.position.x += -c.x;
          g.position.y += -box2.min.y;
          g.position.z += -c.z;
          g.traverse((o) => {
            (o as THREE.Mesh).castShadow = true;
          });
          resolve({ model: g, fit });
        } catch {
          resolve(null);
        }
      },
      undefined,
      () => resolve(null),
    );
  });
}

/** Primitive stand-in used when a model fails to load or no GLB is assigned. */
function primitive(kind: Binding['kind']): THREE.Object3D {
  if (kind === 'barrier') {
    return new THREE.Mesh(
      new THREE.BoxGeometry(TRACK_W / LANES - 1.5, 1.6, 1.2),
      new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0x550000 }),
    );
  }
  if (kind === 'boostPad') {
    return new THREE.Mesh(
      new THREE.CylinderGeometry(1.3, 1.3, 0.25, 20),
      new THREE.MeshStandardMaterial({ color: 0x36e08a, emissive: 0x0a5a32 }),
    );
  }
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2, 0.7, 3.4),
    new THREE.MeshStandardMaterial({ color: 0x5566ff, metalness: 0.35, roughness: 0.4 }),
  );
  body.position.y = 0.75;
  g.add(body);
  return g;
}

const targetFor = (kind: Binding['kind']): number =>
  kind === 'barrier' ? BARRIER_TARGET : kind === 'boostPad' ? BOOST_TARGET : CAR_TARGET;

/** Apply an AssetRef's scale/rotation/offset onto a placement's model+group. */
function applyRef(p: Placement, ref: AssetRef): void {
  const mult = ref.scale ?? 1;
  p.model.scale.setScalar(p.fit * mult);
  const rot = ref.rotation ?? [0, 0, 0];
  p.model.rotation.set(deg(rot[0]), deg(rot[1]), deg(rot[2]));
  const off = ref.offset ?? [0, 0, 0];
  p.group.position.set(p.base.x + off[0], p.base.y + off[1], p.base.z + off[2]);
}

/** Resolve the AssetRef for a binding from the working manifest (or null). */
function refOf(binding: Binding): AssetRef | null {
  if (binding.kind === 'car') return working.cars[binding.index] ?? null;
  if (binding.kind === 'barrier') return working.barrier;
  return working.boostPad;
}

/** Build one placement: load (or stub) the model, wrap it, apply the ref, add to scene. */
async function buildPlacement(binding: Binding, base: THREE.Vector3): Promise<void> {
  const target = targetFor(binding.kind);
  const ref = refOf(binding);
  let model: THREE.Object3D;
  let fit = 1;
  if (ref) {
    const loaded = await loadModel(ref.file, target);
    if (loaded) {
      model = loaded.model;
      fit = loaded.fit;
    } else {
      model = primitive(binding.kind);
    }
  } else {
    model = primitive(binding.kind);
  }
  const group = new THREE.Group();
  group.add(model);
  group.position.copy(base);
  scene.add(group);
  const p: Placement = { group, model, binding, target, fit, base: base.clone() };
  if (ref) applyRef(p, ref);
  placements.push(p);
}

// ---------------------------------------------------------------------------
// Selection by raycast.
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ptr = new THREE.Vector2();

function findPlacement(obj: THREE.Object3D): Placement | null {
  for (const p of placements) {
    let o: THREE.Object3D | null = obj;
    while (o) {
      if (o === p.group) return p;
      o = o.parent;
    }
  }
  return null;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (gizmo.dragging) return;
  ptr.x = (e.clientX / innerWidth) * 2 - 1;
  ptr.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(ptr, camera);
  const hits = raycaster.intersectObjects(placements.map((p) => p.group), true);
  const hit = hits[0];
  if (!hit) { deselect(); return; }     // click empty space → deselect
  const p = findPlacement(hit.object);
  if (p) select(p); else deselect();
});

function select(p: Placement): void {
  selected = p;
  gizmo.attach(p.group);
  focusOn(p);            // auto-focus the camera on the selected model
  renderInspector();
}

function deselect(): void {
  selected = null;
  gizmo.detach();
  renderInspector();
}

// --- Smooth camera focus: orbit the camera to frame a placement's bounding sphere. ---
let camTween: { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTgt: THREE.Vector3; toTgt: THREE.Vector3; t: number } | null = null;

function frameBox(box: THREE.Box3, pad = 1.6): void {
  if (box.isEmpty()) return;
  const center = new THREE.Vector3(); box.getCenter(center);
  const size = new THREE.Vector3(); box.getSize(size);
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 2;
  const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * pad;
  // Keep the existing 3/4 view direction; place the camera back along it from the center.
  const dir = new THREE.Vector3(0.5, 0.6, -1).normalize();
  camTween = {
    fromPos: camera.position.clone(), toPos: center.clone().add(dir.multiplyScalar(dist)),
    fromTgt: orbit.target.clone(), toTgt: center.clone(), t: 0,
  };
}

function focusOn(p: Placement): void {
  frameBox(new THREE.Box3().setFromObject(p.group));
}

function frameAll(): void {
  const box = new THREE.Box3();
  for (const p of placements) box.expandByObject(p.group);
  frameBox(box, 1.3);
}

// ---------------------------------------------------------------------------
// When the gizmo moves the group, write the change back into the AssetRef.
// (Position -> offset relative to base. Rotation/scale on the MODEL, not the
// wrapper, so we keep the gizmo on the group and mirror to the model below.)
// ---------------------------------------------------------------------------
gizmo.addEventListener('objectChange', () => {
  if (!selected) return;
  const ref = refOf(selected.binding);
  if (!ref) return;
  const g = selected.group;
  // offset = group position - base
  ref.offset = [
    round(g.position.x - selected.base.x),
    round(g.position.y - selected.base.y),
    round(g.position.z - selected.base.z),
  ];
  if (gizmo.getMode() === 'rotate') {
    ref.rotation = [
      round((g.rotation.x * 180) / Math.PI),
      round((g.rotation.y * 180) / Math.PI),
      round((g.rotation.z * 180) / Math.PI),
    ];
    // mirror group rotation onto model, reset group so offset stays clean
    selected.model.rotation.copy(g.rotation);
    g.rotation.set(0, 0, 0);
  }
  if (gizmo.getMode() === 'scale') {
    const s = g.scale.x; // uniform
    ref.scale = round(s);
    selected.model.scale.setScalar(selected.fit * s);
    g.scale.setScalar(1);
  }
  renderInspector();
});

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Escape a string for safe interpolation into HTML attribute/text contexts. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// ---------------------------------------------------------------------------
// Inspector panel: role <select> + numeric scale/rotation/offset fields.
// ---------------------------------------------------------------------------
const inspectorEl = document.getElementById('inspector')!;

function roleLabel(b: Binding): string {
  if (b.kind === 'car') return `Car (lane ${b.index})`;
  if (b.kind === 'barrier') return 'Barrier';
  return 'Boost Pad';
}

function renderInspector(): void {
  if (!selected) {
    inspectorEl.innerHTML = '<div class="hint">No model selected.</div>';
    return;
  }
  const ref = refOf(selected.binding);
  const rot = ref?.rotation ?? [0, 0, 0];
  const off = ref?.offset ?? [0, 0, 0];
  const scale = ref?.scale ?? 1;
  const options = availableGlbs
    .map((f) => `<option value="${esc(f)}"${ref && ref.file === f ? ' selected' : ''}>${esc(f)}</option>`)
    .join('');

  inspectorEl.innerHTML = `
    <h4 style="margin-top:12px">${roleLabel(selected.binding)}</h4>
    <label>Model<select id="f-file">${options}</select></label>
    <label>Scale<input id="f-scale" type="number" step="0.05" value="${scale}"></label>
    <label>Rot X°<input id="f-rx" type="number" step="1" value="${rot[0]}"></label>
    <label>Rot Y°<input id="f-ry" type="number" step="1" value="${rot[1]}"></label>
    <label>Rot Z°<input id="f-rz" type="number" step="1" value="${rot[2]}"></label>
    <label>Off X<input id="f-ox" type="number" step="0.1" value="${off[0]}"></label>
    <label>Off Y<input id="f-oy" type="number" step="0.1" value="${off[1]}"></label>
    <label>Off Z<input id="f-oz" type="number" step="0.1" value="${off[2]}"></label>
  `;

  const num = (id: string): number => {
    const el = inspectorEl.querySelector<HTMLInputElement>(`#${id}`);
    const v = el ? parseFloat(el.value) : 0;
    return Number.isFinite(v) ? v : 0;
  };

  const onFieldChange = (): void => {
    if (!selected) return;
    const r = refOf(selected.binding);
    if (!r) return;
    r.scale = num('f-scale');
    r.rotation = [num('f-rx'), num('f-ry'), num('f-rz')];
    r.offset = [num('f-ox'), num('f-oy'), num('f-oz')];
    // applyRef puts rotation/scale on the model and offset on the group, so
    // reset any leftover gizmo transform on the group first.
    selected.group.rotation.set(0, 0, 0);
    selected.group.scale.setScalar(1);
    applyRef(selected, r);
  };

  for (const id of ['f-scale', 'f-rx', 'f-ry', 'f-rz', 'f-ox', 'f-oy', 'f-oz']) {
    inspectorEl.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('input', onFieldChange);
  }

  const fileSel = inspectorEl.querySelector<HTMLSelectElement>('#f-file');
  fileSel?.addEventListener('change', () => {
    if (!selected) return;
    const r = refOf(selected.binding);
    if (!r) return;
    r.file = fileSel.value;
    void swapModel(selected, r);
  });
}

/** Reassign a placement's GLB: reload the model and re-apply the ref. */
async function swapModel(p: Placement, ref: AssetRef): Promise<void> {
  const loaded = await loadModel(ref.file, p.target);
  p.group.remove(p.model);
  p.model = loaded ? loaded.model : primitive(p.binding.kind);
  p.fit = loaded ? loaded.fit : 1;
  p.group.add(p.model);
  p.group.rotation.set(0, 0, 0);
  p.group.scale.setScalar(1);
  applyRef(p, ref);
}

// ---------------------------------------------------------------------------
// Keyboard: switch gizmo mode.
// ---------------------------------------------------------------------------
/** Reset the selected model's scale/rotation/offset back to auto-fit defaults. */
function resetTransform(): void {
  if (!selected) return;
  const ref = refOf(selected.binding);
  if (!ref) return;
  ref.scale = 1; ref.rotation = [0, 0, 0]; ref.offset = [0, 0, 0];
  selected.group.rotation.set(0, 0, 0);
  selected.group.scale.setScalar(1);
  applyRef(selected, ref);
  renderInspector();
  toast('Transform reset');
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'w' || e.key === 'g') gizmo.setMode('translate');
  else if (e.key === 'e') gizmo.setMode('rotate');
  else if (e.key === 'r') gizmo.setMode('scale');
  else if (e.key === 'f') { if (selected) focusOn(selected); else frameAll(); }
  else if (e.key === 'Escape') deselect();
  else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); resetTransform(); }
});

document.getElementById('reset')!.addEventListener('click', resetTransform);
document.getElementById('frameAll')!.addEventListener('click', frameAll);

// ---------------------------------------------------------------------------
// Save.
// ---------------------------------------------------------------------------
const toastEl = document.getElementById('toast')!;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1800);
}

const saveBtn = document.getElementById('save') as HTMLButtonElement;
// Stay disabled until boot() succeeds, so a failed load can't POST the empty literal.
saveBtn.disabled = true;

/** True when the manifest has nothing in any role (the wipe we must never save). */
function isEmptyManifest(m: Manifest): boolean {
  return m.cars.length === 0 && !m.barrier && !m.boostPad && m.props.length === 0;
}

saveBtn.addEventListener('click', async () => {
  if (!loaded) {
    toast('Cannot save: manifest not loaded');
    return;
  }
  // Belt-and-suspenders: never overwrite the real manifest with nothing.
  if (isEmptyManifest(working)) {
    toast('Refusing to save an empty manifest');
    return;
  }
  try {
    working = await saveManifest(working);
    toast('Saved to manifest');
  } catch (err) {
    toast('Save failed');
    console.error(err);
  }
});

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
async function boot(): Promise<void> {
  [working, availableGlbs] = await Promise.all([fetchManifest(), fetchAssets()]);
  if (!availableGlbs.length) {
    // Fall back to whatever files the manifest already references.
    const set = new Set<string>();
    for (const c of working.cars) set.add(c.file);
    if (working.barrier) set.add(working.barrier.file);
    if (working.boostPad) set.add(working.boostPad.file);
    availableGlbs = [...set].sort();
  }

  // Cars: one per lane, spread along z so several are visible at once.
  for (let i = 0; i < working.cars.length; i++) {
    const lane = i % LANES;
    const z = 12 + Math.floor(i / LANES) * 10;
    await buildPlacement({ kind: 'car', index: i }, new THREE.Vector3(laneX(lane), 0, z));
  }
  // Barrier + boost pad at representative positions.
  await buildPlacement({ kind: 'barrier' }, new THREE.Vector3(laneX(0), 0.8, 40));
  await buildPlacement({ kind: 'boostPad' }, new THREE.Vector3(laneX(2), 0.13, 40));

  renderInspector();
  // Load + scene population succeeded: it's now safe to allow Save.
  loaded = true;
  saveBtn.disabled = false;
}

function frame(): void {
  requestAnimationFrame(frame);
  if (camTween) {
    camTween.t = Math.min(1, camTween.t + 0.08);
    const e = 1 - Math.pow(1 - camTween.t, 3);   // ease-out cubic
    camera.position.lerpVectors(camTween.fromPos, camTween.toPos, e);
    orbit.target.lerpVectors(camTween.fromTgt, camTween.toTgt, e);
    if (camTween.t >= 1) camTween = null;
  }
  orbit.update();
  renderer.render(scene, camera);
}

boot().catch((err) => {
  loaded = false;
  saveBtn.disabled = true;
  toast('Failed to load manifest — Save disabled');
  console.error(err);
});
requestAnimationFrame(frame);
