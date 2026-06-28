// Render-only curved track path (Option B). The SERVER sim is unchanged — cars drive a straight
// lane-runner where sim-z is distance (0..RACE_LEN) and sim-x is a lane offset. This module maps
// that flat (z, x) onto a smooth curve so the road, scenery, and cars LOOK like they follow bends,
// while collisions/laps/items stay straight. Build a CurvedTrack from control points, then call
// sample(z, x) per car/object each frame to get its world position + heading.
import * as THREE from 'three';
import { RACE_LEN } from '../shared/constants';
import type { TrackPath } from './map-world';

export interface Placement { pos: THREE.Vector3; headingY: number; }

/**
 * The track path as a sequence of control points. By DEFAULT the segments are STRAIGHT (a
 * polyline): adding a point on a straight run changes nothing until you move it, and moving a
 * point only affects its two adjacent segments — so placement is exact and predictable. A
 * `smoothing` value (0..1) rounds the corners: 0 = sharp straight corners, 1 = a flowing
 * centripetal Catmull-Rom curve. sim-z maps to arc length so visual speed stays even.
 */
export class CurvedTrack {
  private curve: THREE.Curve<THREE.Vector3>;
  private totalLen: number;

  constructor(path: TrackPath) {
    const pts = path.points.map(([x, z]) => new THREE.Vector3(x, 0, z));
    // Need at least two points; fall back to a straight line if degenerate.
    if (pts.length < 2) {
      pts.length = 0;
      pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, RACE_LEN));
    }
    const smoothing = THREE.MathUtils.clamp(path.smoothing ?? 0, 0, 1);
    if (smoothing <= 0.001) {
      // Straight polyline through the points — predictable, no overshoot. CurvePath of line segs.
      const cp = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 0; i < pts.length - 1; i++) cp.add(new THREE.LineCurve3(pts[i]!, pts[i + 1]!));
      this.curve = cp;
    } else {
      // Centripetal Catmull-Rom (no self-intersection/cusp overshoot), tension from smoothing.
      this.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', smoothing);
    }
    this.totalLen = this.curve.getLength();
  }

  /**
   * Place a sim point (z = distance 0..RACE_LEN, x = sideways lane offset) onto the curve.
   * Returns its world position and the curve's heading (rotation about Y) at that distance, so
   * meshes can be turned to face along the track.
   */
  sample(z: number, x: number): Placement {
    // sim-z spans 0..RACE_LEN; map proportionally onto the curve's arc length, clamped.
    const t = THREE.MathUtils.clamp(z / RACE_LEN, 0, 1);
    const center = this.curve.getPointAt(t);
    const tan = this.curve.getTangentAt(t);            // unit tangent (curve forward dir)
    const headingY = Math.atan2(tan.x, tan.z);          // yaw so +Z local aligns with tangent
    // Perpendicular in the ground plane (rotate tangent -90° about Y): right-hand side of travel.
    const perp = new THREE.Vector3(tan.z, 0, -tan.x);
    const pos = center.clone().addScaledVector(perp, x);
    return { pos, headingY };
  }

  /** Sample N evenly-spaced world points along the centerline (for drawing the road ribbon). */
  centerline(segments: number): THREE.Vector3[] {
    return this.curve.getSpacedPoints(segments);
  }

  get length(): number { return this.totalLen; }
}

/** A default straight path (start → finish down +Z) for maps with no authored curve. */
export function straightPath(): TrackPath {
  return { points: [[0, 0], [0, RACE_LEN]] };
}
