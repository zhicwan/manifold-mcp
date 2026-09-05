import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

import {
  createHostActionsManifest,
  createHostActionStatus,
  type HostActionDescriptor,
} from '../packages/protocol/src/wire/host-actions.js';
import type { ViewerModel } from '../packages/protocol/src/wire/model.js';
import type { ViewerSceneRuntime } from '../packages/viewer/src/scene/runtime.js';
import { createViewerStore, type ViewerState, type ViewerStore } from '../packages/viewer/src/store.js';
import type { ConnectOptions } from '../packages/viewer/src/transport/ws-client.js';

const harness = vi.hoisted(() => {
  let releaseExport = (): void => undefined;
  const exportReady = new Promise<void>(resolve => {
    releaseExport = resolve;
  });
  return {
    store: null as ViewerStore | null,
    effect: null as (() => void | (() => void)) | null,
    refs: [] as unknown[],
    refIndex: 0,
    pending: null as unknown,
    pendingWrites: 0,
    feed: null as ConnectOptions | null,
    runtime: null as { scene: ViewerSceneRuntime } | null,
    exportReady,
    releaseExport,
  };
});

// Drive the real component callbacks/effect without adding a DOM test dependency.
vi.mock('react', async importOriginal => ({
  ...(await importOriginal<typeof React>()),
  useEffect: (effect: () => void | (() => void)) => {
    harness.effect = effect;
  },
  useRef: () => ({ current: harness.refs[harness.refIndex++] }),
  useState: () => [
    harness.pending,
    (next: unknown) => {
      const value = typeof next === 'function' ? next(harness.pending) : next;
      if (!Object.is(value, harness.pending)) {
        harness.pendingWrites++;
      }
      harness.pending = value;
    },
  ],
}));
vi.mock('@/store', async () => ({
  ...(await import('../packages/viewer/src/store.js')),
  useViewerStore: () => harness.store,
  useViewerState: <T>(selector: (state: ViewerState) => T) => selector(harness.store!.getState()),
  useAnnotations: () => undefined,
}));
vi.mock('@/components/glass', () => ({ glass: '' }));
vi.mock('@/components/ui/button', () => ({ Button: 'button' }));
vi.mock('@/components/host-actions', () => ({
  useHostActionsSnapshot: () => harness.store!.getState().hostActionsClient!.getSnapshot(),
}));
vi.mock('@/host-actions/client', () => import('../packages/viewer/src/host-actions/client.js'));
vi.mock('@/marks', () => import('../packages/viewer/src/marks/index.js'));
vi.mock('@/marks/ws-uplink', () => import('../packages/viewer/src/marks/ws-uplink.js'));
vi.mock('@/scene/viewer', () => import('../packages/viewer/src/scene/viewer.js'));
vi.mock('@/scene/viewer-canvas-ownership', () => import('../packages/viewer/src/scene/viewer-canvas-ownership.js'));
vi.mock('@/viewer-runtime-lifecycle', () => import('../packages/viewer/src/viewer-runtime-lifecycle.js'));
vi.mock('@/viewer-runtime', () => ({
  useViewerRuntimeHost: () => ({
    publishRuntime: (runtime: { scene: ViewerSceneRuntime }) => {
      harness.runtime = runtime;
      return runtime;
    },
    clearRuntime: () => {
      harness.runtime = null;
      return Promise.resolve();
    },
  }),
}));
vi.mock('@/transport/ws-client', async () => ({
  ...(await import('../packages/viewer/src/transport/ws-client.js')),
  connectMeshFeed: (feed: ConnectOptions) => {
    harness.feed = feed;
    return { send: vi.fn(), isOpen: () => true, close: vi.fn() };
  },
}));
vi.mock('@/exporters/stl', async () => {
  await harness.exportReady;
  return import('../packages/viewer/src/exporters/stl.js');
});
vi.mock('@/exporters/three-mf', () => ({ export3mf: vi.fn() }));
vi.mock('@/demo-payload', () => ({}));

