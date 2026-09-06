import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import type { ViewerModel } from '@manifold3d/protocol/wire/model.js';

import { payloadToGeometry } from '../scene/mesh-bridge.js';

/**
 * Serialize canonical model geometry as binary STL, without scene/XR transforms.
 * Note: STL is a lossy format — vertices get duplicated per face, so the
 * round-trip mesh may no longer be manifold. Prefer 3MF when possible.
 */
export function exportStl(payload: ViewerModel): Blob {
  const geometry = payloadToGeometry(payload);
  const material = new THREE.MeshBasicMaterial();
  try {
    const exporter = new STLExporter();
    const data = exporter.parse(new THREE.Mesh(geometry, material), { binary: true });
    // STLExporter binary mode returns a DataView; wrap its underlying buffer.
    // Cast through ArrayBuffer to satisfy strict BlobPart typing (TS treats
    // ArrayBufferLike as possibly SharedArrayBuffer).
    const buffer = (data as DataView).buffer as ArrayBuffer;
    return new Blob([buffer], { type: 'model/stl' });
  } finally {
    geometry.dispose();
    material.dispose();
  }
}
