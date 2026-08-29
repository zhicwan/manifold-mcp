import * as THREE from 'three';
import type { PreviewPayload } from '../types.js';

/**
 * Build a three.js BufferGeometry from a Manifold mesh payload.
 * Computes vertex normals; with flatShading on the material, this still
 * yields crisp facets for axis-aligned geometry.
 */
export function payloadToGeometry(payload: PreviewPayload): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = packPositions(payload);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(payload.triVerts, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Strip non-position properties down to a tightly-packed xyz Float32Array.
 * Returns the original buffer unchanged when numProp is already 3 to avoid
 * an unnecessary copy on the common path.
 */
export function packPositions(payload: PreviewPayload): Float32Array {
  if (payload.numProp < 3 || payload.vertProperties.length % payload.numProp !== 0) {
    throw new RangeError('Mesh vertex properties are not aligned to a valid position stride.');
  }
  if (payload.numProp === 3) {
    return payload.vertProperties;
  }
  const n = payload.vertProperties.length / payload.numProp;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = payload.vertProperties[i * payload.numProp + 0];
    const y = payload.vertProperties[i * payload.numProp + 1];
    const z = payload.vertProperties[i * payload.numProp + 2];
    if (x === undefined || y === undefined || z === undefined) {
      throw new RangeError(`Mesh vertex ${i} is missing a position component.`);
    }
    out[i * 3 + 0] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}