// Keep Viewer, MarkTool, their stores and HostActionsClient real; only replace
// WebGL and visual decorations that require a browser DOM.
vi.mock('three', async importOriginal => ({
  ...(await importOriginal<typeof THREE>()),
  WebGLRenderer: class {
    setPixelRatio = vi.fn();
    setAnimationLoop = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('three/addons/controls/OrbitControls.js', async () => {
  const { Vector3 } = await import('three');
  return {
    OrbitControls: class {
      target = new Vector3();
      enabled = true;
      update = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      dispose = vi.fn();
    },
  };
});
vi.mock('../packages/viewer/src/scene/view-cube.js', () => ({
  ViewCube: class {
    dispose = vi.fn();
  },
}));
vi.mock('../packages/viewer/src/marks/flyout/index.js', () => ({
  FlyoutLayer: class {
    dismissAll = vi.fn();
    updatePositions = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('../packages/viewer/src/marks/marker-renderer.js', () => ({
  MarkerRenderer: class {
    dispose = vi.fn();
  },
}));
vi.mock('../packages/viewer/src/marks/hover-highlight.js', () => ({
  HoverHighlight: class {
    reset = vi.fn();
    dispose = vi.fn();
  },
}));

// Runtime imports keep the Node-only test tsconfig independent of the browser
// package's JSX/alias compilation settings.
const components = '../packages/viewer/src/components';
const { ViewerCanvas } = (await import(`${components}/viewer-canvas.tsx`)) as {
  ViewerCanvas(props: { resumeIdentity: string }): React.ReactElement;
};
const { AnnotationBatchBar } = (await import(`${components}/annotation-batch-bar.tsx`)) as {
  AnnotationBatchBar(): React.ReactElement | null;
};

const fixAction: HostActionDescriptor = {
  id: 'fix-annotation-batch',
  label: 'Fix them',
  icon: 'wand',
  slot: 'annotation-batch',
  tone: 'default',
  requires: ['model', 'annotations'],
};
const attachAction: HostActionDescriptor = { ...fixAction, id: 'attach-annotation-batch', label: 'Attach' };
let unmount: (() => void) | undefined;
let store: ViewerStore;
let download: { name: string; blob: Blob } | undefined;

beforeEach(() => {
  store = createViewerStore();
  harness.store = store;
  harness.pending = null;
  harness.pendingWrites = 0;
  harness.runtime = null;
  harness.feed = null;
  download = undefined;
  const element = () => ({
    style: {},
    appendChild: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
  });
  harness.refs = [element(), element()];
  vi.stubGlobal('React', React);
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
  });
  let downloadedBlob: Blob;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    downloadedBlob = blob as Blob;
    return 'blob:download';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.stubGlobal('document', {
    body: { dataset: {}, appendChild: vi.fn() },
    createElement: () => ({
      ...element(),
      download: '',
      click(this: { download: string }) {
        download = { name: this.download, blob: downloadedBlob };
      },
    }),
  });
});

afterEach(async () => {
  unmount?.();
  unmount = undefined;
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(identity = 'first'): Promise<void> {
  harness.refIndex = 0;
  ViewerCanvas({ resumeIdentity: identity });
  unmount = harness.effect?.() || undefined;
  await settle();
  expect(store.getState().viewerApi).not.toBeNull();
  harness.feed!.onMesh(model('Original model', 10));
  harness.feed!.onModelVersion?.('model-v1');
  harness.feed!.onHostActionsManifest?.(createHostActionsManifest([fixAction, attachAction]));
}

function addDraft() {
  const { viewerApi, marksRuntime } = store.getState();
  viewerApi!.setMarkMode('annotate');
  return marksRuntime!.store.addComment({
    kind: 'point',
    anchorWorld: [0, 0, 0],
    worldCoord: [0, 0, 0],
    triIds: [],
    note: 'Adjust this face',
  });
}

interface ButtonProps {
  children?: React.ReactNode;
  onClick(): void;
  disabled: boolean;
}

function button(label: string): ButtonProps {
  let result: ButtonProps | undefined;
  const visit = (node: React.ReactNode): void => {
    React.Children.forEach(node, child => {
      if (!React.isValidElement<{ children?: React.ReactNode }>(child)) {
        return;
      }
      if (child.type === 'button' && React.Children.toArray(child.props.children).includes(label)) {
        result = child.props as ButtonProps;
      }
      visit(child.props.children);
    });
  };
  visit(AnnotationBatchBar());
  expect(result, `button ${label}`).toBeDefined();
  return result!;
}

async function settle(): Promise<void> {
  for (let step = 0; step < 30; step++) {
    await Promise.resolve();
  }
}

function model(description: string, width: number): ViewerModel {
  return {
    description,
    numProp: 3,
    triangles: 1,
    vertices: 3,
    vertProperties: new Float32Array([0, 0, 0, width, 0, 0, 0, 20, 30]),
    triVerts: new Uint32Array([0, 1, 2]),
    features: [],
    triFeatureIds: new Uint32Array(1),
    volume: 0,
    surfaceArea: 0,
    genus: 0,
    bboxMin: [0, 0, 0],
    bboxMax: [width, 20, 30],
  };
}

describe('Viewer component ownership', () => {
  it('does not restore a disposed generation or change its replacement tool mode', async () => {
    await mount();
    const oldMarks = store.getState().marksRuntime!;
    const oldApi = store.getState().viewerApi!;
    const draft = addDraft();
    button('Fix them').onClick();
    expect(oldMarks.store.get(draft.id)?.state).toBe('pending');
    const oldSetMode = vi.spyOn(oldApi, 'setMarkMode');
    const oldFlush = vi.spyOn(oldMarks, 'flushAnnotations');

    unmount!();
    await mount('replacement');

    expect(oldMarks.store.get(draft.id)?.state).toBe('pending');
    expect(oldSetMode).not.toHaveBeenCalled();
    expect(oldFlush).not.toHaveBeenCalled();
    expect(harness.pending).toBeNull();
    expect(store.getState().markMode).toBe('orbit');
    expect(document.body.dataset.markMode).toBeUndefined();
    addDraft();
    expect(button('Fix them').disabled).toBe(false);
  });

  it.each(['succeeded', 'failed', 'disposed'] as const)(
    'ignores a late %s completion while the replacement has its own pending batch',
    async outcome => {
      await mount();
      const oldMarks = store.getState().marksRuntime!;
      const oldClient = store.getState().hostActionsClient!;
      const invokeAndWait = oldClient.invokeAndWait.bind(oldClient);
      let release = (): void => undefined;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      vi.spyOn(oldClient, 'invokeAndWait').mockImplementation((...args) =>
        invokeAndWait(...args).then(
          async status => {
            await gate;
            return status;
          },
          async error => {
            await gate;
            throw error;
          },
        ),
      );
      const oldDraft = addDraft();
      button('Fix them').onClick();
      if (outcome !== 'disposed') {
        oldClient.receiveStatus(
          createHostActionStatus({
            ...oldClient.getSnapshot().latestStatus!,
            state: outcome,
          }),
        );
      }
      unmount!();
      await mount('replacement');
      const newMarks = store.getState().marksRuntime!;
      const newDraft = addDraft();
      button('Attach').onClick();
      const writes = harness.pendingWrites;
      const pending = harness.pending;
      const oldFlush = vi.spyOn(oldMarks, 'flushAnnotations');

      release();
      await settle();

      expect(oldMarks.store.get(oldDraft.id)?.state).toBe('pending');
      expect(oldFlush).not.toHaveBeenCalled();
      expect(newMarks.store.get(newDraft.id)?.state).toBe('pending');
      expect(store.getState().markMode).toBe('orbit');
      expect(document.body.dataset.markMode).toBeUndefined();
      expect(harness.pending).toBe(pending);
      expect(harness.pendingWrites).toBe(writes);
      addDraft();
      expect(button('Cancel').disabled).toBe(true);
    },
  );

  it.each(['failed', 'identity-change'] as const)('restores editable drafts on a current %s failure', async failure => {
    await mount();
    const marks = store.getState().marksRuntime!;
    const client = store.getState().hostActionsClient!;
    const draft = addDraft();
    button('Fix them').onClick();
    if (failure === 'failed') {
      client.receiveStatus(createHostActionStatus({ ...client.getSnapshot().latestStatus!, state: 'failed' }));
    } else {
      client.receiveHello({
        kind: 'hello',
        protocolVersion: 1,
        clientId: 'new-client',
        resumeToken: 'new-token',
        resumed: false,
      });
    }
    await settle();

    expect(marks.store.get(draft.id)?.state).toBe('draft');
    expect(marks.store.update(draft.id, { note: 'Recovered edit' })).toBe(true);
    expect(store.getState().markMode).toBe('annotate');
    expect(document.body.dataset.markMode).toBe('annotate');
    expect(button('Cancel').disabled).toBe(false);
    expect(harness.pending).toBeNull();
  });

  it.each(['Fix them', 'Attach'])('freezes only the submitted batch after %s succeeds', async label => {
    await mount();
    const marks = store.getState().marksRuntime!;
    const client = store.getState().hostActionsClient!;
    const submitted = addDraft();
    button(label).onClick();
    const newer = addDraft();
    client.receiveStatus(createHostActionStatus({ ...client.getSnapshot().latestStatus!, state: 'succeeded' }));
    await settle();

    expect(marks.store.get(submitted.id)?.state).toBe('committed');
    expect(marks.store.get(newer.id)?.state).toBe('draft');
    expect(store.getState().markMode).toBe('annotate');
    expect(button('Cancel').disabled).toBe(false);
    expect(harness.pending).toBeNull();
  });

  it.each(['Done', 'Cancel'])('preserves local %s without host batch actions', async label => {
    await mount();
    const marks = store.getState().marksRuntime!;
    store.getState().hostActionsClient!.receiveManifest(createHostActionsManifest([]));
    const draft = addDraft();
    button(label).onClick();

    expect(marks.store.get(draft.id)?.state).toBe(label === 'Done' ? 'committed' : undefined);
    expect(store.getState().markMode).toBe('orbit');
    expect(document.body.dataset.markMode).toBeUndefined();
  });

  it('captures the canonical payload and filename before a lazy STL import completes', async () => {
    await mount();
    const payload = store.getState().payload!;
    const runtime = harness.runtime!.scene;
    runtime.modelRoot.scale.setScalar(0.001);
    runtime.modelRoot.rotation.set(-Math.PI / 2, 0, Math.PI / 3);
    runtime.modelRoot.position.set(1, 2, 3);
    runtime.modelRoot.updateMatrixWorld(true);
    const transform = runtime.modelRoot.matrixWorld.clone();
    const exporting = store.getState().viewerApi!.exportStl();
    await settle();
    expect(download).toBeUndefined();
    payload.description = 'Changed description during import';
    harness.feed!.onMesh(model('Replacement model', 100));

    harness.releaseExport();
    await exporting;
    expect(download?.name).toBe('original-model.stl');
    const geometry = new STLLoader().parse(await download!.blob.arrayBuffer());
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.min.toArray()).toEqual([0, 0, 0]);
    expect(geometry.boundingBox?.max.toArray()).toEqual([10, 20, 30]);
    expect(runtime.modelRoot.matrixWorld.equals(transform)).toBe(true);
    expect(store.getState().payload?.description).toBe('Replacement model');
    geometry.dispose();
  });
});
