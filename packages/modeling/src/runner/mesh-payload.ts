/**
 * Convert the manifold-3d `Mesh` returned by `Manifold.getMesh()` into
 * the full `ModelArtifact` the worker posts back to the MCP layer.
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
 * Build the wire payload from a finished mesh. Returned ArrayBuffers
 * are caller-owned and intended to be passed via `transferList` on
 * `postMessage`.
 *
 * `triFeatureIds` may be backed by a `SharedArrayBuffer` if the host
 * runtime ever surfaces one — guard explicitly so structured clone
 * doesn't blow up at the boundary.
 */
export function buildModelArtifact(
  mesh: ManifoldMesh,
  store: FeatureStore,
  stats: MeshGeometryStats,
  description?: string,
): ModelArtifact {
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const numProp = Number(mesh.numProp ?? 3);
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
    triFeatureIds: toTransferableArrayBuffer(triFeatureIds),
    features,
    volume: stats.volume,
    surfaceArea: stats.surfaceArea,
    genus: stats.genus,
    bboxMin: stats.bboxMin,
    bboxMax: stats.bboxMax,
  };
}

/** @deprecated Use buildModelArtifact. */
export const buildMeshPayload = buildModelArtifact;

/**
 * Return an `ArrayBuffer` view of the typed array's underlying storage,
 * suitable for use in a `postMessage` transferList. If the buffer is a
 * `SharedArrayBuffer` (which cannot be transferred) we copy into a
 * fresh `ArrayBuffer` first; this also handles the rare case where the
 * typed array is a partial view (`byteOffset > 0` or shorter than the
 * full buffer).
 */
function toTransferableArrayBuffer(view: Uint32Array): ArrayBuffer {
  const buf = view.buffer;
  if (buf instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === buf.byteLength) {
    return buf;
  }
  const copy = new Uint32Array(view.length);
  copy.set(view);
  return copy.buffer;
}
