import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  DEFAULT_KARAOKE_VENUE,
  cloneKaraokeVenueConfig,
  isSafeKaraokeGlbBasename,
  karaokeVenueModel,
  parseKaraokeVenueConfig,
  type KaraokeCameraMode,
  type KaraokeTransform,
  type KaraokeVenueConfig,
  type KaraokeVenueRole,
} from '../../shared/karaoke-venue';
import {
  disposeKaraokeObjectResources,
  karaokeAssetManifest,
  karaokeDrumAnchor,
  normalizeKaraokeAsset,
} from '../karaoke/karaoke-assets';
import { karaokeCameraShot } from '../karaoke/karaoke-client-utils';
import { authHeaders, promptForToken } from './editor-auth';

type Selection = KaraokeVenueRole | 'highway';
type GizmoMode = 'translate' | 'rotate' | 'scale';

const ROLES: readonly KaraokeVenueRole[] = [
  'stage', 'lead-singer', 'backup-singer', 'drummer', 'guitarist',
];
const LABELS: Record<Selection, string> = {
  stage: 'Stage', 'lead-singer': 'Lead singer', 'backup-singer': 'Backup singer',
  drummer: 'Drummer', guitarist: 'Guitarist', highway: 'Lyric highway',
};

export class KaraokeVenueEditor {
  private config = cloneKaraokeVenueConfig(DEFAULT_KARAOKE_VENUE);
  private files: string[] = [];
  private loaded = false;
  private selected: Selection = 'stage';
  private cameraMode: KaraokeCameraMode = 'landscape';
  private selectedSpotlight = 0;
  private loadGeneration = new Map<KaraokeVenueRole, number>();
  private roots = new Map<KaraokeVenueRole, THREE.Group>();
  private visuals = new Map<KaraokeVenueRole, THREE.Object3D>();
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(39, 1, .03, 500);
  private renderer: THREE.WebGLRenderer;
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private loader = new GLTFLoader();
  private draco = new DRACOLoader();
  private drumAnchor = new THREE.Group();
  private highway = new THREE.Group();
  private lightRig = new THREE.Group();
  private status: HTMLElement;
  private panel: HTMLElement;
  private tree: HTMLElement;
  private stage: HTMLElement;
  private saveButton: HTMLButtonElement;
  private clock = new THREE.Clock();

