import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector2 } from 'three';

import { Viewer } from '../packages/viewer/src/scene/viewer.js';
import { createViewerGenerationDisposer } from '../packages/viewer/src/viewer-runtime-lifecycle.js';

describe('Viewer render lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops synchronously and disposes resources once', async () => {
    const setAnimationLoop = vi.fn();
    const removeControlListener = vi.fn();
    const removeWindowListener = vi.fn();
    const disposeResources = vi.fn();
    vi.stubGlobal('window', { removeEventListener: removeWindowListener });
    const viewer = Object.assign(Object.create(Viewer.prototype) as object, {
      running: true,
      disposePromise: null,
      renderer: { setAnimationLoop },
      controls: { removeEventListener: removeControlListener },
      requestRender: () => undefined,
      disposeResources,
    }) as unknown as Viewer;

    viewer.stop();
    viewer.stop();

    expect(setAnimationLoop).toHaveBeenCalledOnce();
    expect(setAnimationLoop).toHaveBeenCalledWith(null);
    expect(removeWindowListener).toHaveBeenCalledOnce();
    expect(removeControlListener).toHaveBeenCalledOnce();

    const firstDispose = viewer.dispose();
    const secondDispose = viewer.dispose();
    expect(firstDispose).toBe(secondDispose);
    await firstDispose;

    expect(setAnimationLoop).toHaveBeenCalledOnce();
    expect(disposeResources).toHaveBeenCalledOnce();
  });

  it('reuses the immediate stop path during full disposal', async () => {
    const stop = vi.fn();
    const disposeResources = vi.fn();
    const viewer = Object.assign(Object.create(Viewer.prototype) as object, {
      disposePromise: null,
      stop,
      disposeResources,
    }) as unknown as Viewer;

    await viewer.dispose();

    expect(stop).toHaveBeenCalledOnce();
    expect(disposeResources).toHaveBeenCalledOnce();
  });

  it('stops once, clears public state, then disposes contributions before scene resources', async () => {
    const order: string[] = [];
    const contribution = deferred<void>();
    const dispose = createViewerGenerationDisposer({
      stop: () => {
        order.push('stop');
      },
      beforeContributions: [
        () => {
          order.push('clear-state');
        },
      ],
      disposeContributions: async () => {
        order.push('contributions-start');
        await contribution.promise;
        order.push('contributions-end');
      },
      afterContributions: [
        () => {
          order.push('scene');
        },
      ],
    });

    const first = dispose();
    expect(dispose()).toBe(first);
    expect(order).toEqual(['stop', 'clear-state', 'contributions-start']);
    contribution.resolve();
    await first;
    expect(order).toEqual(['stop', 'clear-state', 'contributions-start', 'contributions-end', 'scene']);
  });

  it('runs every cleanup phase and aggregates failures', async () => {
    const completed: string[] = [];
    const dispose = createViewerGenerationDisposer({
      stop: () => {
        throw new Error('stop');
      },
      beforeContributions: [
        () => {
          completed.push('before');
          throw new Error('before');
        },
      ],
      disposeContributions: () => {
        completed.push('contributions');
        throw new Error('contributions');
      },
      afterContributions: [
        () => {
          completed.push('after');
        },
      ],
    });

    const failure = await dispose().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(3);
    expect(completed).toEqual(['before', 'contributions', 'after']);
  });

  it.each([1, 2])('only resizes and invalidates a stationary viewport once at DPR %i', pixelRatio => {
    const canvas = { clientWidth: 640, clientHeight: 480, width: 300, height: 150 };
    const logicalSize = new Vector2(300, 150);
    const setSize = vi.fn((width: number, height: number) => {
      logicalSize.set(width, height);
      canvas.width = Math.floor(width * pixelRatio);
      canvas.height = Math.floor(height * pixelRatio);
    });
    const updateLayout = vi.fn();
    const camera = { aspect: 1, updateProjectionMatrix: vi.fn() };
    const viewer = Object.assign(Object.create(Viewer.prototype) as { resize(): void }, {
      canvas,
      rendererSize: new Vector2(),
      renderer: { getSize: (target: Vector2) => target.copy(logicalSize), setSize },
      viewCube: { updateLayout },
      camera,
      needsRender: false,
    });

    viewer.resize();
    expect(viewer.needsRender).toBe(true);
    expect(camera.aspect).toBe(640 / 480);
    viewer.needsRender = false;
    for (let frame = 0; frame < 120; frame++) {
      viewer.resize();
      expect(viewer.needsRender).toBe(false);
    }
    expect(setSize).toHaveBeenCalledExactlyOnceWith(640, 480, false);
    expect(updateLayout).toHaveBeenCalledOnce();
    expect(camera.updateProjectionMatrix).toHaveBeenCalledOnce();

    canvas.clientWidth = 800;
    canvas.clientHeight = 600;
    viewer.resize();
    expect(setSize).toHaveBeenLastCalledWith(800, 600, false);
    expect(viewer.needsRender).toBe(true);
    viewer.needsRender = false;
    viewer.resize();
    expect(setSize).toHaveBeenCalledTimes(2);
    expect(viewer.needsRender).toBe(false);
    expect(canvas.width).toBe(800 * pixelRatio);
    expect(canvas.height).toBe(600 * pixelRatio);
  });
});

function deferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
