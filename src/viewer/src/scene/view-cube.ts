import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type ViewCubeTheme = 'light' | 'dark';

/**
 * Hand-drawn navigation cube — a hairline wireframe cube that mirrors
 * the main camera's orientation. Hovering a face gives it a faint fill
 * plus a Geist label; clicking snaps the main camera to that view.
 *
 * We render our own tiny scene into a bottom-left scissor viewport of
 * the shared WebGLRenderer (color left intact, depth cleared) so the
 * cube floats over the model. A transparent HTML overlay sits on top of
 * that corner to capture pointer events without fighting OrbitControls
 * (which is bound to the main canvas). This replaces the third-party
 * `three-viewport-gizmo` so the widget matches our frosted-glass,
 * monochrome, Geist aesthetic and follows the light/dark theme.
 *
 * World is Z-up (viewer.ts sets Object3D.DEFAULT_UP to +Z), so the cube
 * is world-aligned and each face maps directly to a world axis. In our
 * SolidWorks-style convention FRONT is the -Y face (camera-facing in the
 * default iso view at +X / -Y / +Z).
 */

interface FaceDef {
  /** Outward face normal in world space. */
  normal: THREE.Vector3;
  label: string;
}

const FACES: readonly FaceDef[] = [
  { normal: new THREE.Vector3(1, 0, 0), label: 'RIGHT' },
  { normal: new THREE.Vector3(-1, 0, 0), label: 'LEFT' },
  { normal: new THREE.Vector3(0, 1, 0), label: 'BACK' },
  { normal: new THREE.Vector3(0, -1, 0), label: 'FRONT' },
  { normal: new THREE.Vector3(0, 0, 1), label: 'TOP' },
  { normal: new THREE.Vector3(0, 0, -1), label: 'BOT' },
];

/**
 * Orbit pole. In this Z-up scene the camera up MUST stay world-Z at all
 * times: OrbitControls derives azimuth/polar around camera.up, so if we
 * ever left up tilted (e.g. +Y after a top snap) subsequent dragging
 * would orbit around the wrong pole and feel like an axis is locked.
 */
const WORLD_UP = new THREE.Vector3(0, 0, 1);

/**
 * Looking straight down the pole (top/bottom faces) makes the view
 * direction parallel to WORLD_UP, which is degenerate for lookAt. Tilt
 * the target direction a hair toward -Y (front) — imperceptible, and
 * matches how OrbitControls' own makeSafe keeps you just shy of the
 * pole when you drag to a top view.
 */
const POLE_TILT = new THREE.Vector3(0, -0.02, 0);

/** One neutral-ish palette per theme (edge / hover fill / label text). */
const PALETTE: Record<ViewCubeTheme, { edge: string; face: string; label: string }> = {
  light: { edge: '#52525b', face: '#18181b', label: '#18181b' },
  dark: { edge: '#d4d4d8', face: '#fafafa', label: '#fafafa' },
};

const SIZE = 104; // widget box in CSS px
const OFFSET = 16; // distance from the bottom-left corner in CSS px
const CUBE = 1.3; // cube edge length in gizmo-scene units
const HALF = CUBE / 2;
const HOVER_OPACITY = 0.16;
const SNAP_MS = 360;

export class ViewCube {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly requestRender: () => void;

  private readonly gizmoScene = new THREE.Scene();
  private readonly gizmoCamera: THREE.OrthographicCamera;
  private readonly edges: THREE.LineSegments;
  private readonly edgeMat: THREE.LineBasicMaterial;
  private readonly occluder: THREE.Mesh;
  private readonly occluderMat: THREE.MeshBasicMaterial;
  private readonly faceMeshes: THREE.Mesh[];
  private readonly faceMats: THREE.MeshBasicMaterial[];
  private readonly labelSprite: THREE.Sprite;
  private readonly labelMat: THREE.SpriteMaterial;
  private labelTextures: THREE.CanvasTexture[];

  private readonly el: HTMLDivElement;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly tmpSize = new THREE.Vector2();
  private readonly tmpDir = new THREE.Vector3();

  private theme: ViewCubeTheme;
  private hovered = -1;

  private animating = false;
  private snapStart = 0;
  private readonly snapStartDir = new THREE.Vector3();
  private readonly snapEndDir = new THREE.Vector3();
  private readonly snapStartUp = new THREE.Vector3();
  private readonly snapEndUp = new THREE.Vector3();
  private snapDist = 1;

