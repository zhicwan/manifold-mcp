import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ViewerModel } from '@manifold3d/protocol/wire/model.js';

import { payloadToGeometry } from './mesh-bridge.js';
import { ViewCube } from './view-cube.js';
import { computeDesktopCameraClipping } from './camera-clipping.js';
import { applyModelPresentation } from './model-presentation.js';
import type {
  ModelPresentationState,
  ViewerAnimationFrame,
  ViewerModelFraming,
  ViewerSceneRuntime,
} from './runtime.js';

// Tell three.js (and any helpers that respect Object3D.DEFAULT_UP) that
// our world is Z-up. This MUST run before any Object3D / Camera / Helper
// is constructed — both ViewportGizmo and OrbitControls read DEFAULT_UP
// at construction time to set their internal "pole" axis. Setting it
// here at module load means the camera below picks it up automatically.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export type RenderMode = 'solid' | 'wireframe' | 'edges' | 'xray';

export type ViewerTheme = 'light' | 'dark';

/** Scene palette per UI theme. Kept subtle so the model stays the hero. */
const THEME_COLORS: Record<
  ViewerTheme,
  { background: number; gridMajor: number; gridMinor: number; model: number; edges: number }
> = {
  light: { background: 0xf5f5f5, gridMajor: 0xb8b8b8, gridMinor: 0xd8d8d8, model: 0xc4c8cc, edges: 0x242424 },
  dark: { background: 0x131316, gridMajor: 0x3a3a40, gridMinor: 0x27272c, model: 0x8b9096, edges: 0xd6d6dc },
};

/**
 * Owns the three.js scene + render loop. On-demand rendering: only
 * re-renders when something has changed (mesh swap, controls movement,
 * resize, render-mode change). Idle GPU usage is essentially zero.
 *
 * The Viewer UI exposes a single rendering knob — the render mode:
 * solid / wireframe / edges (line overlay) / xray (transparent
 * material, depth write off). Camera framing is driven by the corner
 * ViewCube widget plus the user's own OrbitControls drags.
 */
