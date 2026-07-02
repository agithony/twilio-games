// The 3D battle arena that sits BEHIND the 2D Game Boy overlay. A slowly-spinning turntable of the
// arena model (three.js), rendered into its own WebGL canvas layered under the pixel-art battle
// canvas — the monsters + HP boxes draw over it, the command window is an opaque panel at the bottom.
// Transform/camera/spin come from an ArenaConfig (authored later in the multi-game editor); sensible
// defaults auto-frame the model so it looks right with zero config.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

export interface ArenaConfig {
  file: string;                 // under /assets/arena/
  pos?: [number, number, number];
  rotDeg?: [number, number, number];
  scale?: number;
  spinSpeed?: number;           // turntable radians/sec (0 = static). Default a slow spin.
  cam?: { pos: [number, number, number]; lookAt: [number, number, number]; fov?: number };
}

export class ArenaBackground {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private turntable = new THREE.Group();   // the arena is parented here; we spin THIS
  private raf = 0;
  private last = performance.now();
  private spinSpeed = 0.18;                 // slow, cinematic default
  private disposed = false;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setClearColor(0x0b1a0c, 1);          // deep GB-green void behind the arena
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(0, 3, 8);
    this.scene.add(this.turntable);
    // Lighting: a warm key + cool fill + hemisphere so the arena reads without a PMREM env (cheap).
    const key = new THREE.DirectionalLight(0xfff2d8, 2.0); key.position.set(6, 10, 6); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.7); fill.position.set(-6, 4, -4); this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0xdff0ff, 0x24401c, 0.9));
    this.resize();
    window.addEventListener('resize', this.resize);
    this.loop();
  }

  /** Load + place the arena. Auto-frames the camera on the model's bounds unless cfg.cam is given. */
  load(cfg: ArenaConfig): void {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    loader.setDRACOLoader(draco);
    this.spinSpeed = cfg.spinSpeed ?? this.spinSpeed;
    loader.load(`/assets/arena/${cfg.file}`, (gltf) => {
      if (this.disposed) return;
      const model = gltf.scene;
      // Recenter the model on its own footprint so the turntable spins about its center, not a corner.
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      model.position.sub(center);
      if (cfg.pos) model.position.add(new THREE.Vector3(...cfg.pos));
      if (cfg.rotDeg) model.rotation.set(...cfg.rotDeg.map(d => (d * Math.PI) / 180) as [number, number, number]);
      if (cfg.scale) model.scale.setScalar(cfg.scale);
      this.turntable.add(model);
      // Auto-frame: pull the camera back to fit the model, angled down slightly (arena look).
      if (cfg.cam) {
        this.camera.fov = cfg.cam.fov ?? 45;
        this.camera.position.set(...cfg.cam.pos);
        this.camera.lookAt(new THREE.Vector3(...cfg.cam.lookAt));
      } else {
        const r = Math.max(size.x, size.y, size.z) * (cfg.scale ?? 1);
        const dist = r * 1.4 + 2;
        this.camera.position.set(0, r * 0.5, dist);
        this.camera.lookAt(0, 0, 0);
      }
      this.camera.updateProjectionMatrix();
    }, undefined, () => { /* load failed → the green void remains as a fallback backdrop */ });
  }

  private resize = (): void => {
    const w = this.host.clientWidth || 640, h = this.host.clientHeight || 640;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1); this.last = now;
    this.turntable.rotation.y += this.spinSpeed * dt;   // the turntable spin
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
