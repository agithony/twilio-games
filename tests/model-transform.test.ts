// The game loader must place a model identically to the garage: auto-fit to target, ground on y=0,
// center on x/z — and crucially do so AFTER applying rotation, so a model whose geometry is authored
// off-origin (e.g. the monster truck, local center x≈-238) doesn't get flung sideways by a 90° turn.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyModelTransform } from '../client/model-transform';

/** A group holding one box mesh whose geometry is centered at `offsetX` (off the local origin). */
function offsetBoxGroup(offsetX: number, size: [number, number, number]): THREE.Group {
  const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
  geo.translate(offsetX, 0, 0);                 // author the geometry off-origin
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
  return g;
}

function worldBox(g: THREE.Object3D): THREE.Box3 {
  g.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(g);
}

describe('applyModelTransform', () => {
  it('auto-fits the longest dimension to the target', () => {
    const g = offsetBoxGroup(0, [2, 1, 1]);
    applyModelTransform(g, {}, 4);
    const size = worldBox(g).getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(4, 3);
  });

  it('grounds the model on y=0 and centers x/z', () => {
    const g = offsetBoxGroup(0, [2, 1, 1]);
    applyModelTransform(g, {}, 4);
    const box = worldBox(g);
    expect(box.min.y).toBeCloseTo(0, 3);
    const c = box.getCenter(new THREE.Vector3());
    expect(c.x).toBeCloseTo(0, 3);
    expect(c.z).toBeCloseTo(0, 3);
  });

  it('keeps an OFF-ORIGIN model centered after a 90° Y rotation (monster-truck bug)', () => {
    // Geometry authored far off the local origin; a Y-rotation must not shove it out of the lane.
    const g = offsetBoxGroup(50, [4, 2, 2]);
    applyModelTransform(g, { rotation: [0, 90, 0] }, 4);
    const box = worldBox(g);
    const c = box.getCenter(new THREE.Vector3());
    expect(c.x).toBeCloseTo(0, 3);
    expect(c.z).toBeCloseTo(0, 3);
    expect(box.min.y).toBeCloseTo(0, 3);
  });

  it('applies the manual offset on top of centering', () => {
    const g = offsetBoxGroup(50, [4, 2, 2]);
    applyModelTransform(g, { rotation: [0, 90, 0], offset: [1, 0.5, -2] }, 4);
    const box = worldBox(g);
    const c = box.getCenter(new THREE.Vector3());
    expect(c.x).toBeCloseTo(1, 3);
    expect(c.z).toBeCloseTo(-2, 3);
    expect(box.min.y).toBeCloseTo(0.5, 3);
  });
});
