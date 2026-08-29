import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ViewerFeature, ViewerModel } from '@manifold3d/protocol/wire/model.js';

/**
 * Programmatically-built demo model shown when no MCP preview server is
 * reachable (e.g. running the Viewer UI standalone). A small
 * mounting-bracket-style part: base plate + upright wall + cylindrical
 * boss, with per-part feature ids so hover-highlight and semantic
 * partLabels work exactly like they do against a live server.
 *
 * Geometry stats (volume / surface area) are computed numerically from
 * the triangle soup — parts slightly interpenetrate, so treat the
 * numbers as demo-grade approximations.
 */
export function buildDemoPayload(): ViewerModel {
  const IDENTITY_3X4 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

  // Part definitions in Z-up world space (Manifold convention).
  const parts: Array<{ label: string; kind: ViewerFeature['kind']; geom: THREE.BufferGeometry }> = [];

  // 1. Base plate: 80 x 50 x 8 mm sitting on the ground plane.
  {
    const g = new THREE.BoxGeometry(80, 50, 8);
    g.translate(0, 0, 4);
    parts.push({ label: 'plate#1', kind: 'cube', geom: g });
  }

  // 2. Upright wall along the back edge: 80 x 8 x 42 mm.
  {
    const g = new THREE.BoxGeometry(80, 8, 42);
    g.translate(0, 21, 8 + 21 - 4);
    parts.push({ label: 'wall#1', kind: 'cube', geom: g });
  }

  // 3. Cylindrical boss on the plate. CylinderGeometry is Y-up; rotate to Z-up.
  {
    const g = new THREE.CylinderGeometry(12, 12, 18, 48);
    g.rotateX(Math.PI / 2);
    g.translate(-18, -8, 8 + 9 - 2);
    parts.push({ label: 'boss#1', kind: 'cylinder', geom: g });
  }

  // 4. Small guide pin next to the boss.
  {
    const g = new THREE.CylinderGeometry(4, 4, 26, 32);
    g.rotateX(Math.PI / 2);
    g.translate(22, -10, 8 + 13 - 2);
    parts.push({ label: 'pin#1', kind: 'cylinder', geom: g });
  }

  // Flatten everything to non-indexed triangle soup and tag each
  // triangle with the index of the part that produced it.
  const nonIndexed = parts.map(p => p.geom.toNonIndexed());
  const merged = mergeGeometries(nonIndexed, false);
  if (!merged) {
    throw new Error('demo payload: geometry merge failed');
  }

  const positions = merged.getAttribute('position').array as Float32Array;
  const vertexCount = positions.length / 3;
  const triangleCount = vertexCount / 3;

  const triVerts = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    triVerts[i] = i;
  }

  const triFeatureIds = new Uint32Array(triangleCount);
  let triCursor = 0;
  nonIndexed.forEach((g, partIdx) => {
    const tris = g.getAttribute('position').count / 3;
    triFeatureIds.fill(partIdx, triCursor, triCursor + tris);
    triCursor += tris;
  });

  // Numeric stats from the triangle soup.
  let surfaceArea = 0;
  let signedVolume = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (let t = 0; t < triangleCount; t++) {
    a.fromArray(positions, t * 9);
    b.fromArray(positions, t * 9 + 3);
    c.fromArray(positions, t * 9 + 6);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    surfaceArea += ab.clone().cross(ac).length() / 2;
    signedVolume += a.dot(ab.clone().cross(ac)) / 6;
  }

  merged.computeBoundingBox();
  const box = merged.boundingBox;
  if (!box) {
    throw new Error('demo payload: merged geometry has no bounding box');
  }

  const features: ViewerFeature[] = parts.map(p => ({
    label: p.label,
    kind: p.kind,
    params: {},
    transform: IDENTITY_3X4,
  }));

  for (const g of nonIndexed) {
    g.dispose();
  }
  for (const p of parts) {
    p.geom.dispose();
  }
  merged.dispose();

  return {
    description: 'Demo bracket (offline)',
    numProp: 3,
    triangles: triangleCount,
    vertices: vertexCount,
    vertProperties: positions,
    triVerts,
    features,
    triFeatureIds,
    volume: Math.abs(signedVolume),
    surfaceArea,
    genus: 0,
    bboxMin: [box.min.x, box.min.y, box.min.z],
    bboxMax: [box.max.x, box.max.y, box.max.z],
  };
}