  constructor(private root: HTMLElement) {
    this.root.innerHTML = `
      <div class="kve">
        <header class="kve-chrome"><strong>Voice Karaoke <span>Venue Editor</span></strong><a href="/editor">All editors</a>
          <a href="?game=karaoke&tool=timing">Word timing</a>
          <select id="kvRole" aria-label="Selected scene role">${[...ROLES, 'highway'].map(role => `<option value="${role}">${LABELS[role as Selection]}</option>`).join('')}</select>
          <button data-mode="translate" class="active">Move W</button><button data-mode="rotate">Rotate E</button><button data-mode="scale">Scale R</button>
          <button id="kvFrame">Frame</button><button id="kvReset">Reset</button><span class="grow"></span>
          <label class="camera-label">Camera <select id="kvCameraMode"><option value="landscape">Landscape</option><option value="compact">Compact</option><option value="portrait">Portrait</option></select></label>
          <button id="kvSetCamera">Set current camera</button><button id="kvCapturePreview">Capture preview</button><button id="kvHide">Hide UI</button>
          <i id="kvStatus" role="status" aria-live="polite">Loading venue...</i><button id="kvSave" class="save" disabled>Save venue</button>
        </header>
        <main id="kvStage"><div class="kve-preview"><label>Song time <input id="kvSongTime" type="range" min="0" max="45000" step="100" value="0"></label><label>Intensity <input id="kvIntensity" type="range" min="0" max="1" step="0.01" value="0.35"></label></div><div class="kve-hint">Drag to orbit, right-drag to pan, scroll to zoom. W/E/R changes the gizmo.</div></main>
        <nav id="kvTree" class="kve-chrome" aria-label="Karaoke scene tree"></nav>
        <aside id="kvPanel" class="kve-chrome"></aside>
        <button id="kvReveal" hidden>Show editor UI (H)</button>
      </div>`;
    this.injectStyles();
    this.status = this.required('#kvStatus');
    this.panel = this.required('#kvPanel');
    this.tree = this.required('#kvTree');
    this.stage = this.required('#kvStage');
    this.saveButton = this.required<HTMLButtonElement>('#kvSave');

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.stage.prepend(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x000d25);
    this.scene.fog = new THREE.FogExp2(0x000d25, .024);
    this.scene.add(new THREE.GridHelper(32, 32, 0x45506d, 0x18213a));
    this.scene.add(this.drumAnchor, this.highway, this.lightRig);
    this.drumAnchor.name = 'drum-anchor';
    this.highway.name = 'lyric-highway';
    this.buildHighway();
    this.createRoleRoots();

    this.camera.position.set(...this.config.cameras.landscape.position);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(...this.config.cameras.landscape.lookAt);
    this.orbit.enableDamping = true;
    this.orbit.zoomToCursor = true;
    this.orbit.update();
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.scene.add(this.gizmo);
    this.gizmo.addEventListener('dragging-changed', event => {
      this.orbit.enabled = !(event as unknown as { value: boolean }).value;
    });
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());
    this.draco.setDecoderPath('/draco/');
    this.loader.setDRACOLoader(this.draco);
    // Keep the compiled fallback scene usable even when the persistence API is unavailable.
    this.applyLighting();
    this.bindChrome();
    this.resize();
    this.select('stage', false);
    void this.load();
    this.renderer.setAnimationLoop(() => this.render());
    (window as unknown as { __karaokeVenueEditor?: KaraokeVenueEditor }).__karaokeVenueEditor = this;
  }

  snapshot(): KaraokeVenueConfig { return cloneKaraokeVenueConfig(this.config); }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Karaoke editor is missing ${selector}`);
    return element;
  }

  private createRoleRoots(): void {
    for (const role of ROLES) {
      const root = new THREE.Group();
      root.name = `editor-${role}`;
      root.userData.karaokeRole = role;
      (role === 'drummer' ? this.drumAnchor : this.scene).add(root);
      const fallback = this.fallback(role);
      root.add(fallback);
      this.roots.set(role, root);
      this.visuals.set(role, fallback);
    }
  }

  private bindChrome(): void {
    this.required<HTMLSelectElement>('#kvRole').onchange = event => this.select((event.target as HTMLSelectElement).value as Selection);
    this.required<HTMLSelectElement>('#kvCameraMode').onchange = event => {
      this.cameraMode = (event.target as HTMLSelectElement).value as KaraokeCameraMode;
      this.applyCamera();
      this.applyHighway();
      if (this.selected === 'highway') this.attachSelection();
      this.renderPanel();
    };
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      button.onclick = () => this.setGizmoMode(button.dataset.mode as GizmoMode);
    }
    this.required<HTMLButtonElement>('#kvFrame').onclick = () => this.frameSelection();
    this.required<HTMLButtonElement>('#kvReset').onclick = () => this.resetSelection();
    this.required<HTMLButtonElement>('#kvSetCamera').onclick = () => this.captureCamera();
    this.required<HTMLButtonElement>('#kvCapturePreview').onclick = () => this.capturePreview();
    this.required<HTMLButtonElement>('#kvHide').onclick = () => this.setUiHidden(true);
    this.required<HTMLButtonElement>('#kvReveal').onclick = () => this.setUiHidden(false);
    this.saveButton.onclick = () => void this.save();
    for (const id of ['#kvSongTime', '#kvIntensity']) {
      this.required<HTMLInputElement>(id).oninput = () => this.applyPreview();
    }
    addEventListener('resize', () => this.resize());
    addEventListener('keydown', event => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
      const key = event.key.toLowerCase();
      if (key === 'w') this.setGizmoMode('translate');
      else if (key === 'e') this.setGizmoMode('rotate');
      else if (key === 'r') this.setGizmoMode('scale');
      else if (key === 'f') this.frameSelection();
      else if (key === 'h') this.setUiHidden(!this.root.classList.contains('ui-hidden'));
    });
  }

  private async load(): Promise<void> {
    let venueApiReady = false;
    try {
      const venueResponse = await fetch('/api/karaoke-venue', { cache: 'no-store' });
      if (!venueResponse.ok) throw new Error(`venue request failed (${venueResponse.status})`);
      this.config = parseKaraokeVenueConfig(await venueResponse.json() as unknown);
      venueApiReady = true;
    } catch (error) {
      this.config = cloneKaraokeVenueConfig(DEFAULT_KARAOKE_VENUE);
      this.flash(`Using bundled venue: ${(error as Error).message}`, true);
    }
    try {
      const filesResponse = await fetch('/api/karaoke-asset-files', { cache: 'no-store' });
      if (!filesResponse.ok) throw new Error(`asset catalog failed (${filesResponse.status})`);
      const files = await filesResponse.json() as unknown;
      if (!Array.isArray(files) || files.some(file => !isSafeKaraokeGlbBasename(file))) throw new Error('asset catalog returned unsafe entries');
      this.files = [...new Set([
        ...(files as string[]), ...this.config.models.map(model => model.file),
      ])].sort((a, b) => a.localeCompare(b));
    } catch (error) {
      this.files = this.config.models.map(model => model.file).sort((a, b) => a.localeCompare(b));
      if (venueApiReady) this.flash(`Asset catalog unavailable: ${(error as Error).message}`, true);
    }
    this.applyAll();
    await Promise.all(ROLES.map(role => this.loadRole(role)));
    this.loaded = venueApiReady;
    this.saveButton.disabled = !venueApiReady;
    this.renderTree();
    this.renderPanel();
    if (venueApiReady) this.flash('Venue loaded', false);
    this.frameAll();
  }

  private async loadRole(role: KaraokeVenueRole): Promise<void> {
    const generation = (this.loadGeneration.get(role) ?? 0) + 1;
    this.loadGeneration.set(role, generation);
    const spec = karaokeAssetManifest(this.config).find(entry => entry.role === role)!;
    let visual: THREE.Object3D | null = null;
    try {
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const request = this.loader.loadAsync(spec.url).then(gltf => {
        if (expired) { disposeKaraokeObjectResources(gltf.scene); return null; }
        return gltf.scene;
      }).catch(() => null);
      const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { expired = true; resolve(null); }, 20_000); });
      const source = await Promise.race([request, timeout]);
      if (timer) clearTimeout(timer);
      if (source) visual = normalizeKaraokeAsset(spec, source);
    } catch { /* Procedural replacement below. */ }
    if (generation !== this.loadGeneration.get(role)) {
      if (visual) disposeKaraokeObjectResources(visual);
      return;
    }
    const root = this.roots.get(role)!;
    const prior = this.visuals.get(role);
    if (prior) { prior.removeFromParent(); disposeKaraokeObjectResources(prior); }
    const next = visual ?? this.fallback(role);
    root.add(next);
    this.visuals.set(role, next);
    root.userData.proceduralFallback = !visual;
    if (role === 'stage') this.applyDrumAnchor();
  }

  private fallback(role: KaraokeVenueRole): THREE.Object3D {
    const group = new THREE.Group();
    group.name = `procedural-${role}`;
    const material = new THREE.MeshStandardMaterial({
      color: role === 'stage' ? 0x222a43 : role === 'lead-singer' ? 0xef223a
        : role === 'backup-singer' ? 0xfd7685 : role === 'drummer' ? 0x2188ef : 0x3acefa,
      roughness: .46,
      metalness: role === 'stage' ? .62 : .18,
    });
    if (role === 'stage') {
      const deck = new THREE.Mesh(new THREE.BoxGeometry(14, .65, 8.9), material);
      deck.position.y = .325;
      group.add(deck);
    } else {
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(.34, 1.3, 6, 12), material);
      body.position.y = 1.05;
      const head = new THREE.Mesh(new THREE.SphereGeometry(.27, 16, 12), new THREE.MeshStandardMaterial({ color: 0xd8a27d }));
      head.position.y = 2;
      group.add(body, head);
    }
    return group;
  }

  private applyAll(): void {
    for (const role of ROLES) this.applyModelTransform(role);
    this.applyDrumAnchor();
    this.applyHighway();
    this.applyLighting();
    this.applyCamera();
    this.renderTree();
    this.renderPanel();
  }

  private applyModelTransform(role: KaraokeVenueRole): void {
    applyTransform(this.roots.get(role)!, karaokeVenueModel(this.config, role).transform);
  }

  private applyDrumAnchor(): void {
    const anchor = this.config.drumAnchor;
    let position = new THREE.Vector3(...anchor.manualPosition);
    if (anchor.mode === 'stage-node') {
      position = karaokeDrumAnchor(this.roots.get('stage')!, this.scene)
        ?? new THREE.Vector3(...anchor.fallbackPosition);
    }
    const transform = anchor.nodeTransform;
    this.drumAnchor.position.set(
      position.x + transform.position[0], position.y + transform.position[1], position.z + transform.position[2],
    );
    this.drumAnchor.rotation.set(...transform.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]);
    this.drumAnchor.scale.set(...transform.scale);
    this.drumAnchor.updateMatrixWorld(true);
  }

  private buildHighway(): void {
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(8.7, 10.4),
      new THREE.MeshStandardMaterial({ color: 0x081a35, emissive: 0x041126, transparent: true, opacity: .78, side: THREE.DoubleSide }),
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.set(0, .08, 1.45);
    this.highway.add(surface);
    for (let lane = 0; lane <= 4; lane++) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(.025, .025, 10.2), new THREE.MeshBasicMaterial({ color: 0x66728d }));
      line.position.set((lane - 2) * 2.1, .1, 1.45);
      this.highway.add(line);
    }
  }

  private applyHighway(): void {
    applyTransform(this.highway, this.highwayTransform());
  }

  private highwayTransform(): KaraokeTransform {
    return this.cameraMode === 'portrait' ? this.config.highway.portrait : this.config.highway.landscape;
  }

  private applyLighting(): void {
    this.lightRig.traverse(object => {
      if (object instanceof THREE.SpotLight) object.dispose();
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
    for (const child of [...this.lightRig.children]) child.removeFromParent();
    const lighting = this.config.lighting;
    this.lightRig.add(new THREE.HemisphereLight(lighting.ambient.skyColor, lighting.ambient.groundColor, lighting.ambient.intensity));
    const directional = new THREE.DirectionalLight(lighting.directional.color, lighting.directional.intensity);
    directional.position.set(...lighting.directional.position);
    this.lightRig.add(directional);
    for (const spec of lighting.spotlights) {
      const spot = new THREE.SpotLight(spec.color, spec.intensity, spec.distance, THREE.MathUtils.degToRad(spec.angleDeg), spec.penumbra, spec.decay);
      spot.name = spec.id;
      spot.position.set(...spec.position);
      spot.target.position.set(...spec.target);
      this.lightRig.add(spot, spot.target);
      const marker = new THREE.Mesh(new THREE.SphereGeometry(.11, 8, 6), new THREE.MeshBasicMaterial({ color: spec.color }));
      marker.position.set(...spec.position);
      marker.name = `${spec.id}-marker`;
      this.lightRig.add(marker);
    }
  }

  private applyCamera(): void {
    const pose = this.config.cameras[this.cameraMode];
    this.camera.position.set(...pose.position);
    this.camera.fov = pose.fov;
    this.orbit.target.set(...pose.lookAt);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }

  private applyPreview(): void {
    const songTime = Number(this.required<HTMLInputElement>('#kvSongTime').value);
    const intensity = Number(this.required<HTMLInputElement>('#kvIntensity').value);
    const aspect = this.cameraMode === 'portrait' ? .6 : this.cameraMode === 'compact' ? 1 : 16 / 9;
    const shot = karaokeCameraShot(aspect, songTime, intensity, this.config.cameras);
    this.camera.position.set(...shot.position);
    this.camera.fov = shot.fov;
    this.orbit.target.set(...shot.lookAt);
    this.camera.updateProjectionMatrix();
    const elapsed = songTime / 1000;
    this.lightRig.traverse(object => {
      if (!(object instanceof THREE.SpotLight)) return;
      const spec = this.config.lighting.spotlights.find(entry => entry.id === object.name);
      if (spec) object.intensity = Math.max(0, spec.intensity * (.58 + intensity * 1.48) + Math.sin(elapsed * 1.2) * spec.intensity * .14);
    });
  }

  private select(selection: Selection, frame = true): void {
    this.selected = selection;
    this.required<HTMLSelectElement>('#kvRole').value = selection;
    this.attachSelection();
    this.renderTree();
    this.renderPanel();
    if (frame) this.frameSelection();
  }

  private attachSelection(): void {
    this.gizmo.attach(this.selected === 'highway' ? this.highway : this.roots.get(this.selected)!);
  }

  private setGizmoMode(mode: GizmoMode): void {
    this.gizmo.setMode(mode);
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-mode]')) {
      button.classList.toggle('active', button.dataset.mode === mode);
    }
  }

  private onGizmoChange(): void {
    const object = this.selected === 'highway' ? this.highway : this.roots.get(this.selected)!;
    if (this.gizmo.getMode() === 'scale') {
      object.scale.set(Math.max(.001, object.scale.x), Math.max(.001, object.scale.y), Math.max(.001, object.scale.z));
    }
    const next = transformFrom(object);
    if (this.selected === 'highway') Object.assign(this.highwayTransform(), next);
    else Object.assign(karaokeVenueModel(this.config, this.selected).transform, next);
    if (this.selected === 'stage') this.applyDrumAnchor();
    this.syncTransformInputs();
  }

  private renderTree(): void {
    this.tree.innerHTML = `<h3>Scene</h3>${[...ROLES, 'highway'].map(role => `<button data-tree-role="${role}" class="${this.selected === role ? 'selected' : ''}"><span>${LABELS[role as Selection]}</span><small>${role === 'highway' ? this.cameraMode : this.roots.get(role as KaraokeVenueRole)?.userData.proceduralFallback ? 'procedural fallback' : karaokeVenueModel(this.config, role as KaraokeVenueRole).file}</small></button>`).join('')}`;
    for (const button of this.tree.querySelectorAll<HTMLButtonElement>('[data-tree-role]')) {
      button.onclick = () => this.select(button.dataset.treeRole as Selection);
    }
  }

  private renderPanel(): void {
    const transform = this.selected === 'highway'
      ? this.highwayTransform()
      : karaokeVenueModel(this.config, this.selected).transform;
    const model = this.selected === 'highway' ? null : karaokeVenueModel(this.config, this.selected);
    const camera = this.config.cameras[this.cameraMode];
    const drum = this.config.drumAnchor;
    const ambient = this.config.lighting.ambient;
    const spotlight = this.config.lighting.spotlights[this.selectedSpotlight] ?? this.config.lighting.spotlights[0]!;
    this.panel.innerHTML = `
      <h2>${LABELS[this.selected]}</h2>
      ${model ? `<label>GLB file<select id="kvFile">${this.files.map(file => `<option value="${file}"${file === model.file ? ' selected' : ''}>${file}</option>`).join('')}</select></label>` : '<p>Highway transform follows the selected landscape/compact or portrait mode.</p>'}
      <h3>Position</h3>${vectorFields('pos', transform.position, .1)}
      <h3>Rotation, degrees</h3>${vectorFields('rot', transform.rotation, 1)}
      <h3>Scale</h3>${vectorFields('scale', transform.scale, .05, .001)}
      <h3>Camera: ${this.cameraMode}</h3>
      <label>FOV<input id="kvFov" type="number" min="10" max="120" step="1" value="${round(camera.fov)}"></label>
      <p>Orbit to a view and use Set current camera in the toolbar. Song preview adds choreography to this saved base.</p>
      <h3>Drum anchor</h3>
      <label>Mode<select id="kvDrumMode"><option value="stage-node"${drum.mode === 'stage-node' ? ' selected' : ''}>Stage node: batteria</option><option value="manual"${drum.mode === 'manual' ? ' selected' : ''}>Manual</option></select></label>
      <h4>Manual position</h4>${plainVectorFields('drum-manual', drum.manualPosition, .1)}
      <h4>Missing-node fallback</h4>${plainVectorFields('drum-fallback', drum.fallbackPosition, .1)}
      <h4>Node offset</h4>${plainVectorFields('drum-node-pos', drum.nodeTransform.position, .1)}
      <h4>Node rotation</h4>${plainVectorFields('drum-node-rot', drum.nodeTransform.rotation, 1)}
      <h4>Node scale</h4>${plainVectorFields('drum-node-scale', drum.nodeTransform.scale, .05, .001)}
      <h3>Light rig</h3>
      <label>Sky color<input id="kvSky" type="color" value="${ambient.skyColor}"></label><label>Ground color<input id="kvGround" type="color" value="${ambient.groundColor}"></label><label>Ambient intensity<input id="kvAmbient" type="number" min="0" max="20" step=".1" value="${ambient.intensity}"></label>
      <label>Directional color<input id="kvDirectionalColor" type="color" value="${this.config.lighting.directional.color}"></label><label>Directional intensity<input id="kvDirectionalIntensity" type="number" min="0" max="100" step=".1" value="${this.config.lighting.directional.intensity}"></label>
      <h4>Directional position</h4>${plainVectorFields('directional-pos', this.config.lighting.directional.position, .1)}
      <label>Spotlight<select id="kvSpot">${this.config.lighting.spotlights.map((entry, index) => `<option value="${index}"${index === this.selectedSpotlight ? ' selected' : ''}>${entry.id}</option>`).join('')}</select></label>
      <label>Color<input id="kvSpotColor" type="color" value="${spotlight.color}"></label><label>Intensity<input id="kvSpotIntensity" type="number" min="0" max="500" step="1" value="${spotlight.intensity}"></label><label>Distance<input id="kvSpotDistance" type="number" min=".1" max="500" step=".5" value="${spotlight.distance}"></label><label>Angle degrees<input id="kvSpotAngle" type="number" min="1" max="89" step="1" value="${spotlight.angleDeg}"></label><label>Penumbra<input id="kvSpotPenumbra" type="number" min="0" max="1" step=".05" value="${spotlight.penumbra}"></label><label>Decay<input id="kvSpotDecay" type="number" min="0" max="4" step=".05" value="${spotlight.decay}"></label><label>Beam opacity<input id="kvBeam" type="number" min="0" max="1" step=".01" value="${spotlight.beamOpacity}"></label>
      <h4>Spot position</h4>${plainVectorFields('spot-pos', spotlight.position, .1)}
      <h4>Spot target</h4>${plainVectorFields('spot-target', spotlight.target, .1)}`;
    this.bindPanel(transform, model, camera, drum, ambient, spotlight);
  }

  private bindPanel(
    transform: KaraokeTransform,
    model: ReturnType<typeof karaokeVenueModel> | null,
    camera: KaraokeVenueConfig['cameras'][KaraokeCameraMode],
    drum: KaraokeVenueConfig['drumAnchor'],
    ambient: KaraokeVenueConfig['lighting']['ambient'],
    spotlight: KaraokeVenueConfig['lighting']['spotlights'][number],
  ): void {
    this.panel.querySelector<HTMLSelectElement>('#kvFile')?.addEventListener('change', event => {
      if (!model) return;
      model.file = (event.target as HTMLSelectElement).value;
      void this.loadRole(model.role).then(() => { this.renderTree(); this.frameSelection(); });
    });
    bindVector(this.panel, 'pos', transform.position, () => this.applySelectedTransform());
    bindVector(this.panel, 'rot', transform.rotation, () => this.applySelectedTransform());
    bindVector(this.panel, 'scale', transform.scale, () => this.applySelectedTransform(), true);
    this.bindNumber('kvFov', value => { camera.fov = value; this.camera.fov = value; this.camera.updateProjectionMatrix(); }, 10, 120);
    this.panel.querySelector<HTMLSelectElement>('#kvDrumMode')!.onchange = event => { drum.mode = (event.target as HTMLSelectElement).value as typeof drum.mode; this.applyDrumAnchor(); };
    bindVector(this.panel, 'drum-manual', drum.manualPosition, () => this.applyDrumAnchor());
    bindVector(this.panel, 'drum-fallback', drum.fallbackPosition, () => this.applyDrumAnchor());
    bindVector(this.panel, 'drum-node-pos', drum.nodeTransform.position, () => this.applyDrumAnchor());
    bindVector(this.panel, 'drum-node-rot', drum.nodeTransform.rotation, () => this.applyDrumAnchor());
    bindVector(this.panel, 'drum-node-scale', drum.nodeTransform.scale, () => this.applyDrumAnchor(), true);
    this.panel.querySelector<HTMLInputElement>('#kvSky')!.oninput = event => { ambient.skyColor = (event.target as HTMLInputElement).value; this.applyLighting(); };
    this.panel.querySelector<HTMLInputElement>('#kvGround')!.oninput = event => { ambient.groundColor = (event.target as HTMLInputElement).value; this.applyLighting(); };
    this.bindNumber('kvAmbient', value => { ambient.intensity = value; this.applyLighting(); }, 0, 20);
    const directional = this.config.lighting.directional;
    this.panel.querySelector<HTMLInputElement>('#kvDirectionalColor')!.oninput = event => { directional.color = (event.target as HTMLInputElement).value; this.applyLighting(); };
    this.bindNumber('kvDirectionalIntensity', value => { directional.intensity = value; this.applyLighting(); }, 0, 100);
    bindVector(this.panel, 'directional-pos', directional.position, () => this.applyLighting());
    this.panel.querySelector<HTMLSelectElement>('#kvSpot')!.onchange = event => { this.selectedSpotlight = Number((event.target as HTMLSelectElement).value); this.renderPanel(); };
    this.panel.querySelector<HTMLInputElement>('#kvSpotColor')!.oninput = event => { spotlight.color = (event.target as HTMLInputElement).value; this.applyLighting(); };
    this.bindNumber('kvSpotIntensity', value => { spotlight.intensity = value; this.applyLighting(); }, 0, 500);
    this.bindNumber('kvSpotDistance', value => { spotlight.distance = value; this.applyLighting(); }, .1, 500);
    this.bindNumber('kvSpotAngle', value => { spotlight.angleDeg = value; this.applyLighting(); }, 1, 89);
    this.bindNumber('kvSpotPenumbra', value => { spotlight.penumbra = value; this.applyLighting(); }, 0, 1);
    this.bindNumber('kvSpotDecay', value => { spotlight.decay = value; this.applyLighting(); }, 0, 4);
    this.bindNumber('kvBeam', value => { spotlight.beamOpacity = value; this.applyLighting(); }, 0, 1);
    bindVector(this.panel, 'spot-pos', spotlight.position, () => this.applyLighting());
    bindVector(this.panel, 'spot-target', spotlight.target, () => this.applyLighting());
  }

  private bindNumber(id: string, set: (value: number) => void, min: number, max: number): void {
    this.panel.querySelector<HTMLInputElement>(`#${id}`)!.oninput = event => {
      const value = Number((event.target as HTMLInputElement).value);
      if (Number.isFinite(value)) set(THREE.MathUtils.clamp(value, min, max));
    };
  }

  private applySelectedTransform(): void {
    if (this.selected === 'highway') this.applyHighway();
    else {
      this.applyModelTransform(this.selected);
      if (this.selected === 'stage') this.applyDrumAnchor();
    }
  }

  private syncTransformInputs(): void {
    const transform = this.selected === 'highway' ? this.highwayTransform() : karaokeVenueModel(this.config, this.selected).transform;
    for (const [prefix, values] of [['pos', transform.position], ['rot', transform.rotation], ['scale', transform.scale]] as const) {
      (['x', 'y', 'z'] as const).forEach((axis, index) => {
        const input = this.panel.querySelector<HTMLInputElement>(`#kv-${prefix}-${axis}`);
        if (input) input.value = String(round(values[index]!));
      });
    }
  }

  private resetSelection(): void {
    const defaults = cloneKaraokeVenueConfig(DEFAULT_KARAOKE_VENUE);
    const source = this.selected === 'highway'
      ? (this.cameraMode === 'portrait' ? defaults.highway.portrait : defaults.highway.landscape)
      : karaokeVenueModel(defaults, this.selected).transform;
    const target = this.selected === 'highway' ? this.highwayTransform() : karaokeVenueModel(this.config, this.selected).transform;
    Object.assign(target, cloneTransform(source));
    this.applySelectedTransform();
    this.renderPanel();
    this.flash(`${LABELS[this.selected]} transform reset`, false);
  }

  private captureCamera(): void {
    const pose = this.config.cameras[this.cameraMode];
    pose.position = roundVector(this.camera.position);
    pose.lookAt = roundVector(this.orbit.target);
    pose.fov = round(this.camera.fov);
    this.renderPanel();
    this.flash(`${this.cameraMode} camera captured`, false);
  }

  private capturePreview(): void {
    const visible = this.gizmo.visible;
    this.gizmo.visible = false;
    this.renderer.render(this.scene, this.camera);
    this.renderer.domElement.toBlob(blob => {
      this.gizmo.visible = visible;
      if (!blob) { this.flash('Preview capture failed', true); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `karaoke-venue-${this.cameraMode}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.flash('Preview downloaded', false);
    }, 'image/png');
  }

  private frameSelection(): void {
    const object = this.selected === 'highway' ? this.highway : this.roots.get(this.selected)!;
    this.frameBox(new THREE.Box3().setFromObject(object));
  }

  private frameAll(): void {
    const box = new THREE.Box3();
    for (const root of this.roots.values()) box.expandByObject(root);
    box.expandByObject(this.highway);
    this.frameBox(box);
  }

  private frameBox(box: THREE.Box3): void {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * .5 || 2;
    const distance = Math.max(2, radius / Math.tan(THREE.MathUtils.degToRad(this.camera.fov * .5)) * 1.35);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(.55, .4, 1).normalize().multiplyScalar(distance));
    this.orbit.update();
  }

  private setUiHidden(hidden: boolean): void {
    this.root.classList.toggle('ui-hidden', hidden);
    this.required<HTMLButtonElement>('#kvReveal').hidden = !hidden;
    this.resize();
  }

  private async save(): Promise<void> {
    if (!this.loaded) { this.flash('Cannot save until the venue finishes loading', true); return; }
    let valid: KaraokeVenueConfig;
    try { valid = parseKaraokeVenueConfig(this.config); }
    catch (error) { this.flash(`Cannot save: ${(error as Error).message}`, true); return; }
    const post = () => fetch('/api/karaoke-venue', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(valid),
    });
    this.saveButton.disabled = true;
    try {
      let response = await post();
      if (response.status === 401 && promptForToken()) response = await post();
      if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
      parseKaraokeVenueConfig(await response.json() as unknown);
      this.flash('Venue saved', false);
    } catch (error) {
      this.flash(`Save failed: ${(error as Error).message}`, true);
    } finally {
      this.saveButton.disabled = !this.loaded;
    }
  }

  private resize(): void {
    const width = Math.max(1, this.stage.clientWidth);
    const height = Math.max(1, this.stage.clientHeight);
    this.renderer?.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private render(): void {
    this.clock.getDelta();
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  }

  private flash(message: string, error: boolean): void {
    this.status.textContent = message;
    this.status.classList.toggle('error', error);
  }

  private injectStyles(): void {
    if (document.getElementById('karaoke-venue-editor-styles')) return;
    const style = document.createElement('style');
    style.id = 'karaoke-venue-editor-styles';
    style.textContent = `
      .kve{position:fixed;inset:0;background:#000d25;color:#fff;font:13px system-ui,sans-serif;overflow:hidden}.kve button,.kve select,.kve input{font:inherit}.kve header{position:absolute;z-index:8;top:0;left:0;right:0;height:50px;display:flex;align-items:center;gap:7px;padding:0 12px;background:#11182bea;border-bottom:1px solid #36415d}.kve header strong{font-size:15px}.kve header strong span{color:#fd7685}.kve header a{color:#3acefa;text-decoration:none}.kve header .grow{flex:1}.kve button,.kve select,.kve input{color:#fff;background:#222d48;border:1px solid #46526f;border-radius:6px;padding:6px 8px}.kve button{cursor:pointer}.kve button.active,.kve .save{background:#ef223a;border-color:#ef223a;font-weight:750}.kve button:disabled{opacity:.45;cursor:not-allowed}.kve header i{max-width:220px;color:#36e08a;font-style:normal;font-size:11px}.kve header i.error{color:#ff9aa8}.kve .camera-label{display:flex;gap:5px;align-items:center}.kve main{position:absolute;top:50px;left:205px;right:320px;bottom:0}.kve canvas{display:block;width:100%;height:100%}.kve-preview{position:absolute;z-index:3;top:10px;left:10px;display:flex;gap:12px;padding:8px 10px;background:#060b17d9;border:1px solid #34415f;border-radius:8px}.kve-preview label{display:flex;gap:6px;align-items:center}.kve-preview input{width:105px;padding:0;accent-color:#ef223a}.kve-hint{position:absolute;z-index:3;left:12px;bottom:12px;padding:7px 10px;background:#060b17c9;color:#aeb7ca;border-radius:7px}.kve nav{position:absolute;z-index:5;top:50px;left:0;bottom:0;width:181px;padding:12px;background:#11182bea;border-right:1px solid #36415d;overflow:auto}.kve nav h3,.kve aside h3{margin:9px 0 6px;color:#91a0bc;text-transform:uppercase;letter-spacing:.08em;font-size:10px}.kve nav button{display:flex;width:100%;flex-direction:column;align-items:flex-start;gap:2px;margin:3px 0;text-align:left}.kve nav button.selected{background:#293e70;border-color:#3acefa}.kve nav small{color:#8f9ab0;max-width:100%;overflow:hidden;text-overflow:ellipsis}.kve aside{position:absolute;z-index:5;top:50px;right:0;bottom:0;width:292px;padding:14px;background:#11182bf2;border-left:1px solid #36415d;overflow:auto}.kve aside h2{margin:0 0 10px;font-size:18px}.kve aside h4{margin:9px 0 3px;color:#aab4c8;font-size:11px}.kve aside label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0}.kve aside label>input,.kve aside label>select{width:145px;box-sizing:border-box}.kve aside .vec{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.kve aside .vec label{display:block;margin:0;color:#8996ad;font-size:10px}.kve aside .vec input{display:block;width:100%;box-sizing:border-box;margin-top:2px}.kve aside p{color:#929eb5;font-size:11px;line-height:1.45}.kve #kvReveal{position:fixed;z-index:20;top:10px;right:10px;background:#ef223a}.ui-hidden .kve-chrome,.ui-hidden .kve-preview,.ui-hidden .kve-hint{display:none}.ui-hidden .kve main{inset:0}
      @media(max-width:1050px){.kve header strong span,.kve header .camera-label{display:none}.kve header{overflow-x:auto}.kve main{left:0;right:280px}.kve nav{top:60px;width:155px;height:auto;bottom:auto;max-height:38vh;border:1px solid #36415d}.kve aside{width:252px}.kve header i{display:none}}
      @media(max-width:700px){.kve header{height:92px;align-content:center;flex-wrap:wrap}.kve main{top:92px;right:0;bottom:42vh}.kve nav{top:92px;width:128px;max-height:30vh}.kve aside{top:58vh;left:0;right:0;bottom:0;width:auto;border-left:0;border-top:1px solid #36415d}.kve-preview{right:8px;left:auto;flex-direction:column}.kve-preview input{width:90px}}`;
    document.head.append(style);
  }
}

function vectorFields(prefix: string, vector: readonly number[], step: number, min?: number): string {
  return `<div class="vec">${(['x', 'y', 'z'] as const).map((axis, index) => `<label>${axis.toUpperCase()}<input id="kv-${prefix}-${axis}" data-vector="${prefix}" data-axis="${index}" type="number" step="${step}"${min === undefined ? '' : ` min="${min}"`} value="${round(vector[index]!)}"></label>`).join('')}</div>`;
}

function plainVectorFields(prefix: string, vector: readonly number[], step: number, min?: number): string {
  return vectorFields(prefix, vector, step, min);
}

function bindVector(host: HTMLElement, prefix: string, vector: [number, number, number], apply: () => void, positive = false): void {
  for (const input of host.querySelectorAll<HTMLInputElement>(`[data-vector="${prefix}"]`)) {
    input.oninput = () => {
      const value = Number(input.value);
      const axis = Number(input.dataset.axis);
      if (!Number.isFinite(value) || axis < 0 || axis > 2) return;
      vector[axis] = positive ? Math.max(.001, value) : value;
      apply();
    };
  }
}

function applyTransform(object: THREE.Object3D, transform: KaraokeTransform): void {
  object.position.set(...transform.position);
  object.rotation.set(...transform.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]);
  object.scale.set(...transform.scale);
  object.updateMatrixWorld(true);
}

function transformFrom(object: THREE.Object3D): KaraokeTransform {
  return {
    position: roundVector(object.position),
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z].map(value => round(THREE.MathUtils.radToDeg(value))) as [number, number, number],
    scale: roundVector(object.scale),
  };
}

function roundVector(vector: THREE.Vector3): [number, number, number] {
  return [round(vector.x), round(vector.y), round(vector.z)];
}

function round(value: number): number { return Math.round(value * 1000) / 1000; }

function cloneTransform(transform: KaraokeTransform): KaraokeTransform {
  return { position: [...transform.position], rotation: [...transform.rotation], scale: [...transform.scale] };
}
