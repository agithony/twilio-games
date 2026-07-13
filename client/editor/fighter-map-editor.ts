import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { FighterMapEntry } from '../../shared/fighter-roster';
import { authHeaders, promptForToken } from './editor-auth';
import { loadFbx, prepareFighterModel, retargetClipNames } from '../fighter/fighter-assets';

const DEFAULT_MAP = (): FighterMapEntry => ({
  id: `map-${Date.now()}`, name: 'New Fighter Map', blurb: 'A custom battleground.', color: '#ef223a',
  bounds: [-9, 9], floorY: 0, pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1,
  fightPlane: { origin: [0, 0, 0], rotationY: 0 },
  camera: { pos: [0, 2.15, 10.5], lookAt: [0, 1.25, 0], fov: 36 },
});

export class FighterMapEditor {
  private maps: FighterMapEntry[] = [];
  private files: string[] = [];
  private index = 0;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.05, 2000);
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private gizmoTarget: 'map' | 'plane' | 'left' | 'right' = 'map';
  private model: THREE.Object3D | null = null;
  private leftBoundary: THREE.Mesh;
  private rightBoundary: THREE.Mesh;
  private boundaryGroup = new THREE.Group();
  private grid: THREE.GridHelper;
  private status: HTMLElement;
  private fighterPreview: THREE.Group | null = null;
  private fighterMixer: THREE.AnimationMixer | null = null;
  private showFighter = false;
  private loadedFile: string | null = null;
  private loadGeneration = 0;
  private catalogLoaded = false;

  constructor(private root: HTMLElement) {
    root.innerHTML = `<div class="fme"><header><strong>Voice Fighter — Map Editor</strong><a href="/editor">◂ All editors</a><select id="fmeMap"></select><button id="fmeNew">New map</button><span></span><i id="fmeStatus"></i><button class="save" id="fmeSave">Save maps</button></header><main id="fmeStage"><div class="gizmo-tools"><select id="fmGizmoTarget"><option value="map">Map model</option><option value="plane">Fight plane</option><option value="left">Left boundary</option><option value="right">Right boundary</option></select><button data-gizmo="translate" class="active">Move (W)</button><button data-gizmo="rotate">Rotate (E)</button><button data-gizmo="scale">Scale (R)</button><button id="fmFrame">Frame map</button></div><div class="hint">Left-drag orbit · right-drag pan · scroll zoom · W/E/R gizmo mode</div></main><aside id="fmePanel"></aside></div>`;
    this.injectStyles(); this.status = root.querySelector('#fmeStatus')!;
    const stage = root.querySelector<HTMLElement>('#fmeStage')!;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); this.renderer.setPixelRatio(1); this.renderer.shadowMap.enabled = false; stage.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x080a10); this.scene.add(new THREE.HemisphereLight(0xc7ddff, 0x241017, 1.5));
    const light = new THREE.DirectionalLight(0xffeee4, 3); light.position.set(5, 8, 5); light.castShadow = true; this.scene.add(light);
    this.grid = new THREE.GridHelper(40, 80, 0x4c2430, 0x181c27); this.scene.add(this.grid);
    const wallGeo = new THREE.BoxGeometry(.08, 4, 4), wallMat = new THREE.MeshBasicMaterial({ color: 0xef223a, transparent: true, opacity: .4 });
    this.leftBoundary = new THREE.Mesh(wallGeo, wallMat); this.rightBoundary = new THREE.Mesh(wallGeo, wallMat.clone());
    this.boundaryGroup.add(this.leftBoundary, this.rightBoundary); this.scene.add(this.boundaryGroup);
    this.camera.position.set(0, 4, 14); this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = false; this.orbit.enablePan = true; this.orbit.screenSpacePanning = true;
    this.orbit.minDistance = .01; this.orbit.maxDistance = Infinity; this.orbit.zoomToCursor = true;
    this.orbit.panSpeed = 2; this.orbit.zoomSpeed = 1.5; this.orbit.target.set(0, 1, 0);
    this.orbit.addEventListener('change', () => this.renderFrame());
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement); this.scene.add(this.gizmo);
    this.gizmo.addEventListener('dragging-changed', event => {
      const dragging = (event as unknown as { value: boolean }).value; this.orbit.enabled = !dragging;
      if (!dragging) this.finishGizmoDrag();
    });
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());
    this.gizmo.addEventListener('change', () => this.renderFrame());
    root.querySelector<HTMLSelectElement>('#fmGizmoTarget')!.onchange = event => { this.gizmoTarget = (event.target as HTMLSelectElement).value as typeof this.gizmoTarget; this.attachGizmo(); };
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-gizmo]')) button.onclick = () => this.setGizmoMode(button.dataset.gizmo as 'translate' | 'rotate' | 'scale');
    root.querySelector<HTMLButtonElement>('#fmFrame')!.onclick = () => this.frameMap();
    addEventListener('keydown', event => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key.toLowerCase() === 'w') this.setGizmoMode('translate');
      else if (event.key.toLowerCase() === 'e') this.setGizmoMode('rotate');
      else if (event.key.toLowerCase() === 'r') this.setGizmoMode('scale');
    });
    const resize = () => { const w = stage.clientWidth, h = stage.clientHeight; this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderFrame(); };
    addEventListener('resize', resize); resize();
    root.querySelector<HTMLButtonElement>('#fmeSave')!.onclick = () => void this.save();
    root.querySelector<HTMLButtonElement>('#fmeNew')!.onclick = () => { this.maps.push(DEFAULT_MAP()); this.index = this.maps.length - 1; this.refresh(); };
    void this.load();
  }

  private get cfg(): FighterMapEntry { return this.maps[this.index]!; }
  private async load(): Promise<void> {
    try {
      const [mapResponse, fileResponse] = await Promise.all([fetch('/api/fighter-maps'), fetch('/api/fighter-map-files')]);
      if (!mapResponse.ok || !fileResponse.ok) throw new Error('Map catalog request failed');
      const maps = await mapResponse.json(), files = await fileResponse.json();
      if (!Array.isArray(maps) || !maps.length || !Array.isArray(files)) throw new Error('Map catalog is invalid');
      this.maps = maps; this.files = files; this.catalogLoaded = true; this.refresh();
    } catch (error) { this.flash(`Load failed: ${(error as Error).message}`); }
  }
  private refresh(): void {
    const select = this.root.querySelector<HTMLSelectElement>('#fmeMap')!;
    select.innerHTML = this.maps.map((map, i) => `<option value="${i}" ${i === this.index ? 'selected' : ''}>${escapeHtml(map.name)}</option>`).join('');
    select.onchange = () => { this.index = Number(select.value); this.refresh(); };
    this.renderPanel(); this.applySavedCamera(); this.apply();
  }
  private apply(): void {
    const cfg = this.cfg;
    const plane = fightPlane(cfg);
    this.boundaryGroup.position.set(...plane.origin); this.boundaryGroup.rotation.y = THREE.MathUtils.degToRad(plane.rotationY);
    this.leftBoundary.position.set(cfg.bounds[0], 2, 0); this.rightBoundary.position.set(cfg.bounds[1], 2, 0);
    this.positionFighterReference();
    this.leftBoundary.material = new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: .42 }); this.rightBoundary.material = (this.leftBoundary.material as THREE.Material).clone() as THREE.MeshBasicMaterial;
    const file = cfg.file ?? null;
    if (this.model && this.loadedFile === file) {
      this.applyModelTransform(cfg);
      this.attachGizmo();
      this.renderFrame();
      return;
    }
    if (this.model) { this.scene.remove(this.model); this.model = null; if (this.gizmoTarget === 'map') this.gizmo.detach(); }
    if (this.loadedFile !== file) this.loadGeneration++;
    this.loadedFile = file;
    this.renderFrame();
    if (!file) return;
    const generation = this.loadGeneration;
    const draco = new DRACOLoader(); draco.setDecoderPath('/draco/');
    const loader = new GLTFLoader(); loader.setDRACOLoader(draco);
    loader.load(`/assets/fighters/maps/${encodeURIComponent(file)}`, gltf => {
      if (generation !== this.loadGeneration || file !== this.loadedFile) return;
      this.model = gltf.scene; this.applyModelTransform(this.cfg); this.scene.add(this.model); this.attachGizmo(); this.renderFrame();
    }, undefined, () => this.flash('Model failed to load'));
  }
  private applyModelTransform(cfg: FighterMapEntry): void {
    if (!this.model) return;
    this.model.position.set(...(cfg.pos ?? [0, 0, 0]));
    this.model.rotation.set(...(cfg.rotDeg ?? [0, 0, 0]).map(THREE.MathUtils.degToRad) as [number, number, number]);
    this.model.scale.setScalar(cfg.scale ?? 1); this.model.updateMatrixWorld(true);
  }
  private renderFrame(): void { this.renderer.render(this.scene, this.camera); }
  private frameMap(): void {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * .5, distance = Math.max(1, radius / Math.tan(THREE.MathUtils.degToRad(this.camera.fov * .5)) * 1.2);
    this.orbit.target.copy(center); this.camera.position.set(center.x + distance * .45, center.y + distance * .3, center.z + distance);
    this.camera.near = Math.max(.001, distance / 5000); this.camera.far = Math.max(2000, distance * 10); this.camera.updateProjectionMatrix(); this.orbit.update(); this.renderFrame();
  }
  private attachGizmo(): void {
    const target = this.gizmoTarget === 'map' ? this.model : this.gizmoTarget === 'plane' ? this.boundaryGroup : this.gizmoTarget === 'left' ? this.leftBoundary : this.rightBoundary;
    if (target) this.gizmo.attach(target); else this.gizmo.detach();
    this.updateGizmoAxes(); this.renderFrame();
  }
  private setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.gizmo.setMode(mode);
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-gizmo]')) button.classList.toggle('active', button.dataset.gizmo === mode);
    this.updateGizmoAxes(); this.renderFrame();
  }
  private updateGizmoAxes(): void {
    const mode = this.gizmo.getMode();
    if (this.gizmoTarget === 'left' || this.gizmoTarget === 'right') {
      if (mode !== 'translate') {
        this.gizmo.setMode('translate');
        for (const button of this.root.querySelectorAll<HTMLElement>('[data-gizmo]')) button.classList.toggle('active', button.dataset.gizmo === 'translate');
      }
      this.gizmo.showX = true; this.gizmo.showY = false; this.gizmo.showZ = false; this.gizmo.setSpace('local');
    } else if (this.gizmoTarget === 'plane' && mode === 'rotate') {
      this.gizmo.showX = false; this.gizmo.showY = true; this.gizmo.showZ = false; this.gizmo.setSpace('world');
    } else if (mode === 'scale') {
      this.gizmo.showX = true; this.gizmo.showY = false; this.gizmo.showZ = false; this.gizmo.setSpace('local');
    } else {
      this.gizmo.showX = true; this.gizmo.showY = true; this.gizmo.showZ = true; this.gizmo.setSpace('world');
    }
  }
  private onGizmoChange(): void {
    const cfg = this.cfg;
    if (this.gizmoTarget === 'map' && this.model) {
      if (this.gizmo.getMode() === 'scale') this.model.scale.setScalar(Math.max(.001, this.model.scale.x));
      cfg.pos = round3(this.model.position); cfg.rotDeg = rad3(this.model.rotation); cfg.scale = this.model.scale.x;
    } else if (this.gizmoTarget === 'plane') {
      this.boundaryGroup.rotation.x = 0; this.boundaryGroup.rotation.z = 0;
      cfg.floorY = this.boundaryGroup.position.y;
      cfg.fightPlane = { origin: round3(this.boundaryGroup.position), rotationY: THREE.MathUtils.radToDeg(this.boundaryGroup.rotation.y) };
      this.positionFighterReference();
    } else if (this.gizmoTarget === 'left') {
      this.leftBoundary.position.y = 2; this.leftBoundary.position.z = 0; cfg.bounds = [this.leftBoundary.position.x, cfg.bounds[1]];
    } else if (this.gizmoTarget === 'right') {
      this.rightBoundary.position.y = 2; this.rightBoundary.position.z = 0; cfg.bounds = [cfg.bounds[0], this.rightBoundary.position.x];
    }
    this.syncNumericControls(); this.renderFrame();
  }
  private finishGizmoDrag(): void {
    if (this.gizmoTarget === 'plane' && this.gizmo.getMode() === 'scale') {
      const factor = this.boundaryGroup.scale.x;
      this.cfg.bounds = [this.cfg.bounds[0] * factor, this.cfg.bounds[1] * factor];
      this.boundaryGroup.scale.set(1, 1, 1); this.leftBoundary.position.x = this.cfg.bounds[0]; this.rightBoundary.position.x = this.cfg.bounds[1];
      this.syncNumericControls();
    }
    this.renderFrame();
  }
  private syncNumericControls(): void {
    const cfg = this.cfg, plane = fightPlane(cfg);
    const values: Record<string, number> = {
      'Position X': cfg.pos?.[0] ?? 0, 'Position Y': cfg.pos?.[1] ?? 0, 'Position Z': cfg.pos?.[2] ?? 0,
      'Rotation X': cfg.rotDeg?.[0] ?? 0, 'Rotation Y': cfg.rotDeg?.[1] ?? 0, 'Rotation Z': cfg.rotDeg?.[2] ?? 0,
      Scale: cfg.scale ?? 1, 'Plane X': plane.origin[0], 'Floor Y': plane.origin[1], 'Plane Z': plane.origin[2],
      'Plane rotation Y': plane.rotationY, 'Left boundary': cfg.bounds[0], 'Right boundary': cfg.bounds[1],
    };
    for (const label of this.root.querySelectorAll<HTMLLabelElement>('#fmePanel label')) {
      const input = label.querySelector<HTMLInputElement>('input[type=number]'), name = label.querySelector('span')?.textContent;
      if (input && name && values[name] !== undefined) input.value = String(Math.round(values[name]! * 1000) / 1000);
    }
  }
  private positionFighterReference(): void {
    if (!this.fighterPreview) return;
    const plane = fightPlane(this.cfg);
    this.fighterPreview.position.set(...plane.origin);
    this.fighterPreview.rotation.y = Math.PI + THREE.MathUtils.degToRad(plane.rotationY);
    this.fighterPreview.visible = this.showFighter;
  }
  private renderPanel(): void {
    const panel = this.root.querySelector<HTMLElement>('#fmePanel')!, cfg = this.cfg;
    panel.innerHTML = `<h3>Map setup</h3><label>Name<input id="fmName" value="${escapeHtml(cfg.name)}"></label><label>ID<input id="fmId" value="${escapeHtml(cfg.id)}"></label><label>GLB file<select id="fmFile"><option value="">Procedural fallback</option>${this.files.map(file => `<option ${file === cfg.file ? 'selected' : ''}>${escapeHtml(file)}</option>`).join('')}</select></label><label>Accent<input id="fmColor" type="color" value="${cfg.color}"></label><label class="preview-toggle"><span>Character preview</span><input id="fmFighter" type="checkbox" ${this.showFighter ? 'checked' : ''}></label><h3>Model transform</h3><div id="fmTransform"></div><h3>Fight plane</h3><div id="fmPlane"></div><h3>Fight boundaries</h3><div id="fmBounds"></div><h3>Camera</h3><button class="wide" id="fmCamera">Set camera to this view</button><button class="wide secondary" id="fmPreview">Capture card preview</button><p>The fight plane controls where fighters stand independently of the map model. Plane Z moves gameplay forward/backward; rotation changes its direction. Boundaries are distances along that plane.</p>`;
    this.bindText('fmName', value => cfg.name = value); this.bindText('fmId', value => cfg.id = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'));
    this.root.querySelector<HTMLSelectElement>('#fmFile')!.onchange = event => { cfg.file = (event.target as HTMLSelectElement).value || undefined; this.apply(); };
    this.root.querySelector<HTMLInputElement>('#fmColor')!.oninput = event => { cfg.color = (event.target as HTMLInputElement).value; this.apply(); };
    this.root.querySelector<HTMLInputElement>('#fmFighter')!.onchange = event => void this.toggleFighter((event.target as HTMLInputElement).checked);
    const transform = this.root.querySelector<HTMLElement>('#fmTransform')!, planeHost = this.root.querySelector<HTMLElement>('#fmPlane')!, bounds = this.root.querySelector<HTMLElement>('#fmBounds')!;
    const pos = cfg.pos ?? [0, 0, 0], rot = cfg.rotDeg ?? [0, 0, 0];
    this.number(transform, 'Position X', pos[0], .25, value => { const current = cfg.pos ?? [0, 0, 0]; cfg.pos = [value, current[1], current[2]]; });
    this.number(transform, 'Position Y', pos[1], .25, value => { const current = cfg.pos ?? [0, 0, 0]; cfg.pos = [current[0], value, current[2]]; });
    this.number(transform, 'Position Z', pos[2], .25, value => { const current = cfg.pos ?? [0, 0, 0]; cfg.pos = [current[0], current[1], value]; });
    this.number(transform, 'Rotation X', rot[0], 1, value => { const current = cfg.rotDeg ?? [0, 0, 0]; cfg.rotDeg = [value, current[1], current[2]]; });
    this.number(transform, 'Rotation Y', rot[1], 1, value => { const current = cfg.rotDeg ?? [0, 0, 0]; cfg.rotDeg = [current[0], value, current[2]]; });
    this.number(transform, 'Rotation Z', rot[2], 1, value => { const current = cfg.rotDeg ?? [0, 0, 0]; cfg.rotDeg = [current[0], current[1], value]; });
    this.number(transform, 'Scale', cfg.scale ?? 1, .05, value => cfg.scale = Math.max(.01, value));
    const plane = fightPlane(cfg), origin = plane.origin;
    this.number(planeHost, 'Plane X', origin[0], .25, value => { const current = fightPlane(cfg); cfg.fightPlane = { origin: [value, current.origin[1], current.origin[2]], rotationY: current.rotationY }; });
    this.number(planeHost, 'Floor Y', origin[1], .1, value => { const current = fightPlane(cfg); cfg.floorY = value; cfg.fightPlane = { origin: [current.origin[0], value, current.origin[2]], rotationY: current.rotationY }; });
    this.number(planeHost, 'Plane Z', origin[2], .25, value => { const current = fightPlane(cfg); cfg.fightPlane = { origin: [current.origin[0], current.origin[1], value], rotationY: current.rotationY }; });
    this.number(planeHost, 'Plane rotation Y', plane.rotationY, 1, value => { const current = fightPlane(cfg); cfg.fightPlane = { origin: [...current.origin], rotationY: value }; });
    this.number(bounds, 'Left boundary', cfg.bounds[0], .5, value => cfg.bounds = [value, cfg.bounds[1]]);
    this.number(bounds, 'Right boundary', cfg.bounds[1], .5, value => cfg.bounds = [cfg.bounds[0], value]);
    this.root.querySelector<HTMLButtonElement>('#fmCamera')!.onclick = () => { const p = this.camera.position, t = this.orbit.target; cfg.camera = { pos: round3(p), lookAt: round3(t), fov: this.camera.fov }; this.flash('Camera captured'); };
    this.root.querySelector<HTMLButtonElement>('#fmPreview')!.onclick = () => void this.capturePreview();
  }
  private number(host: HTMLElement, label: string, value: number, step: number, set: (value: number) => void): void {
    const row = document.createElement('label'); row.innerHTML = `<span>${label}</span><input type="number" step="${step}" value="${value}">`;
    row.querySelector('input')!.oninput = event => { const next = Number((event.target as HTMLInputElement).value); if (Number.isFinite(next)) { set(next); this.apply(); } }; host.appendChild(row);
  }
  private bindText(id: string, set: (value: string) => void): void { this.root.querySelector<HTMLInputElement>(`#${id}`)!.oninput = event => set((event.target as HTMLInputElement).value); }
  private async save(): Promise<void> {
    if (!this.catalogLoaded) { this.flash('Cannot save until the catalog loads'); return; }
    const post = () => fetch('/api/fighter-maps', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(this.maps) });
    let response = await post(); if (response.status === 401 && promptForToken()) response = await post(); this.flash(response.ok ? 'Saved' : `Save failed (${response.status})`);
  }
  private applySavedCamera(): void {
    const camera = this.cfg.camera; if (!camera) return;
    this.camera.position.set(...camera.pos); this.camera.fov = camera.fov ?? 36;
    this.orbit.target.set(...camera.lookAt); this.camera.updateProjectionMatrix(); this.orbit.update();
  }
  private async capturePreview(): Promise<void> {
    const visibility = { grid: this.grid.visible, bounds: this.boundaryGroup.visible, gizmo: this.gizmo.visible, fighter: this.fighterPreview?.visible ?? false };
    this.grid.visible = false; this.boundaryGroup.visible = false; this.gizmo.visible = false; if (this.fighterPreview) this.fighterPreview.visible = false;
    this.renderFrame();
    const blob = await new Promise<Blob | null>(resolve => this.renderer.domElement.toBlob(resolve, 'image/png'));
    this.grid.visible = visibility.grid; this.boundaryGroup.visible = visibility.bounds; this.gizmo.visible = visibility.gizmo; if (this.fighterPreview) this.fighterPreview.visible = visibility.fighter;
    this.renderFrame();
    if (!blob) { this.flash('Preview capture failed'); return; }
    const post = () => fetch(`/api/fighter-map-preview?id=${encodeURIComponent(this.cfg.id)}`, { method: 'POST', headers: authHeaders({ 'Content-Type': 'image/png' }), body: blob });
    let response = await post(); if (response.status === 401 && promptForToken()) response = await post();
    if (!response.ok) { this.flash(`Preview failed (${response.status})`); return; }
    const uploaded = await response.json() as { preview: string };
    this.cfg.preview = `${uploaded.preview}?v=${Date.now()}`;
    await this.save(); this.flash('Card preview captured');
  }
  private async toggleFighter(show: boolean): Promise<void> {
    this.showFighter = show;
    if (!show) { if (this.fighterPreview) this.fighterPreview.visible = false; this.renderFrame(); return; }
    if (!this.fighterPreview) {
      this.flash('Loading character preview...');
      const [model, idleSource] = await Promise.all([loadFbx('nyx.fbx'), loadFbx('fighting-idle.fbx')]);
      prepareFighterModel(model);
      model.rotation.y = Math.PI;
      // Editor reference stays visible through misplaced walls so the user can correct the map transform.
      model.traverse(object => {
        if (!(object as THREE.Mesh).isMesh) return;
        const mesh = object as THREE.Mesh;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const highlighted = materials.map(material => {
          const clone = material.clone(); clone.depthTest = false; clone.depthWrite = false;
          if (clone instanceof THREE.MeshStandardMaterial) { clone.emissive.set(0xef223a); clone.emissiveIntensity = .18; }
          return clone;
        });
        mesh.material = Array.isArray(mesh.material) ? highlighted : highlighted[0]!;
        mesh.renderOrder = 1000;
      });
      this.fighterPreview = model;
      this.fighterMixer = new THREE.AnimationMixer(model);
      const idle = idleSource.animations[0];
      if (idle) {
        const action = this.fighterMixer.clipAction(retargetClipNames(idle, model));
        action.setLoop(THREE.LoopRepeat, Infinity).play();
        this.fighterMixer.setTime(.35);
      }
      this.scene.add(model);
      this.flash('Character preview ready');
    }
    this.fighterPreview.visible = this.showFighter;
    this.positionFighterReference();
    this.renderFrame();
  }
  private flash(text: string): void { this.status.textContent = text; setTimeout(() => this.status.textContent = '', 2200); }
  private injectStyles(): void {
    const style = document.createElement('style'); style.textContent = `.fme{position:fixed;inset:0;background:#080a10}.fme header{height:50px;display:flex;align-items:center;gap:10px;padding:0 14px;background:#111522;border-bottom:1px solid #303747}.fme header a{color:#ef4057;text-decoration:none}.fme header span{flex:1}.fme header i{color:#36e08a}.fme button,.fme select,.fme input{background:#242b40;color:#fff;border:1px solid #414b68;border-radius:6px;padding:7px}.fme button{cursor:pointer}.fme .save,.fme .wide{background:#ef223a;border-color:#ef223a;font-weight:700}.fme .wide.secondary{margin-top:7px;background:#2b3247;border-color:#4a5574}.fme main{position:absolute;top:50px;left:0;right:310px;bottom:0}.fme canvas{width:100%;height:100%;display:block}.fme .gizmo-tools{position:absolute;z-index:3;top:10px;left:10px;display:flex;gap:5px;padding:7px;background:#090b10dd;border:1px solid #313747;border-radius:8px}.fme .gizmo-tools button.active{background:#ef223a;border-color:#ef223a}.fme .hint{position:absolute;z-index:2;bottom:12px;left:12px;background:#090b10cc;padding:8px 12px}.fme aside{position:absolute;top:50px;right:0;bottom:0;width:282px;overflow:auto;padding:14px;background:#111522}.fme h3{margin:14px 0 7px;color:#969daf;font-size:11px;text-transform:uppercase}.fme label{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:7px 0}.fme label input,.fme label select{width:145px}.fme label.preview-toggle{padding:8px;background:#1b2030;border-radius:6px}.fme label.preview-toggle input{width:auto;accent-color:#ef223a}.fme .wide{width:100%}.fme p{color:#9299a9;font-size:11px;line-height:1.5}.fme code{color:#fff}`; document.head.appendChild(style);
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
const round3 = (vector: THREE.Vector3): [number, number, number] => [vector.x, vector.y, vector.z].map(value => Math.round(value * 100) / 100) as [number, number, number];
const rad3 = (rotation: THREE.Euler): [number, number, number] => [rotation.x, rotation.y, rotation.z].map(value => Math.round(THREE.MathUtils.radToDeg(value) * 100) / 100) as [number, number, number];
const fightPlane = (map: FighterMapEntry) => map.fightPlane ?? { origin: [0, map.floorY ?? 0, 0] as [number, number, number], rotationY: 0 };
