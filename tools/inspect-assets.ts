import { readdir } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readGlb } from './glb-read';
import { isWheelNode } from '../shared/asset-fit';
import { serializeManifest, type Manifest } from '../shared/asset-manifest';

export type GlbReport = { file: string; size: [number, number, number]; wheelNodes: string[] };

export async function inspectDir(dir: string, read = readGlb): Promise<GlbReport[]> {
  const entries = await readdir(dir);
  const glbs = entries.filter(f => f.toLowerCase().endsWith('.glb'));
  const reports: GlbReport[] = [];
  for (const file of glbs) {
    try {
      const { nodeNames, size } = await read(join(dir, file));
      reports.push({ file, size, wheelNodes: nodeNames.filter(isWheelNode) });
    } catch (e) {
      console.warn(`inspect: could not read ${file} (${(e as Error).message.slice(0,80)}); listing with no size/wheel data`);
      reports.push({ file, size: [0,0,0], wheelNodes: [] });
    }
  }
  return reports;
}

/** Heuristic starter roles: wheeled models => cars; the rest spread across barrier/boostPad/props. */
export function buildStarterManifest(reports: GlbReport[]): Manifest {
  const cars = reports.filter(r => r.wheelNodes.length > 0).map(r => ({ file: r.file }));
  const nonCars = reports.filter(r => r.wheelNodes.length === 0);
  const barrier = nonCars[0] ? { file: nonCars[0].file } : null;
  const boostPad = nonCars[1] ? { file: nonCars[1].file } : null;
  const props = nonCars.slice(2).map(r => ({ file: r.file }));
  return { cars, barrier, boostPad, props };
}

export function formatReport(reports: GlbReport[]): string {
  if (reports.length === 0) return 'No .glb files found in assets/.';
  return reports.map(r => {
    const [x,y,z] = r.size.map(n => n.toFixed(2));
    const wheels = r.wheelNodes.length ? `${r.wheelNodes.length} wheels [${r.wheelNodes.join(', ')}]` : 'no wheels';
    return `${r.file.padEnd(28)} size ${x}×${y}×${z}   ${wheels}`;
  }).join('\n');
}

// CLI entry (only when run directly)
const isMain = process.argv[1] && process.argv[1].endsWith('inspect-assets.ts');
if (isMain) {
  const dir = 'assets';
  Promise.all([
    inspectDir('assets/racer/cars').then(reports => reports.map(report => ({ ...report, file: `racer/cars/${report.file}` }))),
    inspectDir('assets/racer/track').then(reports => reports.map(report => ({ ...report, file: `racer/track/${report.file}` }))),
  ]).then(async groups => {
    const reports = groups.flat();
    console.log(formatReport(reports));
    const manifest = buildStarterManifest(reports);
    await writeFile(join(dir, 'manifest.json'), serializeManifest(manifest));
    console.log(`\nWrote ${join(dir, 'manifest.json')} (${manifest.cars.length} cars).`);
  });
}
