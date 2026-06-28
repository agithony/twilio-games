// client/level-scene.ts
// The editor's 3D viewport: loads the map GLB, builds the track surface, holds the gizmo, and lets
// the caller select/edit Map, Track, or a Prop. Reuses the align tool's proven modules. `current()`
// reads the live transforms back out so the bootstrap can serialize on Save.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { wrapMapScene, applyTrackTransform } from './map-world';
import { CurveEditor } from './align-curve';
import { AssetLoader } from './asset-loader';
import { buildCar } from './car-factory';
import { RACE_LEN, laneX, LANES } from '../shared/constants';
import { addProp as addPropPure, duplicateProp as dupPropPure, removeProp as rmPropPure,
         resolveCarScale, DEFAULT_LIGHTING, type PlacedProp } from '../shared/level';
import type { LevelConfig, LevelTransform } from '../shared/level';

export class LevelScene {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 50000);
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private loader = new GLTFLoader();
  private mapGroup = new THREE.Group();
  private trackGroup = new THREE.Group();
  private curve: CurveEditor | null = null;   // editable track ribbon (replaces the static surface)
  private level!: LevelConfig;
  // Editor-scene lights kept as fields so applyLighting/applyEffects can mirror level values onto
  // the live preview (full bloom/sky preview is verified by launching the game).
  private sun!: THREE.DirectionalLight;
  private ambient!: THREE.HemisphereLight;
  private changeCb: () => void = () => {};
  private propGroups = new Map<string, THREE.Group>();
  private selKey: 'map' | 'track' | string = 'track';
  private assets = new AssetLoader();
  private previewCars = new THREE.Group();
  private carPreviewOn = false;
  // Undo/redo: each entry is a full LevelConfig snapshot (current()'s serialization). `loaded` is
  // the level as last loaded, for Reset. We snapshot BEFORE a discrete edit (see beginEdit()).
  private undoStack: LevelConfig[] = [];
  private redoStack: LevelConfig[] = [];
  private loaded: LevelConfig | null = null;
  private sceneRadius = RACE_LEN;   // world extent (map bbox) — sizes the camera far plane so the
                                    // whole level stays visible at any zoom (recomputed on load).
  // Track point-editing (active only while the Track is selected): drag the green/red handles to
  // bend the curve, click empty ground (armed) to add a point, axis-lock to constrain a drag.
  private ray = new THREE.Raycaster();
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private draggingHandle = -1;
  private dragMoved = false;
  private downPx = { x: 0, y: 0 };
  private addArmed = false;
  private axisLock: 'none' | 'x' | 'z' = 'none';

  constructor(mount: HTMLElement) {
    // kick off car-template loading non-blocking; preview cars fall back to primitives until ready
    this.assets.loadManifest().catch(() => {});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    // Match the GAME renderer's material pipeline so "what you edit is what you play": ACES tone
    // mapping + sRGB output + an image-based environment map. Without these the GLB's PBR materials
    // render flat/washed-out (the textures appear to vanish).
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x223047);
    // Generated room environment so metalness/roughness PBR surfaces on the map GLB actually pick up
    // reflections instead of reading as flat plastic (same trick the game renderer uses).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.ambient = new THREE.HemisphereLight(0xbfd4ff, 0x303040, 1.0); this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff4e2, 2.1); this.sun.position.set(60, 110, 40); this.scene.add(this.sun);
    this.scene.add(new THREE.GridHelper(RACE_LEN * 2, 60, 0x44597f, 0x2c3a55));
    this.scene.add(this.mapGroup, this.trackGroup);

    const d = new DRACOLoader(); d.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    this.loader.setDRACOLoader(d);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true; this.orbit.minDistance = 0; this.orbit.maxDistance = Infinity;
    this.camera.position.set(RACE_LEN * 0.6, RACE_LEN * 0.5, -RACE_LEN * 0.3);
    this.orbit.target.set(0, 0, RACE_LEN / 2); this.orbit.update();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.scene.add(this.gizmo);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.orbit.enabled = !dragging;
      if (dragging) this.beginEdit();   // snapshot once at the start of a gizmo drag
    });
    this.gizmo.addEventListener('objectChange', () => this.changeCb());

    // Track point-editing pointer handlers — active only when the Track is selected (otherwise the
    // gizmo + orbit handle the canvas). Ported from the align tool: screen-space handle picking +
    // ground-plane drag, so you can grab/move/add/delete curve points directly in the viewport.
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (ev) => this.onTrackPointerDown(ev));
    el.addEventListener('pointermove', (ev) => this.onTrackPointerMove(ev));
    el.addEventListener('pointerup', () => this.onTrackPointerUp());
    el.addEventListener('pointerleave', () => this.onTrackPointerUp());

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
    this.loop();
  }

  onChange(cb: () => void): void { this.changeCb = cb; }

  // ── Undo / redo / reset ──────────────────────────────────────────────────────────────────────
  /** Snapshot the current state for undo BEFORE a discrete edit, and clear the redo branch. Call
   *  this at the start of any mutating action (gizmo drag, panel slider, curve button, prop op). */
  beginEdit(): void { this.undoStack.push(this.current()); this.redoStack.length = 0; }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  undo(): void {
    const prev = this.undoStack.pop(); if (!prev) return;
    this.redoStack.push(this.current());
    void this.loadLevel(structuredClone(prev), { keepHistory: true });
  }
  redo(): void {
    const next = this.redoStack.pop(); if (!next) return;
    this.undoStack.push(this.current());
    void this.loadLevel(structuredClone(next), { keepHistory: true });
  }
  /** Revert to the level exactly as it was last loaded (discarding all in-session tweaks). */
  resetToLoaded(): void {
    if (!this.loaded) return;
    this.beginEdit();
    void this.loadLevel(structuredClone(this.loaded), { keepHistory: true });
  }

  /** Mutable live level ref, so the inspector panels can read/write car scale etc. in place. */
  getLevel(): LevelConfig { return this.level; }

  /** The editable track curve (Track inspector buttons drive its setters), or null pre-load. */
  getCurve(): CurveEditor | null { return this.curve; }

  /**
   * Mirror the level's lighting onto the EDITOR preview scene (sun pos/intensity/color, hemisphere
   * ambient + sky/ground tint, exposure, sky background). Reads from a LOCAL fallback default and
   * NEVER writes back to this.level — per-level lighting is opt-in, gained only when the user edits a
   * lighting control (see level.ts onInput callbacks). Full bloom/sky-dome preview is verified by
   * launching the game.
   */
  applyLighting(): void {
    if (!this.level) return;
    const l = this.level.lighting ?? DEFAULT_LIGHTING;
    this.sun.position.set(l.sunPos[0]!, l.sunPos[1]!, l.sunPos[2]!);
    this.sun.intensity = l.sunIntensity;
    this.sun.color.set(l.sunColor);
    this.ambient.intensity = l.ambientIntensity;
    this.ambient.color.set(l.skyColor);
    this.ambient.groundColor.set(l.groundColor);
    this.renderer.toneMappingExposure = l.exposure;
    // NOTE: do NOT paint the scene background with skyColor — that floods the viewport and washes
    // the map's textures out to flat color. The editor keeps a neutral dark backdrop; the sky color
    // drives the hemisphere fill only (the game previews the real sky dome).
    this.changeCb();
  }

  /**
   * Mirror the level's effects onto the EDITOR preview scene. The editor scene has no composer/sky
   * dome, so we can only preview fog here (color + density via FogExp2); bloom/track-glow/pulse/sky
   * are previewed in-game. Reads from a LOCAL fallback default and NEVER writes back to this.level —
   * per-level effects are opt-in, gained only when the user edits an effects control.
   */
  applyEffects(): void {
    if (!this.level) return;
    // The editor deliberately does NOT apply fog. The game's fog density is tuned for SIM scale
    // (small coords), but the editor views the whole map — often scaled 100×+ — from far away, where
    // that density would fog the entire map to near-black and hide all textures. Fog (like bloom and
    // the sky dome) is previewed in-game; here we keep the map crisp for authoring.
    this.changeCb();
  }

  setCarPreview(on: boolean): void { this.carPreviewOn = on; this.applyCars(); }

  /** Whether sample-car preview is on — so a panel re-render can reflect the live toggle state. */
  carPreviewEnabled(): boolean { return this.carPreviewOn; }

  /**
   * (Re)build sample cars at the start of each lane, scaled by the level's resolved car scale.
   * CONTRACT: overrides are keyed by the car INDEX STRING ("0","1","2", …) — the same key the game
   * uses (cars are assigned by index), NOT a GLB filename. Keep this in lockstep with the cars panel.
   */
  applyCars(): void {
    this.previewCars.clear();
    if (!this.carPreviewOn) return;
    for (let lane = 0; lane < LANES; lane++) {
      const tmpl = this.assets.carTemplate(lane);
      const model = buildCar(tmpl ?? null, '#36d1dc', false);
      const wrap = new THREE.Group(); wrap.add(model);
      const s = resolveCarScale(this.level, String(lane));
      wrap.scale.setScalar(s);
      wrap.position.set(laneX(lane), 0.6, 20);
      this.previewCars.add(wrap);
    }
    this.changeCb();
  }

  async loadLevel(level: LevelConfig, opts?: { keepHistory?: boolean }): Promise<void> {
    this.level = level;
    // A fresh load (dropdown/New) establishes the Reset baseline + clears history. Undo/redo/reset
    // reloads pass keepHistory so they don't clobber the stacks they're navigating.
    if (!opts?.keepHistory) {
      this.loaded = structuredClone(level);
      this.undoStack.length = 0; this.redoStack.length = 0;
    }
    // reset groups
    this.mapGroup.clear(); this.trackGroup.clear();
    // map GLB
    await new Promise<void>((res) => {
      this.loader.load(`/assets/maps/${level.file}`, (g) => {
        const wrap = wrapMapScene(g.scene); this.mapGroup.add(wrap);
        applyTrackTransform(this.mapGroup, level.model);
        // Measure the placed map's world extent so the camera far-plane can always contain it
        // (a 200×-scaled map spans tens of thousands of units — a fixed far clips the distance).
        const sphere = new THREE.Box3().setFromObject(this.mapGroup).getBoundingSphere(new THREE.Sphere());
        this.sceneRadius = Math.max(RACE_LEN, sphere.radius * 2 + sphere.center.length());
        res();
      }, undefined, () => res());
    });
    // track surface — an editable CurveEditor (the Track inspector bends it) instead of a static
    // mesh, so what you author here is exactly what races. It rides the track transform.
    applyTrackTransform(this.trackGroup, level.track);
    this.curve = new CurveEditor(level.path);
    this.trackGroup.add(this.curve.group);
    // props ride the track transform like the surface
    this.propGroups.clear();
    for (const p of level.props) this.spawnProp(p);
    // sample cars (editor-only preview) ride the track transform like the surface/props
    this.trackGroup.add(this.previewCars);
    this.applyCars();
    // mirror any saved lighting/effects onto the editor scene (no-op-safe when unset)
    this.applyLighting();
    this.applyEffects();
    this.select('track');
  }

  // helper to instantiate one prop group
  private spawnProp(p: PlacedProp): void {
    this.loader.load(`/assets/${p.file}`, (g) => {
      const grp = new THREE.Group(); grp.add(g.scene);
      grp.position.set(p.pos[0]!, p.pos[1]!, p.pos[2]!);
      grp.rotation.set(p.rotDeg[0]! * Math.PI/180, p.rotDeg[1]! * Math.PI/180, p.rotDeg[2]! * Math.PI/180);
      grp.scale.setScalar(p.scale);
      grp.userData.propId = p.id;
      this.trackGroup.add(grp);            // props ride the track transform like the surface
      this.propGroups.set(p.id, grp);
    }, undefined, () => { /* skip failed prop */ });
  }

  // add a prop from the library at the track start (sim z≈40, lane center)
  addProp(file: string): string {
    this.level = addPropPure(this.level, file, [0, 0, 40]);
    const p = this.level.props[this.level.props.length - 1]!;
    this.spawnProp(p);
    this.select(p.id);
    return p.id;
  }

  duplicateSelectedProp(): string | null {
    if (this.selKey === 'map' || this.selKey === 'track') return null;
    this.level = dupPropPure(this.level, this.selKey);
    const p = this.level.props[this.level.props.length - 1]!;
    this.spawnProp(p);
    this.select(p.id);
    return p.id;
  }

  removeSelectedProp(): void {
    if (this.selKey === 'map' || this.selKey === 'track') return;
    const g = this.propGroups.get(this.selKey);
    if (g) { this.trackGroup.remove(g); this.propGroups.delete(this.selKey); }
    this.level = rmPropPure(this.level, this.selKey);
    this.select('track');
  }

  selectedKey(): 'map' | 'track' | string { return this.selKey; }

  select(key: 'map' | 'track' | string): void {
    this.selKey = key;
    // Map / props use the gizmo (move/rotate/scale the whole object). The TRACK is edited by its
    // curve POINTS (drag handles in the viewport), so the gizmo is detached while Track is selected
    // — otherwise its handles would intercept the clicks meant for the control-point dots.
    if (key === 'track') this.gizmo.detach();
    else if (key === 'map') this.gizmo.attach(this.mapGroup);
    else { const g = this.propGroups.get(key); if (g) this.gizmo.attach(g); else this.gizmo.detach(); }
    this.addArmed = false;   // dropping selection cancels any pending add
    this.changeCb();
  }

  // ── Track point-editing public API (Track inspector wires buttons to these) ───────────────────
  /** Arm "add point": the next click on empty ground drops a control point there. */
  armAddPoint(on: boolean): void { this.addArmed = on; this.changeCb(); }
  isAddArmed(): boolean { return this.addArmed; }
  /** Delete the selected control point (false if none/endpoint selected — caller shows a hint). */
  deleteSelectedPoint(): boolean {
    if (!this.curve) return false;
    this.beginEdit();
    const ok = this.curve.removeSelected();
    if (!ok) { this.undoStack.pop(); }   // nothing removed → don't keep the snapshot
    this.changeCb();
    return ok;
  }
  /** Extend/trim an end of the track along its direction (dist>0 extend, <0 trim). */
  extendTrackEnd(which: 'start' | 'end', dist: number): void {
    if (!this.curve) return;
    this.beginEdit(); this.curve.extendEnd(which, dist); this.changeCb();
  }
  /** Constrain handle drags / arrow nudges to one ground axis ('none' frees both). */
  setAxisLock(a: 'none' | 'x' | 'z'): void { this.axisLock = a; this.changeCb(); }
  axisLockMode(): 'none' | 'x' | 'z' { return this.axisLock; }

  // ── Track pointer interaction (only when the Track is selected) ───────────────────────────────
  private ndc(ev: PointerEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1,
                             -((ev.clientY - r.top) / r.height) * 2 + 1);
  }
  /** Ground-plane (y=0) hit for a pointer, converted into the curve's local (trackGroup) space. */
  private groundLocal(ev: PointerEvent): THREE.Vector3 | null {
    this.ray.setFromCamera(this.ndc(ev), this.camera);
    const hit = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.dragPlane, hit)) return null;
    return this.trackGroup.worldToLocal(hit);
  }
  /** Screen-space proximity pick of the nearest control-point handle (forgiving for tiny dots). */
  private pickHandle(ev: PointerEvent): THREE.Object3D | null {
    if (!this.curve) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    let best: THREE.Object3D | null = null, bestD = 26, v = new THREE.Vector3();
    for (const h of this.curve.handleMeshes()) {
      h.getWorldPosition(v).project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * r.width, sy = (-v.y * 0.5 + 0.5) * r.height;
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }
  private onTrackPointerDown(ev: PointerEvent): void {
    if (this.selKey !== 'track' || !this.curve || this.gizmo.dragging) return;
    // Armed add: drop a point exactly where you clicked on the ground.
    if (this.addArmed) {
      const local = this.groundLocal(ev);
      if (local) { this.beginEdit(); this.curve.addPointAt(local.x, local.z); this.addArmed = false; this.changeCb(); }
      return;
    }
    // Grab a handle (or near one) → start a potential drag; snapshot now, discard if it's a pure click.
    const handle = this.pickHandle(ev);
    if (handle) {
      this.beginEdit();
      this.draggingHandle = this.curve.beginDrag(handle);
      this.dragMoved = false; this.downPx = { x: ev.clientX, y: ev.clientY };
      this.orbit.enabled = false; this.changeCb();
    }
  }
  private onTrackPointerMove(ev: PointerEvent): void {
    if (this.draggingHandle < 0 || !this.curve) return;
    if (!this.dragMoved && Math.hypot(ev.clientX - this.downPx.x, ev.clientY - this.downPx.y) < 3) return;
    const local = this.groundLocal(ev); if (!local) return;
    this.dragMoved = true;
    const cur = this.curve.pointAt(this.draggingHandle);
    let x = local.x, z = local.z;
    if (this.axisLock === 'x' && cur) z = cur.z;
    if (this.axisLock === 'z' && cur) x = cur.x;
    this.curve.dragTo(this.draggingHandle, x, z);
    this.changeCb();
  }
  private onTrackPointerUp(): void {
    if (this.draggingHandle < 0) return;
    if (!this.dragMoved) this.undoStack.pop();   // pure click (select), not an edit → drop snapshot
    this.draggingHandle = -1; this.orbit.enabled = true; this.changeCb();
  }

  /** Read the live scene transforms back into a LevelConfig for saving. */
  current(): LevelConfig {
    const t = (o: THREE.Object3D): LevelTransform => ({
      pos: o.position.toArray().map(n => Math.round(n * 1000) / 1000),
      rotDeg: [o.rotation.x, o.rotation.y, o.rotation.z].map(r => Math.round(r * 180 / Math.PI)),
      scale: Math.round(o.scale.x * 1000) / 1000,
    });
    const props: PlacedProp[] = this.level.props.map(p => {
      const g = this.propGroups.get(p.id);
      return g ? { ...p, ...t(g) } : p;
    });
    // Persist the live curve as the level path; lighting/effects are spread from this.level and are
    // present ONLY if the user edited a lighting/effects control (opt-in), so an untouched level
    // saves without them and keeps in-game zone cycling.
    return { ...this.level, model: t(this.mapGroup), track: t(this.trackGroup),
             path: this.curve ? this.curve.toPath() : this.level.path, props };
  }

  private loop(): void {
    requestAnimationFrame(() => this.loop());
    this.orbit.update();
    // Far plane must contain the WHOLE level (scene radius) AND whatever's beyond the camera at the
    // current zoom — so distant terrain never clips, whether zoomed in on the track or way out.
    const dist = this.camera.position.distanceTo(this.orbit.target);
    this.camera.far = Math.max(2000, dist + this.sceneRadius * 2.5);
    this.camera.near = Math.max(0.05, dist / 5000);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }
}
