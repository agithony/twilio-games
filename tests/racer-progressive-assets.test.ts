import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetLoader } from '../client/asset-loader';
import { renderBoostThumbnailAsync, renderCarThumbnailsAsync } from '../client/thumbnails';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeAssets(carLoads: Promise<boolean>[], boostLoad: Promise<boolean> = Promise.resolve(false)): AssetLoader {
  return {
    carCount: () => carLoads.length,
    carReady: (i: number) => carLoads[i]!,
    carTemplate: () => null,
    boostReady: () => boostLoad,
    boostTemplate: () => null,
  } as unknown as AssetLoader;
}

describe('Racer progressive asset portraits', () => {
  beforeEach(() => {
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => callback());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders cars in completion order instead of manifest order', async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const rendered: number[] = [];
    const complete = renderCarThumbnailsAsync(fakeAssets([first.promise, second.promise]), i => rendered.push(i));

    second.resolve(true);
    await vi.waitFor(() => expect(rendered).toEqual([1]));
    first.resolve(true);
    await complete;

    expect(rendered).toEqual([1, 0]);
  });

  it('continues after an individual car load rejects', async () => {
    const failed = deferred<boolean>();
    const ready = deferred<boolean>();
    const rendered: number[] = [];
    const complete = renderCarThumbnailsAsync(fakeAssets([failed.promise, ready.promise]), i => rendered.push(i));

    failed.reject(new Error('car failed'));
    ready.resolve(true);
    await complete;

    expect(rendered.sort()).toEqual([0, 1]);
  });

  it('pauses settled portraits during a race and resumes afterward', async () => {
    let canRender = false;
    const rendered: number[] = [];
    const complete = renderCarThumbnailsAsync(fakeAssets([Promise.resolve(true)]), i => rendered.push(i), 256, () => canRender);

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(rendered).toEqual([]);
    canRender = true;
    await complete;

    expect(rendered).toEqual([0]);
  });

  it('waits for the boost asset before attempting its portrait', async () => {
    const boost = deferred<boolean>();
    const complete = renderBoostThumbnailAsync(fakeAssets([], boost.promise));
    let settled = false;
    void complete.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    boost.resolve(false);

    await expect(complete).resolves.toBe('');
  });
});