  constructor(
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    controls: OrbitControls,
    requestRender: () => void,
    theme: ViewCubeTheme = 'light',
  ) {
    this.camera = camera;
    this.renderer = renderer;
    this.controls = controls;
    this.requestRender = requestRender;
    this.theme = theme;
    const palette = PALETTE[theme];

    // Fixed ortho camera; we orbit IT around the world-aligned cube to
    // mirror the main camera, so the face turned toward us is the world
    // face the model camera is currently in front of.
    const f = HALF * 2.05;
    this.gizmoCamera = new THREE.OrthographicCamera(-f, f, f, -f, 0.01, 100);
    this.gizmoCamera.position.set(0, 0, 4);

    // Hairline wireframe cube.
    const box = new THREE.BoxGeometry(CUBE, CUBE, CUBE);
    const edgeGeo = new THREE.EdgesGeometry(box);
    box.dispose();
    this.edgeMat = new THREE.LineBasicMaterial({ color: palette.edge, transparent: true, opacity: 0.85 });
    this.edges = new THREE.LineSegments(edgeGeo, this.edgeMat);
    this.gizmoScene.add(this.edges);

    // Depth-only occluder: writes depth but no color, so the scene still
    // shows through the (empty) cube while the back edges get hidden —
    // the cube reads as a clean 3-face wireframe instead of a busy
    // see-through asterisk. Slightly inset so the surface edges win the
    // depth test and stay visible.
    const occGeo = new THREE.BoxGeometry(CUBE * 0.985, CUBE * 0.985, CUBE * 0.985);
    this.occluderMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    this.occluder = new THREE.Mesh(occGeo, this.occluderMat);
    this.occluder.renderOrder = -1;
    this.gizmoScene.add(this.occluder);

    // Invisible (until hovered) face planes — the raycast + fill targets.
    const zAxis = new THREE.Vector3(0, 0, 1);
    this.faceMats = [];
    this.faceMeshes = FACES.map((face, i) => {
      const geo = new THREE.PlaneGeometry(CUBE * 0.9, CUBE * 0.9);
      const mat = new THREE.MeshBasicMaterial({
        color: palette.face,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(face.normal).multiplyScalar(HALF);
      mesh.quaternion.setFromUnitVectors(zAxis, face.normal);
      mesh.renderOrder = 1;
      mesh.userData.faceIndex = i;
      this.faceMats.push(mat);
      this.gizmoScene.add(mesh);
      return mesh;
    });

    // Reusable label sprite, shown on the hovered face only.
    this.labelTextures = FACES.map(face => makeLabelTexture(face.label, palette.label));
    this.labelMat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false });
    this.labelSprite = new THREE.Sprite(this.labelMat);
    this.labelSprite.scale.set(CUBE * 0.85, CUBE * 0.45, 1);
    this.labelSprite.renderOrder = 2;
    this.labelSprite.visible = false;
    this.gizmoScene.add(this.labelSprite);

    // Best-effort: redraw labels once Geist has actually loaded so the
    // first render isn't a fallback face.
    void document.fonts?.ready.then(() => this.regenerateLabels());

    // Transparent pointer-capture overlay in the same corner.
    this.el = document.createElement('div');
    this.el.className = 'nav-cube';
    Object.assign(this.el.style, {
      position: 'fixed',
      left: `${OFFSET}px`,
      bottom: `${OFFSET}px`,
      width: `${SIZE}px`,
      height: `${SIZE}px`,
      zIndex: '10',
      cursor: 'default',
      touchAction: 'none',
    });
    document.body.appendChild(this.el);
    this.el.addEventListener('pointermove', this.onPointerMove);
    this.el.addEventListener('pointerleave', this.onPointerLeave);
    this.el.addEventListener('click', this.onClick);
  }

  /** True while a click-snap tween is in flight (viewer keeps rendering). */
  isAnimating(): boolean {
    return this.animating;
  }

