import { describe, expect, it } from 'vitest';
import { canReloadArenaForViewport, frameStaticPortraitArena, portraitOrientationChanged, proceduralFallbackCamera, responsiveVerticalFov, shouldUseLivePortraitArena } from '../client/fighter/fighter-camera';

describe('Voice Fighter responsive camera projection', () => {
  it('preserves authored landscape shots', () => {
    expect(responsiveVerticalFov(36, 16 / 9)).toBe(36);
    expect(responsiveVerticalFov(40, 2)).toBe(40);
  });

  it('uses bounded diagonal framing for a 9:16 display', () => {
    expect(responsiveVerticalFov(36, 9 / 16)).toBeCloseTo(60.02, 1);
    expect(responsiveVerticalFov(40, 9 / 16)).toBeCloseTo(65.81, 1);
    expect(responsiveVerticalFov(36, 9 / 16)).toBeLessThan(70);
  });

  it('falls back safely for invalid inputs', () => {
    expect(responsiveVerticalFov(Number.NaN, 9 / 16)).toBe(36);
    expect(responsiveVerticalFov(36, 0)).toBe(36);
  });

  it('centers and fits a static portrait arena without changing its authored direction', () => {
    const shot = frameStaticPortraitArena({
      pos: [1.1, 3.27, 16.19], lookAt: [1.02, 2.01, -.32], fov: 36,
    }, [-4.5, 6.75], [0, .75, 8], 0, 9 / 16);
    expect(shot.lookAt).toEqual([1.125, 2.01, 8]);
    const direction = shot.pos.map((value, index) => value - shot.lookAt[index]!) as [number,number,number];
    const depth = Math.hypot(...direction);
    const halfWidth = depth * Math.tan(responsiveVerticalFov(36, 9 / 16) * Math.PI / 360) * 9 / 16;
    expect(halfWidth).toBeGreaterThanOrEqual((6.75 - -4.5) / 2 + 1.5 - .001);
  });

  it('fits the widest procedural arena in portrait', () => {
    const shot = frameStaticPortraitArena({
      pos: [0, 2.15, 10.5], lookAt: [0, 1.25, 0], fov: 36,
    }, [-11, 11], [0, 0, 0], 0, 9 / 16);
    const depth = Math.hypot(...shot.pos.map((value, index) => value - shot.lookAt[index]!));
    const halfWidth = depth * Math.tan(responsiveVerticalFov(36, 9 / 16) * Math.PI / 360) * 9 / 16;
    expect(halfWidth).toBeGreaterThanOrEqual(12.5 - .001);
  });

  it('leaves static landscape camera shots unchanged', () => {
    const shot: Parameters<typeof frameStaticPortraitArena>[0] = {
      pos: [1.1, 3.27, 16.19], lookAt: [1.02, 2.01, -.32], fov: 36,
    };
    expect(frameStaticPortraitArena(shot, [-4.5, 6.75], [0, .75, 8], 0, 16 / 9)).toBe(shot);
  });

  it('centers the procedural fallback on asymmetric arena bounds', () => {
    expect(proceduralFallbackCamera([0, 11])).toEqual({
      pos: [5.5, 2.15, 10.5], lookAt: [5.5, 1.25, 0], fov: 36,
    });
  });

  it('uses live tracking only for the lightweight restaurant in portrait', () => {
    expect(shouldUseLivePortraitArena('inakaya', 9 / 16)).toBe(true);
    expect(shouldUseLivePortraitArena('cyberpunk-city', 9 / 16)).toBe(false);
    expect(shouldUseLivePortraitArena('inakaya', 16 / 9)).toBe(false);
  });

  it('detects orientation boundary changes without reacting to ordinary resizes', () => {
    expect(portraitOrientationChanged(16 / 9, 9 / 16)).toBe(true);
    expect(portraitOrientationChanged(9 / 16, 16 / 9)).toBe(true);
    expect(portraitOrientationChanged(9 / 16, 3 / 4)).toBe(false);
    expect(portraitOrientationChanged(16 / 9, 4 / 3)).toBe(false);
    expect(portraitOrientationChanged(0, 9 / 16)).toBe(false);
  });

  it('allows viewport arena reloads only before the active loading generation is ready', () => {
    expect(canReloadArenaForViewport('loading', '4:rain', '')).toBe(true);
    expect(canReloadArenaForViewport('loading', '4:rain', '4:rain')).toBe(false);
    expect(canReloadArenaForViewport('intro', '4:rain', '')).toBe(false);
    expect(canReloadArenaForViewport('countdown', '4:rain', '')).toBe(false);
    expect(canReloadArenaForViewport('fight', '4:rain', '')).toBe(false);
  });
});
