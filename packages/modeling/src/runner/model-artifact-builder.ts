/**
 * Convert the manifold-3d `Mesh` returned by `Manifold.getMesh()` into
 * the full `ModelArtifact` the worker posts back to its host runner.
 *
 * The payload is structured-cloned across the worker boundary; we copy
 * the typed-array contents into freshly allocated buffers so we can
 * transfer ownership (avoiding a structured-clone copy) without
 * interfering with manifold's own GC of the source `Mesh`.
 */
import { extractFeaturePayload, type FeatureStore } from '../sandbox/feature-recognition.js';
import type { ManifoldMesh } from '../sandbox/manifold-types.js';
import type { ModelArtifact } from './protocol.js';

export interface MeshGeometryStats {
  volume: number;
  surfaceArea: number;
  genus: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

/**
 * Build the model artifact from a finished mesh. Returned ArrayBuffers
 * are caller-owned and intended to be passed via `transferList` on
 * `postMessage`.
 *
 */
export function buildModelArtifact(
  mesh: ManifoldMesh,
  store: FeatureStore,
  stats: MeshGeometryStats,
  description?: string,
): ModelArtifact {
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const numProp = mesh.numProp;
  const vpCopy = new Float32Array(vp.length);
  vpCopy.set(vp);
  const tvCopy = new Uint32Array(tv.length);
  tvCopy.set(tv);
  const { features, triFeatureIds } = extractFeaturePayload(mesh, store);
  return {
    ...(description !== undefined ? { description } : {}),
    numProp,
    triangles: tv.length / 3,
    vertices: vp.length / numProp,
    vertProperties: vpCopy.buffer,
    triVerts: tvCopy.buffer,
    triFeatureIds: triFeatureIds.buffer,
    features,
    volume: stats.volume,
    surfaceArea: stats.surfaceArea,
    genus: stats.genus,
    bboxMin: stats.bboxMin,
    bboxMax: stats.bboxMax,
  };
}
