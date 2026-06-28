import * as THREE from 'three';
import { TRACK_W, TRACK_LEN, LANES, laneX } from '../shared/constants';
import { TRACK_CENTER } from './map-world';
import { CurvedTrack } from './track-path';
import { buildTrackSurface, type SurfaceOpts } from './track-surface';
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
import type { LevelLighting, LevelEffects, PlacedProp } from '../shared/level';
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
  private myId: string | null = null;
  private lastFrame = performance.now();
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
  }

  /** (Re)build the curved 3-lane surface from the current path + width + track-glow. */
  private rebuildSurface(): void {
    if (this.trackSurface) { this.trackContent.remove(this.trackSurface); this.trackSurface = null; }
    if (!this.path) return;
    this.generatedWorld.visible = false;   // the curved surface replaces our straight asphalt
    this.trackSurface = buildTrackSurface(this.path, { ...this.surfaceOpts, glow: this.trackEmissive });
    this.trackSurface.traverse(o => { (o as THREE.Mesh).receiveShadow = true; });
    this.trackContent.add(this.trackSurface);
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
    const skyU = (this.sky.material as THREE.ShaderMaterial).uniforms;
    (skyU.top!.value as THREE.Color).set(l.skyColor);
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
    const skyU = (this.sky.material as THREE.ShaderMaterial).uniforms;
    (skyU.top!.value as THREE.Color).set(e.skyTop);
    (skyU.bottom!.value as THREE.Color).set(e.skyBottom);
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

  /** Set the per-car scale multiplier (keyed by car index) the game applies in ensureCar. */
  setCarScale(fn: (i: number) => number): void { this.carScale = fn; }

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

    // Big inside-out gradient sky dome so the world never reads as a black void.
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(0x2a6cff) }, bottom: { value: new THREE.Color(0xbfe0ff) } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vP;
        void main(){ float h = clamp((normalize(vP).y*0.5)+0.5, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), skyMat);
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

    // Start/finish gantry at z=0.
    const postMat = new THREE.MeshStandardMaterial({ color: 0x10141c, roughness: 0.6, metalness: 0.3 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.2, 12, 1.2), postMat);
      post.position.set(side * (TRACK_W / 2 + 1.5), 6, 0); post.castShadow = true; this.generatedWorld.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W + 6, 2.4, 1.4), postMat);
    beam.position.set(0, 11, 0); beam.castShadow = true; this.generatedWorld.add(beam);
    // "FINISH" banner on the beam — emissive so it's bright and readable in any zone.
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W + 5, 2),
      new THREE.MeshStandardMaterial({ color: 0xef223a, emissive: 0xef223a, emissiveIntensity: 0.6,
        side: THREE.DoubleSide }));
    banner.position.set(0, 11, 0.8); this.generatedWorld.add(banner);
  }

  private spectator = false;
  setMyId(id: string) { this.myId = id; }
  setSpectator(on: boolean) { this.spectator = on; }

  buildItems(items: Item[]) {
    for (const { mesh } of this.itemMeshes) this.trackContent.remove(mesh);
    this.itemMeshes = items.map(item => {
      // NOTE: keep in sync with editor-main.ts placement: world/lane position goes on an
      // OUTER wrapper group; the inner model keeps its baked grounding (-min.y) + offset
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
      const mesh = new THREE.Group();
      mesh.add(model);
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

  private ensureCar(id: string, color: string): THREE.Group {
    let wrapper = this.carMeshes.get(id);
    if (!wrapper) {
      let idx = this.carIndex.get(id);
      if (idx === undefined) { idx = this.nextCarIndex++; this.carIndex.set(id, idx); }
      const template = this.assets?.carTemplate(idx) ?? null;
      // NOTE: keep in sync with editor-main.ts placement. buildCar returns a model that may
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

    for (const c of snap.cars) {
      const wrapper = this.ensureCar(c.id, c.color);
      if (this.path) {
        // Map straight sim (z=distance, x=lane offset) onto the curve. Scale x by laneScale so cars
        // stay centered in widened lanes, and lift onto the track surface.
        const p = this.path.sample(c.z, c.x * this.surfaceOpts.laneScale);
        wrapper.position.set(p.pos.x, p.pos.y + 0.6, p.pos.z);   // p.pos.y carries the track height
        wrapper.rotation.y = p.headingY;   // face along the curve
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
    // Camera focus: in spectator mode, follow the LEADING car (front of the pack) so
    // the action is always on screen no matter which car is whose. Otherwise follow "my" car.
    let focus: typeof snap.cars[number] | undefined;
    if (this.spectator || !this.myId) {
      focus = snap.cars.length
        ? snap.cars.reduce((a, b) => (b.z > a.z ? b : a))   // furthest-ahead car
        : undefined;
    } else {
      focus = snap.cars.find(c => c.id === this.myId) ?? snap.cars[0];
    }
    const me = focus;
    const z = me ? me.z : 0;

    if (shouldCycleZones(this.lightingLocked)) {
      const theme = themeAtZ(z);
      const fog = this.scene.fog as THREE.FogExp2;
      fog.color.set(theme.fog);   // keep our gentle far-horizon density (don't pull from theme)
      (this.ground.material as THREE.MeshStandardMaterial).color.set(theme.ground);
      this.sun.color.set(theme.sun); this.sun.intensity = Math.max(1.4, theme.sunIntensity * 1.6);
      this.ambient.color.set(theme.sky);          // sky tint drives hemisphere fill
      this.ambient.groundColor.set(theme.ground);
      // Sky dome follows the camera and tints to the zone (top = sky, bottom = lighter haze).
      const skyU = (this.sky.material as THREE.ShaderMaterial).uniforms;
      (skyU.top!.value as THREE.Color).set(theme.sky);
      (skyU.bottom!.value as THREE.Color).set(theme.fog);
    }
    // Sun follows the action: aim its target at the car, and place the light a fixed distance away
    // ALONG sunDir so the golden-hour rake angle stays consistent and its shadow frustum tracks the
    // pack. (When zones cycle, sunDir is the default rake; when locked, setLighting set it.)
    const tgt = new THREE.Vector3(0, 0, z + 20);
    this.sun.target.position.copy(tgt); this.sun.target.updateMatrixWorld();
    this.sun.position.copy(tgt).addScaledVector(this.sunDir, 260);

    // Cinematic 3/4 chase: behind + above + slightly offset, looking down-track past the pack.
    const mx = me ? me.x : 0;
    if (this.path) {
      // Curve-aware chase: sample the curve behind the car and ahead of it, so the camera swings
      // through bends instead of pointing off the track. Same offsets as straight (24 back / 45
      // ahead / +10 lateral / height 9), just measured ALONG the curve.
      const eye = this.path.sample(z - 24, mx * 0.3 + 10);
      const look = this.path.sample(z + 45, mx * 0.4);
      // Offsets (9 up / 2.2 look-height) are relative to the track surface, so add its Y height.
      this.camera.position.set(eye.pos.x, eye.pos.y + 9, eye.pos.z);
      this.camera.lookAt(look.pos.x, look.pos.y + 2.2, look.pos.z);
    } else {
      this.camera.position.set(mx * 0.3 + 10, 9, z - 24);
      this.camera.lookAt(mx * 0.4, 2.2, z + 45);
    }
    // Sky dome rides with the camera so the horizon is always far away.
    this.sky.position.copy(this.camera.position);
    this.composer.render();
  }
}
