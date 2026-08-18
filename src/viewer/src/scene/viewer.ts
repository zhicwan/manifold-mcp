import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { payloadToGeometry } from './mesh-bridge.js';
import type { PreviewPayload } from '../types.js';
import { ViewCube } from './view-cube.js';
import { XrRuntime } from '../xr/xr-runtime.js';
import { computeDesktopCameraClipping } from './camera-clipping.js';

// Tell three.js (and any helpers that respect Object3D.DEFAULT_UP) that
// our world is Z-up. This MUST run before any Object3D / Camera / Helper
// is constructed — both ViewportGizmo and OrbitControls read DEFAULT_UP
// at construction time to set their internal "pole" axis. Setting it
// here at module load means the camera below picks it up automatically.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export type RenderMode = 'solid' | 'wireframe' | 'edges' | 'xray';

export type ViewerTheme = 'light' | 'dark';

export interface ViewerOptions {
  onXrSessionStateChange?(active: boolean): void;
}

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
 * The control panel exposes a single rendering knob — the render mode:
 * solid / wireframe / edges (line overlay) / xray (transparent
 * material, depth write off). Camera framing is driven by the corner
 * ViewCube widget plus the user's own OrbitControls drags.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private readonly modelRoot = new THREE.Group();
  private grid: THREE.GridHelper;
  private readonly axes: THREE.AxesHelper;
  private theme: ViewerTheme = 'light';
  private readonly material: THREE.MeshStandardMaterial;
  private mesh: THREE.Mesh | null = null;
  private edgesOverlay: THREE.LineSegments | null = null;
  private needsRender = true;
  private readonly perFrameHooks: Array<() => void> = [];
  private viewCube: ViewCube | null = null;
  private running = true;
  private readonly xr: XrRuntime;

  private currentRenderMode: RenderMode = 'solid';
  private modelRadius = 50;
  private modelCenter = new THREE.Vector3();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: ViewerOptions = {},
  ) {
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

    // ViewCube and XR both depend on the renderer/camera/controls being
    // fully constructed.
    this.viewCube = new ViewCube(this.camera, this.renderer, this.controls, this.requestRender, this.theme);
    this.xr = new XrRuntime({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      controls: this.controls,
      modelRoot: this.modelRoot,
      getMesh: () => this.mesh,
      setDesktopDecorationsVisible: visible => this.setDesktopDecorationsVisible(visible),
      onSessionStateChange: active => options.onXrSessionStateChange?.(active),
      requestRender: this.requestRender,
    });
    this.renderer.setAnimationLoop(this.frame);
  }

  /**
   * Stop the render loop, dispose GPU resources, and detach window
   * listeners. Safe to call once. After dispose() the Viewer is no
   * longer usable. Required so React (or any caller) can boot a fresh
   * Viewer on the next mount without leaking WebGL contexts or rAF
   * loops.
   */
  dispose(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.requestRender);
    this.controls.removeEventListener('change', this.requestRender);

    // VIE-3: dispose order matters. The view-cube gizmo's constructor
    // attaches a 'change' listener AND a wheel/click hook to OrbitControls.
    // Its dispose() detaches those by calling controls.removeEventListener.
    // If we dispose controls first, that internal `controls` reference
    // points at a destroyed object and the gizmo's detach throws — leaking
    // the listener and corrupting the next viewer mount. Always tear down
    // the dependent (viewCube) before the dependency (controls).
    this.xr.dispose();
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
    this.perFrameHooks.length = 0;
    this.axes.geometry.dispose();
    (this.axes.material as THREE.Material).dispose();

    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  readonly requestRender = (): void => {
    this.needsRender = true;
  };

  getMesh(): THREE.Mesh | null {
    return this.mesh;
  }

  enterVr(): Promise<void> {
    return this.xr.enter();
  }

  zoomIn(): void {
    this.zoomDesktopCamera(0.8);
  }

  zoomOut(): void {
    this.zoomDesktopCamera(1.25);
  }

  setMesh(payload: PreviewPayload): THREE.Mesh {
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
    this.material.needsUpdate = true;

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

  /**
   * Register a callback invoked once per animation frame, after the
   * controls update and before the (conditional) render. Used by the
   * marks subsystem to keep flyout positions in sync with the camera.
   * Returns an unsubscribe function so callers can clean up on
   * teardown without growing the hooks array unboundedly across
   * mount/unmount cycles.
   */
  addPerFrameHook(fn: () => void): () => void {
    this.perFrameHooks.push(fn);
    return () => {
      const i = this.perFrameHooks.indexOf(fn);
      if (i !== -1) {
        this.perFrameHooks.splice(i, 1);
      }
    };
  }

  private readonly frame = (time: DOMHighResTimeStamp, frame?: XRFrame): void => {
    if (!this.running) {
      return;
    }
    if (!this.xr.isPresenting()) {
      this.resize();
    }
    if (this.controls.enabled && this.controls.enableDamping) {
      this.controls.update();
    }
    this.xr.update(time, frame);
    for (const hook of this.perFrameHooks) {
      hook();
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
    if (this.xr.isPresenting() || this.needsRender || this.viewCube?.isAnimating()) {
      this.needsRender = false;
      this.renderer.render(this.scene, this.camera);
      // Render the view cube AFTER the main scene so it sits on top of
      // the viewport. This call also advances the gizmo's animation.
      if (!this.xr.isPresenting()) {
        this.viewCube?.render();
      }
      // If still animating after the tick, force another frame so the
      // newly-moved camera gets reflected in the main scene.
      if (!this.xr.isPresenting() && this.viewCube?.isAnimating()) {
        this.needsRender = true;
      }
    }
  };

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
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
    this.xr.onModelChanged(center, radius);
    this.snapCameraToDefaultView();
    const desktopClipping = computeDesktopCameraClipping(radius);
    if (this.xr.isPresenting()) {
      // XR uses metres and must retain its 0.01–100 m clipping range.
      // Save the new model-derived desktop range for session exit without
      // applying millimetre-derived values to the active XR camera.
      this.xr.updateDesktopCameraClipping(desktopClipping.near, desktopClipping.far);
    } else {
      this.camera.near = desktopClipping.near;
      this.camera.far = desktopClipping.far;
      this.camera.updateProjectionMatrix();
    }
    const gridSize = Math.max(50, Math.ceil((radius * 4) / 50) * 50);
    this.grid.scale.setScalar(gridSize / 200);
  }

  private setDesktopDecorationsVisible(visible: boolean): void {
    this.grid.visible = visible;
    this.axes.visible = visible;
    this.viewCube?.setVisible(visible);
    this.requestRender();
  }

  private zoomDesktopCamera(distanceFactor: number): void {
    if (this.xr.isPresenting()) {
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