export class Viewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly rendererSize = new THREE.Vector2();
  private readonly modelRoot = new THREE.Group();
  private readonly runtime: ViewerSceneRuntime;
  private grid: THREE.GridHelper;
  private readonly axes: THREE.AxesHelper;
  private theme: ViewerTheme = 'light';
  private readonly material: THREE.MeshStandardMaterial;
  private mesh: THREE.Mesh | null = null;
  private edgesOverlay: THREE.LineSegments | null = null;
  private needsRender = true;
  private readonly animationFrameHooks = new Set<(frame: ViewerAnimationFrame) => void>();
  private readonly modelChangeHooks = new Set<(framing: ViewerModelFraming) => void>();
  private viewCube: ViewCube | null = null;
  private running = true;
  private immersivePresenting = false;
  private disposePromise: Promise<void> | null = null;

  private currentRenderMode: RenderMode = 'solid';
  private modelPresentationState: ModelPresentationState = 'idle';
  private modelRadius = 50;
  private modelCenter = new THREE.Vector3();
  private modelFraming: ViewerModelFraming | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0xf5f5f5);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    // Standard CAD-style isometric default: camera in the +X / -Y / +Z
    // octant so the user sees front + right + top faces from first load.
    this.camera.position.set(80, -80, 120);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.addEventListener('change', this.requestRender);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xc6cdd4, 0.4));
    const key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(60, 100, 80);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xb0c4de, 0.25);
    fill.position.set(-80, -40, -40);
    this.scene.add(fill);

    // GridHelper draws in the XZ plane by default (Y-up). Rotate it 90°
    // around X so it sits in the XY plane — that's the natural "ground"
    // for Manifold's Z-up world.
    this.grid = new THREE.GridHelper(200, 20, 0xb8b8b8, 0xd8d8d8);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(20);
    this.scene.add(this.axes);
    this.scene.add(this.modelRoot);

    this.material = new THREE.MeshStandardMaterial({
      color: 0xc4c8cc,
      metalness: 0.05,
      roughness: 0.65,
      flatShading: true,
    });

    canvas.style.position = 'fixed';
    canvas.style.inset = '0';
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';

    window.addEventListener('resize', this.requestRender);

    // The ViewCube depends on the renderer/camera/controls being fully constructed.
    this.viewCube = new ViewCube(this.camera, this.renderer, this.controls, this.requestRender, this.theme);
    const runtime: ViewerSceneRuntime = {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      controls: this.controls,
      modelRoot: this.modelRoot,
      getMesh: () => this.mesh,
      getModelFraming: () => this.copyModelFraming(),
      addAnimationFrameHook: hook => this.addAnimationFrameHook(hook),
      addModelChangeHook: (hook, emitCurrent) => this.addModelChangeHook(hook, emitCurrent),
      setImmersivePresenting: presenting => this.setImmersivePresenting(presenting),
      setDesktopDecorationsVisible: visible => this.setDesktopDecorationsVisible(visible),
      setModelPresentationState: state => this.setModelPresentationState(state),
      requestRender: this.requestRender,
    };
    this.runtime = Object.freeze(runtime);
    this.renderer.setAnimationLoop(this.frame);
  }

  /** Immediately stop rendering and detach loop-driving listeners. */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.requestRender);
    this.controls.removeEventListener('change', this.requestRender);
  }

  /**
   * Stop the render loop and dispose all scene/GPU resources. Safe to call
   * repeatedly; callers that own scene contributions must await their cleanup
   * before invoking this final resource teardown.
   */
  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.stop();
    this.disposePromise = Promise.resolve().then(() => this.disposeResources());
    return this.disposePromise;
  }

  private disposeResources(): void {
    // Dispose order matters. The view-cube gizmo's constructor
    // attaches a 'change' listener AND a wheel/click hook to OrbitControls.
    // Its dispose() detaches those by calling controls.removeEventListener.
    // If we dispose controls first, that internal `controls` reference
    // points at a destroyed object and the gizmo's detach throws — leaking
    // the listener and corrupting the next viewer mount. Always tear down
    // the dependent (viewCube) before the dependency (controls).
    this.viewCube?.dispose();
    this.viewCube = null;
    this.controls.dispose();

    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.modelRoot.remove(this.mesh);
      this.mesh = null;
    }
    this.disposeEdgesOverlay();

    this.grid.geometry.dispose();
    if (Array.isArray(this.grid.material)) {
      for (const m of this.grid.material) {
        m.dispose();
      }
    } else {
      this.grid.material.dispose();
    }

    this.material.dispose();
    this.animationFrameHooks.clear();
    this.modelChangeHooks.clear();
    this.axes.geometry.dispose();
    (this.axes.material as THREE.Material).dispose();

    this.renderer.dispose();
  }

  readonly requestRender = (): void => {
    this.needsRender = true;
  };

  /** Stable leaf surface for browser-local scene contributions. */
  getSceneRuntime(): ViewerSceneRuntime {
    return this.runtime;
  }

  zoomIn(): void {
    this.zoomDesktopCamera(0.8);
  }

  zoomOut(): void {
    this.zoomDesktopCamera(1.25);
  }

  setMesh(payload: ViewerModel): THREE.Mesh {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.modelRoot.remove(this.mesh);
    }
    this.disposeEdgesOverlay();

    const geom = payloadToGeometry(payload);
    this.mesh = new THREE.Mesh(geom, this.material);
    this.modelRoot.add(this.mesh);
    this.frameModel(geom);
    this.applyRenderMode();
    this.requestRender();
    return this.mesh;
  }

  // ── Public mode setters (called by the React UI) ──────────────────────

  /**
   * Sync the 3D scene with the UI theme: background, grid, model
   * material and edge-overlay colors all swap together so a dark UI
   * never floats over a blinding light viewport.
   */
  setTheme(theme: ViewerTheme): void {
    if (this.theme === theme) {
      return;
    }
    this.theme = theme;
    const colors = THEME_COLORS[theme];
    this.scene.background = new THREE.Color(colors.background);
    this.material.color.setHex(colors.model);
    applyModelPresentation(this.material, this.modelPresentationState);

    // GridHelper bakes its colors into vertex attributes at construction
    // time, so recreate it with the new palette (preserving transform).
    const oldGrid = this.grid;
    const next = new THREE.GridHelper(200, 20, colors.gridMajor, colors.gridMinor);
    next.rotation.copy(oldGrid.rotation);
    next.scale.copy(oldGrid.scale);
    next.visible = oldGrid.visible;
    this.scene.add(next);
    this.scene.remove(oldGrid);
    oldGrid.geometry.dispose();
    if (Array.isArray(oldGrid.material)) {
      for (const m of oldGrid.material) {
        m.dispose();
      }
    } else {
      oldGrid.material.dispose();
    }
    this.grid = next;

    // Re-tint the edges overlay if the current render mode shows one.
    this.applyRenderMode();
    this.viewCube?.setTheme(theme);
    this.requestRender();
  }

  setRenderMode(mode: RenderMode): void {
    if (this.currentRenderMode === mode) {
      return;
    }
    this.currentRenderMode = mode;
    this.applyRenderMode();
    this.requestRender();
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /**
   * Apply the current render-mode flags to the material AND the edges
   * overlay. Idempotent.
   */
  private applyRenderMode(): void {
    if (!this.mesh) {
      return;
    }
    const m = this.material;

    // Reset baseline (opaque, depth-writing, no wireframe).
    m.wireframe = false;
    m.transparent = false;
    m.opacity = 1;
    m.depthWrite = true;
    this.disposeEdgesOverlay();

    switch (this.currentRenderMode) {
      case 'solid':
        // baseline applies
        break;
      case 'wireframe':
        m.wireframe = true;
        break;
      case 'edges': {
        // Edges = solid model + a black line overlay tracing sharp edges.
        const edges = new THREE.EdgesGeometry(this.mesh.geometry as THREE.BufferGeometry, 25);
        const mat = new THREE.LineBasicMaterial({ color: THEME_COLORS[this.theme].edges });
        this.edgesOverlay = new THREE.LineSegments(edges, mat);
        this.edgesOverlay.renderOrder = 1;
        this.mesh.add(this.edgesOverlay);
        break;
      }
      case 'xray':
        m.transparent = true;
        m.opacity = 0.28;
        m.depthWrite = false;
        break;
    }
    m.needsUpdate = true;
  }

  private disposeEdgesOverlay(): void {
    if (!this.edgesOverlay) {
      return;
    }
    this.edgesOverlay.parent?.remove(this.edgesOverlay);
    this.edgesOverlay.geometry.dispose();
    (this.edgesOverlay.material as THREE.Material).dispose();
    this.edgesOverlay = null;
  }

  /**
   * Frame the model from the standard CAD-style isometric viewpoint:
   * camera in the +X / -Y / +Z octant so the user sees front + right +
   * top faces (matches the ViewCube's reset).
   */
  private snapCameraToDefaultView(): void {
    const r = this.modelRadius;
    const c = this.modelCenter;
    this.camera.position.set(c.x + r * 1.4, c.y - r * 1.4, c.z + r * 1.6);
    this.camera.up.set(0, 0, 1);
    this.controls.target.copy(c);
    this.camera.updateProjectionMatrix();
    // OrbitControls keeps its own spherical state (azimuth/polar around
    // the camera.up axis). Reassigning up means we have to re-seed the
    // spherical coords from the new camera-target relationship —
    // controls.update() does this and unblocks subsequent drags.
    this.controls.update();
  }

  private addAnimationFrameHook(hook: (frame: ViewerAnimationFrame) => void): () => void {
    this.animationFrameHooks.add(hook);
    return () => this.animationFrameHooks.delete(hook);
  }

  private addModelChangeHook(hook: (framing: ViewerModelFraming) => void, emitCurrent = false): () => void {
    this.modelChangeHooks.add(hook);
    if (emitCurrent) {
      const framing = this.copyModelFraming();
      if (framing) {
        hook(framing);
      }
    }
    return () => this.modelChangeHooks.delete(hook);
  }

  private readonly frame = (time: DOMHighResTimeStamp, opaqueFrame?: unknown): void => {
    if (!this.running) {
      return;
    }
    if (!this.immersivePresenting) {
      this.resize();
    }
    if (this.controls.enabled && this.controls.enableDamping) {
      this.controls.update();
    }
    const frame: ViewerAnimationFrame = { time, opaqueFrame };
    for (const hook of this.animationFrameHooks) {
      hook(frame);
    }
    // The view-cube gizmo's render() does double duty: it advances any
    // in-flight camera tween (moving the camera as a side effect) AND
    // draws the gizmo overlay. We need to render whenever:
    //   1. Something explicitly requested a render (needsRender), or
    //   2. The gizmo is animating, so we keep ticking its tween.
    // We reset needsRender BEFORE calling gizmo.render() so that any
    // 'change'/'end' events the gizmo dispatches synchronously (e.g.,
    // when its single-step tween completes inside one frame) can set
    // needsRender back to true and trigger one more repaint with the
    // final camera position on the next frame. Otherwise a trailing
    // `needsRender = false` would clobber that request and the screen
    // would freeze on the pre-final-step camera.
    if (this.immersivePresenting || this.needsRender || this.viewCube?.isAnimating()) {
      this.needsRender = false;
      this.renderer.render(this.scene, this.camera);
      // Render the view cube AFTER the main scene so it sits on top of
      // the viewport. This call also advances the gizmo's animation.
      if (!this.immersivePresenting) {
        this.viewCube?.render();
      }
      // If still animating after the tick, force another frame so the
      // newly-moved camera gets reflected in the main scene.
      if (!this.immersivePresenting && this.viewCube?.isAnimating()) {
        this.needsRender = true;
      }
    }
  };

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const size = this.renderer.getSize(this.rendererSize);
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.viewCube?.updateLayout();
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.needsRender = true;
    }
  }

  private frameModel(geometry: THREE.BufferGeometry): void {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) {
      return;
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) || 10;
    this.modelCenter.copy(center);
    this.modelRadius = radius;
    const desktopClipping = computeDesktopCameraClipping(radius);
    const desktopPosition = new THREE.Vector3(
      center.x + radius * 1.4,
      center.y - radius * 1.4,
      center.z + radius * 1.6,
    );
    this.modelFraming = {
      center: [center.x, center.y, center.z],
      maxDimension: radius,
      desktopCamera: {
        position: [desktopPosition.x, desktopPosition.y, desktopPosition.z],
        target: [center.x, center.y, center.z],
        near: desktopClipping.near,
        far: desktopClipping.far,
      },
    };
    if (!this.immersivePresenting) {
      this.snapCameraToDefaultView();
      this.camera.near = desktopClipping.near;
      this.camera.far = desktopClipping.far;
      this.camera.updateProjectionMatrix();
    }
    const gridSize = Math.max(50, Math.ceil((radius * 4) / 50) * 50);
    this.grid.scale.setScalar(gridSize / 200);
    for (const hook of this.modelChangeHooks) {
      hook(this.copyModelFraming()!);
    }
  }

  private copyModelFraming(): ViewerModelFraming | null {
    const framing = this.modelFraming;
    if (!framing) {
      return null;
    }
    return {
      center: [...framing.center],
      maxDimension: framing.maxDimension,
      desktopCamera: {
        position: [...framing.desktopCamera.position],
        target: [...framing.desktopCamera.target],
        near: framing.desktopCamera.near,
        far: framing.desktopCamera.far,
      },
    };
  }

  private setImmersivePresenting(presenting: boolean): void {
    if (this.immersivePresenting === presenting) {
      return;
    }
    this.immersivePresenting = presenting;
    this.requestRender();
  }

  private setDesktopDecorationsVisible(visible: boolean): void {
    this.grid.visible = visible;
    this.axes.visible = visible;
    this.viewCube?.setVisible(visible);
    this.requestRender();
  }

  private setModelPresentationState(state: ModelPresentationState): void {
    if (this.modelPresentationState === state) {
      return;
    }
    this.modelPresentationState = state;
    applyModelPresentation(this.material, state);
    this.requestRender();
  }

  private zoomDesktopCamera(distanceFactor: number): void {
    if (this.immersivePresenting) {
      return;
    }
    const offset = this.camera.position.clone().sub(this.controls.target);
    const currentDistance = offset.length();
    if (currentDistance === 0) {
      return;
    }
    const minDistance = Math.max(this.modelRadius * 0.08, this.camera.near * 2);
    const maxDistance = Math.max(this.modelRadius * 20, minDistance);
    const nextDistance = THREE.MathUtils.clamp(currentDistance * distanceFactor, minDistance, maxDistance);
    this.camera.position.copy(this.controls.target).add(offset.setLength(nextDistance));
    this.controls.update();
    this.requestRender();
  }
}
