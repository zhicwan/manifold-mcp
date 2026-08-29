import type * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type ModelPresentationState = 'idle' | 'hover' | 'held';

export interface ViewerDesktopCameraFrame {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly near: number;
  readonly far: number;
}

export interface ViewerModelFraming {
  readonly center: readonly [number, number, number];
  readonly maxDimension: number;
  readonly desktopCamera: ViewerDesktopCameraFrame;
}

export interface ViewerAnimationFrame {
  readonly time: DOMHighResTimeStamp;
  /** Renderer-provided frame data. Immersive modules may narrow it locally. */
  readonly opaqueFrame: unknown;
}

/**
 * Narrow scene surface for browser-local immersive contributions. It exposes
 * only the mutable Three.js objects and lifecycle hooks required to render,
 * place, and interact with the current model.
 */
export interface ViewerSceneRuntime {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly modelRoot: THREE.Group;
  /** Current render mesh, or null before the first model frame. */
  getMesh(): THREE.Mesh | null;
  /** Defensive snapshot of the current model and desired desktop framing. */
  getModelFraming(): ViewerModelFraming | null;
  /** Subscribe after controls update and before the conditional scene render. */
  addAnimationFrameHook(hook: (frame: ViewerAnimationFrame) => void): () => void;
  /** Subscribe to model replacements; optionally receive the current snapshot. */
  addModelChangeHook(hook: (framing: ViewerModelFraming) => void, emitCurrent?: boolean): () => void;
  /** Tell the base render loop that an immersive renderer owns frame sizing. */
  setImmersivePresenting(presenting: boolean): void;
  /** Toggle the grid, axes, and desktop view cube together. */
  setDesktopDecorationsVisible(visible: boolean): void;
  /** Apply semantic interaction feedback without exposing the model material. */
  setModelPresentationState(state: ModelPresentationState): void;
  requestRender(): void;
}
