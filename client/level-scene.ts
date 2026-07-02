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
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { wrapMapScene, applyTrackTransform } from './map-world';
import { CurveEditor } from './align-curve';
import { AssetLoader, stripDisplayBases } from './asset-loader';
import { autoFitScale } from '../shared/asset-fit';
import { buildCar } from './car-factory';
import { makeSkyDome, setSkyColors } from './sky-dome';
import { RACE_LEN, TRACK_W, laneX, LANES, TRACK_SURFACE_LIFT,
         HOVER_HEIGHT, HOVER_BOB, HOVER_BOB_SPEED, HOVER_SPIN } from '../shared/constants';
import { addProp as addPropPure, duplicateProp as dupPropPure, removeProp as rmPropPure,
         resolveCarScale, resolveItemScale, resolveCamera, DEFAULT_LIGHTING, DEFAULT_EFFECTS, type PlacedProp } from '../shared/level';
import type { LevelConfig, LevelTransform, ResolvedCamera } from '../shared/level';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

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
  private sky!: THREE.Mesh;                 // shared gradient sky dome (same as the game)
  private composer!: EffectComposer;        // post FX so bloom previews exactly like the game
  private bloom!: UnrealBloomPass;
  private sunDir = new THREE.Vector3(-180, 70, -120).normalize();
  private changeCb: () => void = () => {};
  private propGroups = new Map<string, THREE.Group>();
  private selKey: 'map' | 'track' | string = 'track';
  private assets = new AssetLoader();
  private previewCars = new THREE.Group();
  private carPreviewOn = false;
  // Which car MODEL the Cars panel is focused on (dropdown). The editor shows just this one car at
  // its resolved per-level size, so you can see exactly what you're scaling. null = none selected yet.
  private selectedCarFile: string | null = null;
  // ── Per-level camera preview ──────────────────────────────────────────────────────────────────
  // gameCam mirrors what the GAME camera will be for this level (built from resolveCamera). camHelper
  // draws its frustum (the "vision cone"); camIcon is the draggable body (fixed mode); previewOn
  // renders a small inset from gameCam so you see the in-game framing live.
  private gameCam = new THREE.PerspectiveCamera(46, 16 / 9, 0.5, 6000);
  private camHelper: THREE.CameraHelper | null = null;
  private camIcon = new THREE.Group();
  private camPreviewOn = true;
  // Obstacle/boost preview: a sample barrier + boost on the track, sized by the per-level scale, so
  // you can see and tune how big they'll be in-game. On by default so obstacles are visible.
  private previewObstacles = new THREE.Group();
  private obstaclePreviewOn = true;
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
  // Start/finish gantry models — ALWAYS shown (matching the game), so the editor preview includes
  // them. They ride trackGroup and are re-placed onto the live curve each frame (handles dragging).
  private lineGroup = new THREE.Group();
  private startGantry: THREE.Object3D | null = null;
  private finishGantry: THREE.Object3D | null = null;

  constructor(mount: HTMLElement) {
    // kick off car-template loading non-blocking; preview cars fall back to primitives until ready.
    // When it resolves, refresh the car/obstacle previews + notify (so the Cars panel lists models
    // and samples upgrade from primitive to real models) — avoids a stale empty list at boot.
    this.assets.loadManifest().then(() => { this.applyCars(); this.applyObstacles(); this.changeCb(); }).catch(() => {});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    // Match the GAME renderer's material pipeline so "what you edit is what you play": ACES tone
    // mapping + sRGB output + an image-based environment map. Without these the GLB's PBR materials
    // render flat/washed-out (the textures appear to vanish).
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(this.renderer.domElement);
    // Generated room environment so metalness/roughness PBR surfaces on the map GLB actually pick up
    // reflections instead of reading as flat plastic (same trick the game renderer uses).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    // Same pieces the GAME renders, so the editor preview matches exactly: gradient sky dome, fog,
    // hemisphere + a shadow-casting sun. Sky/fog/ambient/exposure are all driven by applyLighting/
    // applyEffects below from the level's own values.
    this.scene.fog = new THREE.FogExp2(0x0b1020, 0.0016);
    this.sky = makeSkyDome(); this.scene.add(this.sky);
    this.ambient = new THREE.HemisphereLight(0xbfd4ff, 0x303040, 1.0); this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff4e2, 2.1); this.sun.position.set(60, 110, 40);
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -90; sc.right = 90; sc.top = 160; sc.bottom = -160; sc.near = 1; sc.far = 1200; sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new THREE.GridHelper(RACE_LEN * 2, 60, 0x44597f, 0x2c3a55));
    this.scene.add(this.mapGroup, this.trackGroup);

    const d = new DRACOLoader(); d.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    this.loader.setDRACOLoader(d);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    // Effectively infinite zoom: no min dolly distance (tiny epsilon avoids a divide-by-zero in
    // OrbitControls' math), no max. The per-frame near-plane (see loop) shrinks with distance so
    // geometry never clips as you push right up to a surface.
    this.orbit.enableDamping = true; this.orbit.minDistance = 1e-4; this.orbit.maxDistance = Infinity;
    // Scroll-zoom toward the cursor (not just the orbit target), so you can zoom into a model that's
    // far from the current pivot — the common case on a huge 200x-scaled map.
    this.orbit.zoomToCursor = true;
    this.camera.position.set(RACE_LEN * 0.6, RACE_LEN * 0.5, -RACE_LEN * 0.3);
    this.orbit.target.set(0, 0, RACE_LEN / 2); this.orbit.update();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.scene.add(this.gizmo);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.orbit.enabled = !dragging;
      if (dragging) this.beginEdit();   // snapshot once at the start of a gizmo drag
    });
    this.gizmo.addEventListener('objectChange', () => {
      // Editing a gantry via the gizmo "pins" it (manual), so the per-frame auto-placement
      // stops moving it and current() persists its transform.
      if (this.selKey === 'startLine' && this.startGantry) this.startGantry.userData.manual = true;
      if (this.selKey === 'finishLine' && this.finishGantry) this.finishGantry.userData.manual = true;
      this.changeCb();
    });

    // Track point-editing pointer handlers — active only when the Track is selected (otherwise the
    // gizmo + orbit handle the canvas). Ported from the align tool: screen-space handle picking +
    // ground-plane drag, so you can grab/move/add/delete curve points directly in the viewport.
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (ev) => this.onTrackPointerDown(ev));
    el.addEventListener('pointermove', (ev) => this.onTrackPointerMove(ev));
    el.addEventListener('pointerup', () => this.onTrackPointerUp());
    el.addEventListener('pointerleave', () => this.onTrackPointerUp());

    // Post-processing chain identical to the game so bloom previews 1:1.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.45, 0.7, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.composer.setSize(innerWidth, innerHeight);
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

  /** Set the live level data WITHOUT the async 3D reload, so the editor's tree/panel can render
   *  immediately (and current()/getLevel() are valid) while loadLevel() populates the 3D preview in
   *  the background. Ensures a curve exists so current() can serialize even before the GLB lands. */
  setLevel(level: LevelConfig): void {
    this.level = level;
    if (!this.curve) this.curve = new CurveEditor(level.path);
  }

  /** Measure a map GLB and return a good STARTING model scale so its footprint ≈ the track length —
   *  a sane initial size for a brand-new level (the fixed default only suited tiny models; large
   *  track GLBs ×20 rendered off-screen/inside the mesh). Returns null on load failure (keep default). */
  async measureMapScale(file: string): Promise<number | null> {
    return new Promise((resolve) => {
      this.loader.load(`/assets/maps/${file}`, (g) => {
        const wrap = wrapMapScene(g.scene);   // recenter like the real placement
        const size = new THREE.Box3().setFromObject(wrap).getSize(new THREE.Vector3());
        // Fit the model's largest dimension to the full driven length, so the whole track frames up.
        resolve(autoFitScale([size.x, size.y, size.z], RACE_LEN) || 1);
      }, undefined, () => resolve(null));
    });
  }

  /** Capture the CURRENT editor view as this level's map-select PREVIEW shot — eye + look-target in
   *  world space (the same space renderMapThumbnail places the map in, so the tile frames identically).
   *  Stored on this.level so current() persists it on save. */
  capturePreviewShot(): void {
    if (!this.level) return;
    const eye = this.camera.position, tgt = this.orbit.target;
    const round = (n: number) => Math.round(n * 100) / 100;
    this.level.previewCam = {
      pos: [round(eye.x), round(eye.y), round(eye.z)],
      lookAt: [round(tgt.x), round(tgt.y), round(tgt.z)],
      fov: Math.round(this.camera.fov),
    };
  }
  /** Forget a saved preview shot → the map-select tile reverts to the auto establishing shot. */
  clearPreviewShot(): void { if (this.level) delete this.level.previewCam; }
  /** Whether this level currently has a custom preview shot (for the button label). */
  hasPreviewShot(): boolean { return !!this.level?.previewCam; }

  /** The editable track curve (Track inspector buttons drive its setters), or null pre-load. */
  getCurve(): CurveEditor | null { return this.curve; }

  /** The live three.js scene (for in-browser debugging / headless smoke introspection). */
  getScene(): THREE.Scene { return this.scene; }
  /** The editor camera (for in-browser debugging / headless smoke introspection). */
  getCamera(): THREE.PerspectiveCamera { return this.camera; }
  /** Current camera→orbit-target distance (zoom level) — debug/smoke introspection. */
  getOrbitDistance(): number { return this.camera.position.distanceTo(this.orbit.target); }

  /**
   * Mirror the level's lighting onto the editor scene — using the SAME pipeline as the game (sun as
   * a raking direction, hemisphere fill, sky-dome top color, exposure), so the preview matches what
   * you'll play. Reads a LOCAL fallback default and never writes back (lighting stays opt-in).
   */
  applyLighting(): void {
    if (!this.level) return;
    const l = this.level.lighting ?? DEFAULT_LIGHTING;
    this.sunDir.set(l.sunPos[0]!, l.sunPos[1]!, l.sunPos[2]!).normalize();
    this.sun.intensity = l.sunIntensity;
    this.sun.color.set(l.sunColor);
    this.ambient.intensity = l.ambientIntensity;
    this.ambient.color.set(l.skyColor);
    this.ambient.groundColor.set(l.groundColor);
    this.renderer.toneMappingExposure = l.exposure;
    setSkyColors(this.sky, l.skyColor, this.level.effects?.skyBottom ?? DEFAULT_EFFECTS.skyBottom);
    this.changeCb();
  }

  /**
   * Mirror the level's effects onto the editor scene with the real pipeline: bloom (composer), fog
   * (FogExp2), sky-dome top/bottom, and the track-glow factor (rebuilds the surface). What you tune
   * here is exactly what the game renders. Opt-in: reads a local default, never writes back.
   */
  applyEffects(): void {
    if (!this.level) return;
    const e = this.level.effects ?? DEFAULT_EFFECTS;
    this.bloom.strength = e.bloom.strength;
    this.bloom.radius = e.bloom.radius;
    this.bloom.threshold = e.bloom.threshold;
    const fog = this.scene.fog as THREE.FogExp2;
    fog.density = e.fog.density; fog.color.set(e.fog.color);
    setSkyColors(this.sky, this.level.lighting?.skyColor ?? DEFAULT_LIGHTING.skyColor, e.skyBottom);
    this.curve?.setGlow(e.trackEmissive);   // track-glow changed → rebuild lane materials
    this.changeCb();
  }

  setCarPreview(on: boolean): void { this.carPreviewOn = on; this.applyCars(); }

  /** Whether sample-car preview is on — so a panel re-render can reflect the live toggle state. */
  carPreviewEnabled(): boolean { return this.carPreviewOn; }
  /** The manifest car-model filenames (the keys per-level car-scale overrides use). May be empty
   *  until the manifest finishes loading; the Cars panel re-renders on change. */
  carModelFiles(): string[] { return this.assets.carFiles(); }

  /** Which car model the editor is previewing (the Cars-panel dropdown), defaulting to the first. */
  selectedCarModel(): string | null {
    if (this.selectedCarFile) return this.selectedCarFile;
    return this.assets.carFiles()[0] ?? null;
  }
  /** Focus the editor preview on one car model (from the Cars-panel dropdown). */
  setSelectedCarModel(file: string): void { this.selectedCarFile = file; this.applyCars(); }

  /**
   * Show ONE car — the model selected in the Cars panel — at its resolved per-level size, centered
   * on the track, so you can see exactly what you're scaling. Overrides are keyed by the car model
   * FILENAME (the same key the game uses). Older "3 cars per lane" preview is gone — it couldn't
   * show the 16 models past lane 3.
   */
  applyCars(): void {
    this.previewCars.clear();
    if (!this.carPreviewOn) return;
    const file = this.selectedCarModel();
    const tmpl = file ? this.assets.carTemplateByFile(file) : null;
    const model = buildCar(tmpl ?? null, '#36d1dc', false);
    const wrap = new THREE.Group(); wrap.add(model);
    wrap.scale.setScalar(file ? resolveCarScale(this.level, file) : this.level.cars.masterScale);
    this.previewCars.add(wrap);
    this.placePreviewCars();
    this.changeCb();
  }

  /** Position the single preview car centered down-track (curve-aware), re-placed each frame. */
  private placePreviewCars(): void {
    const SAMPLE_Z = 20;
    const curve = this.curve?.curve();
    for (const wrap of this.previewCars.children) {
      if (curve) {
        const p = curve.sample(SAMPLE_Z, 0);
        wrap.position.set(p.pos.x, p.pos.y + TRACK_SURFACE_LIFT, p.pos.z);
        // Match the game: yaw then pitch (Euler 'YXZ') so the preview car tips with the slope too.
        wrap.rotation.set(-p.pitch, p.headingY, 0, 'YXZ');
      } else {
        wrap.position.set(0, TRACK_SURFACE_LIFT, SAMPLE_Z); wrap.rotation.set(0, 0, 0);
      }
    }
  }

  setObstaclePreview(on: boolean): void { this.obstaclePreviewOn = on; this.applyObstacles(); }
  obstaclePreviewEnabled(): boolean { return this.obstaclePreviewOn; }

  /** Build the sample barrier + boost preview, sized by the per-level scale the SAME way the game
   *  does (clone the auto-fit template, multiply by resolveItemScale). Called on load + on edits. */
  applyObstacles(): void {
    this.previewObstacles.clear();
    if (!this.obstaclePreviewOn) return;
    const make = (kind: 'barrier' | 'boost', lane: number, primitive: THREE.Object3D) => {
      const tmpl = kind === 'barrier' ? this.assets.barrierTemplate() : this.assets.boostTemplate();
      const model = tmpl ? skeletonClone(tmpl) : primitive;   // primitive fallback = game parity
      const inner = new THREE.Group(); inner.add(model);
      inner.scale.setScalar(resolveItemScale(this.level, kind));
      const wrap = new THREE.Group(); wrap.add(inner);
      wrap.userData.lane = lane; wrap.userData.kind = kind;
      // A real boost model hovers above the track (matches the game); tag it so the loop bobs it.
      if (kind === 'boost' && tmpl) wrap.userData.hover = true;
      this.previewObstacles.add(wrap);
    };
    // A barrier in lane 0 and a boost in lane 2, a bit further down-track than the sample cars.
    make('barrier', 0, new THREE.Mesh(new THREE.BoxGeometry(6.5, 1.6, 1.2),
      new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0x550000 })));
    make('boost', 2, new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.25, 20),
      new THREE.MeshStandardMaterial({ color: 0x36e08a, emissive: 0x0a5a32 })));
    this.placePreviewObstacles();
    this.changeCb();
  }

  /** Position the obstacle/boost preview onto the live curve (further down-track than the cars).
   *  Boost orbs tagged hover bob + spin around HOVER_HEIGHT, using the SAME shared constants as the
   *  game (renderer.ts) so the preview matches. `dt` (real seconds) keeps the spin frame-rate
   *  independent like the game; defaults so the one-off call in applyObstacles still works. */
  private placePreviewObstacles(dt = 1 / 60): void {
    const SAMPLE_Z = 70;
    const curve = this.curve?.curve();
    const laneScale = this.curve?.laneScale ?? 1;
    for (const wrap of this.previewObstacles.children) {
      const lane = (wrap.userData.lane as number) ?? 0;
      // primitives carry their own ground height; templates self-ground (wrapper y handled by lift)
      if (curve) {
        const p = curve.sample(SAMPLE_Z, laneX(lane) * laneScale);
        wrap.position.set(p.pos.x, p.pos.y + 0.6, p.pos.z);
        wrap.rotation.y = p.headingY;
      } else {
        wrap.position.set(laneX(lane), 0.6, SAMPLE_Z); wrap.rotation.y = 0;
      }
      if (wrap.userData.hover) {
        const inner = wrap.children[0] as THREE.Object3D | undefined;
        if (inner) {
          inner.position.y = HOVER_HEIGHT + Math.sin(this.loopClock * HOVER_BOB_SPEED * Math.PI * 2) * HOVER_BOB;
          inner.rotation.y += dt * HOVER_SPIN;   // real-dt spin = frame-rate-independent, matches game
        }
      }
    }
  }

  // ── Per-level camera (preview cone + live inset) ──────────────────────────────────────────────
  /** Representative car z the chase-cam frames in the editor (mid of the first stretch). */
  private static readonly CAM_PREVIEW_Z = 60;

  setCameraPreview(on: boolean): void { this.camPreviewOn = on; this.changeCb(); }
  cameraPreviewEnabled(): boolean { return this.camPreviewOn; }
  /** The resolved level camera (mode + params), for the inspector to read/edit. */
  resolvedCamera(): ResolvedCamera { return resolveCamera(this.level); }

  /** (Re)build the camera cone + icon + inset to reflect the level's current camera config. Called
   *  on load and whenever a camera control changes. */
  applyCamera(): void {
    // FOV mirrors the game so the cone + inset match what will actually render.
    const cam = resolveCamera(this.level);
    this.gameCam.fov = cam.fov; this.gameCam.updateProjectionMatrix();
    // Build the frustum helper + a small camera-body icon once; both ride trackGroup like the race.
    if (!this.camHelper) {
      this.camHelper = new THREE.CameraHelper(this.gameCam);
      this.scene.add(this.camHelper);   // helper reads gameCam's world matrix; keep it in world space
      // simple camera body icon: a little box + lens cone
      const body = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 6),
        new THREE.MeshBasicMaterial({ color: 0x36d1dc }));
      const lens = new THREE.Mesh(new THREE.ConeGeometry(2, 4, 16),
        new THREE.MeshBasicMaterial({ color: 0x0b1020 }));
      lens.rotation.x = -Math.PI / 2; lens.position.z = 4;
      this.camIcon.add(body, lens);
    }
    this.trackGroup.add(this.camIcon);   // re-parent after a loadLevel trackGroup.clear() (idempotent)
    this.placeGameCam();
    this.camHelper.visible = this.camPreviewOn;
    this.camIcon.visible = this.camPreviewOn;
    this.changeCb();
  }

  /** Pose gameCam (and the icon) using the SAME math as the game renderer, so the cone/inset show
   *  exactly the in-game framing. Chase uses a representative car at CAM_PREVIEW_Z; fixed uses pos. */
  private placeGameCam(): void {
    const cam = resolveCamera(this.level);
    const curve = this.curve?.curve();
    const laneScale = this.curve?.laneScale ?? 1;
    if (cam.mode === 'fixed' && cam.pos && cam.lookAt) {
      const [px, py, pz] = cam.pos as [number, number, number];
      const [lx, ly, lz] = cam.lookAt as [number, number, number];
      if (curve) {
        const eye = curve.sample(pz, px), look = curve.sample(lz, lx);
        this.gameCam.position.set(eye.pos.x, eye.pos.y + py, eye.pos.z);
        this.gameCam.lookAt(look.pos.x, look.pos.y + ly, look.pos.z);
      } else {
        this.gameCam.position.set(px, py, pz); this.gameCam.lookAt(lx, ly, lz);
      }
    } else {
      const z = LevelScene.CAM_PREVIEW_Z;
      if (curve) {
        const eye = curve.sample(z - cam.behind, cam.lateral * laneScale);
        const look = curve.sample(z + cam.lookAhead, 0);
        this.gameCam.position.set(eye.pos.x, eye.pos.y + cam.height, eye.pos.z);
        this.gameCam.lookAt(look.pos.x, look.pos.y + cam.lookHeight, look.pos.z);
      } else {
        this.gameCam.position.set(cam.lateral, cam.height, z - cam.behind);
        this.gameCam.lookAt(0, cam.lookHeight, z + cam.lookAhead);
      }
    }
    this.gameCam.updateMatrixWorld();
    // The icon: trackGroup-LOCAL pose. gameCam is parented to the scene (world), trackGroup may carry
    // a transform — convert the world eye into trackGroup-local so the icon sits at the camera.
    this.camIcon.position.copy(this.trackGroup.worldToLocal(this.gameCam.position.clone()));
    this.camIcon.quaternion.copy(this.gameCam.quaternion);   // good enough visually for the body
    this.camHelper?.update();
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
    // map GLB — resolve on success OR error OR a timeout, so a slow/stalled GLB (or DRACO decode)
    // can NEVER hang loadLevel forever (which would freeze the rest of the editor setup). The tree/
    // panel already rendered before this ran (see level.ts refresh), so the UI stays usable regardless.
    await new Promise<void>((res) => {
      let done = false;
      const finish = () => { if (!done) { done = true; res(); } };
      const timer = setTimeout(finish, 12000);   // safety net: don't wait on a wedged load forever
      this.loader.load(`/assets/maps/${level.file}`, (g) => {
        clearTimeout(timer);
        const wrap = wrapMapScene(g.scene); this.mapGroup.add(wrap);
        applyTrackTransform(this.mapGroup, level.model);
        // Measure the placed map's world extent so the camera far-plane can always contain it
        // (a 200×-scaled map spans tens of thousands of units — a fixed far clips the distance).
        const sphere = new THREE.Box3().setFromObject(this.mapGroup).getBoundingSphere(new THREE.Sphere());
        this.sceneRadius = Math.max(RACE_LEN, sphere.radius * 2 + sphere.center.length());
        finish();
      }, undefined, () => { clearTimeout(timer); finish(); });
    });
    // track surface — an editable CurveEditor (the Track inspector bends it) instead of a static
    // mesh, so what you author here is exactly what races. It rides the track transform.
    applyTrackTransform(this.trackGroup, level.track);
    this.curve = new CurveEditor(level.path);
    this.trackGroup.add(this.curve.group);
    // Start/finish gantry models bookend the track (same as the game). They ride trackGroup and
    // are placed onto the curve at z=0 / z=RACE_LEN, re-placed each frame so they track edits.
    this.buildGantries();
    // props ride the track transform like the surface
    this.propGroups.clear();
    for (const p of level.props) this.spawnProp(p);
    // sample cars (editor-only preview) ride the track transform like the surface/props
    this.trackGroup.add(this.previewCars);
    this.applyCars();
    // sample obstacle + boost preview (sized by the per-level scale) ride the track too
    this.trackGroup.add(this.previewObstacles);
    this.applyObstacles();
    // mirror any saved lighting/effects onto the editor scene (no-op-safe when unset)
    this.applyLighting();
    this.applyEffects();
    // per-level camera: build the cone/icon and pose gameCam from the level's camera config
    this.applyCamera();
    this.select('track');
  }

  // ── Start / Finish gantries (editor preview mirror of the game's setStartFinishLines) ──────────
  /** (Re)build the start (z=0) + finish (z=RACE_LEN) gantry models into lineGroup on trackGroup. */
  private buildGantries(): void {
    this.lineGroup.clear();
    this.startGantry = null; this.finishGantry = null;
    this.trackGroup.add(this.lineGroup);
    this.loadGantry('starting_line.glb', 0, (g) => { this.startGantry = g; });
    this.loadGantry('finish_line.glb', RACE_LEN, (g) => { this.finishGantry = g; });
  }

  /** Gantry auto-fit width target — IDENTICAL formula to the game renderer (track-width aware) so
   *  the editor preview matches what races. */
  private gantryTarget(): number {
    const laneScale = this.curve?.laneScale ?? 1;
    const shoulder = this.curve?.shoulder ?? 0;
    return TRACK_W * laneScale + 2 * shoulder + 8;
  }

  private loadGantry(file: string, z: number, assign: (g: THREE.Object3D) => void): void {
    this.loader.load(`/assets/${file}`, (gltf) => {
      const model = gltf.scene;
      stripDisplayBases(model);
      // Auto-fit so its widest axis spans a little past the track, then ground + center it.
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3(); box.getSize(size);
      model.scale.setScalar(autoFitScale([size.x, size.y, size.z], this.gantryTarget()));
      const box2 = new THREE.Box3().setFromObject(model);
      const c = new THREE.Vector3(); box2.getCenter(c);
      model.position.x += -c.x; model.position.z += -c.z; model.position.y += -box2.min.y;
      model.traverse(o => { (o as THREE.Mesh).castShadow = true; });
      const wrapper = new THREE.Group(); wrapper.add(model); wrapper.userData.lineZ = z;
      // Apply a saved authoring offset (absolute wrapper transform): mark manual so the per-frame
      // auto-placement leaves it where the author put it.
      const off = z === 0 ? this.level?.startLine : this.level?.finishLine;
      if (off) {
        wrapper.userData.manual = true;
        if (off.pos) wrapper.position.set(off.pos[0]!, off.pos[1]!, off.pos[2]!);
        if (off.rotDeg) wrapper.rotation.set(off.rotDeg[0]! * Math.PI/180, off.rotDeg[1]! * Math.PI/180, off.rotDeg[2]! * Math.PI/180);
        if (off.scale !== undefined) wrapper.scale.setScalar(off.scale);
      }
      this.lineGroup.add(wrapper);
      assign(wrapper);
      this.placeGantries();
      // If this gantry is the current selection (user clicked it before the GLB resolved),
      // attach the gizmo now so it becomes editable without re-clicking.
      if ((z === 0 && this.selKey === 'startLine') || (z === RACE_LEN && this.selKey === 'finishLine')) {
        this.gizmo.attach(wrapper); this.changeCb();
      }
    }, undefined, () => { /* missing model: no gantry, no crash */ });
  }

  /** Position the AUTO (un-edited) gantries onto the live curve (z=0 start, z=RACE_LEN finish).
   *  A gantry the user has edited (userData.manual) is left at its saved transform; a gantry being
   *  dragged (selected) is owned by the gizmo. Cheap; called per-frame. */
  private placeGantries(): void {
    const curve = this.curve?.curve();
    for (const [w, key] of [[this.startGantry, 'startLine'], [this.finishGantry, 'finishLine']] as const) {
      if (!w) continue;
      if (this.selKey === key) continue;   // selected: the gizmo owns it; don't fight the drag
      if (w.userData.manual) continue;     // user-positioned: keep its saved transform
      const z = (w.userData.lineZ as number) ?? 0;
      if (curve) {
        const p = curve.sample(z, 0);
        w.position.set(p.pos.x, p.pos.y + 0.6, p.pos.z);
        w.rotation.set(0, p.headingY, 0);
      } else {
        w.position.set(0, 0, z); w.rotation.set(0, 0, 0);
      }
    }
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

  /** Keys in the tree that are NOT user props (no duplicate/delete). */
  private isNonPropKey(key: string): boolean {
    return key === 'map' || key === 'track' || key === 'level'
      || key === 'startLine' || key === 'finishLine';
  }

  duplicateSelectedProp(): string | null {
    if (this.isNonPropKey(this.selKey)) return null;
    this.level = dupPropPure(this.level, this.selKey);
    const p = this.level.props[this.level.props.length - 1]!;
    this.spawnProp(p);
    this.select(p.id);
    return p.id;
  }

  removeSelectedProp(): void {
    if (this.isNonPropKey(this.selKey)) return;
    const g = this.propGroups.get(this.selKey);
    if (g) { this.trackGroup.remove(g); this.propGroups.delete(this.selKey); }
    this.level = rmPropPure(this.level, this.selKey);
    this.select('track');
  }

  selectedKey(): 'map' | 'track' | string { return this.selKey; }

  select(key: 'map' | 'track' | string): void {
    this.selKey = key;
    // Map / track / props use the gizmo (move/rotate/scale the whole object) AND the numeric fields.
    // The track's curve control-POINTS are still separately draggable in the viewport; the gizmo sits
    // at the track group's origin for whole-track placement (what the user expects to grab).
    if (key === 'track') this.gizmo.attach(this.trackGroup);
    else if (key === 'map') this.gizmo.attach(this.mapGroup);
    else if (key === 'startLine' && this.startGantry) this.gizmo.attach(this.startGantry);
    else if (key === 'finishLine' && this.finishGantry) this.gizmo.attach(this.finishGantry);
    else if (key === 'obstacle' || key === 'boost') {
      // The barrier/boost samples are sized by sliders (level-wide), not moved freely — make sure
      // the preview is on so there's something to see, and don't attach the gizmo (no per-object
      // transform; they're scaled via the inspector + placed by the course generator at runtime).
      this.obstaclePreviewOn = true; this.applyObstacles(); this.gizmo.detach();
    }
    else if (key === 'camera') {
      // Show the cone + inset so the user sees the camera they're editing. The camera is edited via
      // the inspector's numeric fields (sim-space, unambiguous); the icon is a visual marker, so no
      // gizmo is attached (dragging would need inverse curve-projection to write back).
      this.camPreviewOn = true; this.applyCamera(); this.gizmo.detach();
    }
    else if (key === 'cars') {
      // Turn on the sample cars so the per-model size edits are visible; no gizmo (sized via panel).
      this.carPreviewOn = true; this.applyCars(); this.gizmo.detach();
    }
    else { const g = this.propGroups.get(key); if (g) this.gizmo.attach(g); else this.gizmo.detach(); }
    this.addArmed = false;   // dropping selection cancels any pending add
    this.changeCb();
  }

  /** The live preview wrapper for the barrier or boost sample (or null if not built yet). */
  private obstacleSample(kind: 'barrier' | 'boost'): THREE.Object3D | null {
    return this.previewObstacles.children.find(o => o.userData.kind === kind) ?? null;
  }

  /**
   * Select AND frame: like select(), but also flies the orbit camera to the chosen object so it
   * fills the view (and becomes zoomable — OrbitControls orbits/zooms around its target, so an
   * object far from the old target was effectively un-zoomable). ONLY the left-panel tree calls
   * this; viewport/programmatic selection uses plain select() and leaves the camera alone.
   */
  selectAndFrame(key: 'map' | 'track' | string): void {
    this.select(key);
    this.frameObject(key);
  }

  /** Move the orbit target onto the selected object's center and dolly in to fit its radius. */
  private frameObject(key: string): void {
    const obj = key === 'map' ? this.mapGroup
      : key === 'startLine' ? this.startGantry
      : key === 'finishLine' ? this.finishGantry
      : key === 'obstacle' ? this.obstacleSample('barrier')
      : key === 'boost' ? this.obstacleSample('boost')
      : key === 'camera' ? this.camIcon
      : key === 'cars' ? (this.previewCars.children[0] ?? null)   // frame the first sample car
      : (key === 'track' || key === 'level') ? null
      : this.propGroups.get(key) ?? null;

    const box = new THREE.Box3();
    if (obj) {
      box.setFromObject(obj);
    } else {
      // Track/Level: frame the whole drivable track (its curve), in trackGroup world space.
      const c = this.curve?.curve();
      if (c) for (const z of [0, RACE_LEN / 2, RACE_LEN]) {
        box.expandByPoint(this.trackGroup.localToWorld(c.sample(z, 0).pos.clone()));
      } else {
        box.setFromCenterAndSize(new THREE.Vector3(0, 0, RACE_LEN / 2), new THREE.Vector3(60, 20, RACE_LEN));
      }
    }
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1);
    // Distance so the sphere fits the vertical FOV with a little margin.
    const fitDist = (radius / Math.sin((this.camera.fov * Math.PI / 180) / 2)) * 1.25;
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    if (dir.lengthSq() < 1e-6) dir.set(0.5, 0.6, -0.3).normalize();   // fallback if degenerate
    this.orbit.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, fitDist);
    this.orbit.update();
  }

  // ── Selected-object transform API (Map / Prop / Start / Finish inspector wires to these) ───────
  /** The live three.js object the gizmo is editing for the current selection (null for level/track). */
  private selectedObject(): THREE.Object3D | null {
    const k = this.selKey;
    if (k === 'map') return this.mapGroup;
    if (k === 'track') return this.trackGroup;   // track IS gizmo/numeric-movable (move/rotate/scale)
    if (k === 'startLine') return this.startGantry;
    if (k === 'finishLine') return this.finishGantry;
    return this.propGroups.get(k) ?? null;
  }

  /** True when the selection is a movable object (Map/Prop/Start/Finish) — i.e. has a transform. */
  hasTransform(): boolean { return this.selectedObject() !== null; }

  /** Read the selected object's transform as pos (units), rotDeg (degrees), uniform scale. */
  selectedTransform(): { pos: [number, number, number]; rotDeg: [number, number, number]; scale: number } | null {
    const o = this.selectedObject();
    if (!o) return null;
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return {
      pos: [r(o.position.x), r(o.position.y), r(o.position.z)],
      rotDeg: [r(o.rotation.x * 180 / Math.PI), r(o.rotation.y * 180 / Math.PI), r(o.rotation.z * 180 / Math.PI)],
      scale: r(o.scale.x),
    };
  }

  /** A gantry edited numerically is "pinned" (manual) like a gizmo edit, so it persists + stops
   *  auto-following the track. No-op for map/props. */
  private pinIfGantry(): void {
    if (this.selKey === 'startLine' && this.startGantry) this.startGantry.userData.manual = true;
    if (this.selKey === 'finishLine' && this.finishGantry) this.finishGantry.userData.manual = true;
  }

  /** Set one axis of the selected object's position (world units). */
  setSelectedPos(axis: 0 | 1 | 2, v: number): void {
    const o = this.selectedObject(); if (!o) return;
    o.position.setComponent(axis, v); this.pinIfGantry(); this.changeCb();
  }
  /** Set one axis of the selected object's rotation (degrees). */
  setSelectedRotDeg(axis: 0 | 1 | 2, deg: number): void {
    const o = this.selectedObject(); if (!o) return;
    const e = o.rotation; const rad = deg * Math.PI / 180;
    if (axis === 0) e.x = rad; else if (axis === 1) e.y = rad; else e.z = rad;
    this.pinIfGantry(); this.changeCb();
  }
  /** Set the selected object's uniform scale (clamped to a sane positive range). */
  setSelectedScale(s: number): void {
    const o = this.selectedObject(); if (!o) return;
    o.scale.setScalar(THREE.MathUtils.clamp(s, 0.001, 100000)); this.pinIfGantry(); this.changeCb();
  }
  /** Reset a pinned gantry back to auto-follow-the-track placement. No-op unless a gantry selected. */
  resetSelectedGantry(): void {
    if (this.selKey === 'startLine' && this.startGantry) { this.startGantry.userData.manual = false; this.startGantry.scale.setScalar(1); }
    if (this.selKey === 'finishLine' && this.finishGantry) { this.finishGantry.userData.manual = false; this.finishGantry.scale.setScalar(1); }
    this.placeGantries(); this.changeCb();
  }

  /** Switch the viewport gizmo between translate / rotate / scale (toolbar + W/E/R keys). */
  setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.gizmoMode = mode;
    this.gizmo.setMode(mode);
    this.changeCb();
  }
  gizmoModeNow(): 'translate' | 'rotate' | 'scale' { return this.gizmoMode; }
  private gizmoMode: 'translate' | 'rotate' | 'scale' = 'translate';

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
    // Gantries: persist an offset ONLY when the author moved one (userData.manual); otherwise leave
    // it auto-placed (undefined) so it keeps following the track.
    const gantry = (o: THREE.Object3D | null) => o && o.userData.manual
      ? { pos: o.position.toArray().map(n => Math.round(n * 1000) / 1000),
          rotDeg: [o.rotation.x, o.rotation.y, o.rotation.z].map(r => Math.round(r * 180 / Math.PI)),
          scale: Math.round(o.scale.x * 1000) / 1000 }
      : undefined;
    const startLine = gantry(this.startGantry);
    const finishLine = gantry(this.finishGantry);
    // Persist the live curve as the level path; lighting/effects are spread from this.level and are
    // present ONLY if the user edited a lighting/effects control (opt-in), so an untouched level
    // saves without them and keeps in-game zone cycling.
    return { ...this.level, model: t(this.mapGroup), track: t(this.trackGroup),
             path: this.curve ? this.curve.toPath() : this.level.path, props,
             ...(startLine ? { startLine } : {}), ...(finishLine ? { finishLine } : {}) };
  }

  private loopClock = 0;
  private loopLast = performance.now();
  private loop(): void {
    requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const dt = Math.min((now - this.loopLast) / 1000, 0.1);
    this.loopClock += dt; this.loopLast = now;
    this.orbit.update();
    // Keep the gantries + preview cars glued to the live curve (so dragging a track point moves
    // them too — WYSIWYG with the game).
    this.placeGantries();
    this.placePreviewCars();
    this.placePreviewObstacles(dt);
    if (this.camHelper) this.placeGameCam();   // keep the camera cone glued to the live curve
    this.applyPulse();
    // Far plane must contain the WHOLE level (scene radius) AND whatever's beyond the camera at the
    // current zoom — so distant terrain never clips, whether zoomed in on the track or way out.
    const dist = this.camera.position.distanceTo(this.orbit.target);
    this.camera.far = Math.max(2000, dist + this.sceneRadius * 2.5);
    // Near shrinks with how close we are so you can push right up to a surface without it clipping;
    // floored at a tiny value (not 0.05) so extreme close-ups stay visible. Capped vs far to keep a
    // sane depth-buffer ratio when zoomed way out.
    this.camera.near = Math.max(0.002, Math.min(dist / 5000, dist * 0.5));
    this.camera.updateProjectionMatrix();
    // Sun rakes from sunDir, aimed at the track center; place it relative to the scene so shadows
    // land across the play area (matches the game's raking-sun model).
    const tgt = new THREE.Vector3(0, 0, RACE_LEN / 2);
    this.sun.target.position.copy(tgt); this.sun.target.updateMatrixWorld();
    this.sun.position.copy(tgt).addScaledVector(this.sunDir, Math.max(300, this.sceneRadius));
    // Sky dome rides the camera so the gradient is always the backdrop.
    this.sky.position.copy(this.camera.position);
    this.composer.render();   // post-FX (bloom) so the preview matches the game exactly
    this.renderCameraInset();
  }

  /** Render a small bottom-right inset from gameCam: a live "this is the in-game view" preview.
   *  Drawn straight to the framebuffer (no composer) after the main pass via scissor + viewport. */
  private renderCameraInset(): void {
    if (!this.camPreviewOn) return;
    const r = this.renderer;
    const w = Math.round(innerWidth * 0.26), h = Math.round(w * 9 / 16);
    const x = innerWidth - w - 16, y = 16;   // bottom-right (GL origin is bottom-left)
    // The cone/icon shouldn't appear INSIDE the camera's own preview — hide them for this pass.
    const helperVis = this.camHelper?.visible ?? false, iconVis = this.camIcon.visible;
    if (this.camHelper) this.camHelper.visible = false; this.camIcon.visible = false;
    this.gameCam.aspect = w / h; this.gameCam.updateProjectionMatrix();
    r.setScissorTest(true);
    r.setViewport(x, y, w, h); r.setScissor(x, y, w, h);
    r.render(this.scene, this.gameCam);
    r.setScissorTest(false);
    r.setViewport(0, 0, innerWidth, innerHeight);
    if (this.camHelper) this.camHelper.visible = helperVis; this.camIcon.visible = iconVis;
  }

  /** Animate the level's track-glow pulse on the curve ribbon, mirroring the game renderer so the
   *  preview is WYSIWYG. amount 0 (default) = steady, so this is a no-op until the author enables it. */
  private applyPulse(): void {
    const p = this.level?.effects?.pulse;
    if (!this.curve || !p || p.amount <= 0 || p.speed <= 0) return;
    const wave = (Math.sin(this.loopClock * p.speed * Math.PI * 2) + 1) / 2;
    const factor = 1 + p.amount * wave;
    this.curve.group.traverse(o => {
      const m = (o as THREE.Mesh).material as (THREE.MeshStandardMaterial & { _baseEmissive?: number }) | undefined;
      if (!m || !m.emissive || m.emissiveIntensity === undefined) return;
      // Capture the rebuilt base once per material so the pulse modulates from it (setGlow rebuilds
      // materials, which resets this capture — correct, since the base changed).
      if (m._baseEmissive === undefined) m._baseEmissive = m.emissiveIntensity;
      if (m._baseEmissive > 0) m.emissiveIntensity = m._baseEmissive * factor;
    });
  }
}