  /** Draw the cube overlay AND advance any in-flight snap tween. */
  render(): void {
    this.advanceSnap();
    this.updateGizmoCamera();

    const gl = this.renderer;
    const size = gl.getSize(this.tmpSize);
    const prevAutoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setScissorTest(true);
    gl.setViewport(OFFSET, OFFSET, SIZE, SIZE);
    gl.setScissor(OFFSET, OFFSET, SIZE, SIZE);
    gl.clearDepth();
    gl.render(this.gizmoScene, this.gizmoCamera);
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.x, size.y);
    gl.autoClear = prevAutoClear;
  }

  /** No-op: the widget uses fixed CSS-pixel corner geometry. */
  updateLayout(): void {
    return;
  }

  /** Re-tint edges/faces/labels to the given theme. */
  setTheme(theme: ViewCubeTheme): void {
    if (this.theme === theme) {
      return;
    }
    this.theme = theme;
    const palette = PALETTE[theme];
    this.edgeMat.color.set(palette.edge);
    for (const mat of this.faceMats) {
      mat.color.set(palette.face);
    }
    this.regenerateLabels();
    this.requestRender();
  }

  dispose(): void {
    this.el.removeEventListener('pointermove', this.onPointerMove);
    this.el.removeEventListener('pointerleave', this.onPointerLeave);
    this.el.removeEventListener('click', this.onClick);
    this.el.remove();

    this.edges.geometry.dispose();
    this.edgeMat.dispose();
    this.occluder.geometry.dispose();
    this.occluderMat.dispose();
    for (const mesh of this.faceMeshes) {
      mesh.geometry.dispose();
    }
    for (const mat of this.faceMats) {
      mat.dispose();
    }
    for (const tex of this.labelTextures) {
      tex.dispose();
    }
    this.labelMat.dispose();
  }

  /** Orbit the gizmo camera to mirror the main camera's orientation. */
  private updateGizmoCamera(): void {
    this.tmpDir.copy(this.camera.position).sub(this.controls.target);
    if (this.tmpDir.lengthSq() < 1e-8) {
      this.tmpDir.set(0, -1, 0);
    }
    this.tmpDir.normalize().multiplyScalar(4);
    this.gizmoCamera.position.copy(this.tmpDir);
    this.gizmoCamera.up.copy(this.camera.up);
    this.gizmoCamera.lookAt(0, 0, 0);
    this.gizmoCamera.updateMatrixWorld();
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.setHover(this.pick(e));
  };

  private readonly onPointerLeave = (): void => {
    this.setHover(-1);
  };

  private readonly onClick = (e: PointerEvent): void => {
    const i = this.pick(e);
    if (i >= 0) {
      this.startSnap(i);
    }
  };

  /** Raycast the overlay pointer into the gizmo scene → face index or -1. */
  private pick(e: PointerEvent): number {
    this.updateGizmoCamera();
    const rect = this.el.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(this.ndc, this.gizmoCamera);
    const hits = this.raycaster.intersectObjects(this.faceMeshes, false);
    return hits.length > 0 ? (hits[0].object.userData.faceIndex as number) : -1;
  }

  private setHover(i: number): void {
    if (this.hovered === i) {
      return;
    }
    if (this.hovered >= 0) {
      this.faceMats[this.hovered].opacity = 0;
    }
    this.hovered = i;
    if (i >= 0) {
      this.faceMats[i].opacity = HOVER_OPACITY;
      this.labelMat.map = this.labelTextures[i];
      this.labelMat.needsUpdate = true;
      this.labelSprite.position.copy(FACES[i].normal).multiplyScalar(HALF + 0.02);
      this.labelSprite.visible = true;
      this.el.style.cursor = 'pointer';
    } else {
      this.labelSprite.visible = false;
      this.el.style.cursor = 'default';
    }
    this.requestRender();
  }

  private startSnap(i: number): void {
    const face = FACES[i];
    const dist = this.camera.position.distanceTo(this.controls.target) || this.camera.position.length() || 1;
    this.snapStartDir.copy(this.camera.position).sub(this.controls.target).normalize();
    this.snapEndDir.copy(face.normal);
    // Keep the orbit pole = world up. If the face points along the pole
    // (top/bottom), nudge the view direction off it so lookAt stays well
    // defined and OrbitControls keeps a consistent pole afterwards.
    if (Math.abs(this.snapEndDir.dot(WORLD_UP)) > 0.999) {
      this.snapEndDir.add(POLE_TILT).normalize();
    }
    this.snapStartUp.copy(this.camera.up);
    this.snapEndUp.copy(WORLD_UP);
    this.snapDist = dist;
    this.snapStart = performance.now();
    this.animating = true;
    this.requestRender();
  }

  private advanceSnap(): void {
    if (!this.animating) {
      return;
    }
    const k = Math.min((performance.now() - this.snapStart) / SNAP_MS, 1);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;

    // Slerp the view direction (from identity toward start→end rotation).
    const rot = new THREE.Quaternion().setFromUnitVectors(this.snapStartDir, this.snapEndDir);
    const step = new THREE.Quaternion().identity().slerp(rot, e);
    const dir = this.snapStartDir.clone().applyQuaternion(step);
    const up = this.snapStartUp.clone().lerp(this.snapEndUp, e).normalize();

    this.camera.position.copy(this.controls.target).addScaledVector(dir, this.snapDist);
    this.camera.up.copy(up);
    this.camera.lookAt(this.controls.target);

    if (k >= 1) {
      // Land exactly on world up so the orbit pole is pristine.
      this.camera.up.copy(WORLD_UP);
      this.camera.lookAt(this.controls.target);
      this.animating = false;
      this.controls.update();
      this.requestRender();
    }
  }

  private regenerateLabels(): void {
    const color = PALETTE[this.theme].label;
    const next = FACES.map(face => makeLabelTexture(face.label, color));
    for (const tex of this.labelTextures) {
      tex.dispose();
    }
    this.labelTextures = next;
    if (this.hovered >= 0) {
      this.labelMat.map = this.labelTextures[this.hovered];
      this.labelMat.needsUpdate = true;
    }
  }
}

/** Render a face label to a transparent canvas texture in Geist. */
function makeLabelTexture(text: string, color: string): THREE.CanvasTexture {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, w, h);
    ctx.font = '600 68px "Geist Variable", ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 4);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
