import * as THREE from 'three';

import type { AnnotationStore } from './annotation-store.js';
import type { Annotation } from './types.js';

/**
 * Renders 3D markers for annotations:
 *  - point: a small red sphere at the world coordinate
 *  - region: a yellow translucent overlay of the selected triangles
 *
 * Markers always render on top of the model (depthTest off) so users
 * never lose track of where they marked, even when rotating the camera
 * to the back of the model.
 */
export class MarkerRenderer {
  private readonly group = new THREE.Group();
  private readonly perAnnotation = new Map<string, THREE.Object3D>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    parent: THREE.Scene,
    private readonly store: AnnotationStore,
    private readonly getMesh: () => THREE.Mesh | null,
    private readonly requestRender: () => void,
  ) {
    this.group.name = 'marks-overlay';
    parent.add(this.group);
    this.unsubscribe = store.subscribe(items => this.sync(items));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const obj of this.perAnnotation.values()) {
      this.disposeObject(obj);
    }
    this.perAnnotation.clear();
    this.group.parent?.remove(this.group);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.requestRender();
  }

  private sync(items: Annotation[]): void {
    const aliveIds = new Set(items.map(a => a.id));
    for (const [id, obj] of this.perAnnotation) {
      if (!aliveIds.has(id)) {
        this.group.remove(obj);
        this.disposeObject(obj);
        this.perAnnotation.delete(id);
      }
    }
    for (const ann of items) {
      if (this.perAnnotation.has(ann.id)) {
        continue;
      }
      const obj = ann.kind === 'point' ? this.makePointMarker(ann) : this.makeRegionMarker(ann);
      if (obj) {
        this.perAnnotation.set(ann.id, obj);
        this.group.add(obj);
      }
    }
    this.requestRender();
  }

  private makePointMarker(ann: Annotation): THREE.Object3D {
    // Bright red sphere; small enough not to obscure detail. Size is in
    // world units (mm); we'll let the user re-mark if scale is wrong.
    const geom = new THREE.SphereGeometry(0.6, 16, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff3030,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const sphere = new THREE.Mesh(geom, mat);
    sphere.position.fromArray(ann.anchorWorld);
    sphere.renderOrder = 999;
    sphere.userData.annotationId = ann.id;
    return sphere;
  }

  private makeRegionMarker(ann: Annotation): THREE.Object3D | null {
    const mesh = this.getMesh();
    if (!mesh) {
      return null;
    }
    const sourceGeom = mesh.geometry as THREE.BufferGeometry;
    const sourcePos = sourceGeom.getAttribute('position') as THREE.BufferAttribute;
    const sourceIndex = sourceGeom.getIndex();
    if (!sourceIndex) {
      return null;
    }

    // Build a sub-geometry containing just the selected triangles.
    const positions = new Float32Array(ann.triIds.length * 9);
    let cursor = 0;
    for (const tri of ann.triIds) {
      for (let k = 0; k < 3; k++) {
        const vi = sourceIndex.getX(tri * 3 + k);
        positions[cursor++] = sourcePos.getX(vi);
        positions[cursor++] = sourcePos.getY(vi);
        positions[cursor++] = sourcePos.getZ(vi);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd23f,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const overlay = new THREE.Mesh(geom, mat);
    overlay.matrix.copy(mesh.matrixWorld);
    overlay.matrixAutoUpdate = false;
    overlay.renderOrder = 998;
    overlay.userData.annotationId = ann.id;
    return overlay;
  }

  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse(node => {
      const m = node as THREE.Mesh;
      if (m.geometry) {
        m.geometry.dispose();
      }
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) {
        for (const x of mat) {
          x.dispose();
        }
      } else if (mat) {
        mat.dispose();
      }
    });
  }
}
