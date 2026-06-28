import * as THREE from 'three';
import { TRACK_W, TRACK_LEN, LANES, laneX } from '../shared/constants';
import type { WorldSnapshot, Item } from '../shared/types';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { AssetLoader } from './asset-loader';
import { buildCar } from './car-factory';
import { themeAtZ } from '../shared/zones';

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

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  private sky!: THREE.Mesh;            // gradient sky dome; tinted each frame

  /** Build the static world: sky dome, terrain, asphalt track, markings, curbs, start gantry. */
  private buildWorld(): void {
    const FULL_LEN = TRACK_LEN * 3;          // covers all laps of travel
    const midZ = TRACK_LEN;

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
    this.ground.receiveShadow = true; this.scene.add(this.ground);

    // Asphalt track surface.
    const asphalt = new THREE.Mesh(
      new THREE.PlaneGeometry(TRACK_W, FULL_LEN),
      new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.95, metalness: 0.0 }));
    asphalt.rotation.x = -Math.PI / 2; asphalt.position.set(0, 0, midZ);
    asphalt.receiveShadow = true; this.scene.add(asphalt);

    // Dashed white lane dividers (between the lanes).
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xeef2ff, roughness: 0.6 });
    for (let lane = 1; lane < LANES; lane++) {
      const x = TRACK_W / 2 - (TRACK_W / LANES) * lane;   // divider between lane-1 and lane
      for (let z = -TRACK_LEN; z < FULL_LEN; z += 14) {
        const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 6), dashMat);
        dash.rotation.x = -Math.PI / 2; dash.position.set(x, 0.02, z);
        this.scene.add(dash);
      }
    }

    // Solid edge lines + raised curbs on both sides.
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xeef2ff, roughness: 0.6 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xef223a, roughness: 0.7, emissive: 0x300008 });
    for (const side of [-1, 1]) {
      const ex = side * (TRACK_W / 2 - 0.3);
      const edge = new THREE.Mesh(new THREE.PlaneGeometry(0.5, FULL_LEN), edgeMat);
      edge.rotation.x = -Math.PI / 2; edge.position.set(ex, 0.02, midZ); this.scene.add(edge);
      const curb = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, FULL_LEN),
        curbMat);
      curb.position.set(side * (TRACK_W / 2 + 0.4), 0.25, midZ);
      curb.castShadow = true; curb.receiveShadow = true; this.scene.add(curb);
    }

    // Start/finish gantry at z=0.
    const postMat = new THREE.MeshStandardMaterial({ color: 0x10141c, roughness: 0.6, metalness: 0.3 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.2, 12, 1.2), postMat);
      post.position.set(side * (TRACK_W / 2 + 1.5), 6, 0); post.castShadow = true; this.scene.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W + 6, 2.4, 1.4), postMat);
    beam.position.set(0, 11, 0); beam.castShadow = true; this.scene.add(beam);
    // "FINISH" banner on the beam — emissive so it's bright and readable in any zone.
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W + 5, 2),
      new THREE.MeshStandardMaterial({ color: 0xef223a, emissive: 0xef223a, emissiveIntensity: 0.6,
        side: THREE.DoubleSide }));
    banner.position.set(0, 11, 0.8); this.scene.add(banner);
  }

  setMyId(id: string) { this.myId = id; }

  buildItems(items: Item[]) {
    for (const { mesh } of this.itemMeshes) this.scene.remove(mesh);
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
      mesh.position.set(laneX(item.lane), y, item.z);
      this.scene.add(mesh);
      return { mesh, item };
    });
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
      wrapper = new THREE.Group();
      wrapper.add(model);
      wrapper.userData.model = model;
      this.scene.add(wrapper); this.carMeshes.set(id, wrapper);
    }
    return wrapper;
  }

  render(snap: WorldSnapshot) {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;

    for (const c of snap.cars) {
      const wrapper = this.ensureCar(c.id, c.color);
      wrapper.position.set(c.x, 0, c.z);
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
    const me = snap.cars.find(c => c.id === this.myId) ?? snap.cars[0];
    const z = me ? me.z : 0;

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
    // Keep the shadow frustum + sky following the action.
    this.sun.position.set(60, 110, z + 40);
    this.sun.target.position.set(0, 0, z + 20); this.sun.target.updateMatrixWorld();

    // Cinematic 3/4 chase: behind + above + slightly offset, looking down-track past the pack.
    const mx = me ? me.x : 0;
    this.camera.position.set(mx * 0.3 + 10, 9, z - 24);
    this.camera.lookAt(mx * 0.4, 2.2, z + 45);
    // Sky dome rides with the camera so the horizon is always far away.
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}
