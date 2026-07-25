import { describe, expect, it } from 'vitest';
import { chaseCameraPose } from '../client/chase-camera';
import { splitScreenViewports, type SplitScreenCar } from '../client/split-screen';

const car = (id: string, name: string, x: number, z: number): SplitScreenCar => ({
  id, name, color: id === 'p1' ? '#36d1dc' : '#f22f46', x, z, invulnerable: false,
});

describe('Voice Racer split screen', () => {
  it('covers an odd-height canvas with top and bottom player viewports', () => {
    const views = splitScreenViewports([
      car('p1', 'Ada', -4, 100),
      car('p2', 'Rex', 4, 20),
    ], 1920, 1081);

    expect(views).toEqual([
      expect.objectContaining({ car: expect.objectContaining({ id: 'p1' }), glY: 540, cssTop: 0, width: 1920, height: 541 }),
      expect.objectContaining({ car: expect.objectContaining({ id: 'p2' }), glY: 0, cssTop: 541, width: 1920, height: 540 }),
    ]);
    expect(views[0]!.height + views[1]!.height).toBe(1081);
  });

  it('activates only when exactly two racers are present', () => {
    const racers = [car('p1', 'Ada', 0, 0), car('p2', 'Rex', 0, 0), car('p3', 'Kai', 0, 0)];
    expect(splitScreenViewports(racers.slice(0, 1), 1280, 720)).toEqual([]);
    expect(splitScreenViewports(racers, 1280, 720)).toEqual([]);
  });

  it('resolves an independent behind-the-car camera for each racer', () => {
    const settings = { behind: 24, height: 9, lookAhead: 45, lookHeight: 2.2, lateral: 10 };
    const first = chaseCameraPose(car('p1', 'Ada', -4, 100), settings);
    const second = chaseCameraPose(car('p2', 'Rex', 4, 20), settings);

    expect(first).toEqual({ eye: { x: 8.8, y: 9, z: 76 }, look: { x: -1.6, y: 2.2, z: 145 } });
    expect(second).toEqual({ eye: { x: 11.2, y: 9, z: -4 }, look: { x: 1.6, y: 2.2, z: 65 } });
  });

  it('samples curved tracks behind and ahead of the selected racer', () => {
    const samples: Array<[number, number]> = [];
    const pose = chaseCameraPose(car('p1', 'Ada', 5, 80), {
      behind: 20, height: 8, lookAhead: 30, lookHeight: 3, lateral: 2,
    }, {
      sample: (z, x) => {
        samples.push([z, x]);
        return { pos: { x: x + 100, y: z / 10, z: z * 2 } };
      },
    });

    expect(samples).toEqual([[60, 3.5], [110, 2]]);
    expect(pose).toEqual({ eye: { x: 103.5, y: 14, z: 120 }, look: { x: 102, y: 14, z: 220 } });
  });
});
