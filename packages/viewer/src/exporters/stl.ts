import type * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

/**
 * Serialize a three.js mesh as binary STL.
 * Note: STL is a lossy format — vertices get duplicated per face, so the
 * round-trip mesh may no longer be manifold. Prefer 3MF when possible.
 */
export function exportStl(mesh: THREE.Mesh): Blob {
  const exporter = new STLExporter();
  const data = exporter.parse(mesh, { binary: true });
  // STLExporter binary mode returns a DataView; wrap its underlying buffer.
  // Cast through ArrayBuffer to satisfy strict BlobPart typing (TS treats
  // ArrayBufferLike as possibly SharedArrayBuffer).
  const buffer = (data as DataView).buffer as ArrayBuffer;
  return new Blob([buffer], { type: 'model/stl' });
}
