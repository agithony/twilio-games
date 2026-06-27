import { describe, it, expect } from 'vitest';
import { buildStarterManifest, type GlbReport } from '../tools/inspect-assets';

const reports: GlbReport[] = [
  { file: 'sedan.glb',  size: [2,1.4,4],   wheelNodes: ['wheel_FL','wheel_FR','wheel_RL','wheel_RR'] },
  { file: 'truck.glb',  size: [2.4,2,5],   wheelNodes: ['wheel1','wheel2'] },
  { file: 'cone.glb',   size: [0.6,1,0.6], wheelNodes: [] },
  { file: 'tree.glb',   size: [3,6,3],     wheelNodes: [] },
];

describe('buildStarterManifest', () => {
  it('assigns wheeled models to cars', () => {
    const m = buildStarterManifest(reports);
    const carFiles = m.cars.map(c => c.file);
    expect(carFiles).toContain('sedan.glb');
    expect(carFiles).toContain('truck.glb');
  });
  it('puts non-car models into props (or barrier/boostPad), never cars', () => {
    const m = buildStarterManifest(reports);
    const carFiles = m.cars.map(c => c.file);
    expect(carFiles).not.toContain('tree.glb');
    // everything maps somewhere
    const all = [...m.cars, m.barrier, m.boostPad, ...m.props].filter(Boolean).map(r => (r as any).file);
    expect(all).toContain('tree.glb');
    expect(all).toContain('cone.glb');
  });
  it('produces a valid manifest shape even with no inputs', () => {
    const m = buildStarterManifest([]);
    expect(m).toEqual({ cars: [], barrier: null, boostPad: null, props: [] });
  });
});
