import * as THREE from 'three';

import type { AnnotationStore } from '../annotation-store.js';

/**
 * Pure per-frame screen projection helper for the flyout layer.
 *
 * Projects each annotation's world-space anchor into NDC, then maps to
 * pixel coordinates using a caller-supplied `screenSize`. Hides flyouts
 * whose anchor is behind the camera (z outside [-1, 1]).
 *
 * The callers of {@link updatePositions} are expected to cache the
 * canvas's bounding rect and only invalidate it on `window.resize` --
 * the previous implementation called `getBoundingClientRect()` every
 * frame, which forces a synchronous layout in browsers and shows up as
 * a hot spot in profiles even when nothing moves.
 */
export function updatePositions(
  camera: THREE.Camera,
  store: AnnotationStore,
  elements: ReadonlyMap<string, HTMLElement>,
  screenSize: { x: number; y: number },
  scratch: THREE.Vector3 = new THREE.Vector3(),
): void {
  for (const [id, el] of elements) {
    const ann = store.get(id);
    if (!ann) {
      continue;
    }
    scratch.fromArray(ann.anchorWorld).project(camera);
    const visible = scratch.z >= -1 && scratch.z <= 1;
    if (!visible) {
      el.style.display = 'none';
      continue;
    }
    const x = (scratch.x * 0.5 + 0.5) * screenSize.x;
    const y = (1 - (scratch.y * 0.5 + 0.5)) * screenSize.y;
    el.style.display = '';
    el.style.transform = `translate(${x}px, ${y}px)`;
  }
}
