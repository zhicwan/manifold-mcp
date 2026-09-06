import { describe, expect, it, vi } from 'vitest';

import { createViewerStore } from '../packages/viewer/src/store.js';

describe('Viewer store instances', () => {
  it('isolates state and subscriptions between ViewerApp stores', () => {
    const first = createViewerStore();
    const second = createViewerStore();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    first.subscribe(firstListener);
    second.subscribe(secondListener);

    first.setStatus('connected');
    first.setModelVersion('first-model');

    expect(first.getState()).toMatchObject({ status: 'connected', modelVersion: 'first-model' });
    expect(second.getState()).toMatchObject({ status: 'connecting', modelVersion: 'unknown' });
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).not.toHaveBeenCalled();
  });
});
