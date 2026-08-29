import { describe, expect, it } from 'vitest';

import { acquireViewerCanvasOwnership } from '../packages/viewer/src/scene/viewer-canvas-ownership.js';

describe('Viewer canvas generation ownership', () => {
  it('queues a replacement generation until the active generation releases', async () => {
    const canvas = {} as HTMLCanvasElement;
    const first = await acquireViewerCanvasOwnership(canvas).acquired;
    const secondAcquisition = acquireViewerCanvasOwnership(canvas);
    let secondResolved = false;
    void secondAcquisition.acquired.then(() => {
      secondResolved = true;
    });

    await Promise.resolve();
    expect(secondResolved).toBe(false);

    first?.release();
    const second = await secondAcquisition.acquired;
    expect(second?.isCurrent()).toBe(true);
    second?.release();
  });

  it('cancels a queued remount without acquiring or blocking the active generation', async () => {
    const canvas = {} as HTMLCanvasElement;
    const active = await acquireViewerCanvasOwnership(canvas).acquired;
    const cancelled = acquireViewerCanvasOwnership(canvas);

    cancelled.cancel();
    cancelled.cancel();

    await expect(cancelled.acquired).resolves.toBeNull();
    expect(active?.isCurrent()).toBe(true);
    active?.release();
  });

  it('releases only after asynchronous generation cleanup finishes', async () => {
    const canvas = {} as HTMLCanvasElement;
    const active = await acquireViewerCanvasOwnership(canvas).acquired;
    const replacementAcquisition = acquireViewerCanvasOwnership(canvas);
    const cleanup = deferred<void>();
    const release = active?.releaseAfter(() => cleanup.promise);
    let replacementResolved = false;
    void replacementAcquisition.acquired.then(() => {
      replacementResolved = true;
    });

    await Promise.resolve();
    expect(replacementResolved).toBe(false);

    cleanup.resolve();
    await release;
    const replacement = await replacementAcquisition.acquired;
    expect(replacement?.isCurrent()).toBe(true);
    replacement?.release();
  });
});

function deferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
