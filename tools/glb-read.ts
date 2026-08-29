import { createRequire } from 'node:module';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const draco3d = createRequire(import.meta.url)('draco3dgltf') as {
  createDecoderModule: () => Promise<unknown>;
};

export interface GlbBounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface GlbReadResult {
  nodeNames: string[];
  size: [number, number, number];
  animationNames: string[];
  extensionNames: string[];
  primitiveCount: number;
  nodeBounds: Record<string, GlbBounds>;
}

function finiteBounds(value: { min: number[]; max: number[] }): GlbBounds | null {
  const values = [...value.min, ...value.max];
  if (values.length !== 6 || !values.every(Number.isFinite)) return null;
  const min = value.min as [number, number, number];
  const max = value.max as [number, number, number];
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Reads plain or Draco-compressed GLBs headlessly, including transformed world-space bounds. */
export async function readGlb(path: string): Promise<GlbReadResult> {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
  const doc = await io.read(path);
  const root = doc.getRoot();
  const nodeNames = root.listNodes().map(node => node.getName()).filter(Boolean);
  const animationNames = root.listAnimations().map(animation => animation.getName()).filter(Boolean);
  const extensionNames = root.listExtensionsUsed().map(extension => extension.extensionName);
  const sceneBounds = finiteBounds(getBounds(root.listScenes()[0]!));
  const nodeBounds: Record<string, GlbBounds> = {};
  for (const node of root.listNodes()) {
    const name = node.getName();
    if (!name) continue;
    const bounds = finiteBounds(getBounds(node));
    if (bounds) nodeBounds[name] = bounds;
  }
  const primitiveCount = root.listMeshes().reduce((total, mesh) => total
    + mesh.listPrimitives().filter(primitive => primitive.getAttribute('POSITION')).length, 0);
  return {
    nodeNames,
    size: sceneBounds?.size ?? [0, 0, 0],
    animationNames,
    extensionNames,
    primitiveCount,
    nodeBounds,
  };
}
