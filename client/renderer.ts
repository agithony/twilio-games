import * as THREE from 'three';
import { TRACK_W, TRACK_LEN, RACE_LEN, LANES, laneX, TRACK_SURFACE_LIFT,
         HOVER_HEIGHT, HOVER_BOB, HOVER_BOB_SPEED, HOVER_SPIN } from '../shared/constants';
import { TRACK_CENTER } from './map-world';
import { CurvedTrack } from './track-path';
import { buildTrackSurface, type SurfaceOpts } from './track-surface';
import { makeSkyDome, setSkyColors } from './sky-dome';
import { frameField } from './field-camera';
import { autoFitScale } from '../shared/asset-fit';
import { stripDisplayBases } from './asset-loader';
import type { WorldSnapshot, Item } from '../shared/types';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { AssetLoader } from './asset-loader';
import { buildCar } from './car-factory';
import { themeAtZ } from '../shared/zones';
import { shouldCycleZones } from './zone-gate';
import type { LevelLighting, LevelEffects, PlacedProp, GantryOffset, ResolvedCamera } from '../shared/level';
import { DEFAULT_CAMERA } from '../shared/level';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

export class Renderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private carMeshes = new Map<string, THREE.Group>();
  private carIndex = new Map<string, number>();
  private nextCarIndex = 0;
  private itemMeshes: { mesh: THREE.Object3D; item: Item }[] = [];
  // Consumable boosts: which item ids were consumed last frame (to detect the visible→gone edge and
  // fire the pickup pop once), and live one-shot pop effects to animate + retire.
  private consumedNow = new Set<number>();
  private pops: { group: THREE.Group; age: number; ttl: number }[] = [];
  private myId: string | null = null;
  private lastFrame = performance.now();
  private clock = 0;   // accumulated seconds, drives the track-emissive pulse
  private sun: THREE.DirectionalLight;
  private ambient: THREE.HemisphereLight;
  private ground!: THREE.Mesh;         // surrounding terrain (theme-tinted); set in buildWorld()

  constructor(mount: HTMLElement, private assets?: AssetLoader) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Filmic tone mapping + sRGB output for a far less "flat" look.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0b1020);
    this.scene.fog = new THREE.FogExp2(0x0b1020, 0.0016);   // gentle depth haze, far horizon

    // Image-based lighting: a generated room environment so metal/paint on the GLB
    // cars actually REFLECTS the world (turns flat-plastic look into real material).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.1, 4000);

    // Key light (sun) with a real shadow frustum covering the play area.
    this.sun = new THREE.DirectionalLight(0xfff4e2, 2.1);
    this.sun.position.set(60, 110, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -60; sc.right = 60; sc.top = 120; sc.bottom = -120; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);
    // Sky/ground hemisphere fill gives natural ambient instead of flat grey.
    this.ambient = new THREE.HemisphereLight(0xbfd4ff, 0x202840, 0.7);
    this.scene.add(this.ambient);

    this.buildWorld();

    // Post-processing: bloom makes the sun, boost pads, neon edges, and bright
    // surfaces GLOW — the "AAA sheen" that reads great on a big screen.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight),
      0.45,   // strength — subtle, not blown out
      0.7,    // radius
      0.85,   // threshold — only genuinely bright things bloom
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.composer.setSize(innerWidth, innerHeight);
    });
  }

  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private sky!: THREE.Mesh;            // gradient sky dome; tinted each frame
  private generatedWorld = new THREE.Group();   // our built track (hidden when a map model is used)
  private mapWorld: THREE.Object3D | null = null;
  // The TRACK. `trackGroup` is the transform handle the saved `track` config drives; its ORIGIN
  // sits at the race CENTER (see TRACK_CENTER) so rotation pivots about the middle. The actual
  // cars/items/markings live in `trackContent`, an inner group shifted by -TRACK_CENTER so they
  // keep their normal sim coords (cars drive +Z from z=0) while the parent's pivot is centered.
  // Moving trackGroup moves the whole race together (onto a map's road when one is loaded).
  private trackGroup = new THREE.Group();
  private trackContent = new THREE.Group();
  // Render-only curved path (Option B). When set, cars/items are placed by mapping their straight
  // sim (z, x) onto this curve; null = the classic straight track. The sim never changes.
  private path: CurvedTrack | null = null;
  private surfaceOpts: SurfaceOpts = { laneScale: 1, shoulder: 0 };
  private trackSurface: THREE.Group | null = null;   // the shared 3-lane surface (when a path is set)
  // Per-level look: when a level supplies its own lighting we LOCK it (zones stop cycling) and apply
  // the saved sun/ambient/sky/exposure once. Effects (bloom/fog/glow/sky) + props are visual-only.
  private lightingLocked = false;
  private trackEmissive = 1;
  private pulse = { speed: 0, amount: 0 };
  private sunDir = new THREE.Vector3(-180, 70, -120).normalize();   // golden-hour rake direction
  // Per-level car sizing: the game-side half of the editor's car scale. Keyed by the per-car INDEX
  // (the SAME key the editor writes), so main.ts wires (i) => resolveCarScale(level, String(i)).
  private carScale: (i: number) => number = () => 1;
  // Per-level obstacle/boost size multiplier (applied on top of the manifest's global auto-fit).
  // main.ts wires (kind) => resolveItemScale(level, kind). buildItems re-reads it, so changing it
  // and rebuilding items resizes them live.
  private itemScale: (kind: 'barrier' | 'boost') => number = () => 1;
  // Per-level camera (chase-cam tuning OR a fixed cinematic camera). Defaults to the classic chase
  // numbers so a level without a camera looks exactly as before.
  private cam: ResolvedCamera = { ...DEFAULT_CAMERA };
  private propsGroup = new THREE.Group();     // decoration props live here (added to trackContent)
  private propLoader = (() => {
    const l = new GLTFLoader(); const d = new DRACOLoader();
    d.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/'); l.setDRACOLoader(d);
    return l;
  })();

  /**
   * Replace the generated track with a loaded track-model "map" (from /maptest layout).
   * Pass null to revert to the generated track. The sky dome stays (backdrop either way).
   */
  setMapWorld(world: THREE.Object3D | null): void {
    if (this.mapWorld) { this.scene.remove(this.mapWorld); this.mapWorld = null; }
    if (world) {
      this.mapWorld = world;
      this.scene.add(world);
      this.generatedWorld.visible = false;   // hide our asphalt/curbs/gantry; map is the world
    } else {
      this.generatedWorld.visible = true;
    }
  }

  /**
   * Set the render-only curved path + its width opts (cars/items follow it visually). Pass null for
   * the classic straight track. Builds the shared 3-lane surface so the game looks like the editor.
   */
  setPath(path: CurvedTrack | null, opts: SurfaceOpts = { laneScale: 1, shoulder: 0 }): void {
    this.path = path;
    this.surfaceOpts = opts;
    this.rebuildSurface();
    // Re-place any already-built items onto the new path (cars re-place every frame in render()).
    for (const { mesh, item } of this.itemMeshes) {
      this.placeItem(mesh, item, (mesh.userData.groundY as number) ?? 0);
    }
    // Re-place the start/finish gantries onto the new curve (each remembers its sim-z).
    for (const wrapper of this.lineGroup.children) {
      this.placeLine(wrapper, (wrapper.userData.lineZ as number) ?? 0);
    }
  }

  /** (Re)build the curved 3-lane surface from the current path + width + track-glow. */
  private rebuildSurface(): void {
    if (this.trackSurface) { this.trackContent.remove(this.trackSurface); this.trackSurface = null; }
    this.pulseMats = [];
    if (!this.path) return;
    this.generatedWorld.visible = false;   // the curved surface replaces our straight asphalt
    this.trackSurface = buildTrackSurface(this.path, { ...this.surfaceOpts, glow: this.trackEmissive });
    this.trackSurface.traverse(o => {
      (o as THREE.Mesh).receiveShadow = true;
      // Remember each emissive lane material + its base intensity so the pulse modulates from it.
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && m.emissive && m.emissiveIntensity > 0) this.pulseMats.push({ m, base: m.emissiveIntensity });
    });
    this.trackContent.add(this.trackSurface);
  }
  // Emissive lane materials (+ their base intensity) that the pulse modulates each frame.
  private pulseMats: { m: THREE.MeshStandardMaterial; base: number }[] = [];

  /** Animate the track-glow pulse the level authored (effects.pulse). amount 0 = steady (no-op). */
  private applyPulse(): void {
    if (this.pulse.amount <= 0 || this.pulse.speed <= 0 || this.pulseMats.length === 0) return;
    // Sine 0..1; scale each material between base and base*(1+amount).
    const wave = (Math.sin(this.clock * this.pulse.speed * Math.PI * 2) + 1) / 2;
    const factor = 1 + this.pulse.amount * wave;
    for (const { m, base } of this.pulseMats) m.emissiveIntensity = base * factor;
  }

  /** Apply a level's lighting; null reverts to zone-cycling. The sun direction is taken from
   *  sunPos as a DIRECTION (the light is placed far away along it each frame so it rakes the whole
   *  scene), and the shadow frustum is widened to cover the track length so shadows actually land. */
  setLighting(l: LevelLighting | null): void {
    this.lightingLocked = !!l;
    if (!l) return;
    this.sunDir.set(l.sunPos[0]!, l.sunPos[1]!, l.sunPos[2]!).normalize();
    this.sun.intensity = l.sunIntensity;
    this.sun.color.set(l.sunColor);
    this.ambient.intensity = l.ambientIntensity;
    this.ambient.color.set(l.skyColor);
    this.ambient.groundColor.set(l.groundColor);
    this.renderer.toneMappingExposure = l.exposure;
    // Tint only the dome top to the sky color; keep the current bottom (effects own the gradient).
    const curBottom = ((this.sky.material as THREE.ShaderMaterial).uniforms.bottom!.value as THREE.Color);
    setSkyColors(this.sky, l.skyColor, curBottom.clone());
    // A wide shadow frustum so the locked sun casts real ground shadows across the play area.
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -90; sc.right = 90; sc.top = 160; sc.bottom = -160; sc.near = 1; sc.far = 1200;
    sc.updateProjectionMatrix();
  }

  /** Apply a level's effects (bloom/fog/track-glow/sky); null leaves current values. */
  setEffects(e: LevelEffects | null): void {
    if (!e) return;
    this.bloom.strength = e.bloom.strength;
    this.bloom.radius = e.bloom.radius;
    this.bloom.threshold = e.bloom.threshold;
    const fog = this.scene.fog as THREE.FogExp2;
    fog.density = e.fog.density; fog.color.set(e.fog.color);
    this.trackEmissive = e.trackEmissive;
    this.pulse = { ...e.pulse };
    this.rebuildSurface();   // track glow changed → rebuild the lane materials with the new value
    setSkyColors(this.sky, e.skyTop, e.skyBottom);
  }

  /** Load + place decoration props (visual-only) in the track content group. */
  setProps(props: PlacedProp[]): void {
    this.trackContent.remove(this.propsGroup);
    this.propsGroup = new THREE.Group();
    this.trackContent.add(this.propsGroup);
    for (const p of props) {
      this.propLoader.load(`/assets/${p.file}`, (gltf) => {
        const g = new THREE.Group(); g.add(gltf.scene);
        g.position.set(p.pos[0]!, p.pos[1]!, p.pos[2]!);
        g.rotation.set(p.rotDeg[0]! * Math.PI / 180, p.rotDeg[1]! * Math.PI / 180, p.rotDeg[2]! * Math.PI / 180);
        g.scale.setScalar(p.scale);
        g.userData.propId = p.id;
        this.propsGroup.add(g);
      }, undefined, () => { /* skip a failed prop, keep the scene */ });
    }
  }

  /** Set the per-car scale multiplier (keyed by car index) the game applies in ensureCar. ALSO
   *  re-applies to cars that already exist — the level (and thus this scale) loads asynchronously on
   *  race start, often AFTER the first snapshot created the car wrappers, so without this re-apply a
   *  car keeps its creation-time scale (the "scale not applied" bug). */
  setCarScale(fn: (i: number) => number): void {
    this.carScale = fn;
    for (const [id, wrapper] of this.carMeshes) {
      const idx = this.carIndex.get(id);
      if (idx !== undefined) wrapper.scale.setScalar(fn(idx));
    }
  }

  /** Remove ALL car meshes + reset the id→index maps. Called when switching from the attract-mode
   *  demo to a real race so the demo's autopilot cars don't linger frozen on the track, and on the
   *  reverse so a stale race car doesn't haunt the menu backdrop. */
  clearCars(): void {
    for (const [, wrapper] of this.carMeshes) this.trackContent.remove(wrapper);
    this.carMeshes.clear();
    this.carIndex.clear();
    this.nextCarIndex = 0;
  }
  /** Set the per-level obstacle/boost size multiplier (applied in buildItems on top of auto-fit). */
  setItemScale(fn: (kind: 'barrier' | 'boost') => number): void { this.itemScale = fn; }
  /** Set the per-level camera (chase tuning or a fixed cinematic camera); null reverts to default. */
  setCamera(cam: ResolvedCamera | null): void {
    this.cam = cam ?? { ...DEFAULT_CAMERA };
    this.camera.fov = this.cam.fov; this.camera.updateProjectionMatrix();
  }

  getLightingLocked(): boolean { return this.lightingLocked; }

  /** Accessors for the in-game align mode (attach a gizmo to the live map world / track). */
  getMapWorld(): THREE.Object3D | null { return this.mapWorld; }
  getTrackGroup(): THREE.Group { return this.trackGroup; }
  getScene(): THREE.Scene { return this.scene; }
  getCamera(): THREE.PerspectiveCamera { return this.camera; }
  getDomElement(): HTMLCanvasElement { return this.renderer.domElement; }

  /** Build the static world: sky dome, terrain, asphalt track, markings, curbs, start gantry. */
  private buildWorld(): void {
    const FULL_LEN = TRACK_LEN * 3;          // covers all laps of travel
    const midZ = TRACK_LEN;
    // The track group rides in the scene; its inner content group is shifted by -TRACK_CENTER so
    // the group's ORIGIN (where the gizmo attaches + rotation pivots) sits at the race center,
    // while cars/items/markings inside keep normal sim coords. Moving trackGroup moves it all.
    this.scene.add(this.trackGroup);
    // Outer origin defaults to the race center; inner content shifts back by -TRACK_CENTER. Net:
    // content sits at normal sim coords (cars at z 0..TRACK_LEN) while the pivot is centered. A
    // loaded map overrides trackGroup's transform via applyTrackTransform(getTrackGroup(), ...).
    this.trackGroup.position.set(TRACK_CENTER[0], TRACK_CENTER[1], TRACK_CENTER[2]);
    this.trackContent.position.set(-TRACK_CENTER[0], -TRACK_CENTER[1], -TRACK_CENTER[2]);
    this.trackGroup.add(this.trackContent);
    this.trackContent.add(this.generatedWorld);

    // Big inside-out gradient sky dome (shared with the editor via sky-dome.ts — one source of
    // truth so the game + editor preview can't drift) so the world never reads as a black void.
    this.sky = makeSkyDome();
    this.scene.add(this.sky);

    // Surrounding terrain (wide; theme-tinted each frame via this.ground.material).
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, FULL_LEN + 4000),
      new THREE.MeshStandardMaterial({ color: 0x3a4a63, roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2; this.ground.position.set(0, -0.05, midZ);
    this.ground.receiveShadow = true; this.generatedWorld.add(this.ground);

    // Asphalt track surface.
    const asphalt = new THREE.Mesh(
      new THREE.PlaneGeometry(TRACK_W, FULL_LEN),
      new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.95, metalness: 0.0 }));
    asphalt.rotation.x = -Math.PI / 2; asphalt.position.set(0, 0, midZ);
    asphalt.receiveShadow = true; this.generatedWorld.add(asphalt);

    // Dashed white lane dividers (between the lanes).
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xeef2ff, roughness: 0.6 });
    for (let lane = 1; lane < LANES; lane++) {
      const x = TRACK_W / 2 - (TRACK_W / LANES) * lane;   // divider between lane-1 and lane
      for (let z = -TRACK_LEN; z < FULL_LEN; z += 14) {
        const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 6), dashMat);
        dash.rotation.x = -Math.PI / 2; dash.position.set(x, 0.02, z);
        this.generatedWorld.add(dash);
      }
    }

    // Solid edge lines + raised curbs on both sides.
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xeef2ff, roughness: 0.6 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xef223a, roughness: 0.7, emissive: 0x300008 });
    for (const side of [-1, 1]) {
      const ex = side * (TRACK_W / 2 - 0.3);
      const edge = new THREE.Mesh(new THREE.PlaneGeometry(0.5, FULL_LEN), edgeMat);
      edge.rotation.x = -Math.PI / 2; edge.position.set(ex, 0.02, midZ); this.generatedWorld.add(edge);
      const curb = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, FULL_LEN),
        curbMat);
      curb.position.set(side * (TRACK_W / 2 + 0.4), 0.25, midZ);
      curb.castShadow = true; curb.receiveShadow = true; this.generatedWorld.add(curb);
    }

    // Start (z=0) and finish (z=RACE_LEN) line MODELS are loaded + placed by
    // setStartFinishLines(), into the lineGroup which rides trackContent — so they follow
    // BOTH the straight track and a curved map path (and any track transform/hills). A
    // lightweight primitive gantry is drawn here as a fallback until/unless the models load.
    this.trackContent.add(this.lineGroup);
    this.buildFallbackGantry(0x10141c, 'finish');
  }

  // ── Start / Finish line models ──────────────────────────────────────────────────────────────
  // Real GLB gantries that ALWAYS bookend the track. Placed in lineGroup (rides trackContent), so
  // they sit on the curve at z=0 / z=RACE_LEN in both straight and curved-map modes.
  private lineGroup = new THREE.Group();
  private lineLoader = (() => {
    const l = new GLTFLoader(); const d = new DRACOLoader();
    d.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/'); l.setDRACOLoader(d);
    return l;
  })();
  /** Remembered files so setPath() can re-place the gantries onto a freshly-set curve. */
  private lineFiles: { start?: string; finish?: string } = {};

  /**
   * Load + place the start and finish gantry models so they bookend the track. Each is auto-fit so
   * its widest dimension spans a bit beyond the track, grounded on the surface, and turned to face
   * across the track. Pass either/both files; missing ones keep the primitive fallback gantry.
   */
  setStartFinishLines(files: { start?: string; finish?: string },
                      offsets: { start?: GantryOffset; finish?: GantryOffset } = {}): void {
    this.lineFiles = files;
    this.lineOffsets = offsets;
    // clear any previously-built gantries (models + fallback) and rebuild
    this.lineGroup.clear();
    if (!files.start && !files.finish) { this.buildFallbackGantry(0x10141c, 'finish'); return; }
    if (files.start) this.loadLine(files.start, 0, offsets.start);
    if (files.finish) this.loadLine(files.finish, RACE_LEN, offsets.finish);
    // keep a fallback finish gantry only if no finish model was supplied
    if (!files.finish) this.buildFallbackGantry(0x10141c, 'finish');
  }
  private lineOffsets: { start?: GantryOffset; finish?: GantryOffset } = {};

  private loadLine(file: string, z: number, offset?: GantryOffset): void {
    this.lineLoader.load(`/assets/${file}`, (gltf) => {
      const model = gltf.scene;
      stripDisplayBases(model);
      // Auto-fit so the gantry's longest axis spans a little wider than the full track width.
      const target = (TRACK_W * this.surfaceOpts.laneScale) + 2 * this.surfaceOpts.shoulder + 8;
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3(); box.getSize(size);
      const s = autoFitScale([size.x, size.y, size.z], target);
      model.scale.setScalar(s);
      // ground it: recompute, sit min.y on 0, center x/z so the wrapper controls placement
      const box2 = new THREE.Box3().setFromObject(model);
      const c = new THREE.Vector3(); box2.getCenter(c);
      model.position.x += -c.x; model.position.z += -c.z; model.position.y += -box2.min.y;
      model.traverse(o => { (o as THREE.Mesh).castShadow = true; });
      const wrapper = new THREE.Group();
      wrapper.add(model);
      wrapper.userData.lineZ = z;
      if (offset) wrapper.userData.offset = offset;   // author-pinned transform (overrides auto-place)
      this.lineGroup.add(wrapper);
      this.placeLine(wrapper, z);
    }, undefined, () => { /* model failed: keep whatever fallback exists */ });
  }

  /** Position one gantry wrapper at sim-z (lane center x=0), onto the curve when a path is set —
   *  UNLESS the level pinned an absolute offset transform, which then wins (matches the editor). */
  private placeLine(wrapper: THREE.Object3D, z: number): void {
    const off = wrapper.userData.offset as GantryOffset | undefined;
    if (off) {
      if (off.pos) wrapper.position.set(off.pos[0]!, off.pos[1]!, off.pos[2]!);
      if (off.rotDeg) wrapper.rotation.set(off.rotDeg[0]! * Math.PI/180, off.rotDeg[1]! * Math.PI/180, off.rotDeg[2]! * Math.PI/180);
      if (off.scale !== undefined) wrapper.scale.setScalar(off.scale);
      return;
    }
    if (this.path) {
      const p = this.path.sample(z, 0);
      wrapper.position.set(p.pos.x, p.pos.y + 0.6, p.pos.z);   // +0.6 = track surface lift (Y_ROAD)
      wrapper.rotation.y = p.headingY;
    } else {
      wrapper.position.set(0, 0, z);
      wrapper.rotation.y = 0;
    }
  }

  /** Simple primitive gantry (posts + emissive banner) used when no model is supplied/loaded. */
  private buildFallbackGantry(color: number, _label: string): void {
    const g = new THREE.Group(); g.userData.lineZ = 0; g.userData.fallback = true;
    const postMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.2, 12, 1.2), postMat);
      post.position.set(side * (TRACK_W / 2 + 1.5), 6, 0); post.castShadow = true; g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W + 6, 2.4, 1.4), postMat);
    beam.position.set(0, 11, 0); beam.castShadow = true; g.add(beam);
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W + 5, 2),
      new THREE.MeshStandardMaterial({ color: 0xef223a, emissive: 0xef223a, emissiveIntensity: 0.6,
        side: THREE.DoubleSide }));
    banner.position.set(0, 11, 0.8); g.add(banner);
    this.lineGroup.add(g);
    this.placeLine(g, 0);
  }

  private spectator = false;
  setMyId(id: string) { this.myId = id; }
  setSpectator(on: boolean) { this.spectator = on; }

  buildItems(items: Item[]) {
    this.consumedNow.clear();   // fresh race: no orb is mid-pickup
    for (const { mesh } of this.itemMeshes) this.trackContent.remove(mesh);
    this.itemMeshes = items.map(item => {
      // NOTE: keep in sync with the editor preview (level-scene.ts) placement: world/lane position
      // goes on an OUTER wrapper group; the inner model keeps its baked grounding (-min.y) + offset
      // from AssetLoader.normalize so manifest offset survives and models sit on y=0.
      let model: THREE.Object3D;
      let usingTemplate: boolean;
      if (item.kind === 'barrier') {
        const template = this.assets?.barrierTemplate() ?? null;
        usingTemplate = !!template;
        model = template
          ? skeletonClone(template)
          : new THREE.Mesh(new THREE.BoxGeometry(TRACK_W / LANES - 1.5, 1.6, 1.2),
              new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0x550000 }));
      } else {
        const template = this.assets?.boostTemplate() ?? null;
        usingTemplate = !!template;
        model = template
          ? skeletonClone(template)
          : new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.25, 20),
              new THREE.MeshStandardMaterial({ color: 0x36e08a, emissive: 0x0a5a32 }));
      }
      // Per-level size multiplier on an INNER group (keeps the model's baked grounding/offset),
      // so resizing scales the obstacle in place without lifting/sinking it off the track.
      const scaled = new THREE.Group();
      scaled.add(model);
      scaled.scale.setScalar(this.itemScale(item.kind));
      const mesh = new THREE.Group();
      mesh.add(scaled);
      // A real boost MODEL hovers above the track (bob + spin animated in render()); the barrier and
      // any primitive fallback stay grounded. Tag the hovering ones + remember their hover height.
      const hover = item.kind === 'boost' && usingTemplate;
      if (hover) { mesh.userData.hover = true; scaled.userData.hoverBaseY = HOVER_HEIGHT; }
      // Real models self-ground via baked -min.y, so wrapper y=0. Primitives have no baked
      // grounding (box centered, pad thin), so keep their original y (0.8 / 0.13).
      const y = usingTemplate ? 0 : (item.kind === 'barrier' ? 0.8 : 0.13);
      this.placeItem(mesh, item, y);
      mesh.userData.groundY = y;     // remembered so setPath() can re-place onto the curve
      this.trackContent.add(mesh);   // ride the track transform so items align with the race line
      return { mesh, item };
    });
  }

  /** Position one item mesh: straight sim coords, or mapped onto the curve when a path is set. */
  private placeItem(mesh: THREE.Object3D, item: Item, y: number): void {
    if (this.path) {
      // Scale the lane offset by laneScale so items sit in the (possibly widened) lanes, and lift
      // onto the track surface (Y_ROAD ≈ 0.6).
      const p = this.path.sample(item.z, laneX(item.lane) * this.surfaceOpts.laneScale);
      mesh.position.set(p.pos.x, p.pos.y + y + 0.6, p.pos.z);   // p.pos.y carries the track height
      mesh.rotation.y = p.headingY;
    } else {
      mesh.position.set(laneX(item.lane), y, item.z);
      mesh.rotation.y = 0;
    }
  }

  /**
   * Hide/show boost orbs per the sim's consumed list, and fire a one-shot pickup POP on the
   * visible→consumed edge (so it plays exactly once when a player grabs the orb). Reappears (mesh
   * shown again) when the sim respawns it ~0.5s later.
   */
  private applyConsumed(consumedItems: number[]): void {
    const consumed = new Set(consumedItems);
    for (const { mesh, item } of this.itemMeshes) {
      if (item.kind !== 'boost') continue;
      const isGone = consumed.has(item.id);
      const wasGone = this.consumedNow.has(item.id);
      if (isGone && !wasGone) {
        // pop where the orb VISUALLY was — its placed pos plus the hover float height.
        const at = mesh.position.clone();
        if (mesh.userData.hover) at.y += HOVER_HEIGHT;
        this.spawnPop(at);
      }
      mesh.visible = !isGone;
    }
    this.consumedNow = consumed;
  }

  /** Spawn a small, quick "collected!" sparkle at a world position: a thin ring that gently expands
   *  and fades, plus a brief soft flash. Tuned to be subtle, not a big shockwave. */
  private spawnPop(at: THREE.Vector3): void {
    const group = new THREE.Group();
    group.position.copy(at);
    const mat = (c: number, o: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true,
      opacity: o, depthWrite: false, blending: THREE.AdditiveBlending });
    // Thin ring (0.15 wide), starts roughly orb-sized; expands only modestly in updatePops.
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.0, 28), mat(0x7afcff, 0.85));
    ring.rotation.x = -Math.PI / 2;   // lie flat-ish; faces up
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), mat(0xcceeff, 0.7));
    group.add(ring, flash);
    this.trackContent.add(group);
    this.pops.push({ group, age: 0, ttl: 0.35 });   // short-lived
  }

  /** Advance + retire pickup sparkles: ring expands a little and fades; flash shrinks and fades. */
  private updatePops(dt: number): void {
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i]!;
      p.age += dt;
      const f = p.age / p.ttl;        // 0..1
      if (f >= 1) {
        this.trackContent.remove(p.group);
        p.group.traverse(o => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; m?.dispose(); (o as THREE.Mesh).geometry?.dispose(); });
        this.pops.splice(i, 1);
        continue;
      }
      const ease = 1 - (1 - f) * (1 - f);   // ease-out: quick then settles
      const ring = p.group.children[0] as THREE.Mesh;
      const flash = p.group.children[1] as THREE.Mesh;
      ring.scale.setScalar(1 + ease * 1.4);                       // modest expansion (was up to 7×)
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - f);
      flash.scale.setScalar(Math.max(0.01, 1 - ease));            // flash blinks out
      (flash.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - f * 1.6);
      p.group.position.y += dt * 1.2;   // gentle upward drift
    }
  }

  private ensureCar(id: string, color: string, carIndex?: number): THREE.Group {
    let wrapper = this.carMeshes.get(id);
    if (!wrapper) {
      // Prefer the player's CHOSEN car model (carIndex from the snapshot, set in car-select); fall
      // back to round-robin join order only when no choice was made (legacy / direct-join races).
      let idx = this.carIndex.get(id);
      if (idx === undefined) {
        idx = carIndex ?? this.nextCarIndex++;
        this.carIndex.set(id, idx);
      }
      const template = this.assets?.carTemplate(idx) ?? null;
      // NOTE: keep in sync with the editor preview (level-scene.ts). buildCar returns a model that may
      // carry baked grounding/offset on its own .position (template path) or be self-grounded
      // (primitive body at y=0.75). Wrap it so we set world position on the OUTER group and
      // never clobber the inner model's grounding. mixer/wheels live on the inner model.
      const model = buildCar(template, color, id === this.myId);
      model.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
      wrapper = new THREE.Group();
      wrapper.add(model);
      wrapper.userData.model = model;
      // Per-level car sizing: scale the WRAPPER (not the inner model) so the model's baked grounding
      // (-min.y) is preserved and the car still sits on y=0. Keyed by the per-car index (idx).
      wrapper.scale.setScalar(this.carScale(idx));
      this.trackContent.add(wrapper); this.carMeshes.set(id, wrapper);   // cars ride the track transform
    }
    return wrapper;
  }

  render(snap: WorldSnapshot) {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    this.clock += dt;
    this.applyPulse();

    for (const c of snap.cars) {
      const wrapper = this.ensureCar(c.id, c.color, c.carIndex);
      if (this.path) {
        // Map straight sim (z=distance, x=lane offset) onto the curve. Scale x by laneScale so cars
        // stay centered in widened lanes, and lift onto the track surface.
        const p = this.path.sample(c.z, c.x * this.surfaceOpts.laneScale);
        wrapper.position.set(p.pos.x, p.pos.y + TRACK_SURFACE_LIFT, p.pos.z);   // sit on the road ribbon
        // Orient along the track AND tip with the slope: yaw (Y) then pitch about the car's local
        // lateral axis, via Euler order 'YXZ' so a hill never rolls the car sideways. rotation.x is
        // -pitch because tipping the nose UP (+Z forward → +Y) is a negative X rotation in three.js.
        wrapper.rotation.set(-p.pitch, p.headingY, 0, 'YXZ');
      } else {
        wrapper.position.set(c.x, 0, c.z);
      }
      // Animation lives on the inner model (mixer/wheels set by buildCar).
      const model = wrapper.userData.model as THREE.Object3D;
      // Animation priority: baked clip (mixer) > wheel-spin > static.
      const mixer = model.userData.mixer as THREE.AnimationMixer | undefined;
      if (mixer) {
        mixer.update(dt);
      } else {
        const wheels = model.userData.wheels as THREE.Object3D[] | undefined;
        if (wheels && wheels.length) {
          for (const w of wheels) w.rotation.x += dt * 14;
        }
      }
    }
    // Consumed boosts: hide the ones the sim marks picked-up, and on the visible→gone EDGE spawn a
    // pickup pop where the orb was. They reappear (shown again) when the sim respawns them.
    this.applyConsumed(snap.consumedItems);
    // Hovering boost orbs: bob up/down around HOVER_HEIGHT and spin, so they read as floating
    // power-ups rather than sitting on the asphalt. Only meshes tagged hover + still visible.
    for (const { mesh } of this.itemMeshes) {
      if (!mesh.userData.hover || !mesh.visible) continue;
      const scaled = mesh.children[0] as THREE.Object3D | undefined;
      if (!scaled) continue;
      const base = (scaled.userData.hoverBaseY as number) ?? HOVER_HEIGHT;
      scaled.position.y = base + Math.sin(this.clock * HOVER_BOB_SPEED * Math.PI * 2) * HOVER_BOB;
      scaled.rotation.y += dt * HOVER_SPIN;
    }
    this.updatePops(dt);
    // Camera focus. The shared DISPLAY frames the whole FIELD (every player is on one screen, so we
    // can't chase the leader — that pushes the back of the pack off-screen). A solo keyboard player
    // (own myId, not the spectator display) still follows their own car.
    const fieldMode = this.spectator || !this.myId;
    let focus: typeof snap.cars[number] | undefined;
    if (fieldMode) {
      // `z` for zone/sun = field CENTER (mid of clamped pack), so atmosphere tracks the action.
      focus = snap.cars.length
        ? snap.cars.reduce((a, b) => (b.z > a.z ? b : a))   // leader, only used as a fallback ref
        : undefined;
    } else {
      focus = snap.cars.find(c => c.id === this.myId) ?? snap.cars[0];
    }
    const me = focus;
    // z drives zone-cycling + sun aim. In field mode use the pack center; solo uses the own car.
    let z = me ? me.z : 0;
    if (fieldMode && snap.cars.length) {
      let front = -Infinity, back = Infinity;
      for (const c of snap.cars) { if (c.z > front) front = c.z; if (c.z < back) back = c.z; }
      z = (front + back) / 2;
    }

    if (shouldCycleZones(this.lightingLocked)) {
      const theme = themeAtZ(z);
      const fog = this.scene.fog as THREE.FogExp2;
      fog.color.set(theme.fog);   // keep our gentle far-horizon density (don't pull from theme)
      (this.ground.material as THREE.MeshStandardMaterial).color.set(theme.ground);
      this.sun.color.set(theme.sun); this.sun.intensity = Math.max(1.4, theme.sunIntensity * 1.6);
      this.ambient.color.set(theme.sky);          // sky tint drives hemisphere fill
      this.ambient.groundColor.set(theme.ground);
      // Sky dome follows the camera and tints to the zone (top = sky, bottom = lighter haze).
      setSkyColors(this.sky, theme.sky, theme.fog);
    }
    // Sun follows the action: aim its target at the car, and place the light a fixed distance away
    // ALONG sunDir so the golden-hour rake angle stays consistent and its shadow frustum tracks the
    // pack. (When zones cycle, sunDir is the default rake; when locked, setLighting set it.)
    const tgt = new THREE.Vector3(0, 0, z + 20);
    this.sun.target.position.copy(tgt); this.sun.target.updateMatrixWorld();
    this.sun.position.copy(tgt).addScaledVector(this.sunDir, 260);

    const mx = me ? me.x : 0;
    if (this.cam.mode === 'fixed' && this.cam.pos && this.cam.lookAt) {
      // FIXED cinematic camera: a static eye/look in sim-world space, mapped onto the curve when a
      // path is set (so "z" reads as track distance), else used as raw world coords. The race plays
      // from this viewpoint — cars drive through frame.
      const px = this.cam.pos[0]!, py = this.cam.pos[1]!, pz = this.cam.pos[2]!;
      const lx = this.cam.lookAt[0]!, ly = this.cam.lookAt[1]!, lz = this.cam.lookAt[2]!;
      if (this.path) {
        const eye = this.path.sample(pz, px);
        const look = this.path.sample(lz, lx);
        this.camera.position.set(eye.pos.x, eye.pos.y + py, eye.pos.z);
        this.camera.lookAt(look.pos.x, look.pos.y + ly, look.pos.z);
      } else {
        this.camera.position.set(px, py, pz);
        this.camera.lookAt(lx, ly, lz);
      }
    } else if (fieldMode) {
      // FIELD cam: frame the whole pack (sim-space eye/look from frameField), pulling back + rising
      // as the field spreads so every player stays visible. Offsets come from the level chase params.
      const { behind, height, lookAhead, lookHeight, lateral } = this.cam;
      const f = frameField(snap.cars, { behind, height, lookAhead, lookHeight, lateral });
      if (this.path) {
        const eye = this.path.sample(f.eyeZ, f.eyeX);
        const look = this.path.sample(f.lookZ, f.lookX);
        this.camera.position.set(eye.pos.x, eye.pos.y + f.eyeY, eye.pos.z);
        this.camera.lookAt(look.pos.x, look.pos.y + f.lookY, look.pos.z);
      } else {
        this.camera.position.set(f.eyeX, f.eyeY, f.eyeZ);
        this.camera.lookAt(f.lookX, f.lookY, f.lookZ);
      }
    } else {
      // SOLO CHASE cam: follow my own car. behind + above + slightly lateral, looking down-track.
      // Offsets come from the level (default = the classic 24 back / 9 up / 45 ahead / 10 lateral /
      // 2.2 look-height), so a level with no camera renders exactly as before.
      const { behind, height, lookAhead, lookHeight, lateral } = this.cam;
      if (this.path) {
        // Curve-aware: sample behind/ahead along the curve so the camera swings through bends.
        const eye = this.path.sample(z - behind, mx * 0.3 + lateral);
        const look = this.path.sample(z + lookAhead, mx * 0.4);
        this.camera.position.set(eye.pos.x, eye.pos.y + height, eye.pos.z);
        this.camera.lookAt(look.pos.x, look.pos.y + lookHeight, look.pos.z);
      } else {
        this.camera.position.set(mx * 0.3 + lateral, height, z - behind);
        this.camera.lookAt(mx * 0.4, lookHeight, z + lookAhead);
      }
    }
    // Sky dome rides with the camera so the horizon is always far away.
    this.sky.position.copy(this.camera.position);
    this.composer.render();
  }
}
