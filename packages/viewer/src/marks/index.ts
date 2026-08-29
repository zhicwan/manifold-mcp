import type * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { AnnotationStore } from './annotation-store.js';
import { FeatureResolver } from './feature-resolver.js';
import { FlyoutLayer } from './flyout/index.js';
import { HoverHighlight } from './hover-highlight.js';
import { MarkerRenderer } from './marker-renderer.js';
import { MarkTool } from './mark-tool.js';
import type { MarkMode } from './types.js';
import type { ViewerModel } from '@manifold3d/protocol/wire/model.js';

export interface MarksDeps {
  scene: THREE.Scene;
  camera: THREE.Camera;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  overlayHost: HTMLElement;
  getMesh(): THREE.Mesh | null;
  requestRender(): void;
  /** Notified when the mark tool's interaction mode changes. */
  onModeChange?(mode: MarkMode): void;
  /** Notified after a non-empty annotation edit is explicitly committed. */
  onAnnotationCommit?(): void;
  /** Receives a pending selection id so ViewerCanvas can attach it. */
  onSelectionCreated?(id: string): void;
}

/**
 * Top-level entry point for the marks subsystem. Wires together the
 * store, picker, marker renderer, flyouts and tool. Returns a small
 * handle exposing the few methods the rest of the viewer needs to
 * call: `frame()` once per render frame; `setModelVersion()` and
 * `setPayload()` whenever a new mesh arrives.
 *
 * React reads the same store via useSyncExternalStore and invokes its narrow
 * batch/selection transaction APIs.
 */
export function installMarks(deps: MarksDeps): MarksHandle {
  const store = new AnnotationStore();
  const flyouts = new FlyoutLayer(
    deps.overlayHost,
    deps.canvas,
    deps.camera,
    store,
    deps.requestRender,
    deps.onAnnotationCommit,
  );
  const markers = new MarkerRenderer(deps.scene, store, deps.getMesh, deps.requestRender);
  let resolver: FeatureResolver | null = null;
  const tool = new MarkTool(
    deps.overlayHost,
    deps.canvas,
    deps.camera,
    deps.controls,
    store,
    flyouts,
    deps.getMesh,
    () => resolver,
    deps.onModeChange,
    deps.onSelectionCreated,
  );
  const hover = new HoverHighlight(
    deps.scene,
    deps.canvas,
    deps.camera,
    deps.getMesh,
    () => resolver,
    deps.requestRender,
  );

  return {
    store,
    setMode(mode: MarkMode): void {
      tool.setMode(mode);
    },
    commitOpenDraft(): void {
      flyouts.dismissAll();
    },
    frame(): void {
      flyouts.updatePositions();
    },
    setModelVersion(v: string): void {
      store.setModelVersion(v);
    },
    setPayload(payload: ViewerModel): void {
      // Build a fresh resolver per model so old per-feature AABBs are
      // discarded along with the old mesh.
      resolver = payload.features.length > 0 && payload.triFeatureIds.length > 0 ? new FeatureResolver(payload) : null;
      hover.reset();
    },
    setImmersivePresenting(presenting: boolean): void {
      tool.setEnabled(!presenting);
      hover.setEnabled(!presenting);
      markers.setVisible(!presenting);
      deps.overlayHost.style.display = presenting ? 'none' : '';
    },
    dispose(): void {
      hover.dispose();
      tool.dispose();
      markers.dispose();
      flyouts.dispose();
    },
  };
}

export interface MarksHandle {
  store: AnnotationStore;
  setMode(mode: MarkMode): void;
  commitOpenDraft(): void;
  frame(): void;
  setModelVersion(v: string): void;
  setPayload(payload: ViewerModel): void;
  setImmersivePresenting(presenting: boolean): void;
  dispose(): void;
}
