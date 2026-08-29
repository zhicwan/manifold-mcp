import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Viewer } from '../packages/viewer/src/scene/viewer.js';

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

  it('stops ViewerCanvas before contribution cleanup begins', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../packages/viewer/src/components/viewer-canvas.tsx'),
      'utf8',
    );

    const generationDispose = source.slice(
      source.lastIndexOf('dispose(): Promise<void> {'),
      source.lastIndexOf('} catch (error) {'),
    );
    expect(generationDispose.indexOf('viewer.stop()')).toBeLessThan(
      generationDispose.indexOf('await runtimeHost.clearRuntime(publishedRuntime)'),
    );
    expect(generationDispose.indexOf('await runtimeHost.clearRuntime(publishedRuntime)')).toBeLessThan(
      generationDispose.indexOf('await viewer.dispose()'),
    );
  });
});
