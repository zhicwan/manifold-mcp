import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';

import { createViewerSceneCleanupRegistry } from '../packages/viewer/src/viewer-runtime-lifecycle.js';
import { createXrExperienceScope } from '../packages/viewer/src/xr/experience.js';
import { acquireXrRendererOwnership } from '../packages/viewer/src/xr/renderer-ownership.js';
import { createXrExperienceState } from '../packages/viewer/src/xr/state.js';

describe('XR Viewer composition', () => {
  it('provides explicit scene, toolbar, and overlay slots per experience', () => {
    const first = createXrExperienceScope({
      toolbarEnd: 'toolbar',
      sceneLayers: 'scene',
      overlays: 'overlay',
    });
    const second = createXrExperienceScope({});

    expect(first.Provider).not.toBe(second.Provider);
    expect(first.slots).toEqual({
      toolbarEnd: 'toolbar',
      sceneLayers: 'scene',
      overlays: 'overlay',
    });
  });

  it('keeps scoped XR state isolated between Viewer instances', () => {
    const first = createXrExperienceState();
    const second = createXrExperienceState();

    first.setSupport(true);
    first.setHasModel(true);

    expect(first.getSnapshot()).toMatchObject({ support: 'supported', hasModel: true });
    expect(second.getSnapshot()).toMatchObject({ support: 'checking', hasModel: false });
  });

  it('ignores an old enter rejection after a replacement starts', async () => {
    const state = createXrExperienceState();
    const oldAttempt = deferred<void>();
    const oldBinding = state.bindEnterHandler(() => oldAttempt.promise);
    state.setHasModel(true);
    const oldEnter = state.enter();

    oldBinding.unbind();
    const replacementAttempt = deferred<void>();
    state.bindEnterHandler(() => replacementAttempt.promise);
    state.setHasModel(true);
    const replacementEnter = state.enter();
    expect(state.getSnapshot()).toMatchObject({ sessionState: 'starting', error: null });

    oldAttempt.reject(new Error('old failure'));
    await expect(oldEnter).rejects.toThrow('old failure');
    expect(state.getSnapshot()).toMatchObject({ sessionState: 'starting', error: null });

    replacementAttempt.resolve();
    await replacementEnter;
  });

  it('ignores an old enter success after a replacement becomes active', async () => {
    const state = createXrExperienceState();
    const oldAttempt = deferred<void>();
    const oldBinding = state.bindEnterHandler(() => oldAttempt.promise);
    state.setHasModel(true);
    const oldEnter = state.enter();

    oldBinding.unbind();
    const replacementAttempt = deferred<void>();
    const replacementBinding = state.bindEnterHandler(() => replacementAttempt.promise);
    state.setHasModel(true);
    const replacementEnter = state.enter();
    replacementBinding.setSessionState('active');

    oldAttempt.resolve();
    await oldEnter;
    expect(state.getSnapshot()).toMatchObject({ sessionState: 'active', error: null });

    replacementAttempt.resolve();
    await replacementEnter;
  });

  it('awaits already-started slot cleanup before base disposal continues', async () => {
    const registry = createViewerSceneCleanupRegistry();
    const order: string[] = [];
    let finishCleanup: (() => void) | undefined;
    const cleanupFinished = new Promise<void>(finish => {
      finishCleanup = finish;
    });

    const unmountSlot = registry.register(async () => {
      order.push('slot-start');
      await cleanupFinished;
      order.push('slot-end');
    });

    const slotDisposal = unmountSlot();
    const beforeBaseDisposal = registry.disposeAll().then(() => order.push('base-dispose'));
    await Promise.resolve();
    expect(order).toEqual(['slot-start']);

    finishCleanup?.();
    await Promise.all([slotDisposal, beforeBaseDisposal]);
    expect(order).toEqual(['slot-start', 'slot-end', 'base-dispose']);
  });

  it('registers cleanup before async ownership startup and cancels a pending mount', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../packages/viewer/src/xr/index.tsx'), 'utf8');
    expect(source.indexOf('registerSceneCleanup')).toBeLessThan(source.indexOf('acquisition.acquired.then'));

    const renderer = {} as THREE.WebGLRenderer;
    const active = await acquireXrRendererOwnership(renderer).acquired;
    const pending = acquireXrRendererOwnership(renderer);
    const registry = createViewerSceneCleanupRegistry();
    registry.register(async () => {
      pending.cancel();
      await pending.acquired;
    });

    await expect(registry.disposeAll()).resolves.toBeUndefined();
    expect(active?.isCurrent()).toBe(true);
    active?.release();
  });
});

function deferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((finish, reject) => {
    resolvePromise = finish;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
