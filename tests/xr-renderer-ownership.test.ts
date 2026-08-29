import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';

import { acquireXrRendererOwnership } from '../packages/viewer/src/xr/renderer-ownership.js';

describe('XR renderer ownership', () => {
  it('serializes active and replacement runtimes on one renderer', async () => {
    const renderer = {} as THREE.WebGLRenderer;
    const firstAcquisition = acquireXrRendererOwnership(renderer);
    const first = await firstAcquisition.acquired;
    expect(first?.isCurrent()).toBe(true);

    const secondAcquisition = acquireXrRendererOwnership(renderer);
    let secondResolved = false;
    void secondAcquisition.acquired.then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    first?.release();
    const second = await secondAcquisition.acquired;
    expect(second?.isCurrent()).toBe(true);
    expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);

    first?.release();
    const thirdAcquisition = acquireXrRendererOwnership(renderer);
    let thirdResolved = false;
    void thirdAcquisition.acquired.then(() => {
      thirdResolved = true;
    });
    await Promise.resolve();
    expect(thirdResolved).toBe(false);

    second?.release();
    const third = await thirdAcquisition.acquired;
    expect(third?.isCurrent()).toBe(true);
    third?.release();
  });

  it('cancels a pending remount without waiting for the active owner', async () => {
    const renderer = {} as THREE.WebGLRenderer;
    const active = await acquireXrRendererOwnership(renderer).acquired;
    const pending = acquireXrRendererOwnership(renderer);

    pending.cancel();
    pending.cancel();

    await expect(pending.acquired).resolves.toBeNull();
    expect(active?.isCurrent()).toBe(true);
    active?.release();
  });
});
