// In-GAME align mode (?map=NAME): position the TRACK (the generated race) and the MAP (your GLB
// scenery) relative to each other so "what you align is what you play". You grab EITHER object
// (Tab toggles, or click it) and move/rotate/scale it with the gizmo or keyboard. Save writes both
// transforms to maps.json (`track` + `model`); the game applies them verbatim. OrbitControls for
// the camera, with a dynamic near/far plane so zoom is unlimited and a huge map never clips.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RACE_LEN } from '../shared/constants';
import { fetchMaps, applyTrackTransform, wrapMapScene, matrixFromTransform, transformFromMatrix, CANONICAL_TRACK, IDENTITY_TRANSFORM, TRACK_CENTER, type MapTransform, type TrackPath } from './map-world';
import { CurveEditor } from './align-curve';

export async function startAlignMode(mapName: string): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x223047);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x303040, 1.3));
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(300, 800, 200); scene.add(sun);

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 50000);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;          // glide instead of snap — far less jerky
  orbit.dampingFactor = 0.08;
  orbit.screenSpacePanning = false;    // pan along the ground, not the view plane
  // No zoom stops: a racing map scales arbitrarily, so don't clamp how close/far you can go.
  orbit.minDistance = 0;
  orbit.maxDistance = Infinity;

  // Load the map config up front so the curve editor can seed from any saved cfg.path.
  const maps = await fetchMaps();
  const cfg = maps[mapName];
  const file = cfg?.file ?? `${mapName}.glb`;

  // --- The TRACK: race footprint in a group whose ORIGIN is the race center (gizmo sits in the
  // middle, rotation pivots about the middle). Geometry lives in an inner group shifted by
  // -TRACK_CENTER, mirroring the game's trackGroup/trackContent so saved numbers match. ---
  const track = new THREE.Group();
  const trackContent = new THREE.Group();
  trackContent.position.set(-TRACK_CENTER[0], -TRACK_CENTER[1], -TRACK_CENTER[2]);
  track.add(trackContent);
  // The track footprint is a CURVE you can edit (Option B). The CurveEditor owns the road ribbon +
  // lane lines + start/lap markers + draggable control-point handles, all built along the curve.
  // cfg.path seeds it; a straight default if none.
  const curveEditor = new CurveEditor(cfg?.path);
  trackContent.add(curveEditor.group);
  scene.add(track);

  // Ground grid + axes: a constant spatial reference (purely cosmetic; nothing must "fit" on it).
  const grid = new THREE.GridHelper(RACE_LEN * 2, 60, 0x44597f, 0x2c3a55);
  grid.position.set(0, 0, RACE_LEN / 2); scene.add(grid);
  scene.add(new THREE.AxesHelper(40));

  // --- Load the map (GLB) into a recentered group (pivot = visual center, so the gizmo sits ON it). ---
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  loader.setDRACOLoader(draco);

  let map = new THREE.Group();

  await new Promise<void>((resolve) => {
    loader.load(`/assets/maps/${file}`, (gltf) => {
      map = wrapMapScene(gltf.scene);
      map.traverse(o => { (o as THREE.Mesh).receiveShadow = true; });
      scene.add(map);
      applyTrackTransform(map, cfg?.model ?? (cfg ? { pos: [0, 0, RACE_LEN / 2], rotDeg: [0, 0, 0], scale: 20 } : IDENTITY_TRANSFORM));
      applyTrackTransform(track, cfg?.track ?? { pos: [...TRACK_CENTER], rotDeg: [0, 0, 0], scale: 1 });
      resolve();
    }, undefined, () => { scene.add(map); resolve(); });
  });

  // --- Selection: the gizmo + keyboard act on whichever object is selected. Selecting does NOT
  // move the camera — you stay exactly where you are. ---
  type Sel = 'track' | 'map';
  let selected: Sel = 'track';
  const selectedObj = (): THREE.Group => (selected === 'track' ? track : map);

  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(1.1);
  scene.add(gizmo);
  gizmo.addEventListener('dragging-changed', (e) => {
    const dragging = (e as unknown as { value: boolean }).value;
    orbit.enabled = !dragging;
    if (dragging) pushUndo();   // snapshot once at the start of a gizmo drag
  });
  let uniform = true;
  gizmo.addEventListener('objectChange', () => {
    if (uniform && gizmo.getMode() === 'scale') {
      const o = selectedObj();
      const s = Math.max(o.scale.x, o.scale.y, o.scale.z);
      o.scale.setScalar(s);
    }
    updateInfo();
  });
  function select(s: Sel): void { selected = s; gizmo.attach(selectedObj()); updateInfo(); }
  gizmo.attach(track);

  // --- Undo/redo + per-object reset ---------------------------------------------------------
  // A snapshot is the full editable state: track transform, map transform, and the curve path.
  // We push one onto the undo stack BEFORE each discrete edit, so undo restores the prior state.
  interface Snapshot { track: MapTransform; map: MapTransform; path: TrackPath; }
  const snapshot = (): Snapshot =>
    ({ track: transformOf(track), map: transformOf(map), path: curveEditor.toPath() });
  const applySnapshot = (s: Snapshot): void => {
    applyTrackTransform(track, s.track);
    applyTrackTransform(map, s.map);
    curveEditor.setPath(s.path);
    gizmo.attach(selectedObj());
    updateInfo();
  };
  // The state each object started at this session (for "Reset" of just that object).
  const initial = { track: null as MapTransform | null, map: null as MapTransform | null,
                    path: null as TrackPath | null };
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  // Call BEFORE mutating state. Pushes the current state for undo and clears the redo branch.
  function pushUndo(): void { undoStack.push(snapshot()); redoStack.length = 0; }
  function undo(): void {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(snapshot());
    applySnapshot(prev);
  }
  function redo(): void {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(snapshot());
    applySnapshot(next);
  }
  // Reset ONE object to its session-initial state (the values present when the editor opened).
  function resetObject(which: Sel | 'path'): void {
    pushUndo();
    if (which === 'track' && initial.track) applyTrackTransform(track, initial.track);
    else if (which === 'map' && initial.map) applyTrackTransform(map, initial.map);
    else if (which === 'path' && initial.path) curveEditor.setPath(initial.path);
    gizmo.attach(selectedObj());
    updateInfo();
  }

  // --- Curve-edit mode: when ON, click a dot to SELECT it, drag it to bend the track, or arm
  // "add point" and click the ground to drop a point exactly there. The gizmo is detached so it
  // doesn't intercept clicks. ---
  let curveMode = false;
  let addArmed = false;        // next ground click drops a new control point at that spot
  let draggingHandle = -1;
  let dragMoved = false;       // did the pointer move during this grab? (drag vs pure click-select)
  let downPx = { x: 0, y: 0 }; // screen pos at grab, to distinguish a click from a real drag
  let axisLock: 'none' | 'x' | 'z' = 'none';   // constrain handle drags to one ground axis
  const ray = new THREE.Raycaster();
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);   // ground (y=0) in world space
  const ndcOf = (ev: PointerEvent): THREE.Vector2 => {
    const r = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1,
                             -((ev.clientY - r.top) / r.height) * 2 + 1);
  };
  // World ground-plane hit for a pointer event, converted into trackContent local space (where the
  // curve's control points live). Returns null if the ray misses the ground.
  const groundLocal = (ev: PointerEvent): THREE.Vector3 | null => {
    ray.setFromCamera(ndcOf(ev), camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(dragPlane, hit)) return null;
    return trackContent.worldToLocal(hit);
  };
  // Pick the control-point handle whose SCREEN position is nearest the click, within a pixel
  // radius. Far more forgiving than an exact ray-sphere hit, so you can always grab a tiny dot to
  // move it after placing it. Returns the handle Object3D, or null if none is close enough.
  const PICK_PX = 26;
  const pickHandleNear = (ev: PointerEvent): THREE.Object3D | null => {
    const r = renderer.domElement.getBoundingClientRect();
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    let best: THREE.Object3D | null = null, bestD = PICK_PX;
    const v = new THREE.Vector3();
    for (const h of curveEditor.handleMeshes()) {
      h.getWorldPosition(v).project(camera);
      if (v.z > 1) continue;   // behind the camera
      const sx = (v.x * 0.5 + 0.5) * r.width;
      const sy = (-v.y * 0.5 + 0.5) * r.height;
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  };
  function setCurveMode(on: boolean): void {
    curveMode = on;
    if (!on) addArmed = false;
    if (on) gizmo.detach(); else gizmo.attach(selectedObj());
    updateInfo();
  }

  renderer.domElement.addEventListener('pointerdown', (ev) => {
    if (gizmo.dragging) return;
    ray.setFromCamera(ndcOf(ev), camera);
    if (curveMode) {
      // Armed to add: drop a new point exactly where you clicked on the ground.
      if (addArmed) {
        const local = groundLocal(ev);
        if (local) {
          pushUndo();
          curveEditor.addPointAt(local.x, local.z);
          addArmed = false;
          updateInfo();
        }
        return;
      }
      // Click on or NEAR a handle → select it AND begin a potential drag (drag-vs-click decided on
      // move/up). Screen-space proximity pick so tiny dots are easy to grab and re-move after placing.
      const handle = pickHandleNear(ev);
      if (handle) {
        pushUndo();   // snapshot once; if it turns out to be a pure click we pop it on pointerup
        draggingHandle = curveEditor.beginDrag(handle);
        dragMoved = false;
        downPx = { x: ev.clientX, y: ev.clientY };
        orbit.enabled = false;
        updateInfo();
        return;
      }
      // Clicked empty space (not near any handle): clear the selection, let orbit handle the drag.
      curveEditor.select(-1);
      updateInfo();
      return;
    }
    // Not curve mode: click-select track vs map (no camera move).
    const hitTrack = ray.intersectObject(track, true)[0]?.distance ?? Infinity;
    const hitMap = ray.intersectObject(map, true)[0]?.distance ?? Infinity;
    if (hitTrack === Infinity && hitMap === Infinity) return;
    select(hitMap < hitTrack ? 'map' : 'track');
  });

  // Drag a grabbed handle along the ground plane (converted into trackContent space). Axis lock
  // (X or Z) constrains the motion so you can keep a point's other coordinate fixed.
  renderer.domElement.addEventListener('pointermove', (ev) => {
    if (draggingHandle < 0) return;
    // Ignore sub-threshold jitter so a click stays a pure select, not a tiny accidental move.
    if (!dragMoved && Math.hypot(ev.clientX - downPx.x, ev.clientY - downPx.y) < 3) return;
    const local = groundLocal(ev);
    if (!local) return;
    dragMoved = true;
    const cur = curveEditor.pointAt(draggingHandle);
    let x = local.x, z = local.z;
    if (axisLock === 'x' && cur) z = cur.z;   // lock Z: only X moves
    if (axisLock === 'z' && cur) x = cur.x;   // lock X: only Z moves
    curveEditor.dragTo(draggingHandle, x, z);
    updateInfo();
  });
  const endDrag = () => {
    if (draggingHandle < 0) return;
    // A grab that never moved is a pure SELECT, not an edit — undo the snapshot we pushed on grab.
    if (!dragMoved) undoStack.pop();
    draggingHandle = -1;
    orbit.enabled = true;
    updateInfo();
  };
  renderer.domElement.addEventListener('pointerup', endDrag);
  renderer.domElement.addEventListener('pointerleave', endDrag);

  // --- Camera framing (explicit buttons/keys only — never auto-triggered by selection). ---
  function radiusOf(): number {
    const size = new THREE.Box3().setFromObject(map).getSize(new THREE.Vector3());
    return Math.max(size.length() * 0.6, RACE_LEN * 0.6, 50);
  }
  function frameTop(): void {
    const r = radiusOf();
    orbit.target.set(0, 0, RACE_LEN / 2);
    camera.position.set(0.01, r * 1.6, RACE_LEN / 2); orbit.update();
  }
  function framePersp(): void {
    const r = radiusOf();
    orbit.target.set(0, 0, RACE_LEN / 2);
    camera.position.set(r * 0.9, r * 0.8, -r * 0.5); orbit.update();
  }
  framePersp();

  // --- Keyboard nudging (precise, never fights the camera) — acts on the SELECTED object. ---
  let step = 5;
  const nudge = (dx: number, dy: number, dz: number) => {
    const o = selectedObj(); o.position.x += dx; o.position.y += dy; o.position.z += dz; updateInfo();
  };
  const rotateY = (deg: number) => { selectedObj().rotation.y += (deg * Math.PI) / 180; updateInfo(); };
  const scaleBy = (f: number) => { selectedObj().scale.multiplyScalar(f); updateInfo(); };

  addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); select(selected === 'track' ? 'map' : 'track'); return; }
    if (e.key === 'g') { gizmo.setMode('translate'); return; }
    if (e.key === 'e') { gizmo.setMode('rotate'); return; }
    if (e.key === 'r') { gizmo.setMode('scale'); return; }
    if (e.key === 'u') { uniform = !uniform; updateInfo(); return; }
    if (e.key === 't' || e.key === 'T') { frameTop(); return; }
    if (e.key === 'f' || e.key === 'F') { framePersp(); return; }
    if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); return; }
    // Undo / redo: ⌘Z / ⌘⇧Z (or ⌘Y). Handle before the nudge keys.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault(); e.shiftKey ? redo() : undo(); return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (e.key === '1') { step = 1; updateInfo(); return; }
    if (e.key === '2') { step = 5; updateInfo(); return; }
    if (e.key === '3') { step = 25; updateInfo(); return; }
    // Axis-lock toggles while editing the curve (X locks Z, Z locks X, F frees).
    if (curveMode && (e.key === 'x' || e.key === 'X')) { axisLock = axisLock === 'x' ? 'none' : 'x'; updateInfo(); return; }
    if (curveMode && (e.key === 'z' || e.key === 'Z') && !e.metaKey && !e.ctrlKey) { axisLock = axisLock === 'z' ? 'none' : 'z'; updateInfo(); return; }
    // For nudge/rotate/scale: snapshot once at the START of a held-key run (e.repeat is false on
    // the first keydown), so holding an arrow coalesces into ONE undo step instead of dozens.
    const isEdit = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '[', ']', '-', '_', '=', '+'].includes(e.key);
    if (isEdit && !e.repeat) pushUndo();
    // In curve mode with a point selected, arrows nudge THAT POINT (respecting axis lock) instead
    // of moving the whole track/map. This is how you fine-tune or shorten/extend a selected end.
    if (curveMode && curveEditor.selectedIndex >= 0 &&
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      let dx = 0, dz = 0;
      if (e.key === 'ArrowUp') dz = step; else if (e.key === 'ArrowDown') dz = -step;
      else if (e.key === 'ArrowLeft') dx = step; else if (e.key === 'ArrowRight') dx = -step;
      if (axisLock === 'x') dz = 0;       // lock Z → only X
      if (axisLock === 'z') dx = 0;       // lock X → only Z
      curveEditor.nudgeSelected(dx, dz);
      updateInfo();
      return;
    }
    switch (e.key) {
      case 'ArrowUp':    e.preventDefault(); e.shiftKey ? nudge(0, step, 0) : nudge(0, 0, step); break;
      case 'ArrowDown':  e.preventDefault(); e.shiftKey ? nudge(0, -step, 0) : nudge(0, 0, -step); break;
      case 'ArrowLeft':  e.preventDefault(); nudge(step, 0, 0); break;
      case 'ArrowRight': e.preventDefault(); nudge(-step, 0, 0); break;
      case '[':          rotateY(-step); break;
      case ']':          rotateY(step); break;
      case '-': case '_': scaleBy(0.97); break;
      case '=': case '+': scaleBy(1.03); break;
    }
  });

  function transformOf(o: THREE.Object3D): MapTransform {
    const r2d = (rad: number) => Math.round((rad * 180) / Math.PI);
    return {
      pos: o.position.toArray().map((n) => Math.round(n * 1000) / 1000),
      rotDeg: [r2d(o.rotation.x), r2d(o.rotation.y), r2d(o.rotation.z)],
      scale: Math.round(o.scale.x * 1000) / 1000,
    };
  }
  async function save(): Promise<void> {
    // Re-express the MAP relative to the CANONICAL race (track pinned at the center, scale 1), so
    // the saved `model` preserves the exact visual relationship you aligned — even though you may
    // have moved the track around the editor for convenience. The game keeps the race in canonical
    // sim space; only the map carries an offset. savedModel = CANONICAL · trackWorld⁻¹ · mapWorld.
    track.updateWorldMatrix(true, false); map.updateWorldMatrix(true, false);
    const mapInTrackFrame = new THREE.Matrix4()
      .copy(track.matrixWorld).invert().multiply(map.matrixWorld);
    const savedModelMat = matrixFromTransform(CANONICAL_TRACK).multiply(mapInTrackFrame);
    // The curved path is saved as-is (control points in sim coords); the game replays it render-only.
    const payload = { map: mapName, file, track: CANONICAL_TRACK,
      model: transformFromMatrix(savedModelMat), path: curveEditor.toPath() };
    try {
      const res = await fetch('/api/maps', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      flash(res.ok ? `Saved ✓ — play it: /play.html?display=1&map=${mapName}` : 'Save failed');
    } catch { flash('Server unreachable'); }
  }

  // --- UI panel ---
  const panel = document.createElement('div');
  panel.style.cssText = 'position:absolute;top:12px;left:12px;background:rgba(16,22,40,.93);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:12px 14px;font:13px system-ui,sans-serif;color:#e8ecf6;max-width:360px';
  document.getElementById('app')!.appendChild(panel);
  const mkBtn = (label: string, fn: () => void, active = false) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `font:inherit;color:#fff;background:${active ? '#3552a8' : '#2a3350'};border:0;border-radius:7px;padding:6px 10px;margin:2px;cursor:pointer`;
    b.onclick = () => { fn(); renderer.domElement.focus(); }; return b;
  };
  function updateInfo(): void {
    panel.replaceChildren();
    const h = document.createElement('div');
    const hb = document.createElement('b'); hb.textContent = `🗺️ Align: ${mapName}`; h.append(hb);

    const selRow = document.createElement('div');
    selRow.style.cssText = 'margin:6px 0';
    selRow.append(
      mkBtn('🏁 Track', () => select('track'), selected === 'track'),
      mkBtn('🗺️ Map', () => select('map'), selected === 'map'));
    const selLabel = document.createElement('span');
    selLabel.style.cssText = 'color:#9aa0b4;font-size:12px;margin-left:6px';
    selLabel.textContent = `editing: ${selected.toUpperCase()} (Tab/click to switch)`;
    selRow.append(selLabel);

    const hint = document.createElement('div');
    hint.style.cssText = 'color:#93a0c0;font-size:11px;line-height:1.6;margin:6px 0';
    hint.innerHTML =
      'Cyan lanes + red car = the TRACK (where cars drive). Align it onto your MAP\'s road.<br>' +
      '<b>Arrows</b> move · <b>Shift+↑↓</b> height · <b>[ ]</b> rotate · <b>− =</b> scale<br>' +
      '<b>1/2/3</b> step · <b>T</b> top · <b>F</b> 3-D · <b>Tab</b> switch object · drag gizmo for fine control';

    // Undo / redo (disabled when their stack is empty) + reset the SELECTED object.
    const histRow = document.createElement('div');
    histRow.style.cssText = 'margin:6px 0';
    const undoBtn = mkBtn(`↶ Undo${undoStack.length ? ` (${undoStack.length})` : ''}`, () => undo());
    const redoBtn = mkBtn(`↷ Redo${redoStack.length ? ` (${redoStack.length})` : ''}`, () => redo());
    if (!undoStack.length) { undoBtn.disabled = true; undoBtn.style.opacity = '0.45'; }
    if (!redoStack.length) { redoBtn.disabled = true; redoBtn.style.opacity = '0.45'; }
    histRow.append(undoBtn, redoBtn,
      mkBtn(`⟲ Reset ${selected}`, () => resetObject(selected)));

    const views = document.createElement('div');
    views.append(mkBtn('⬇ Top (T)', frameTop), mkBtn('⬈ 3-D (F)', framePersp));

    const tools = document.createElement('div');
    tools.append(mkBtn('Move (G)', () => gizmo.setMode('translate')),
                 mkBtn('Rotate (E)', () => gizmo.setMode('rotate')),
                 mkBtn('Scale (R)', () => gizmo.setMode('scale')),
                 mkBtn(`Uniform: ${uniform ? 'ON' : 'off'} (U)`, () => { uniform = !uniform; updateInfo(); }));

    // Curve editor controls.
    const sel = curveEditor.selectedIndex;
    const hasSel = sel >= 0;
    const curveTitle = document.createElement('div');
    curveTitle.style.cssText = 'margin-top:10px;font-size:11px;color:#9aa0b4;border-top:1px solid rgba(255,255,255,.12);padding-top:8px';
    curveTitle.innerHTML = `<b style="color:#36e08a">🛣 Curve the track</b> — ${curveEditor.pointCount} points` +
      (hasSel ? ` · point ${sel + 1} selected` : '');

    const curveRow = document.createElement('div');
    curveRow.append(
      mkBtn(curveMode ? '✓ Bending ON' : 'Bend track', () => setCurveMode(!curveMode), curveMode));
    if (curveMode) {
      curveRow.append(
        mkBtn(addArmed ? '✓ Click to place…' : '+ Add point', () => { addArmed = !addArmed; updateInfo(); }, addArmed),
        mkBtn('🗑 Delete point', () => {
          if (!curveEditor.removeSelected()) { flash('Select a non-endpoint dot first (click it), then Delete.'); return; }
          undoStack.push(snapshot()); redoStack.length = 0;   // record the deletion
          updateInfo();
        }),
        mkBtn('Straighten', () => { pushUndo(); curveEditor.reset(); updateInfo(); }),
        mkBtn('⟲ Reset curve', () => resetObject('path')));

      // Axis lock: keep one ground coordinate fixed while dragging/nudging the selected point.
      const lockRow = document.createElement('div');
      lockRow.style.marginTop = '4px';
      lockRow.append(
        mkBtn('Free', () => { axisLock = 'none'; updateInfo(); }, axisLock === 'none'),
        mkBtn('Lock Z (move X)', () => { axisLock = 'x'; updateInfo(); }, axisLock === 'x'),
        mkBtn('Lock X (move Z)', () => { axisLock = 'z'; updateInfo(); }, axisLock === 'z'));
      curveRow.append(lockRow);

      // Extend / trim the two ENDS of the track (drag-free way to lengthen or shorten start/end).
      const endRow = document.createElement('div');
      endRow.style.marginTop = '4px';
      endRow.append(
        mkBtn('⟸ Extend start', () => { pushUndo(); curveEditor.extendEnd('start', step * 4); updateInfo(); }),
        mkBtn('Trim start ⟹', () => { pushUndo(); curveEditor.extendEnd('start', -step * 4); updateInfo(); }),
        mkBtn('Extend end ⟹', () => { pushUndo(); curveEditor.extendEnd('end', step * 4); updateInfo(); }),
        mkBtn('⟸ Trim end', () => { pushUndo(); curveEditor.extendEnd('end', -step * 4); updateInfo(); }));
      curveRow.append(endRow);

      // Track WIDTH: shoulders add empty road on each side (lanes stay the same size) to cover the
      // map's road — exactly what you asked for. Lane width is a separate, secondary control.
      const widthRow = document.createElement('div');
      widthRow.style.marginTop = '4px';
      // Shoulder step scales with the current width so it's usable from 0 to thousands of units.
      const shoulderStep = () => Math.max(6, curveEditor.shoulder * 0.3 || 6);
      widthRow.append(
        mkBtn('Wider sides +', () => { pushUndo(); curveEditor.setShoulder(curveEditor.shoulder + shoulderStep()); updateInfo(); }),
        mkBtn('Narrower sides −', () => { pushUndo(); curveEditor.setShoulder(curveEditor.shoulder - shoulderStep()); updateInfo(); }),
        mkBtn('Lanes wider +', () => { pushUndo(); curveEditor.setLaneScale(curveEditor.laneScale * 1.2); updateInfo(); }),
        mkBtn('Lanes narrower −', () => { pushUndo(); curveEditor.setLaneScale(curveEditor.laneScale / 1.2); updateInfo(); }));
      curveRow.append(widthRow);
      const widthInfo = document.createElement('div');
      widthInfo.style.cssText = 'color:#9aa0b4;font-size:11px;margin-top:3px';
      widthInfo.textContent = `side shoulder ${Math.round(curveEditor.shoulder)}u · lane width ×${curveEditor.laneScale.toFixed(2)}`;
      curveRow.append(widthInfo);

      // Corner ROUNDING: straight segments by default; round corners more/less. This is the
      // "control the angle between points" control — sharper = more angular corners.
      const smoothRow = document.createElement('div');
      smoothRow.style.marginTop = '4px';
      smoothRow.append(
        mkBtn('Sharper corners', () => { pushUndo(); curveEditor.setSmoothing(curveEditor.cornerSmoothing - 0.1); updateInfo(); }),
        mkBtn('Smoother corners', () => { pushUndo(); curveEditor.setSmoothing(curveEditor.cornerSmoothing + 0.1); updateInfo(); }),
        mkBtn('Straight (0)', () => { pushUndo(); curveEditor.setSmoothing(0); updateInfo(); }));
      curveRow.append(smoothRow);
      const smoothInfo = document.createElement('div');
      smoothInfo.style.cssText = 'color:#9aa0b4;font-size:11px;margin-top:3px';
      smoothInfo.textContent = curveEditor.cornerSmoothing <= 0.001
        ? 'corners: straight (sharp angles, exact placement)'
        : `corner rounding: ${Math.round(curveEditor.cornerSmoothing * 100)}%`;
      curveRow.append(smoothInfo);
    } else {
      curveRow.append(mkBtn('⟲ Reset curve', () => resetObject('path')));
    }

    const curveHint = document.createElement('div');
    curveHint.style.cssText = 'color:#93a0c0;font-size:11px;line-height:1.5;margin:4px 0';
    curveHint.innerHTML = curveMode
      ? (addArmed
          ? '<b>Click anywhere on the ground</b> to drop a new control point there.'
          : '<b>Click & drag any dot</b> to move it (even after placing it) — it turns yellow when grabbed. ' +
            'Or click to select, then <b>arrow keys</b> nudge it. Red dots = start/finish. ' +
            'Use <b>Lock X/Z</b> for one-axis moves · <b>1/2/3</b> sets nudge step.')
      : 'Click "Bend track" to shape the road. Cars drive the curve visually.';

    const t = transformOf(selectedObj());
    const info = document.createElement('div');
    info.style.cssText = 'color:#9aa0b4;margin:6px 0;font-size:12px';
    info.textContent = `${selected} pos (${t.pos.join(', ')}) · rotY ${t.rotDeg[1]}° · scale ${t.scale} · step ${step}`;

    const saveBtn = mkBtn('💾 Save all (⌘S)', () => void save());
    saveBtn.style.background = '#f22f46'; saveBtn.style.display = 'block'; saveBtn.style.marginTop = '8px';
    panel.append(h, selRow, histRow, hint, views, tools, curveTitle, curveRow, curveHint, info, saveBtn);
  }
  // Capture the session-initial state now that the map has loaded (used by per-object Reset).
  initial.track = transformOf(track);
  initial.map = transformOf(map);
  initial.path = curveEditor.toPath();
  updateInfo();

  function flash(m: string): void {
    updateInfo();
    const f = document.createElement('div');
    f.style.cssText = 'color:#36e08a;margin-top:6px;font-size:12px'; f.textContent = m; panel.append(f);
  }

  renderer.domElement.tabIndex = 0;
  renderer.domElement.style.outline = 'none';
  renderer.domElement.focus();

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  function loop(): void {
    requestAnimationFrame(loop);
    orbit.update();
    // Dynamic near/far sized to the camera's distance from its target, so unlimited zoom never
    // clips — zoom way out to see a huge map, or way in to nudge a lane, with good depth precision.
    const dist = camera.position.distanceTo(orbit.target);
    camera.far = Math.max(2000, dist * 4);
    camera.near = Math.max(0.05, dist / 5000);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }
  loop();
}
