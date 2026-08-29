import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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

  it('uses the nearest context store for imperative component access', async () => {
    const files = [
      '../packages/viewer/src/store.ts',
      '../packages/viewer/src/components/viewer-app.tsx',
      '../packages/viewer/src/components/viewer-canvas.tsx',
      '../packages/viewer/src/components/right-rail.tsx',
    ];
    const sources = await Promise.all(files.map(file => readFile(resolve(import.meta.dirname, file), 'utf8')));

    expect(sources.join('\n')).not.toMatch(/export const viewerStore|import \{[^}]*viewerStore/);
    expect(sources[1]!).toContain('<ViewerStoreProvider>');
    expect(sources[2]!).toContain('useViewerStore()');
    expect(sources[3]!).toContain('useViewerStore()');
  });
});
