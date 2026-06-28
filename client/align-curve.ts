// Curve editor for the align tool (Option B). Owns the track's control points, the curved road
// ribbon + lane lines built along them, and draggable handles at each point. Drag a handle on the
// ground plane to bend the track; add/remove points to extend/trim or add bends. The resulting
// TrackPath is saved to maps.json and replayed in-game (render-only — the sim stays straight).
import * as THREE from 'three';
import { RACE_LEN, laneX } from '../shared/constants';
import { CurvedTrack } from './track-path';
import { buildTrackSurface, type SurfaceOpts } from './track-surface';
import type { TrackPath } from './map-world';

export class CurveEditor {
  /** The group all curve geometry + handles live in (caller adds it to the scene/track group). */
  readonly group = new THREE.Group();
  private points: THREE.Vector3[];          // control points (y=0), in start→finish order
  private ribbon = new THREE.Group();        // the shared 3-lane surface (same mesh the game uses)
  private handles = new THREE.Group();       // draggable spheres at each control point
  private markers = new THREE.Group();       // start car, arrow, lap lines
  private selectedHandle = -1;
  private opts: SurfaceOpts;                 // lane width + shoulder (saved into the path)
  private smoothing: number;                 // 0 = straight segments, higher = rounded corners

  constructor(path?: TrackPath) {
    this.points = (path?.points ?? [[0, 0], [0, RACE_LEN]]).map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.opts = { laneScale: path?.laneScale ?? 1, shoulder: path?.shoulder ?? 0 };
    this.smoothing = path?.smoothing ?? 0;
    this.group.add(this.ribbon, this.handles, this.markers);
    this.rebuild();
  }

  /** The current authored path + width + smoothing (saved to maps.json). */
  toPath(): TrackPath {
    return { points: this.points.map(p => [round(p.x), round(p.z)]),
             laneScale: round(this.opts.laneScale), shoulder: round(this.opts.shoulder),
             smoothing: round(this.smoothing) };
  }

  /** Adjust lane width (multiplier) or side shoulder (world units), clamped to sane ranges. The
   *  shoulder range is large because maps can be scaled huge — you may need a wide apron to cover
   *  the map's own road. */
  setLaneScale(v: number): void { this.opts.laneScale = THREE.MathUtils.clamp(v, 0.3, 20); this.rebuild(); }
  setShoulder(v: number): void { this.opts.shoulder = THREE.MathUtils.clamp(v, 0, 4000); this.rebuild(); }
  /** Corner rounding between points: 0 = sharp straight corners, 1 = fully flowing curve. */
  setSmoothing(v: number): void { this.smoothing = THREE.MathUtils.clamp(v, 0, 1); this.rebuild(); }
  get laneScale(): number { return this.opts.laneScale; }
  get shoulder(): number { return this.opts.shoulder; }
  get cornerSmoothing(): number { return this.smoothing; }

  /** A live CurvedTrack for sampling (used to place markers + by callers if needed). */
  curve(): CurvedTrack { return new CurvedTrack(this.toPath()); }

  /** All draggable handle meshes (caller raycasts these to start a drag). */
  handleMeshes(): THREE.Object3D[] { return this.handles.children; }

  /** Begin dragging the handle for object `o` (returns its index, or -1 if not a handle). */
  beginDrag(o: THREE.Object3D): number {
    const idx = this.handles.children.indexOf(o);
    this.selectedHandle = idx;
    this.highlight();
    return idx;
  }

  /** Move the dragged control point to a new ground position, then rebuild live. */
  dragTo(idx: number, x: number, z: number): void {
    const p = this.points[idx];
    if (!p) return;
    p.set(x, 0, z);
    this.rebuild();
  }

  /** Select a handle by index (e.g. a plain click, no drag). -1 clears the selection. */
  select(idx: number): void { this.selectedHandle = idx; this.highlight(); }

  /**
   * Insert a control point at an EXACT ground position (where you clicked), placed at the spot in
   * the path that keeps it ordered start→finish: the segment whose line the point is nearest to.
   * Returns the new point's index (and selects it). Never inserts before the start / after the end.
   */
  addPointAt(x: number, z: number): number {
    const np = new THREE.Vector3(x, 0, z);
    let bi = 0, best = Infinity;
    for (let i = 0; i < this.points.length - 1; i++) {
      const d = distToSegment(np, this.points[i]!, this.points[i + 1]!);
      if (d < best) { best = d; bi = i; }
    }
    this.points.splice(bi + 1, 0, np);
    this.selectedHandle = bi + 1;
    this.rebuild();
    return this.selectedHandle;
  }

  /** Remove the selected control point. Returns false (no-op) if nothing selected, an endpoint is
   *  selected, or we're already at the 2-point minimum a track needs. */
  removeSelected(): boolean {
    const i = this.selectedHandle;
    if (i < 0) return false;                                   // nothing selected
    if (this.points.length <= 2) return false;                 // need a start + end
    if (i === 0 || i === this.points.length - 1) return false; // can't delete start/finish
    this.points.splice(i, 1);
    this.selectedHandle = -1;
    this.rebuild();
    return true;
  }

