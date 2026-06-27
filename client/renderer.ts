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
  private ambient: THREE.AmbientLight;
  private ground: THREE.Mesh;

  constructor(mount: HTMLElement, private assets?: AssetLoader) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    mount.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0b1020);
    this.scene.fog = new THREE.FogExp2(0x0b1020, 0.01);
    this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 2000);

    this.sun = new THREE.DirectionalLight(0xfff6e6, 1.2);
    this.sun.position.set(40, 80, -20); this.sun.castShadow = true; this.scene.add(this.sun);
    this.ambient = new THREE.AmbientLight(0x5566aa, 0.6); this.scene.add(this.ambient);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W, TRACK_LEN * 3),
      new THREE.MeshStandardMaterial({ color: 0x1a2238 }));
    this.ground.rotation.x = -Math.PI / 2; this.ground.position.z = TRACK_LEN; this.scene.add(this.ground);

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
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
    (this.scene.background as THREE.Color).set(theme.sky);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.set(theme.fog); fog.density = theme.fogDensity;
    (this.ground.material as THREE.MeshStandardMaterial).color.set(theme.ground);
    this.sun.color.set(theme.sun); this.sun.intensity = theme.sunIntensity;
    this.ambient.color.set(theme.ambient);

    this.camera.position.set(13, 15, z - 30);
    this.camera.lookAt(me ? me.x * 0.4 : 0, 1.5, z + 26);
    this.renderer.render(this.scene, this.camera);
  }
}
