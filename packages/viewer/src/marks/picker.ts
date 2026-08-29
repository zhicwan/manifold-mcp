import * as THREE from 'three';

/**
 * Result of a single-point pick: the world-space hit point plus the
 * triangle index (face) that was hit. The face index is recorded so
 * later milestones can resolve it back to a feature.
 */
export interface PointPick {
  worldCoord: THREE.Vector3;
  triId: number;
}

/**
 * Result of a region (rectangle) pick: the centroid of all selected
 * triangles plus the list of triangle indices contained in the rect.
 */
export interface RegionPick {
  centroidWorld: THREE.Vector3;
  triIds: number[];
}

/**
 * Convert a mouse event in canvas space into normalized device coords
 * (range [-1, 1] in x and y), accounting for canvas size + offset.
 */
export function eventToNdc(ev: MouseEvent, canvas: HTMLCanvasElement): THREE.Vector2 {
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  return new THREE.Vector2(x, y);
}

/**
 * Cast a ray from the camera through the given NDC point and return the
 * nearest mesh hit, or null if nothing was hit.
 */
export function pickPoint(ndc: THREE.Vector2, camera: THREE.Camera, mesh: THREE.Mesh): PointPick | null {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObject(mesh, false);
  if (hits.length === 0) {
    return null;
  }
  const hit = hits[0];
  if (!hit) {
    return null;
  }
  return {
    worldCoord: hit.point.clone(),
    triId: hit.faceIndex ?? -1,
  };
}

/**
 * Select all triangles whose centroid projects inside the given screen-
 * space rectangle (NDC coordinates, both corners).
 *
 * The implementation is O(triangles) per call — fine for our typical
 * <200k triangle budget. Triangles facing away from the camera are
 * excluded so users only mark visible surface area, matching the
 * "what-you-see-is-what-you-select" expectation.
 */
export function pickRegion(
  ndcA: THREE.Vector2,
  ndcB: THREE.Vector2,
  camera: THREE.Camera,
  mesh: THREE.Mesh,
): RegionPick | null {
  const minX = Math.min(ndcA.x, ndcB.x);
  const maxX = Math.max(ndcA.x, ndcB.x);
  const minY = Math.min(ndcA.y, ndcB.y);
  const maxY = Math.max(ndcA.y, ndcB.y);

  const geom = mesh.geometry as THREE.BufferGeometry;
  const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
  const indexAttr = geom.getIndex();
  if (!indexAttr) {
    return null;
  }

  const matrixWorld = mesh.matrixWorld;
  const cameraPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();

  const triIds: number[] = [];
  const centroidSum = new THREE.Vector3();

  const triCount = indexAttr.count / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = indexAttr.getX(t * 3);
    const i1 = indexAttr.getX(t * 3 + 1);
    const i2 = indexAttr.getX(t * 3 + 2);
    a.fromBufferAttribute(posAttr, i0).applyMatrix4(matrixWorld);
    b.fromBufferAttribute(posAttr, i1).applyMatrix4(matrixWorld);
    c.fromBufferAttribute(posAttr, i2).applyMatrix4(matrixWorld);

    centroid
      .copy(a)
      .add(b)
      .add(c)
      .multiplyScalar(1 / 3);

    // Backface cull: skip triangles facing away from the camera.
    edge1.subVectors(b, a);
    edge2.subVectors(c, a);
    normal.crossVectors(edge1, edge2);
    const view = projected.subVectors(cameraPos, centroid);
    if (normal.dot(view) <= 0) {
      continue;
    }

    projected.copy(centroid).project(camera);
    if (
      projected.x >= minX &&
      projected.x <= maxX &&
      projected.y >= minY &&
      projected.y <= maxY &&
      projected.z >= -1 &&
      projected.z <= 1
    ) {
      triIds.push(t);
      centroidSum.add(centroid);
    }
  }

  if (triIds.length === 0) {
    return null;
  }
  centroidSum.multiplyScalar(1 / triIds.length);
  return { centroidWorld: centroidSum, triIds };
}