  /**
   * Extend (+dist) or trim (−dist) one END of the track along its local direction. The start point
   * moves opposite its outgoing direction; the end point moves along its incoming direction. Keeps
   * the endpoint from crossing its neighbor (leaves a minimum gap).
   */
  extendEnd(which: 'start' | 'end', dist: number): void {
    const n = this.points.length;
    if (n < 2) return;
    if (which === 'start') {
      const a = this.points[0]!, b = this.points[1]!;
      const dir = a.clone().sub(b).normalize();              // points "backward" off the start
      const moved = a.clone().addScaledVector(dir, dist);
      if (moved.distanceTo(b) > 5) a.copy(moved);
    } else {
      const a = this.points[n - 1]!, b = this.points[n - 2]!;
      const dir = a.clone().sub(b).normalize();              // points "forward" off the end
      const moved = a.clone().addScaledVector(dir, dist);
      if (moved.distanceTo(b) > 5) a.copy(moved);
    }
    this.rebuild();
  }

  /** Nudge the selected point by (dx, dz) in path-local space (arrow-key editing). */
  nudgeSelected(dx: number, dz: number): boolean {
    const p = this.points[this.selectedHandle];
    if (!p) return false;
    p.x += dx; p.z += dz;
    this.rebuild();
    return true;
  }

  /** Reset to a straight track (start → finish down +Z). */
  reset(): void {
    this.points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, RACE_LEN)];
    this.selectedHandle = -1;
    this.rebuild();
  }

  /** Restore the editor to a saved path + width opts (used by undo/redo). Clears the selection. */
  setPath(path: TrackPath): void {
    this.points = path.points.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.opts = { laneScale: path.laneScale ?? 1, shoulder: path.shoulder ?? 0 };
    this.smoothing = path.smoothing ?? 0;
    this.selectedHandle = -1;
    this.rebuild();
  }

  /** The control point at `idx` (live reference), or undefined. Used for axis-locked dragging. */
  pointAt(idx: number): THREE.Vector3 | undefined { return this.points[idx]; }

  get selectedIndex(): number { return this.selectedHandle; }
  get pointCount(): number { return this.points.length; }

  // ── Rebuild all geometry from the current control points. ──
  private rebuild(): void {
    const curve = this.curve();
    this.buildRibbon(curve);
    this.buildHandles();
    this.buildMarkers(curve);
  }

  private clear(g: THREE.Group): void {
    for (const c of [...g.children]) {
      g.remove(c);
      (c as THREE.Mesh).geometry?.dispose?.();
    }
  }

  private buildRibbon(curve: CurvedTrack): void {
    this.clear(this.ribbon);
    // Use the EXACT shared surface the game renders, so the editor preview == the real track.
    this.ribbon.add(buildTrackSurface(curve, this.opts));
  }

  private buildHandles(): void {
    this.clear(this.handles);
    this.points.forEach((p, i) => {
      const isEnd = i === 0 || i === this.points.length - 1;
      const sel = i === this.selectedHandle;
      // Bigger, depth-test-off spheres so they're easy to see and grab, and never hidden behind the
      // road/map. The selected one is larger + yellow; endpoints red; mid bends green.
      const r = sel ? 11 : (isEnd ? 9 : 8);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12),
        new THREE.MeshBasicMaterial({ color: sel ? 0xffcf33 : (isEnd ? 0xff3b3b : 0x36e08a),
          depthTest: false, transparent: true }));
      mesh.renderOrder = 999;   // draw on top of the track surface
      mesh.position.set(p.x, 3, p.z);
      this.handles.add(mesh);
    });
  }

  private highlight(): void {
    // Rebuild so the selected handle's SIZE updates too (not just color).
    this.buildHandles();
  }

  private buildMarkers(curve: CurvedTrack): void {
    this.clear(this.markers);
    // Start car + forward arrow at the start of the curve, lane 1 (the lap lines + lanes come from
    // the shared surface). Lift onto the surface (y≈0.6) so they sit on the road, not under it.
    const s0 = curve.sample(4, laneX(1) * this.opts.laneScale);
    const car = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 3.4),
      new THREE.MeshBasicMaterial({ color: 0xff3b3b }));
    car.position.set(s0.pos.x, 1.2, s0.pos.z); car.rotation.y = s0.headingY; this.markers.add(car);
    const s1 = curve.sample(12, laneX(1) * this.opts.laneScale);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.2, 4, 8),
      new THREE.MeshBasicMaterial({ color: 0xffcf33 }));
    arrow.position.set(s1.pos.x, 1.2, s1.pos.z);
    arrow.rotation.set(Math.PI / 2, 0, 0); arrow.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), s1.headingY);
    this.markers.add(arrow);
  }
}

function round(n: number): number { return Math.round(n * 1000) / 1000; }

/** Shortest distance from point p to the segment a→b (XZ plane). Used to choose where a clicked
 *  point inserts into the ordered path. */
function distToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = b.clone().sub(a); const ap = p.clone().sub(a);
  const len2 = ab.lengthSq() || 1e-9;
  const t = THREE.MathUtils.clamp(ap.dot(ab) / len2, 0, 1);
  return ap.sub(ab.multiplyScalar(t)).length();
}
